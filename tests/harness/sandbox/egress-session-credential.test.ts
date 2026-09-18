/**
 * tests/harness/sandbox/egress-session-credential.test.ts
 *
 * specs/egress-credential-sentinel.md T2 —— session 装配步骤（Step 1.5）
 * 与 fence spec 扩展。
 *
 * 钉住的不变式：
 *   - 名册在场 → spec.env = 代理三键之上追加凭据假值与 CA_TRUST_VARS
 *     （invariant 1 通道 = egress env 增量）；spec.binds = masked store /
 *     trust bundle / masked-file 盖 bind（invariant 9 落位由 bwrap 侧钉）；
 *   - 铸造在起代理之前：CA 装载 / 装配期 assert 失败 = 代理未起、
 *     session 不存在（F4「不起带部分代换的 session」的 session 面判据）；
 *   - 名册缺席 → 不装载 CA、不铸造（spec.binds 缺席）；
 *   - SC9 后半：socat 缺失（Step 1 失败）→ 凭据层随 session 整体缺席，
 *     无假值半注入（loadEgressCa 未被调 = registry/store 未构造）。
 *
 * 注入策略沿用 egress-session.test.ts：假 socat spawn / createHttpProxyServer
 * seam；loadEgressCa / hostEnv 为 T2 新增 seam。fixture 全为生成假凭据。
 */
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { spawn as realSpawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "vitest";
import {
  createEgressSession,
  SocatUnavailableError,
  type EgressSession,
} from "../../../src/harness/sandbox/egress/session.js";
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

function fakeSocatProc(pid: number) {
  const proc = realSpawn("/bin/true", ["--version"], { stdio: "ignore" });
  try {
    proc.kill("SIGKILL");
  } catch {
    /* */
  }
  return Object.assign(proc, { pid });
}

/** 生成的假凭据 + 假 CA（trust bundle 文件真写，路径消费面用）。 */
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
      probeSocat: () => true,
      spawn: (() => fakeSocatProc(4242)) as typeof realSpawn,
      socketPathFactory: (id) => join(scratchDir(), `egress-${id}.sock`),
      createHttpProxyServer: () => createServer(),
      loadEgressCa: () => f.caLoad,
      hostEnv: { GH_TOKEN: f.realEnvToken },
    });
    sessions.push(session);

    // 代理键仍在（buildProxyEnv 之上追加，不替换）。
    assert.match(
      session.spec.env.HTTP_PROXY ?? "",
      /^http:\/\/127\.0\.0\.1:\d+$/
    );
    // invariant 1 通道：GH_TOKEN = 假值，真值不进。
    assert.match(session.spec.env.GH_TOKEN ?? "", /^fake_value_/);
    assert.ok(!Object.values(session.spec.env).includes(f.realEnvToken));
    assert.ok(!Object.values(session.spec.env).includes(f.realFileToken));
    // Assumption 11：CA_TRUST_VARS 全量指向 trust bundle。
    for (const name of CA_TRUST_VARS)
      assert.equal(session.spec.env[name], f.caLoad.ca.trustBundlePath);
    // F8 装配期 bind 完整性：bundle 自 bind + masked-file 盖行在场。
    const binds = session.spec.binds ?? [];
    assert.ok(
      binds.some(
        (b) => b.src === f.caLoad.ca.trustBundlePath && b.readonly === true
      )
    );
    const masked = binds.find((b) => b.dest === f.hostsPath);
    assert.ok(masked, "masked 盖行（dest=真路径）进 bind 表");
    assert.notEqual(masked.src, f.hostsPath);
    // CA key 不进表（SC8 消费面）。
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
        probeSocat: () => true,
        spawn: (() => fakeSocatProc(4242)) as typeof realSpawn,
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
      probeSocat: () => true,
      spawn: (() => fakeSocatProc(4242)) as typeof realSpawn,
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

  it("SC9 后半：socat 缺失（Step 1 失败）→ 凭据层整体缺席，无假值半注入", async () => {
    const f = fixture();
    let caCalled = false;
    await assert.rejects(
      createEgressSession({
        policy: {
          allowedDomains: ["github.com"],
          deniedDomains: [],
          commandLabel: "test:no-socat",
          credentials: f.roster,
        },
        socatCommand: "socat-this-does-not-exist",
        probeSocat: () => false,
        loadEgressCa: () => {
          caCalled = true;
          return f.caLoad;
        },
        hostEnv: { GH_TOKEN: f.realEnvToken },
      }),
      SocatUnavailableError
    );
    // Step 1 先于 Step 1.5：registry/store 根本未构造 = 无半注入态。
    assert.equal(caCalled, false);
  });
});

function createHttpProxyServerStub(_opts: unknown): Server {
  return createServer();
}
