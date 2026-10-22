/**
 * tests/tui/hub-bridge-live-background-tasks.test.ts (bun:test)
 *
 * The background-task source of the `/quit` busy set: the bridge member
 * `listLiveBackgroundTasks`. TUI engine rebuilds can leave a task live on an
 * earlier manager, so the host projection must retain every manager until the
 * manager shutdown reaps its tasks.
 *
 * Acceptance:
 *  - live rows from initial and rebuilt managers, all conversations (the busy
 *    set joins them by conversation_id itself);
 *  - no manager wired -> empty, never a throw;
 *  - manager registration is identity-deduplicated and live rows are read at
 *    CALL time, so finished tasks disappear on the next read.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import {
  createInflightRegistry,
  createTuiBridge,
} from "../../src/tui/hub-bridge.js";
import { buildTuiDeps } from "../../src/tui/deps.js";
import { createNoAskUser } from "../../src/harness/permission/ask-user.js";
import { createBackgroundTaskManager } from "../../src/harness/background/manager.js";
import type { RuntimeBundle } from "../../src/cli/runtime.js";
import type { IknowEnv } from "../../src/config/env.js";
import type { BackgroundTaskManager } from "../../src/harness/background/manager.js";
import { planQuitBusy, quitBusyNoticeLines } from "../../src/tui/quit-busy.js";
import { createQuitBackgroundTasks } from "../../src/tui/quit-background-tasks.js";
import { makeDeps } from "../cli/_fixtures.js";

class FakeBackgroundChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();

  constructor(readonly pid: number) {
    super();
  }

  kill(): boolean {
    return true;
  }
}

function managerWithFakeChild(tasksDir: string): {
  readonly manager: BackgroundTaskManager;
  readonly child: FakeBackgroundChild;
} {
  const child = new FakeBackgroundChild(2_000_000_000);
  const manager = createBackgroundTaskManager({
    tasksDir,
    spawn: async () => child as unknown as ChildProcess,
  });
  return { manager, child };
}

async function spawnLiveTask(
  manager: BackgroundTaskManager,
  conversationId: string
): Promise<{ readonly task_id: string; readonly log_path: string }> {
  const result = await manager.spawn({
    command: "synthetic background task",
    cwd: baseDir,
    conversationId,
  });
  expect(result.status).toBe("ok");
  if (result.status !== "ok") throw result.error;
  return result;
}

async function waitForPersistedStatus(
  logPath: string,
  expectedStatus: string
): Promise<void> {
  const recordPath = logPath.replace(/\.log$/, ".json");
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const record = JSON.parse(await readFile(recordPath, "utf8")) as {
        status?: unknown;
      };
      if (record.status === expectedStatus) return;
    } catch (error) {
      const isExpectedReadRace =
        error instanceof SyntaxError ||
        (typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "ENOENT");
      if (!isExpectedReadRace) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`background record did not reach ${expectedStatus}`);
}

/** Minimal valid RuntimeBundle (same fixture shape as deps-max-turns.test.ts). */
function makeBundle(): RuntimeBundle {
  const env: IknowEnv = {
    llm: {
      baseUrl: "http://127.0.0.1:9999",
      model: "test-model",
      fallback: [],
      apiKey: "sk-test-sentinel-tui",
      maxOutputTokens: 1024,
      timeoutMs: 60_000,
      temperature: 0,
      thinking: "off",
      thinkingEffort: "",
      stream: "on",
    },
    chat: { showThinking: false },
    web: { searchUrl: undefined, proxy: undefined },
    compress: { contextWindow: 200_000, thresholdTokens: undefined },
    mcp: { connectTimeoutMs: 60_000 },
    subagent: { taskTimeoutMs: undefined },
    workspaceRoot: undefined,
    productRoot: undefined,
  };
  return { env } as unknown as RuntimeBundle;
}

let baseDir = "";

beforeEach(async () => {
  baseDir = await mkdtemp(join(tmpdir(), "iknow-tui-live-bg-"));
});

