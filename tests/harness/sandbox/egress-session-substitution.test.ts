/**
 * tests/harness/sandbox/egress-session-substitution.test.ts
 *
 * specs/egress-credential-sentinel.md — proxy substitution wiring + dispose.
 *
 * Pinned invariants:
 *   - invariant 2: substitution happens only on the forwarding leg after the
 *     filter has admitted the request (the decision is unchanged, no extra
 *     violation is recorded); a substitution fires only when destHost matches
 *     the entry's own injectHosts; the gate-miss direction is always "the fake
 *     value goes out = auth failure";
 *   - invariant 3: domains newly approved by the approval gate never enter any
 *     entry's injectHosts (credential-washout protection);
 *   - invariant 5 / Assumption 7: the plaintext arm gets zero substitution
 *     (mutateHeadersPlaintext / getBodySubstitutionsPlaintext are never wired);
 *     non-TLS CONNECT bytes → the opaque-tunnel arm is untouched (no
 *     getMitmSocketPath configured; all demultiplexing stays in the package's
 *     existing implementation);
 *   - Assumption 5: shouldTerminateTLS terminates everything by default;
 *     exempt host ∧ an injectable credential exists → reason
 *     `tls-exempt-injectable`;
 *   - a Content-Encoding request body skips substitution → reason
 *     `substitution-skipped` lands in the violationSink's bypass-diagnosis
 *     tier, never confused with the other signal classes — domain denial /
 *     infra failure (direction assertion: real values never enter violation
 *     records);
 *   - dispose: registry.clear() + MaskedFileStore.dispose() + trust-bundle temp
 *     cleanup; the normal path and the failure path (proxy already started,
 *     unix socket listen fails) share one release channel; idempotent.
 *
 * Injection strategy follows egress-session-credential.test.ts: the
 * createHttpProxyServer seam captures options without starting a proxy; the
 * onCredentialMint seam observes the session-private registry / store. All
 * fixtures are generated fake credentials; real values never cross the test surface.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, it } from "vitest";
import {
  createEgressSession,
  type EgressCredentialResources,
  type EgressSession,
  type EgressSessionOptions,
} from "../../../src/harness/sandbox/egress/session.js";
import type { EgressRelayPaths } from "../../../src/harness/sandbox/egress/relay-assets.js";
import {
  createEgressViolationSink,
  renderEgressViolations,
} from "../../../src/harness/sandbox/egress/violations.js";
import { createEgressApprovalGate } from "../../../src/harness/sandbox/egress/approval.js";
import type { EgressCredentialRoster } from "../../../src/harness/sandbox/egress/credential-assembly.js";
import type {
  HttpProxyServerOptions,
  MitmCA,
} from "../../../src/harness/sandbox/egress/upstream.js";
import type { EgressCaLoad } from "../../../src/harness/sandbox/egress/ca-store.js";

const GITHUB_HOSTS = ["github.com", "*.github.com"];

const scratch: string[] = [];
const sessions: EgressSession[] = [];

function scratchDir(): string {
  const d = mkdtempSync(join(tmpdir(), "iknow-egress-subst-"));
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

interface Fixture {
  readonly roster: EgressCredentialRoster;
  readonly realEnvToken: string;
  readonly realExtraToken: string;
  readonly realFileToken: string;
  readonly hostsPath: string;
  readonly caLoad: EgressCaLoad;
}

/** Generated fake credentials + fake CA (trust bundle in its own subdir, so dispose has a clean criterion). */
function fixture(): Fixture {
  const dir = scratchDir();
  const bundleDir = join(dir, "mitm-bundle");
  mkdirSync(bundleDir);
  const bundlePath = join(bundleDir, "trust-bundle.pem");
  writeFileSync(
    bundlePath,
    "-----BEGIN CERTIFICATE-----\nZmFrZQo=\n-----END CERTIFICATE-----\n"
  );
  const realEnvToken = `gho_FAKEenv${Math.random().toString(36).slice(2)}`;
  const realExtraToken = `xoxb_FAKEextra${Math.random().toString(36).slice(2)}`;
  const realFileToken = `gho_FAKEfile${Math.random().toString(36).slice(2)}`;
  const hostsPath = join(dir, "hosts.yml");
  writeFileSync(hostsPath, `github.com:\n  oauth_token: ${realFileToken}\n`);
  const ca = {
    trustBundlePath: bundlePath,
    keyPath: join(dir, "ca-key.pem"),
    certPath: join(dir, "ca-cert.pem"),
    ephemeral: false,
  } as unknown as MitmCA;
  return {
    roster: {
      files: [
        {
          path: hostsPath,
          extract: "oauth_token:\\s*(\\S+)",
          injectHosts: GITHUB_HOSTS,
        },
      ],
      envVars: [
        { name: "GH_TOKEN", injectHosts: GITHUB_HOSTS },
        // Separate entry: injectHosts covers only the exempt domain (used by the
        // tls-exempt-injectable case), orthogonal to the github domains.
        { name: "EXTRA_TOKEN", injectHosts: ["pinned.example.com"] },
      ],
    },
    realEnvToken,
    realExtraToken,
    realFileToken,
    hostsPath,
    caLoad: {
      ca,
      state: {
        certPath: ca.certPath,
        keyPath: ca.keyPath,
        action: "loaded",
        notice: null,
      },
    },
  };
}

