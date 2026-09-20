/**
 * tests/harness/sandbox/egress-session-credential.test.ts
 *
 * specs/egress-credential-sentinel.md — session assembly step 1.5 (credential
 * minting) and the fence-spec extension.
 *
 * Pinned invariants:
 *   - roster present → spec.env appends the credential fakes and CA_TRUST_VARS on
 *     top of the three proxy keys (invariant 1: the channel is an egress env
 *     delta); spec.binds carries the masked store / trust bundle / masked-file
 *     overlay (invariant 9 placement is pinned on the bwrap side);
 *   - minting happens before the proxy starts: a CA-load or assembly-time assert
 *     failure means no proxy and no session (the session-side criterion of "never
 *     start a session with partial substitution");
 *   - roster absent → no CA load, no minting (spec.binds absent);
 *   - relay dependency absent (assembly step 1 fails, ADR-0107) → the whole
 *     credential layer is absent with the session and no fakes are half-injected
 *     (loadEgressCa not called = registry/store never constructed).
 *
 * Injection strategy follows egress-session.test.ts: fake relayResolver path set /
 * createHttpProxyServer seam; loadEgressCa and hostEnv are the newly added seams.
 * All fixtures are generated fake credentials.
 */
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "vitest";
import {
  createEgressSession,
  EgressRelayUnavailableError,
  SANDBOX_HTTP_PROXY_PORT,
  type EgressSession,
} from "../../../src/harness/sandbox/egress/session.js";
import type { EgressRelayPaths } from "../../../src/harness/sandbox/egress/relay-assets.js";
import type { EgressCredentialRoster } from "../../../src/harness/sandbox/egress/credential-assembly.js";
import {
  CA_TRUST_VARS,
  type MitmCA,
} from "../../../src/harness/sandbox/egress/upstream.js";
import type { EgressCaLoad } from "../../../src/harness/sandbox/egress/ca-store.js";

const scratch: string[] = [];
const sessions: EgressSession[] = [];

function scratchDir(): string {
  const d = mkdtempSync(join(tmpdir(), "iknow-egress-cred-session-"));
  scratch.push(d);
  return d;
}

afterEach(async () => {
  for (const s of sessions.splice(0)) await s.dispose();
  for (const p of scratch.splice(0))
    rmSync(p, { recursive: true, force: true });
});

/** Fixed fake relay path set — unit tests never probe host existence (resolver seam given directly). */
function fakeRelay(): EgressRelayPaths {
  const relayDir = "/test-root/vendor/egress-relay";
  return {
    nodePath: "/test-root/bin/node",
    relayDir,
    bridgeScriptPath: join(relayDir, "egress-tcp-relay.mjs"),
    connectScriptPath: join(relayDir, "egress-http-connect.mjs"),
  };
}

/** Generated fake credentials + fake CA (the trust bundle file is really written, since paths are consumed). */
function fixture(): {
  roster: EgressCredentialRoster;
  realEnvToken: string;
  realFileToken: string;
  hostsPath: string;
  caLoad: EgressCaLoad;
} {
  const dir = scratchDir();
  const bundlePath = join(dir, "bundle.pem");
  writeFileSync(
    bundlePath,
    "-----BEGIN CERTIFICATE-----\nZmFrZQo=\n-----END CERTIFICATE-----\n"
  );
  const realEnvToken = `gho_FAKEenv${Math.random().toString(36).slice(2)}`;
  const realFileToken = `gho_FAKEfile${Math.random().toString(36).slice(2)}`;
  const hostsPath = join(dir, "hosts.yml");
  writeFileSync(hostsPath, `github.com:\n  oauth_token: ${realFileToken}\n`);
  const ca = {
    trustBundlePath: bundlePath,
    keyPath: join(dir, "ca-key.pem"),
  } as unknown as MitmCA;
  return {
    roster: {
      files: [
        {
          path: hostsPath,
          extract: "oauth_token:\\s*(\\S+)",
          injectHosts: ["github.com", "*.github.com"],
        },
      ],
      envVars: [
        { name: "GH_TOKEN", injectHosts: ["github.com", "*.github.com"] },
      ],
    },
    realEnvToken,
    realFileToken,
    hostsPath,
    caLoad: {
      ca,
      state: {
        certPath: join(dir, "cert.pem"),
        keyPath: ca.keyPath,
        action: "loaded",
        notice: null,
      },
    },
  };
}