afterEach(async () => {
  await rm(baseDir, { recursive: true, force: true });
});

function bridgeWith(
  listLiveBackgroundTasks?: () => ReturnType<
    BackgroundTaskManager["listLiveTasks"]
  >
): ReturnType<typeof createTuiBridge> {
  return createTuiBridge({
    dataDir: baseDir,
    workspaceRoot: baseDir,
    deps: makeDeps([]),
    inflight: createInflightRegistry(),
    ...(listLiveBackgroundTasks ? { listLiveBackgroundTasks } : {}),
  });
}

describe("TuiBridge.listLiveBackgroundTasks", () => {
  test("missing manager sources return an empty list", () => {
    const bridge = bridgeWith();
    expect(bridge.listLiveBackgroundTasks()).toEqual([]);

    const source = createQuitBackgroundTasks();
    source.register(undefined);
    expect(source.listLiveTasks()).toEqual([]);
    expect(
      bridgeWith(() => source.listLiveTasks()).listLiveBackgroundTasks()
    ).toEqual([]);
  });

  test("an initial-root task still triggers quit confirmation after a rebuild", async () => {
    const source = createQuitBackgroundTasks();
    const startup = managerWithFakeChild(join(baseDir, "startup-tasks"));
    const rebuilt = managerWithFakeChild(join(baseDir, "worktree-tasks"));
    const startupTask = await spawnLiveTask(startup.manager, "conv-startup");
    const rebuiltTask = await spawnLiveTask(rebuilt.manager, "conv-worktree");

    source.register(startup.manager);
    source.register(rebuilt.manager);
    source.register(rebuilt.manager);
    const bridge = bridgeWith(() => source.listLiveTasks());
    const liveRows = bridge.listLiveBackgroundTasks();

    expect(liveRows).toEqual([
      { task_id: startupTask.task_id, conversation_id: "conv-startup" },
      { task_id: rebuiltTask.task_id, conversation_id: "conv-worktree" },
    ]);
    const plan = planQuitBusy({
      sessions: {
        startup: { conversationId: "conv-startup", runState: "idle" },
        worktree: { conversationId: "conv-worktree", runState: "idle" },
      },
      inflightTurns: new Map(),
      liveBackgroundTasks: liveRows,
      subagents: [],
    });
    expect(plan.needsSecondConfirm).toBe(true);
    expect(plan.hasStoppableWork).toBe(true);
    expect(quitBusyNoticeLines(plan.hasStoppableWork)[0]).toContain(
      "存在后台任务或子代理仍在运行"
    );

    startup.child.emit("exit", 0, null);
    expect(bridge.listLiveBackgroundTasks()).toEqual([
      { task_id: rebuiltTask.task_id, conversation_id: "conv-worktree" },
    ]);
    await waitForPersistedStatus(startupTask.log_path, "exited");

    rebuilt.child.emit("exit", 0, null);
    expect(bridge.listLiveBackgroundTasks()).toEqual([]);
    await waitForPersistedStatus(rebuiltTask.log_path, "exited");
  });

  test("manager read failures propagate without returning partial rows", () => {
    const source = createQuitBackgroundTasks();
    const failure = new Error("manager read failed");
    source.register({
      listLiveTasks: () => [],
    } as unknown as BackgroundTaskManager);
    source.register({
      listLiveTasks: () => {
        throw failure;
      },
    } as unknown as BackgroundTaskManager);

    expect(() => source.listLiveTasks()).toThrow(failure);
  });
});

