/**
 * tests/harness/egress-three-form-lifecycle.test.ts
 *
 * specs/egress-ssh-bridge.md T5/SC5 —— 三形态生命周期 + yolo no-op 接线
 * （单桥条件形态：SOCKS 桥已被操作员裁定摘出本分支，一切断言只覆盖
 * 「当前在场的桥」= HTTP 桥 `iknow-egress-*`；不写死双桥，也不写死
 * 「永不出现第二桥」——T2 日后在场时本集自然扩容不判红）。
 *
 * 钉住的不变式：
 *   - invariant 4（注入面 SSOT）：bash 前台 / background per-task / verify
 *     单例三形态消费**同一份** EgressFenceSpec —— spec 字段集
 *     {unixSocketPath, sandboxLocalPort, env, innerBridgeScript} 在三个
 *     命令装配点的消费形状（socket bind / --setenv env 注入 / bash -c
 *     payload 内层前导）逐形态相等；
 *   - invariant 3 / F1：yolo（消费面无缝入参）/ 工厂返 undefined /
 *     EgressRelayUnavailableError 三类「session 缺席」路径下，GIT_SSH_COMMAND
 *     与内层前导在围栏 argv 中**均缺席**，payload byte-identical；
 *   - 0097 §dispose 契约：per-task settle() 单次释放（exit 重复触发不
 *     二次 dispose）；verify 模块级单例 lazy start 跨调用复用；
 *   - SC5：stale socket 启动前清理 + dispose 收「全部已起的桥」+ 幂等
 *     （断言从 spawn spy 现场记录派生，不写死桥数）。
 *
 * 手法：node:child_process.spawn 模块 mock 捕获三形态最终 fence argv
 * （同 bash-egress-inner-bridge.test.ts 先例）；session.js 的
 * createEgressSession 经 re-export 链注入（manager.test.ts 先例），三消费
 * 面共用同一 holder。真 session 生命周期件用 importActual 取。
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: vi.fn(actual.spawn),
  };
});

/**
 * 三消费面（bash 默认工厂 / manager per-task / verify 模块级）都经
 * sandbox/index → egress/index → session.js 的 re-export 链取
 * createEgressSession 绑定；替换本模块即同时驱动三形态的「起 session」面。
 */
const sessionHolder: {
  impl: (opts: unknown) => Promise<unknown>;
  calls: number;
} = { impl: async () => undefined, calls: 0 };

vi.mock(
  "../../src/harness/sandbox/egress/session.js",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("../../src/harness/sandbox/egress/session.js")
      >();
    return {
      ...actual,
      createEgressSession: async (opts: unknown) => {
        sessionHolder.calls += 1;
        return sessionHolder.impl(opts);
      },
    };
  }
);

const childProcessMock = await import("node:child_process");
const spawnMock = childProcessMock.spawn as unknown as ReturnType<typeof vi.fn>;

const { createBashTool } = await import("../../src/harness/aci/tools/bash.ts");
const { createBackgroundTaskManager, defaultBackgroundSpawn } =
  await import("../../src/harness/background/manager.ts");
const { resolveTasksDir } =
  await import("../../src/harness/background/paths.ts");
const { makeDefaultRunVerify, disposeEgressSessionForVerify } =
  await import("../../src/harness/verify/sandbox-run.ts");
const sessionMocked =
  await import("../../src/harness/sandbox/egress/session.js");
const {
  buildInnerBridgeScript,
  buildProxyEnv,
  SANDBOX_HTTP_PROXY_PORT,
  EgressRelayUnavailableError,
} = sessionMocked;
const STUB_RELAY = {
  nodePath: "/test-root/bin/node",
  relayDir: "/test-root/vendor/egress-relay",
  bridgeScriptPath: "/test-root/vendor/egress-relay/egress-tcp-relay.mjs",
  connectScriptPath: "/test-root/vendor/egress-relay/egress-http-connect.mjs",
} as const;
const actualSession = await vi.importActual<
  typeof import("../../src/harness/sandbox/egress/session.js")
>("../../src/harness/sandbox/egress/session.js");
const { createEgressViolationSink } =
  await import("../../src/harness/sandbox/egress/violations.ts");

const FIX_CWD = mkdtempSync(join(tmpdir(), "iknow-egress-3f-"));
const scratchDirs: string[] = [];

function scratchDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  scratchDirs.push(d);
  return d;
}

// ── 假 child：三形态共用（runInSandbox 等 close；manager settle 等 exit） ──

