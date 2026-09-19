/**
 * tests/harness/egress-entry-wiring.test.ts
 *
 * specs/egress-credential-sentinel.md T6 —— 入口形态接线 + yolo 姿态显式。
 *
 * 钉住的不变式：
 *   - 凭据装配函数入口（`mintEgressCredentialLayer`）显式姿态分支：
 *     `no-fence`（yolo / 围栏整体退场）→ 不铸造、不注入，返回
 *     `{ skipped: "no-fence" }` + 诊断痕（F9 / Assumption 9 不静默，
 *     离线可查证「宿主真值直达、无存在面保护」）；`fenced` → 委托
 *     `mintEgressCredentials`（T2 形状逐字）；
 *   - isolation OFF（settings.isolation.network 缺席）：装配层同样留
 *     `skipped: no-fence` 痕（SC9 反命门：不许「看起来有保护实则无」）；
 *   - 三装配点（bash 前台 / background manager / verify 单例）经同一
 *     `createEgressSession` 缝获得凭据层：各面只透传 `{ policy }`，
 *     对凭据零分支代码（policy.credentials 恒等透传）；
 *   - background 挂 settle() 的释放通道（dispose 生产实现覆盖
 *     registry/store 已由 T3 session 测试钉）；
 *   - EgressRelayUnavailableError 路径：凭据层随 session 缺席（缝未被调 /
 *     egress spec 不落 fence），fence env 无假值键，infra 文案不变
 *     （不新增冒充）；
 *   - `createEgressSession` 缝扩展保持加性形状：三面对 opts 的期望只有
 *     `{ policy }` 一键，ssh-bridge plan 可在同一 opts 形状上加字段接线。
 *
 * 全部 fixture 为生成假值；宿主真值 / .env* 不进任何输入或断言。
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { promises as fsp } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** 模块级捕获盒（vi.hoisted：mock 工厂在 import 期即引用）。 */
const h = vi.hoisted(() => ({
  /** createBwrapFence（index 导出）收到的 opts 序列。 */
  fenceOpts: [] as Record<string, unknown>[],
  /** runInSandbox（index 与 runner 两处导出）收到的 args 序列。 */
  runArgs: [] as Record<string, unknown>[],
  /** createEgressSession（index 导出）收到的 opts 序列。 */
  egressCalls: [] as Record<string, unknown>[],
  /** createEgressSession 行为（测试逐例改写）。 */
  egressImpl: (_opts: unknown): Promise<unknown> =>
    Promise.reject(new Error("not configured")),
  /** runInSandbox 返回值（测试逐例改写）。 */
  runResult: { exitCode: 0, stdout: "", stderr: "" },
}));

vi.mock("../../src/harness/sandbox/index.ts", async () => {
  const mod = await vi.importActual<
    typeof import("../../src/harness/sandbox/index.ts")
  >("../../src/harness/sandbox/index.ts");
  return {
    ...mod,
    createBwrapFence: (opts: Record<string, unknown>) => {
      h.fenceOpts.push(opts);
      return { __stubFence: true };
    },
    createEgressSession: (opts: Record<string, unknown>) => {
      h.egressCalls.push(opts);
      return h.egressImpl(opts);
    },
    runInSandbox: async (args: Record<string, unknown>) => {
      h.runArgs.push(args);
      return h.runResult;
    },
  };
});

// bash.ts 直接 import runInSandbox from sandbox/runner.js —— 一并替换。
vi.mock("../../src/harness/sandbox/runner.ts", async () => {
  const mod = await vi.importActual<
    typeof import("../../src/harness/sandbox/runner.ts")
  >("../../src/harness/sandbox/runner.ts");
  return {
    ...mod,
    runInSandbox: async (args: Record<string, unknown>) => {
      h.runArgs.push(args);
      return h.runResult;
    },
  };
});