test("a cancelled background receipt still triggers quit confirmation while its task is live", () => {
  const root = mkdtempSync(join(tmpdir(), "iknow-tui-quit-receipt-"));
  const home = join(root, "home");
  const work = join(root, "work");
  mkdirSync(home, { recursive: true });
  mkdirSync(work, { recursive: true });
  try {
    const result = spawnSync(
      process.execPath,
      [
        join(import.meta.dirname, "fixtures", "quit-background-receipt.ts"),
        root,
      ],
      {
        cwd: work,
        env: {
          PATH: process.env.PATH ?? "",
          HOME: home,
          XDG_CONFIG_HOME: join(home, ".config"),
          TMPDIR: root,
        },
        encoding: "utf8",
        timeout: 15_000,
        maxBuffer: 32 * 1024,
      }
    );
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("quit-background-receipt:ok");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 20_000);

describe("run.tsx registers engine managers with the quit projection", () => {
  const runSrc = readFileSync(
    join(import.meta.dirname, "..", "..", "src", "tui", "run.tsx"),
    "utf8"
  );

  test("the startup manager is registered and the bridge receives the projection", () => {
    expect(runSrc).toMatch(
      /import \{ createQuitBackgroundTasks \} from "\.\/quit-background-tasks\.js";/
    );
    const startupIdx = runSrc.indexOf(
      "} = await buildTuiDeps(bundle, depsOpts);"
    );
    expect(startupIdx).toBeGreaterThanOrEqual(0);
    expect(
      runSrc
        .slice(runSrc.lastIndexOf("const {", startupIdx), startupIdx)
        .match(/\n\s+backgroundManager,/)
    ).not.toBeNull();
    const startupRegisterIdx = runSrc.indexOf(
      "quitBackgroundTasks.register(backgroundManager);",
      startupIdx
    );
    expect(startupRegisterIdx).toBeGreaterThan(startupIdx);

    const bridgeIdx = runSrc.indexOf("const bridge = createTuiBridge({");
    expect(bridgeIdx).toBeGreaterThanOrEqual(0);
    // Pin the terminator: an unfound block end would let the slice swallow the
    // rest of the file and any later backgroundManager satisfy the match.
    const bridgeEnd = runSrc.indexOf("\n    });", bridgeIdx);
    expect(bridgeEnd).toBeGreaterThan(bridgeIdx);
    const bridgeBlock = runSrc.slice(bridgeIdx, bridgeEnd);
    expect(bridgeBlock).toMatch(
      /listLiveBackgroundTasks: \(\) => quitBackgroundTasks\.listLiveTasks\(\)/
    );
  });

  test("rebuild managers register without entering the hub bundle", () => {
    const seamIdx = runSrc.indexOf("buildEngine: async (root) => {");
    expect(seamIdx).toBeGreaterThanOrEqual(0);
    const seamEnd = runSrc.indexOf("\n      },", seamIdx);
    expect(seamEnd).toBeGreaterThan(seamIdx);
    const seam = runSrc.slice(seamIdx, seamEnd);
    expect(seam).toMatch(/backgroundManager: bgm,/);
    expect(seam).toMatch(/quitBackgroundTasks\.register\(bgm\);/);
    const returnIdx = seam.indexOf("return {");
    expect(returnIdx).toBeGreaterThanOrEqual(0);
    expect(seam.slice(returnIdx)).not.toMatch(/backgroundManager/);
  });
});

/**
 * The other half of the route: the assembly layer has to hand the manager over
 * at all. `buildHarnessEngine` built it and `buildTuiDeps` dropped it on the
 * floor, which is what left the busy set blind to a live `sleep`.
 */
describe("buildTuiDeps 把引擎的 backgroundManager 交给 host", () => {
  test("扁平结果带 handle，listLiveTasks 可用，bridge 读得到", async () => {
    const built = await buildTuiDeps(makeBundle(), {
      askUser: createNoAskUser(),
      userHome: join(baseDir, "home"),
      cwd: baseDir,
      dataDir: baseDir,
    });
    try {
      expect(typeof built.backgroundManager?.listLiveTasks).toBe("function");
      expect(built.backgroundManager?.listLiveTasks()).toEqual([]);
      expect(
        bridgeWith(
          () => built.backgroundManager?.listLiveTasks() ?? []
        ).listLiveBackgroundTasks()
      ).toEqual([]);
    } finally {
      if (built.shutdown) await built.shutdown();
    }
  });
});