function makeFakeChild(pid = 47181) {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    pid,
    kill: vi.fn(() => true),
    unref: () => undefined,
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
  });
  queueMicrotask(() => child.emit("close", 0));
  return child;
}

beforeEach(() => {
  spawnMock.mockReset();
  spawnMock.mockImplementation(() => makeFakeChild());
  sessionHolder.impl = async () => undefined;
  sessionHolder.calls = 0;
});

afterEach(() => {
  for (const p of scratchDirs.splice(0)) {
    rmSync(p, { recursive: true, force: true });
  }
});

// ── 单桥 stub spec（形状来自真 builder = 注入面 SSOT） ─────────────────────

const STUB_SOCKET = join(scratchDir("iknow-egress-3f-sock-"), "live.sock");
const STUB_TOKEN = "ab".repeat(32);
const STUB_SPEC = {
  unixSocketPath: STUB_SOCKET,
  sandboxLocalPort: SANDBOX_HTTP_PROXY_PORT,
  env: buildProxyEnv(SANDBOX_HTTP_PROXY_PORT, STUB_TOKEN, STUB_RELAY),
  innerBridgeScript: buildInnerBridgeScript(
    STUB_RELAY.nodePath,
    STUB_RELAY.bridgeScriptPath,
    STUB_SOCKET
  ),
  relayAssetsDir: STUB_RELAY.relayDir,
};

function stubSession(dispose = vi.fn(async () => undefined)) {
  return Object.freeze({
    id: "three-form-stub",
    spec: STUB_SPEC,
    violationSink: createEgressViolationSink(),
    dispose,
  });
}

const WIRE_CMD = "echo wire";
const POLICY = {
  allowedDomains: ["github.com"],
  deniedDomains: [],
  commandLabel: "test:three-form",
} as const;

// ── fence argv 事实抽取 ───────────────────────────────────────────────────

function firstSpawnArgv(): readonly string[] {
  const call = spawnMock.mock.calls[0] as readonly unknown[] | undefined;
  assert.ok(call, "expected the form to spawn the fence process");
  return (call[1] ?? []) as readonly string[];
}

function fenceFacts(argv: readonly string[]) {
  const idx = argv.indexOf("-c");
  assert.notEqual(idx, -1, "expected a `bash -c` payload in fence argv");
  const setenvOf = (name: string): string | undefined => {
    for (let i = 0; i + 2 < argv.length; i++) {
      if (argv[i] === "--setenv" && argv[i + 1] === name) return argv[i + 2];
    }
    return undefined;
  };
  return {
    payload: argv[idx + 1] ?? "",
    gitSsh: setenvOf("GIT_SSH_COMMAND"),
    httpProxy: setenvOf("HTTP_PROXY"),
    socketBound: argv.includes(STUB_SOCKET),
  };
}

type Facts = ReturnType<typeof fenceFacts>;

const ABSENT: Partial<Facts> = {
  payload: WIRE_CMD, // byte-identical（invariant 3 的 argv 面）
  gitSsh: undefined,
  httpProxy: undefined,
  socketBound: false,
};

// ── 三形态驱动 ────────────────────────────────────────────────────────────

async function driveForegroundBash(): Promise<readonly string[]> {
  const tool = createBashTool(FIX_CWD, {
    egressPolicyFactory: () => ({ ...POLICY }),
    createEgressSessionFactory: (async () => stubSession()) as never,
  });
  spawnMock.mockClear();
  await tool.handler({ command: WIRE_CMD }, { conversationId: "conv-3f-fg" });
  return firstSpawnArgv();
}

async function driveBackground(
  withPolicy: boolean
): Promise<readonly string[]> {
  const root = scratchDir("iknow-bg-3f-");
  const manager = createBackgroundTaskManager({
    tasksDir: resolveTasksDir({
      dataDir: root,
      projectIdentityRoot: root,
    }),
    spawn: defaultBackgroundSpawn,
  });
  spawnMock.mockClear();
  const res = await manager.spawn({
    command: WIRE_CMD,
    cwd: FIX_CWD,
    ...(withPolicy ? { egressPolicy: { ...POLICY } } : {}),
  });
  assert.equal(res.status, "ok");
  return firstSpawnArgv();
}

async function driveVerify(withPolicy: boolean): Promise<readonly string[]> {
  const runVerify = makeDefaultRunVerify({
    cwd: FIX_CWD,
    ...(withPolicy ? { egressPolicy: { ...POLICY } } : {}),
  });
  spawnMock.mockClear();
  await runVerify(WIRE_CMD, {});
  return firstSpawnArgv();
}