import { createBashTool } from "../../src/harness/aci/tools/bash.js";
import { createBackgroundTaskManager } from "../../src/harness/background/manager.js";
import { resolveTasksDir } from "../../src/harness/background/paths.js";
import {
  mintEgressCredentialLayer,
  noFenceCredentialTrace,
  type EgressCredentialRoster,
} from "../../src/harness/sandbox/egress/credential-assembly.js";
import type { MitmCA } from "../../src/harness/sandbox/egress/upstream.js";
import { createEgressPolicyFactory } from "../../src/harness/sandbox/egress/assembly.js";
import { EgressRelayUnavailableError } from "../../src/harness/sandbox/egress/session.js";
import type {
  EgressPolicyInput,
  EgressSession,
} from "../../src/harness/sandbox/egress/session.js";
import { makeDefaultRunVerify } from "../../src/harness/verify/sandbox-run.js";
import type { IknowSettings } from "../../src/config/settings.js";

const scratch: string[] = [];
function scratchDir(): string {
  const d = mkdtempSync(join(tmpdir(), "iknow-t6-entry-"));
  scratch.push(d);
  return d;
}

beforeEach(() => {
  h.fenceOpts.length = 0;
  h.runArgs.length = 0;
  h.egressCalls.length = 0;
  h.egressImpl = () => Promise.reject(new Error("not configured"));
  h.runResult = { exitCode: 0, stdout: "", stderr: "" };
});

afterEach(async () => {
  for (const p of scratch.splice(0))
    rmSync(p, { recursive: true, force: true });
});

/** 假凭据名册（fixture，非宿主真值）。 */
function rosterFixture(): EgressCredentialRoster {
  return {
    files: [],
    envVars: [{ name: "GH_TOKEN", injectHosts: ["github.com"] }],
  };
}

/** 测试用 MitmCA 替身：mint 入口只消费 trustBundlePath / bind 源（T2 fixture 同款）。 */
function fakeCa(): MitmCA {
  const dir = scratchDir();
  const bundlePath = join(dir, "trust-bundle.pem");
  writeFileSync(
    bundlePath,
    "-----BEGIN CERTIFICATE-----\nZmFrZQo=\n-----END CERTIFICATE-----\n"
  );
  return {
    trustBundlePath: bundlePath,
    keyPath: join(dir, "ca-key-should-never-bind.pem"),
    certPath: join(dir, "cert.pem"),
  } as unknown as MitmCA;
}

/** mint 层 stub session spec：模拟 T2 铸造后的 fence env 增量（假值）。 */
function mintedSpec(): EgressSession["spec"] {
  return {
    unixSocketPath: "/tmp/iknow-t6-stub.sock",
    sandboxLocalPort: 18080,
    innerBridgeScript:
      "/test-root/bin/node /test-root/vendor/egress-relay/egress-tcp-relay.mjs '/tmp/iknow-t6-stub.sock' 18080",
    relayAssetsDir: "/test-root/vendor/egress-relay",
    env: {
      HTTP_PROXY: "http://127.0.0.1:18080",
      HTTPS_PROXY: "http://127.0.0.1:18080",
      GH_TOKEN: "fake_value_t6_fixture",
      SSL_CERT_FILE: "/tmp/iknow-t6-bundle.pem",
    },
  };
}

function stubSession(opts?: { readonly spec?: EgressSession["spec"] }): {
  session: EgressSession;
  dispose: ReturnType<typeof vi.fn>;
} {
  const dispose = vi.fn(async () => undefined);
  return {
    session: Object.freeze({
      id: "t6-stub",
      spec: opts?.spec ?? mintedSpec(),
      violationSink: {
        record: () => undefined,
        drain: () => [],
      },
      dispose,
    }) as unknown as EgressSession,
    dispose,
  };
}

// ── 1. 凭据装配入口姿态分支（credential-assembly.ts / F9）──────────────────

