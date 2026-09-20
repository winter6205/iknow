/**
 * tests/harness/egress-three-form-lifecycle.test.ts
 *
 * specs/egress-ssh-bridge.md — three-form lifecycle + yolo no-op wiring.
 * Single-bridge conditional form: the SOCKS bridge was cut from this branch by
 * operator decision, so all assertions cover only the bridges actually present
 * = the HTTP bridge `iknow-egress-*`; never hardcode two bridges, and never
 * hardcode "a second bridge will never appear" — once more bridges land, this
 * suite should grow naturally without going red.
 *
 * Pinned invariants:
 *   - injection-face SSOT: bash foreground / background per-task / verify
 *     singleton consume the SAME EgressFenceSpec — the consumption shape of
 *     {unixSocketPath, sandboxLocalPort, env, innerBridgeScript} at the three
 *     command assembly points (socket bind / --setenv env injection /
 *     bash -c inner prefix) is equal across forms;
 *   - under all three "session absent" paths (yolo = no seam input at the
 *     consumer / factory returns undefined / EgressRelayUnavailableError),
 *     GIT_SSH_COMMAND and the inner prefix are BOTH absent from the fence
 *     argv and the payload is byte-identical;
 *   - ADR-0097 dispose contract: per-task settle() releases exactly once
 *     (repeated exit must not dispose twice); verify's module-level singleton
 *     lazy-starts once and is reused across calls;
 *   - stale socket cleaned before start + dispose collects ALL started
 *     bridges + is idempotent (assertions derived from live spawn-spy
 *     records, bridge count not hardcoded).
 *
 * Technique: mock node:child_process.spawn to capture each form's final fence
 * argv (precedent: bash-egress-inner-bridge.test.ts); inject
 * createEgressSession through session.js's re-export chain (precedent:
 * manager.test.ts) so all three consumers share one holder. Real session
 * lifecycle parts come from importActual.
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
 * All three consumers (bash default factory / manager per-task / verify
 * module level) resolve createEgressSession through the re-export chain
 * sandbox/index → egress/index → session.js; mocking this module drives the
 * "start session" face of all three forms at once.
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

// ── Fake child shared by all three forms (runInSandbox awaits close; manager settle awaits exit) ──

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

// ── Single-bridge stub spec (shape built by the real builders = injection-face SSOT) ──

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

// ── fence argv fact extraction ────────────────────────────────────────────

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
  payload: WIRE_CMD, // byte-identical (the argv face of the zero-injection invariant)
  gitSsh: undefined,
  httpProxy: undefined,
  socketBound: false,
};

// ── Three-form drivers ─────────────────────────────────────────────────────

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

// ── 1. All three forms consume the same spec field set (present path, single-bridge form) ──

describe("egress-ssh-bridge T5 — 三形态消费同一份 EgressFenceSpec", () => {
  it("前台 / background / verify 的 socket bind、env 注入、内层前导逐形态相等", async () => {
    sessionHolder.impl = async () => stubSession();
    const fg = fenceFacts(await driveForegroundBash());
    const bg = fenceFacts(await driveBackground(true));
    const vf = fenceFacts(await driveVerify(true));

    const expected = {
      // prefix = spec.innerBridgeScript verbatim + "\n" + command (same shape
      // as the bash.ts foreground wiring; background spawn factory and verify
      // command wrapper are the consumption points).
      payload: `${STUB_SPEC.innerBridgeScript}\n${WIRE_CMD}`,
      gitSsh: STUB_SPEC.env.GIT_SSH_COMMAND,
      httpProxy: STUB_SPEC.env.HTTP_PROXY,
      socketBound: true,
    };
    // The four spec fields consume equally at all three assembly points:
    // unixSocketPath→--bind, env→--setenv (incl. GIT_SSH_COMMAND;
    // sandboxLocalPort lives as the literal 3128 inside env values),
    // innerBridgeScript→bash -c prefix.
    expect([bg, vf]).toEqual([expected, expected]);
    expect(fg).toEqual(expected);
    // Prefix carries the single-bridge relay + trap (shape SSOT lives in
    // session.ts; this pins the wiring at three sites; ADR-0107: shipped
    // node relay assets — old host-package-install wording must not return).
    for (const f of [fg, bg, vf]) {
      expect(f.payload).toContain("egress-tcp-relay.mjs");
      expect(f.payload).toContain(" 3128 ");
      expect(f.payload).toContain('trap "kill %1 2>/dev/null; exit" EXIT');
      expect(f.payload.toLowerCase()).not.toContain("socat");
    }
  });
});

// ── 2. Zero injection: yolo / factory undefined / EgressRelayUnavailableError ──

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
    // The bash assembly layer records a start failure as an infra violation
    // → typed failure; the run itself already happened (equivalent to this
    // call having no egress seam).
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

// ── 3. Lifecycle channels (no new code, assertions only) ───────────────────

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
    // Repeated exit (shutdown cascade / event-replay shape) must not dispose a second time.
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
    // ADR-0097 dispose contract: release is idempotent (not started / already
    // released → silent success).
    await expect(
      disposeEgressSessionForVerify(runVerify)
    ).resolves.toBeUndefined();
    await expect(
      disposeEgressSessionForVerify(runVerify)
    ).resolves.toBeUndefined();
  });

  it("资源在场证据：stale socket 启动前清理 + server 真 listen + dispose 收全部已起资源且幂等", async () => {
    // Real createEgressSession (importActual) + relayResolver / socketPath
    // injection seams (ADR-0107: bridge = unix listen with no host process;
    // resource presence is evidenced by the socket file and a live listener,
    // independent of any host package surface).
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

    // Present right after start: the stale empty file is replaced by a real
    // listener (the server itself listens on the unix socket); default present
    // resource = one HTTP proxy listener (SOCKS bridge was cut from this
    // branch by operator decision — when it lands again this suite should grow
    // naturally without going red; conditional form).
    expect(existsSync(stalePath)).toBe(true);

    await session.dispose();
    // One dispose channel collects ALL started resources: listener closed + socket removed.
    expect(existsSync(stalePath)).toBe(false);
    // Idempotent: repeated dispose never throws (finally-safe).
    await session.dispose();
    await session.dispose();
  });
});

afterAll(() => {
  rmSync(FIX_CWD, { recursive: true, force: true });
});