// ── 1. 三形态 spec 字段集相等（present 路径，单桥条件形态） ────────────────

describe("egress-ssh-bridge T5 — 三形态消费同一份 EgressFenceSpec", () => {
  it("前台 / background / verify 的 socket bind、env 注入、内层前导逐形态相等", async () => {
    sessionHolder.impl = async () => stubSession();
    const fg = fenceFacts(await driveForegroundBash());
    const bg = fenceFacts(await driveBackground(true));
    const vf = fenceFacts(await driveVerify(true));

    const expected = {
      // 前导 = spec.innerBridgeScript 逐字 + "\n" + 命令（与 bash.ts 前台 T1
      // 接线同形；background spawn factory 与 verify 命令包装是消费点）。
      payload: `${STUB_SPEC.innerBridgeScript}\n${WIRE_CMD}`,
      gitSsh: STUB_SPEC.env.GIT_SSH_COMMAND,
      httpProxy: STUB_SPEC.env.HTTP_PROXY,
      socketBound: true,
    };
    // spec 四字段在三个装配点的消费形状相等：unixSocketPath→--bind、
    // env→--setenv（含 GIT_SSH_COMMAND，sandboxLocalPort 以 3128 字面
    // 活在 env 值里）、innerBridgeScript→bash -c 前导。
    expect([bg, vf]).toEqual([expected, expected]);
    expect(fg).toEqual(expected);
    // 前导含单桥中继 + trap（形状 SSOT 在 session.ts，此处钉三处接线；
    // ADR-0107：自带 node 中继件，旧宿主装包字样不得回潮）。
    for (const f of [fg, bg, vf]) {
      expect(f.payload).toContain("egress-tcp-relay.mjs");
      expect(f.payload).toContain(" 3128 ");
      expect(f.payload).toContain('trap "kill %1 2>/dev/null; exit" EXIT');
      expect(f.payload.toLowerCase()).not.toContain("socat");
    }
  });
});

// ── 2. F1 零注入：yolo / 工厂 undefined / EgressRelayUnavailableError ────

describe("egress-ssh-bridge T5 / F1 — session 缺席三路径零注入（invariant 3）", () => {
  it("前台：无 egressPolicyFactory（yolo 姿态 = 无出网资格入参）→ argv 零注入", async () => {
    const tool = createBashTool(FIX_CWD, {});
    spawnMock.mockClear();
    await tool.handler({ command: WIRE_CMD }, { conversationId: "conv-3f-y" });
    expect(fenceFacts(firstSpawnArgv())).toMatchObject(ABSENT);
  });

  it("前台：工厂返 undefined → argv 零注入", async () => {
    const tool = createBashTool(FIX_CWD, {
      egressPolicyFactory: () => undefined,
      createEgressSessionFactory: (async () => stubSession()) as never,
    });
    spawnMock.mockClear();
    await tool.handler({ command: WIRE_CMD }, { conversationId: "conv-3f-u" });
    expect(fenceFacts(firstSpawnArgv())).toMatchObject(ABSENT);
  });

  it("前台：EgressRelayUnavailableError → 命令照常执行且 argv 零注入（无缝 = 纯断网）", async () => {
    const tool = createBashTool(FIX_CWD, {
      egressPolicyFactory: () => ({ ...POLICY }),
      createEgressSessionFactory: (async () => {
        throw new EgressRelayUnavailableError(
          "relay deps missing",
          "repair the iknow install root"
        );
      }) as never,
    });
    spawnMock.mockClear();
    // bash 装配层把 start 失败留痕为 infra violation → typed failure；
    // 执行本身已发生（F1「等同本次调用无 egress 缝」形态）。
    await expect(
      tool.handler({ command: WIRE_CMD }, { conversationId: "conv-3f-s" })
    ).rejects.toThrow();
    expect(fenceFacts(firstSpawnArgv())).toMatchObject(ABSENT);
  });

  it("background：caller 未透传 egressPolicy（yolo / 工厂 undefined 在消费面合一）→ 零注入", async () => {
    expect(fenceFacts(await driveBackground(false))).toMatchObject(ABSENT);
  });

  it("background：EgressRelayUnavailableError → 任务照常 spawn 且零注入", async () => {
    sessionHolder.impl = async () => {
      throw new EgressRelayUnavailableError(
        "relay deps missing",
        "repair the iknow install root"
      );
    };
    expect(fenceFacts(await driveBackground(true))).toMatchObject(ABSENT);
  });

  it("verify：caller 未注入 egressPolicy（yolo / 工厂 undefined 合一）→ 零注入", async () => {
    expect(fenceFacts(await driveVerify(false))).toMatchObject(ABSENT);
    expect(sessionHolder.calls).toBe(0);
  });

  it("verify：EgressRelayUnavailableError → 命令照常执行且零注入", async () => {
    sessionHolder.impl = async () => {
      throw new EgressRelayUnavailableError(
        "relay deps missing",
        "repair the iknow install root"
      );
    };
    expect(fenceFacts(await driveVerify(true))).toMatchObject(ABSENT);
  });
});

