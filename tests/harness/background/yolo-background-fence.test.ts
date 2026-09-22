/**
 * ADR-0119 / specs/yolo-mode.md — yolo wiring on the background-spawn face
 * (route 2 of four).
 *
 * Invariants pinned here (Contract §3 / §6):
 *   - `BackgroundSpawnRequest.yolo` (a static value forwarded from the per-call
 *     snapshot in bash.ts) → `defaultBackgroundSpawn` passes yolo to
 *     `createBwrapFence` → the fence argv is bare (`argv[0] = "bash"`); when
 *     absent / false → byte-identical to the baseline bwrap argv;
 *   - yolo ON ⇒ `manager.spawn` starts no egress session (no fence = no netns, so
 *     the proxy seam is meaningless — ADR-0119 ruling 3): `createEgressSession`
 *     is not called and the spawn request carries no `egressSpec`; the control
 *     case proves that the same non-yolo input does start a session and attach a
 *     spec;
 *   - the bash-handler hop itself: `{background:true}` + yolo holder → the
 *     `BackgroundSpawnRequest` handed to the manager carries `yolo: true`, and
 *     that captured request fed into the real `defaultBackgroundSpawn` emits
 *     bare argv (the per-call snapshot → request spread is not just assumed to
 *     forward).
 *
 * Technique: intercept node:child_process (same shape as
 * tests/harness/aci/bash-fence-parity.test.ts) to capture the spawn argv from
 * defaultBackgroundSpawn; createEgressSession is replaced by a module-mock
 * stand-in (same shape as nextCreateEgressImpl in
 * tests/harness/background/manager.test.ts) that counts calls.
 */
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: vi.fn(actual.spawn),
  };
});

// createEgressSession stand-in — counts "was it called while yolo is on". The
// default impl throws so that any accidental real call goes explicitly red
// instead of passing silently.
const egressSessionCalls: unknown[] = [];
vi.mock(
  "../../../src/harness/sandbox/egress/session.js",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("../../../src/harness/sandbox/egress/session.ts")
      >();
    return {
      ...actual,
      createEgressSession: async (opts: unknown) => {
        egressSessionCalls.push(opts);
        return {
          id: "test-egress-session",
          spec: {
            unixSocketPath: "/tmp/iknow-yolo-bg-test.sock",
            sandboxLocalPort: 18080,
            env: { HTTP_PROXY: "http://127.0.0.1:18080" },
          },
          violationSink: { drain: () => [] },
          dispose: async () => undefined,
        };
      },
    };
  }
);

const childProcessMock = await import("node:child_process");
const spawnMock = childProcessMock.spawn as unknown as ReturnType<typeof vi.fn>;

const { defaultBackgroundSpawn, createBackgroundTaskManager } =
  await import("../../../src/harness/background/manager.ts");
const { resolveTasksDir } =
  await import("../../../src/harness/background/paths.ts");
const { promises: fs } = await import("node:fs");
import { createBashTool } from "../../../src/harness/aci/tools/bash.ts";
import { createYoloContext } from "../../../src/harness/sandbox/yolo.ts";
import type {
  BackgroundSpawnRequest,
  BackgroundTaskManager,
} from "../../../src/harness/background/manager.ts";

const TMP = mkdtempSync(join(tmpdir(), "yolo-bg-tmp-"));
const CWD = mkdtempSync(join(tmpdir(), "yolo-bg-cwd-"));

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true });
  rmSync(CWD, { recursive: true, force: true });
});

function makeFakeChild(pid = 99001): ChildProcess {
  const kill = vi.fn(() => true);
  return Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    pid,
    kill,
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
  }) as unknown as ChildProcess;
}

/** Drive the real defaultBackgroundSpawn, capturing argv via the nodeSpawn intercept. */
async function backgroundArgv(opts: {
  readonly yolo?: boolean;
}): Promise<readonly string[]> {
  spawnMock.mockImplementation(() => makeFakeChild());
  await defaultBackgroundSpawn({
    command: "echo hi",
    cwd: CWD,
    env: { PATH: "/bin" },
    tmpDir: TMP,
    ...(opts.yolo !== undefined ? { yolo: opts.yolo } : {}),
  });
  const call = spawnMock.mock.calls[0];
  expect(call).toBeDefined();
  // spawn(cmd, args, opts) — argv = [cmd, ...args]
  const argv = [call?.[0] as string, ...(call?.[1] as readonly string[])];
  spawnMock.mockClear();
  return argv;
}

afterEach(() => {
  spawnMock.mockReset();
  egressSessionCalls.length = 0;
});