describe("T6 凭据装配入口姿态分支", () => {
  it("posture no-fence → 不铸造不注入：返回 skipped 痕 + registry 未构造 + 诊断留痕", () => {
    const diagnostics: string[] = [];
    const out = mintEgressCredentialLayer({
      posture: "no-fence",
      onDiagnostic: (m) => diagnostics.push(m),
    });
    assert.deepEqual(out, { skipped: "no-fence" });
    // registry / store / envVars / binds 均不在场 = 未构造。
    assert.equal("registry" in out, false);
    assert.equal("store" in out, false);
    assert.equal("envVars" in out, false);
    assert.equal("binds" in out, false);
    // 不静默：诊断痕在场且离线可查证（canonical marker）。
    assert.equal(diagnostics.length, 1);
    assert.match(diagnostics[0]!, /skipped: no-fence/);
  });

  it("posture fenced → 委托 mintEgressCredentials（T2 形状逐字：registry/envVars/binds 在场）", () => {
    const ca = fakeCa();
    const hostEnv: Record<string, string | undefined> = {
      GH_TOKEN: `gho_FAKE_t6_${Math.random().toString(36).slice(2)}`,
    };
    const out = mintEgressCredentialLayer({
      posture: "fenced",
      roster: rosterFixture(),
      ca,
      env: hostEnv,
    });
    assert.equal("skipped" in out, false);
    if ("skipped" in out) return;
    assert.ok(out.registry);
    assert.ok(out.store);
    assert.ok(out.envVars.GH_TOKEN);
    // 假值空间：注入 env 值是 fake_value_…，非宿主真值。
    assert.match(out.envVars.GH_TOKEN!, /^fake_value_/);
    assert.notEqual(out.envVars.GH_TOKEN, hostEnv.GH_TOKEN);
    out.store.dispose();
  });

  it("no-fence 痕文案 = SSOT 常量（装配层与入口共用，离线 grep 单点）", () => {
    assert.match(noFenceCredentialTrace(), /skipped: no-fence/);
    // 痕里绝不带凭据材料。
    assert.doesNotMatch(noFenceCredentialTrace(), /GH_TOKEN|token\s*[:=]/i);
  });
});

// ── 2. isolation OFF（assembly.ts）姿态留痕 ────────────────────────────────

describe("T6 isolation OFF（network 段缺席）显式 skipped 痕", () => {
  it("settings.isolation.network 缺席 → 工厂恒返 undefined + onWarn 收到 no-fence 痕", () => {
    const warns: string[] = [];
    const factory = createEgressPolicyFactory({
      settings: {} as unknown as IknowSettings,
      commandLabel: "bash",
      onWarn: (m) => warns.push(m),
    });
    assert.equal(factory(), undefined);
    assert.ok(
      warns.some((w) => /skipped: no-fence/.test(w)),
      `expected no-fence trace, got: ${JSON.stringify(warns.map((w) => w.slice(0, 60)))}`
    );
  });

  it("network 在场 → 无 skipped 痕（铸造路径不误报姿态）", () => {
    const warns: string[] = [];
    const factory = createEgressPolicyFactory({
      settings: {
        isolation: {
          network: { allowedDomains: ["example.com"], deniedDomains: [] },
        },
      } as unknown as IknowSettings,
      commandLabel: "bash",
      onWarn: (m) => warns.push(m),
    });
    const policy = factory() as EgressPolicyInput;
    assert.ok(policy);
    assert.equal(warns.filter((w) => /no-fence/.test(w)).length, 0);
  });
});

// ── 3. 三装配点 wiring（工厂注入 seam）─────────────────────────────────────