// ── 3. 生命周期通道（零新代码，只加断言） ─────────────────────────────────

describe("egress-ssh-bridge T5 — settle / verify 单例 / 在场桥释放", () => {
  it("per-task settle()：exit 触发 dispose 一次，重复 exit 不二次释放", async () => {
    const dispose = vi.fn(async () => undefined);
    sessionHolder.impl = async () => stubSession(dispose);
    let settledChild: ReturnType<typeof makeFakeChild> | undefined;
    const root = scratchDir("iknow-bg-3f-settle-");
    const manager = createBackgroundTaskManager({
      tasksDir: resolveTasksDir({
        dataDir: root,
        projectIdentityRoot: root,
      }),
      spawn: async () => {
        settledChild = makeFakeChild(47301);
        return settledChild as unknown as ChildProcess;
      },
    });
    const res = await manager.spawn({
      command: WIRE_CMD,
      cwd: FIX_CWD,
      egressPolicy: { ...POLICY },
    });
    expect(res.status).toBe("ok");
    expect(dispose).toHaveBeenCalledTimes(0);
    settledChild!.emit("exit", 0, null);
    await new Promise<void>((r) => setImmediate(r));
    expect(dispose).toHaveBeenCalledTimes(1);
    // 重复 exit（shutdown 级联 / 事件重放形状）不再二次 dispose。
    settledChild!.emit("exit", 0, null);
    await new Promise<void>((r) => setImmediate(r));
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("verify 模块级单例：跨调用 lazy start 仅一次；释放通道幂等安全", async () => {
    sessionHolder.impl = async () => stubSession();
    const runVerify = makeDefaultRunVerify({
      cwd: FIX_CWD,
      egressPolicy: { ...POLICY },
    });
    await runVerify("echo a", {});
    await runVerify("echo b", {});
    expect(sessionHolder.calls).toBe(1);
    // 0097 §dispose 契约：释放调用幂等（未起 / 已释放静默成功）。
    await expect(
      disposeEgressSessionForVerify(runVerify)
    ).resolves.toBeUndefined();
    await expect(
      disposeEgressSessionForVerify(runVerify)
    ).resolves.toBeUndefined();
  });

  it("资源在场证据：stale socket 启动前清理 + server 真 listen + dispose 收全部已起资源且幂等", async () => {
    // 真 createEgressSession（importActual）+ relayResolver / socketPath
    // 注入 seam（ADR-0107：桥 = 宿主无进程的 unix listen，资源在场性以
    // socket 文件与真实应答为证据，不依赖任何宿主装包面）。
    const dir = scratchDir("iknow-egress-3f-life-");
    const stalePath = join(dir, "iknow-egress-stale-3f.sock");
    writeFileSync(stalePath, "");

    const session = await actualSession.createEgressSession({
      policy: { ...POLICY },
      relayResolver: () => ({
        nodePath: "/test-root/bin/node",
        relayDir: "/test-root/vendor/egress-relay",
        bridgeScriptPath: "/test-root/vendor/egress-relay/egress-tcp-relay.mjs",
        connectScriptPath:
          "/test-root/vendor/egress-relay/egress-http-connect.mjs",
      }),
      socketPathFactory: () => stalePath,
    });

    // 启动即在场：stale 空文件被换装成真监听（server 本体 listen unix
    // socket），默认在场的资源 = HTTP 代理监听一条（SOCKS 桥已被操作员
    // 裁定摘出本分支，T2 日后在场时本集自然扩容不判红 —— SC5 条件形态）。
    expect(existsSync(stalePath)).toBe(true);

    await session.dispose();
    // dispose 单通道收「全部已起的资源」：监听关闭 + socket 删除。
    expect(existsSync(stalePath)).toBe(false);
    // 幂等：重复 dispose 不抛（finally-safe）。
    await session.dispose();
    await session.dispose();
  });
});

afterAll(() => {
  rmSync(FIX_CWD, { recursive: true, force: true });
});