interface Opened {
  readonly session: EgressSession;
  readonly opts: HttpProxyServerOptions;
  readonly cred: EgressCredentialResources;
}

/** Open a session and capture proxy options + credential resources (no real proxy started). */
async function openSession(
  f: Fixture,
  extra: {
    allowedDomains?: readonly string[];
    approvalGate?: EgressSessionOptions["policy"]["approvalGate"];
    violationSink?: EgressSessionOptions["violationSink"];
    tlsExemptHosts?: readonly string[];
  } = {}
): Promise<Opened> {
  let captured: HttpProxyServerOptions | undefined;
  let cred: EgressCredentialResources | undefined;
  const session = await createEgressSession({
    policy: {
      allowedDomains: extra.allowedDomains ?? ["github.com", "api.example.com"],
      deniedDomains: [],
      commandLabel: "test:substitution",
      credentials: f.roster,
      ...(extra.approvalGate !== undefined
        ? { approvalGate: extra.approvalGate }
        : {}),
    },
    relayResolver: fakeRelay,
    socketPathFactory: (id) => join(scratchDir(), `egress-${id}.sock`),
    createHttpProxyServer: (opts) => {
      captured = opts;
      return createServer();
    },
    loadEgressCa: () => f.caLoad,
    hostEnv: { GH_TOKEN: f.realEnvToken, EXTRA_TOKEN: f.realExtraToken },
    onCredentialMint: (c) => {
      cred = c;
    },
    ...(extra.violationSink !== undefined
      ? { violationSink: extra.violationSink }
      : {}),
    ...(extra.tlsExemptHosts !== undefined
      ? { tlsExemptHosts: extra.tlsExemptHosts }
      : {}),
  });
  sessions.push(session);
  assert.ok(captured, "createHttpProxyServer seam 必须捕获 options");
  assert.ok(cred, "onCredentialMint seam 必须捕获 resources");
  return { session, opts: captured, cred };
}