describe("createEgressSession — T2 铸造步骤", () => {
  it("名册在场：spec.env 含假值 + CA_TRUST_VARS；spec.binds 含 store/bundle/masked 盖行", async () => {
    const f = fixture();
    const session = await createEgressSession({
      policy: {
        allowedDomains: ["github.com"],
        deniedDomains: [],
        commandLabel: "test:credential",
        credentials: f.roster,
      },
      relayResolver: fakeRelay,
      socketPathFactory: (id) => join(scratchDir(), `egress-${id}.sock`),
      createHttpProxyServer: () => createServer(),
      loadEgressCa: () => f.caLoad,
      hostEnv: { GH_TOKEN: f.realEnvToken },
    });
    sessions.push(session);

    // the proxy keys remain (appended on top of buildProxyEnv, not replaced).
    assert.match(
      session.spec.env.HTTP_PROXY ?? "",
      new RegExp(`^http://[^@]+@127\\.0\\.0\\.1:${SANDBOX_HTTP_PROXY_PORT}$`)
    );
    // invariant 1 channel: GH_TOKEN = fake value; the real value never enters.
    assert.match(session.spec.env.GH_TOKEN ?? "", /^fake_value_/);
    assert.ok(!Object.values(session.spec.env).includes(f.realEnvToken));
    assert.ok(!Object.values(session.spec.env).includes(f.realFileToken));
    // Assumption 11: every CA_TRUST_VARS entry points at the trust bundle.
    for (const name of CA_TRUST_VARS)
      assert.equal(session.spec.env[name], f.caLoad.ca.trustBundlePath);
    // assembly-time bind integrity: bundle self-bind + masked-file overlay present.
    const binds = session.spec.binds ?? [];
    assert.ok(
      binds.some(
        (b) => b.src === f.caLoad.ca.trustBundlePath && b.readonly === true
      )
    );
    const masked = binds.find((b) => b.dest === f.hostsPath);
    assert.ok(masked, "masked 盖行（dest=真路径）进 bind 表");
    assert.notEqual(masked.src, f.hostsPath);
    // the CA key never enters the bind table.
    assert.ok(
      !binds.some(
        (b) => b.src === f.caLoad.ca.keyPath || b.dest === f.caLoad.ca.keyPath
      )
    );
  });

  it("铸造失败（CA 装载抛）→ 代理未起、session 不存在（铸造先于 Step 2）", async () => {
    let proxyStarted = false;
    await assert.rejects(
      createEgressSession({
        policy: {
          allowedDomains: ["github.com"],
          deniedDomains: [],
          commandLabel: "test:mint-fail",
          credentials: fixture().roster,
        },
        relayResolver: fakeRelay,
        createHttpProxyServer: (opts) => {
          proxyStarted = true;
          return createHttpProxyServerStub(opts);
        },
        loadEgressCa: () => {
          throw new Error("ca boom");
        },
        hostEnv: {},
      }),
      /ca boom/
    );
    assert.equal(proxyStarted, false, "Step 1.5 失败不得泄漏到 Step 2");
  });

  it("名册缺席 → 不装载 CA、不铸造（spec.binds 缺席）", async () => {
    let caCalled = false;
    const session = await createEgressSession({
      policy: {
        allowedDomains: ["github.com"],
        deniedDomains: [],
        commandLabel: "test:no-roster",
      },
      relayResolver: fakeRelay,
      socketPathFactory: (id) => join(scratchDir(), `egress-${id}.sock`),
      createHttpProxyServer: () => createServer(),
      loadEgressCa: () => {
        caCalled = true;
        throw new Error("must not be called");
      },
    });
    sessions.push(session);
    assert.equal(caCalled, false);
    assert.equal(session.spec.binds, undefined);
    assert.equal(session.spec.env.GH_TOKEN, undefined);
  });

  it("SC9 后半：中继依赖缺席（Step 1 失败）→ 凭据层整体缺席，无假值半注入", async () => {
    const f = fixture();
    let caCalled = false;
    await assert.rejects(
      createEgressSession({
        policy: {
          allowedDomains: ["github.com"],
          deniedDomains: [],
          commandLabel: "test:no-relay",
          credentials: f.roster,
        },
        relayResolver: () => undefined,
        loadEgressCa: () => {
          caCalled = true;
          return f.caLoad;
        },
        hostEnv: { GH_TOKEN: f.realEnvToken },
      }),
      EgressRelayUnavailableError
    );
    // assembly step 1 precedes step 1.5: registry/store were never constructed = no half-injection state.
    assert.equal(caCalled, false);
  });
});

function createHttpProxyServerStub(_opts: unknown): Server {
  return createServer();
}