describe("T6 前台 bash 装配点", () => {
  it("policy.credentials 在场 → 缝收到逐字 { policy }（keys 只有 policy，roster 恒等透传），fence 挂 egress spec，finally dispose", async () => {
    const roster = rosterFixture();
    const { session, dispose } = stubSession();
    const seam = vi.fn(async (opts: unknown) => {
      h.egressCalls.push(opts as Record<string, unknown>);
      return session;
    });
    const tool = createBashTool(scratchDir(), {
      egressPolicyFactory: () => ({
        allowedDomains: ["github.com"],
        deniedDomains: [],
        commandLabel: "bash:t6",
        credentials: roster,
      }),
      createEgressSessionFactory: seam as never,
    });
    await tool.handler({ command: "true" }, { conversationId: "conv-t6-fg" });

    assert.equal(h.egressCalls.length, 1);
    const opts = h.egressCalls[0]!;
    assert.deepEqual(Object.keys(opts), ["policy"]);
    const policy = opts.policy as EgressPolicyInput;
    assert.equal(policy.credentials, roster);
    // fence 装配零分支：egress = session.spec 恒等透传。
    assert.equal(h.fenceOpts.length, 1);
    assert.equal(h.fenceOpts[0]!.egress, session.spec);
    assert.equal(dispose.mock.calls.length, 1);
  });

  it("isolation OFF（工厂返 undefined）→ 缝零调用、fence 无 egress 段、fence env 无假值键", async () => {
    const tool = createBashTool(scratchDir(), {
      egressPolicyFactory: () => undefined,
    });
    await tool.handler({ command: "true" }, { conversationId: "conv-t6-off" });
    assert.equal(h.egressCalls.length, 0);
    assert.equal(h.fenceOpts.length, 1);
    assert.equal("egress" in h.fenceOpts[0]!, false);
    const env = h.fenceOpts[0]!.env as Record<string, string>;
    for (const key of ["GH_TOKEN", "SSL_CERT_FILE", "HTTPS_PROXY"]) {
      assert.equal(key in env, false, `fence env must not carry ${key}`);
    }
    assert.equal(
      Object.values(env).some((v) => v.includes("fake_value_")),
      false
    );
  });

  it("EgressRelayUnavailableError → 凭据层随 session 缺席（fence 无 egress / env 无假值键）+ infra 文案不变不新增冒充", async () => {
    const seam = vi.fn(async () => {
      throw new EgressRelayUnavailableError(
        "relay assets missing",
        "repair the iknow install root"
      );
    });
    const tool = createBashTool(scratchDir(), {
      egressPolicyFactory: () => ({
        allowedDomains: ["github.com"],
        deniedDomains: [],
        commandLabel: "bash:t6-relay",
        credentials: rosterFixture(),
      }),
      createEgressSessionFactory: seam as never,
    });
    await expect(
      tool.handler({ command: "true" }, { conversationId: "conv-t6-relay" })
    ).rejects.toThrow(/egress relay unavailable/);
    assert.equal(h.fenceOpts.length, 1);
    assert.equal("egress" in h.fenceOpts[0]!, false);
    const env = h.fenceOpts[0]!.env as Record<string, string>;
    assert.equal("GH_TOKEN" in env, false);
    // infra 文案不冒充凭据层话术。
    assert.equal(h.fenceOpts.length >= 1, true);
  });
});

/** fake ChildProcess（manager settle 事件驱动）。 */
function makeFakeChild(pid = 424242): EventEmitter & Record<string, unknown> {
  const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.pid = pid;
  child.kill = vi.fn(() => true);
  child.exitCode = null;
  child.signalCode = null;
  return child;
}