describe("T3 代换接线 —— filter 与代换正交（捕获 options，不真起代理）", () => {
  it("放行 ∧ injectHosts 命中 → headers 假→真代换；不改 filter 判定、不重复记违例", async () => {
    const f = fixture();
    const { session, opts, cred } = await openSession(f);
    const fake = cred.mint.envVars.GH_TOKEN ?? "";
    assert.match(fake, /^fake_value_/);

    const allowed = await Promise.resolve(
      opts.filter(443, "github.com", {} as never)
    );
    assert.equal(allowed, true, "filter 判定不因代换接线改变");
    assert.equal(opts.mitmCA, f.caLoad.ca, "mitmCA 接线 = session 装载的 CA");

    const headers: Record<string, string | string[]> = {
      authorization: `Bearer ${fake}`,
    };
    opts.mutateHeaders?.(headers, "github.com");
    assert.equal(
      headers.authorization,
      `Bearer ${f.realEnvToken}`,
      "转发腿 headers fake→real（invariant 2 双门全开）"
    );
    assert.equal(
      session.violationSink.size(),
      0,
      "放行 + 代换不再记任何违例（0097 违例所有权在 filter）"
    );
  });

  it("放行但条目 injectHosts 不命中 → 假值原样转发；body 代换集为空（漏门方向 = 认证失败）", async () => {
    const f = fixture();
    const { opts, cred } = await openSession(f);
    const fake = cred.mint.envVars.GH_TOKEN ?? "";

    const headers: Record<string, string | string[]> = {
      authorization: `Bearer ${fake}`,
    };
    opts.mutateHeaders?.(headers, "api.example.com");
    assert.equal(headers.authorization, `Bearer ${fake}`, "不命中 → 假值原样");

    assert.deepEqual(opts.getBodySubstitutions?.("api.example.com") ?? [], []);
    const pairs = opts.getBodySubstitutions?.("github.com") ?? [];
    const reals = pairs.map((p) => p.realValue.toString("utf8"));
    assert.ok(reals.includes(f.realEnvToken));
    assert.ok(
      reals.includes(f.realFileToken),
      "masked 文件条目同样进 body 代换集"
    );
  });

  it("批准门新批域不进入任何条目 injectHosts（invariant 3 / SC4 洗出防护）", async () => {
    const f = fixture();
    const { opts, cred } = await openSession(f, {
      // non-empty base (the allowlist-empty tier carries no approval semantics);
      // evil.example.com is the first-seen new domain.
      allowedDomains: ["api.example.com"],
      approvalGate: createEgressApprovalGate({
        askApproval: async () => true,
      }),
    });
    const fake = cred.mint.envVars.GH_TOKEN ?? "";

    // the approval gate admits evil.example.com (a newly approved domain).
    const allowed = await opts.filter(443, "evil.example.com", {} as never);
    assert.equal(allowed, true);

    // but the GH_TOKEN entry's injectHosts excludes it → the fake value forwards
    // verbatim; substitution never fires.
    const headers: Record<string, string | string[]> = {
      authorization: `Bearer ${fake}`,
    };
    opts.mutateHeaders?.(headers, "evil.example.com");
    assert.equal(
      headers.authorization,
      `Bearer ${fake}`,
      "批准 A 域不洗出 B 凭据（injectHosts 静态钉）"
    );
    assert.deepEqual(opts.getBodySubstitutions?.("evil.example.com") ?? [], []);
  });

  it("明文臂零代换：mutateHeadersPlaintext / getBodySubstitutionsPlaintext 永不接线（invariant 5 / Assumption 7）", async () => {
    const f = fixture();
    const { opts } = await openSession(f);
    assert.equal(opts.mutateHeadersPlaintext, undefined);
    assert.equal(opts.getBodySubstitutionsPlaintext, undefined);
    // AWS SigV4 is out of scope for the first phase (spec Out-of-scope).
    assert.equal(opts.planSigv4, undefined);
    // non-TLS CONNECT bytes → the opaque-tunnel arm is untouched (per the
    // ssh-bridge dependency declaration): this repo never configures
    // getMitmSocketPath; non-TLS sniff demultiplexing stays in the package's
    // existing implementation.
    assert.equal(opts.getMitmSocketPath, undefined);
  });

  it("shouldTerminateTLS 缺省全终止（Assumption 5）", async () => {
    const f = fixture();
    const { opts } = await openSession(f);
    assert.equal(typeof opts.shouldTerminateTLS, "function");
    assert.equal(opts.shouldTerminateTLS!("github.com", 443), true);
    assert.equal(opts.shouldTerminateTLS!("api.example.com", 8443), true);
  });

  it("F5 Content-Encoding → 体代换跳过痕 reason=substitution-skipped；headers 仍代换；真值不入痕（SC6 方向）", async () => {
    const f = fixture();
    const { session, opts, cred } = await openSession(f);
    const fake = cred.mint.envVars.GH_TOKEN ?? "";
    // in-package order: CONNECT calls shouldTerminateTLS(hostname, port) before mutateHeaders.
    opts.shouldTerminateTLS!("github.com", 443);

    const headers: Record<string, string | string[]> = {
      "content-encoding": "gzip",
      "content-length": "123",
      authorization: `Bearer ${fake}`,
    };
    opts.mutateHeaders?.(headers, "github.com");
    // headers are still substituted (only the body scan is skipped); the trace records the body skip.
    assert.equal(headers.authorization, `Bearer ${f.realEnvToken}`);

    const violations = session.violationSink.drain();
    assert.equal(violations.length, 1);
    assert.equal(violations[0].reason, "substitution-skipped");
    assert.equal(violations[0].host, "github.com");
    assert.equal(violations[0].port, 443, "痕携带 CONNECT 端口，不伪造");
    assert.ok(
      !JSON.stringify(violations).includes(f.realEnvToken),
      "SC6 方向断言：诊断痕绝无真值"
    );
  });

  it("F5 痕只在「注入域 ∧ 声明体 ∧ Content-Encoding」三条件齐全时产生（旁路诊断不冒充）", async () => {
    const f = fixture();
    const { session, opts, cred } = await openSession(f);
    const fake = cred.mint.envVars.GH_TOKEN ?? "";
    // a compressed request outside the inject domains has no substitution to skip → no trace.
    opts.mutateHeaders?.(
      {
        "content-encoding": "gzip",
        "content-length": "10",
        authorization: `Bearer ${fake}`,
      },
      "api.example.com"
    );
    // no declared body (no content-length / transfer-encoding) → the package builds no transform → no trace.
    opts.mutateHeaders?.({ "content-encoding": "gzip" }, "github.com");
    assert.equal(session.violationSink.size(), 0);
  });

  it("F6 豁免域 ∧ 可注入凭据 → 不终止 + tls-exempt-injectable；豁免而无凭据不留痕", async () => {
    const f = fixture();
    const sink = createEgressViolationSink();
    const { opts } = await openSession(f, {
      violationSink: sink,
      tlsExemptHosts: ["pinned.example.com", "bare.example.net"],
    });

    assert.equal(opts.shouldTerminateTLS!("pinned.example.com", 443), false);
    const drained = sink.drain();
    assert.equal(drained.length, 1);
    assert.equal(drained[0].reason, "tls-exempt-injectable");
    assert.equal(drained[0].host, "pinned.example.com");
    assert.ok(!JSON.stringify(drained).includes(f.realExtraToken));

    // exempt but no credential entry points at it → not terminated, and no trace (exemption itself is not a violation).
    assert.equal(opts.shouldTerminateTLS!("bare.example.net", 443), false);
    assert.equal(sink.size(), 0);

    // non-exempt domains are unaffected (terminate everything by default).
    assert.equal(opts.shouldTerminateTLS!("github.com", 443), true);
  });

  it("四类信号互不混淆：域判定拒绝 / 代换跳过 / 豁免注入 / infra 各有独立 reason 与渲染档", async () => {
    const f = fixture();
    const sink = createEgressViolationSink();
    const { opts } = await openSession(f, {
      violationSink: sink,
      tlsExemptHosts: ["pinned.example.com"],
    });
    const fake = "fake_value_signaltest";
    // 1) domain-decision denial (filter).
    await Promise.resolve(opts.filter(443, "blocked.example", {} as never));
    // 2) substitution-skipped trace.
    opts.shouldTerminateTLS!("github.com", 443);
    opts.mutateHeaders?.(
      {
        "content-encoding": "gzip",
        "content-length": "5",
        authorization: `Bearer ${fake}`,
      },
      "github.com"
    );
    // 3) exempt-domain injection trace.
    opts.shouldTerminateTLS!("pinned.example.com", 443);
    // 4) infra failure (existing channel).
    sink.record({
      kind: "egress_violation",
      host: "egress-seam",
      port: 0,
      reason: "infra-unavailable",
      command: "test",
    });

    const all = sink.drain();
    const reasons = new Set(all.map((v) => v.reason));
    // blocked.example is not in the allow set and there is no approval gate → non-interactive fail-closed (no-approval-inlet).
    assert.deepEqual([...reasons].sort(), [
      "infra-unavailable",
      "no-approval-inlet",
      "substitution-skipped",
      "tls-exempt-injectable",
    ]);
    assert.equal(all.length, 4);
    const text = renderEgressViolations(all);
    // domain denial renders as `[network_denied]` ("network denied"); the two substitution diagnostics go to the `[egress_diagnostic]` ("egress diagnostic") bypass tier.
    assert.match(text, /\[network_denied\] blocked\.example:443/);
    assert.match(text, /\[egress_diagnostic\] github\.com:443/);
    assert.match(text, /\[egress_diagnostic\] pinned\.example\.com:443/);
  });

  it("无名册 → 代理 options 不出现任何凭据臂（mitmCA / mutateHeaders / getBodySubstitutions 缺席）", async () => {
    let captured: HttpProxyServerOptions | undefined;
    const session = await createEgressSession({
      policy: {
        allowedDomains: ["github.com"],
        deniedDomains: [],
        commandLabel: "test:no-cred",
      },
      relayResolver: fakeRelay,
      socketPathFactory: (id) => join(scratchDir(), `egress-${id}.sock`),
      createHttpProxyServer: (opts) => {
        captured = opts;
        return createServer();
      },
    });
    sessions.push(session);
    assert.ok(captured);
    assert.equal(captured.mitmCA, undefined);
    assert.equal(captured.mutateHeaders, undefined);
    assert.equal(captured.getBodySubstitutions, undefined);
    assert.equal(captured.shouldTerminateTLS, undefined);
  });
});