describe("background spawn face — yolo wiring (ADR-0119)", () => {
  it("yolo true → bare fence argv (argv[0] = bash)", async () => {
    const argv = await backgroundArgv({ yolo: true });
    expect(argv).toEqual(["bash", "-c", "echo hi"]);
  });

  it("yolo absent → baseline bwrap argv (argv[0] = bwrap); yolo:false is byte-identical", async () => {
    const baseline = await backgroundArgv({});
    expect(baseline[0]).toBe("bwrap");
    expect(baseline).toContain("--unshare-net");
    const withFalse = await backgroundArgv({ yolo: false });
    expect(withFalse).toEqual(baseline);
  });

  it("manager.spawn: yolo true with an egressPolicy present → no egress session, request has no egressSpec", async () => {
    const root = await fs.mkdtemp(join(tmpdir(), "iknow-yolo-bg-"));
    const capturedReqs: Record<string, unknown>[] = [];
    const manager = createBackgroundTaskManager({
      tasksDir: resolveTasksDir({ dataDir: root, projectIdentityRoot: root }),
      spawn: async (req) => {
        capturedReqs.push(req as unknown as Record<string, unknown>);
        return makeFakeChild(98001);
      },
    });
    const res = await manager.spawn({
      command: "true",
      cwd: CWD,
      tmpDir: TMP,
      yolo: true,
      egressPolicy: {
        allowedDomains: ["example.com"],
        deniedDomains: [],
        commandLabel: "bash:yolo-bg",
      },
    });
    expect(res.status).toBe("ok");
    expect(egressSessionCalls).toHaveLength(0);
    expect(capturedReqs).toHaveLength(1);
    expect(capturedReqs[0]!.egressSpec).toBeUndefined();
    expect(capturedReqs[0]!.yolo).toBe(true);
    await fs.rm(root, { recursive: true, force: true });
  });

  it("control case: non-yolo with an egressPolicy present → createEgressSession called once, request carries egressSpec", async () => {
    const root = await fs.mkdtemp(join(tmpdir(), "iknow-yolo-bg-ctl-"));
    const capturedReqs: Record<string, unknown>[] = [];
    const manager = createBackgroundTaskManager({
      tasksDir: resolveTasksDir({ dataDir: root, projectIdentityRoot: root }),
      spawn: async (req) => {
        capturedReqs.push(req as unknown as Record<string, unknown>);
        return makeFakeChild(98002);
      },
    });
    await manager.spawn({
      command: "true",
      cwd: CWD,
      tmpDir: TMP,
      egressPolicy: {
        allowedDomains: ["example.com"],
        deniedDomains: [],
        commandLabel: "bash:non-yolo-bg",
      },
    });
    expect(egressSessionCalls).toHaveLength(1);
    expect(capturedReqs[0]!.egressSpec).toBeDefined();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("handler hop: bash {background:true} + yolo holder → request carries yolo:true → the real defaultBackgroundSpawn emits bare argv", async () => {
    const captured: BackgroundSpawnRequest[] = [];
    const manager = {
      spawn: async (req: BackgroundSpawnRequest) => {
        captured.push(req);
        return {
          status: "ok",
          task_id: "bg-yolo-hop",
          log_path: join(TMP, "bg-yolo-hop.log"),
        };
      },
    } as unknown as BackgroundTaskManager;
    // yolo ON at construction skips requireBwrap (bash.ts assembly gate), so
    // this case is bwrap-free-host safe like the rest of this file.
    const tool = createBashTool(CWD, {
      tmpDir: TMP,
      yolo: createYoloContext(true),
      backgroundManager: manager,
    });
    const receipt = (await tool.handler(
      { command: "echo hi", background: true },
      { conversationId: "yolo-bg-hop" }
    )) as { task_id: string };
    expect(receipt.task_id).toBe("bg-yolo-hop");
    expect(captured).toHaveLength(1);
    expect(captured[0]!.yolo).toBe(true);

    // Feed the handler-captured request into the real spawn face: the whole
    // hop (per-call snapshot → request spread → fence factory) yields bare
    // argv, not just the request field.
    spawnMock.mockImplementation(() => makeFakeChild());
    await defaultBackgroundSpawn(captured[0]!);
    const call = spawnMock.mock.calls[0];
    expect(call).toBeDefined();
    const argv = [call?.[0] as string, ...(call?.[1] as readonly string[])];
    expect(argv).toEqual(["bash", "-c", "echo hi"]);
    spawnMock.mockClear();
  });
});