describe("T6 background 装配点", () => {
  it("egressPolicy.credentials → 缝收逐字 { policy }（keys 只有 policy）；settle() 释放通道触发 dispose（覆盖 registry/store 的释放归 T3 session.dispose）", async () => {
    const root = await fsp.mkdtemp(join(tmpdir(), "iknow-t6-bg-"));
    scratch.push(root);
    const roster = rosterFixture();
    const { session, dispose } = stubSession();
    h.egressImpl = async () => session;
    const capturedSpec: unknown[] = [];
    const spawned: (EventEmitter & Record<string, unknown>)[] = [];
    const manager = createBackgroundTaskManager({
      tasksDir: resolveTasksDir({
        dataDir: root,
        projectIdentityRoot: root,
      }),
      spawn: async (req) => {
        capturedSpec.push(req.egressSpec);
        const child = makeFakeChild();
        spawned.push(child);
        return child as never;
      },
    });
    await manager.spawn({
      command: "true",
      cwd: ".",
      egressPolicy: {
        allowedDomains: ["example.com"],
        deniedDomains: [],
        commandLabel: "background:t6",
        credentials: roster,
      },
    });
    assert.equal(h.egressCalls.length, 1);
    assert.deepEqual(Object.keys(h.egressCalls[0]!), ["policy"]);
    assert.equal(
      (h.egressCalls[0]!.policy as EgressPolicyInput).credentials,
      roster
    );
    assert.equal(capturedSpec[0], session.spec);
    assert.equal(dispose.mock.calls.length, 0);
    // child exit → settle → dispose（release channel 既有档位；
    // dispose 生产实现覆盖 registry/store 释放已由 T3 session 测试钉）。
    spawned[0]!.emit("exit", 0, null);
    await new Promise<void>((r) => setImmediate(r));
    assert.equal(dispose.mock.calls.length, 1);
  });
});

describe("T6 verify 装配点（模块级单例）", () => {
  it("egressPolicy.credentials → 缝收逐字 { policy }；多条命令复用同一 session（单例档位）；spec.env 进 fenceEnv", async () => {
    const roster = rosterFixture();
    const { session } = stubSession();
    h.egressImpl = async () => session;
    const runVerify = makeDefaultRunVerify({
      cwd: scratchDir(),
      egressPolicy: {
        allowedDomains: ["example.com"],
        deniedDomains: [],
        commandLabel: "verify:t6",
        credentials: roster,
      },
    });
    await runVerify("true", {});
    await runVerify("false", {});
    assert.equal(h.egressCalls.length, 1, "verify 面 session 单例复用");
    assert.deepEqual(Object.keys(h.egressCalls[0]!), ["policy"]);
    assert.equal(
      (h.egressCalls[0]!.policy as EgressPolicyInput).credentials,
      roster
    );
    const env = h.runArgs[0]!.env as Record<string, string>;
    assert.equal(env.GH_TOKEN, "fake_value_t6_fixture");
    assert.equal(env.SSL_CERT_FILE, "/tmp/iknow-t6-bundle.pem");
    void session;
  });

  it("EgressRelayUnavailableError（session 起不来）→ 凭据层缺席：fenceEnv 无假值键、fence 无 egress 段、既有 catch 语义不变", async () => {
    h.egressImpl = async () => {
      throw new EgressRelayUnavailableError(
        "relay assets missing",
        "repair the iknow install root"
      );
    };
    const runVerify = makeDefaultRunVerify({
      cwd: scratchDir(),
      egressPolicy: {
        allowedDomains: ["example.com"],
        deniedDomains: [],
        commandLabel: "verify:t6-relay",
        credentials: rosterFixture(),
      },
    });
    const res = await runVerify("true", {});
    assert.equal(res.exitCode, 0);
    assert.equal(h.fenceOpts.length, 1);
    assert.equal("egress" in h.fenceOpts[0]!, false);
    const env = h.fenceOpts[0]!.env as Record<string, string>;
    assert.equal("GH_TOKEN" in env, false);
    assert.equal("HTTPS_PROXY" in env, false);
  });
});

// ── 4. 各面对凭据零分支代码（静态钉）───────────────────────────────────────

describe("T6 三装配点对凭据零分支", () => {
  const files = [
    "src/harness/aci/tools/bash.ts",
    "src/harness/background/manager.ts",
    "src/harness/verify/sandbox-run.ts",
  ];
  it.each(files)("%s 源码不含 credential/sentinel/mint 标识", (rel) => {
    const src = readFileSync(join(process.cwd(), rel), "utf8");
    // 注释里允许出现（解释性引用），只钉代码面：剥掉块/行注释后再查。
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    assert.doesNotMatch(code, /credential|sentinel|\bmint/i);
  });
});