describe("T3 dispose —— registry / masked store / trust bundle 三资源同一释放通道", () => {
  it("正常路径 dispose：三资源释放；重复 dispose 幂等", async () => {
    const f = fixture();
    const { session, opts, cred } = await openSession(f);
    const storeDir = cred.mint.store.dirPath;
    assert.ok(storeDir, "masked store 目录已写");
    assert.ok(existsSync(storeDir));
    assert.ok(existsSync(f.caLoad.ca.trustBundlePath));
    assert.ok(cred.mint.registry.size > 0);

    await session.dispose();
    assert.equal(cred.mint.registry.size, 0, "registry.clear()");
    assert.ok(!existsSync(storeDir), "MaskedFileStore.dispose() 删目录");
    assert.ok(
      !existsSync(dirname(f.caLoad.ca.trustBundlePath)),
      "trust bundle 临时件清理（bundle 目录随 disposeMitmCA 删除）"
    );

    // after release substitution is inert: the fake value passes through (registry cleared = no pair to substitute; fail-safe direction).
    const headers: Record<string, string | string[]> = {
      authorization: "Bearer fake_value_gone",
    };
    opts.mutateHeaders?.(headers, "github.com");
    assert.equal(headers.authorization, "Bearer fake_value_gone");

    await session.dispose(); // idempotent: does not throw
  });

  it("异常路径（unix socket listen 失败、代理已起）→ 三资源同样释放，不留 stale", async () => {
    const f = fixture();
    let captured: HttpProxyServerOptions | undefined;
    let cred: EgressCredentialResources | undefined;
    await assert.rejects(
      createEgressSession({
        policy: {
          allowedDomains: ["github.com"],
          deniedDomains: [],
          commandLabel: "test:listen-fail",
          credentials: f.roster,
        },
        relayResolver: fakeRelay,
        // listen is guaranteed to fail: the socket's parent directory does not exist (ENOENT) → typed cleanup channel.
        socketPathFactory: (id) =>
          join(scratchDir(), "no-such-dir", `egress-${id}.sock`),
        createHttpProxyServer: (opts) => {
          captured = opts;
          return createServer();
        },
        loadEgressCa: () => f.caLoad,
        hostEnv: { GH_TOKEN: f.realEnvToken },
        onCredentialMint: (c) => {
          cred = c;
        },
      }),
      /listen E(ACCES|NOENT)/
    );
    assert.ok(captured, "代理 Step 2 先于失败发生（listen 失败 = Step 3）");
    assert.ok(cred);
    assert.equal(cred.mint.registry.size, 0);
    const storeDir = cred.mint.store.dirPath;
    if (storeDir !== undefined) {
      assert.ok(!existsSync(storeDir), "masked store 目录已删");
    }
    assert.ok(!existsSync(dirname(f.caLoad.ca.trustBundlePath)));
  });
});
