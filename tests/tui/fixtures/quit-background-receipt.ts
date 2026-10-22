import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { createAciExecutor } from "../../../src/harness/aci/aci-executor.js";
import { createBashTool } from "../../../src/harness/aci/tools/bash.js";
import { createBackgroundTaskManager } from "../../../src/harness/background/manager.js";
import { resolveTasksDir } from "../../../src/harness/background/paths.js";
import type {
  Executor,
  ToolCall,
  ToolExecutionResult,
} from "../../../src/harness/tools/types.js";
import {
  createInflightRegistry,
  createTuiBridge,
} from "../../../src/tui/hub-bridge.js";
import { planQuitBusy } from "../../../src/tui/quit-busy.js";
import { createQuitBackgroundTasks } from "../../../src/tui/quit-background-tasks.js";
import { makeDeps } from "../../cli/_fixtures.js";

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

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

interface PendingHandler {
  promise?: Promise<unknown>;
}

interface BackgroundTaskReceipt {
  readonly task_id: string;
  readonly log_path: string;
}

function createBashExecutor(
  bash: ReturnType<typeof createBashTool>,
  pending: PendingHandler
): Executor {
  return Object.freeze({
    executeAll: async (
      calls: ReadonlyArray<ToolCall>,
      signal?: AbortSignal,
      _timeoutMs?: number,
      conversationId?: string
    ): Promise<ReadonlyArray<ToolExecutionResult>> => {
      const call = calls[0]!;
      const handler = Promise.resolve(
        bash.handler(call.input, { signal, conversationId })
      );
      pending.promise = handler;
      const payload = await handler;
      return [
        {
          kind: "ok",
          toolUseId: call.id,
          payload: [
            {
              type: "text",
              text:
                typeof payload === "string" ? payload : JSON.stringify(payload),
            },
          ],
        },
      ];
    },
  });
}

async function waitForPersistedExit(logPath: string): Promise<void> {
  const recordPath = logPath.replace(/\.log$/, ".json");
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const record = JSON.parse(await readFile(recordPath, "utf8")) as {
        status?: unknown;
      };
      if (record.status === "exited") return;
    } catch (error) {
      const expectedRace =
        error instanceof SyntaxError ||
        (typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "ENOENT");
      if (!expectedRace) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("background record did not reach exited");
}

interface BackgroundRun {
  readonly manager: ReturnType<typeof createBackgroundTaskManager>;
  readonly child: FakeBackgroundChild;
  readonly spawnEntered: Promise<void>;
  readonly releaseSpawn: () => void;
  readonly caller: AbortController;
  readonly execution: Promise<ReadonlyArray<ToolExecutionResult>>;
  readonly pendingHandler: PendingHandler;
}

function createBackgroundRun(
  root: string,
  conversationId: string
): BackgroundRun {
  const gate = deferred<void>();
  const entered = deferred<void>();
  const child = new FakeBackgroundChild(2_000_000_002);
  const manager = createBackgroundTaskManager({
    tasksDir: resolveTasksDir({
      dataDir: join(root, "data"),
      projectIdentityRoot: root,
    }),
    spawn: async () => {
      entered.resolve();
      await gate.promise;
      return child as unknown as ChildProcess;
    },
  });
  const home = join(root, "home");
  const bash = createBashTool(join(root, "work"), {
    backgroundManager: manager,
    workspaceRoot: join(root, "work"),
    homeRoot: home,
    fenceRetired: { get: () => true },
  });
  const pendingHandler: PendingHandler = {};
  const inner = createBashExecutor(bash, pendingHandler);
  const aci = createAciExecutor({
    inner,
    catalog: Object.freeze({
      get: (name: string) => (name === "bash" ? bash : undefined),
      all: () => Object.freeze([bash]),
    }),
  });
  const caller = new AbortController();
  const execution = aci.executeAll(
    [
      {
        id: "background-cancel",
        name: "bash",
        input: { command: "sleep 300", background: true },
      },
    ],
    caller.signal,
    undefined,
    conversationId
  );
  return {
    manager,
    child,
    spawnEntered: entered.promise,
    releaseSpawn: () => gate.resolve(),
    caller,
    execution,
    pendingHandler,
  };
}

async function verifyCancelledReceiptAndQuit(root: string): Promise<void> {
  const conversationId = "conv-cancelled-background";
  const run = createBackgroundRun(root, conversationId);
  let task: BackgroundTaskReceipt | undefined;
  try {
    await run.spawnEntered;
    run.caller.abort();
    const [receipt] = await run.execution;
    assert.equal(receipt?.kind, "execution_failed");
    if (receipt?.kind !== "execution_failed") {
      throw new Error("ACI did not return an execution failure");
    }
    assert.equal(receipt.toolUseId, "background-cancel");
    // ADR-0147 R3: a held call's result carries the [approval] line after the
    // cancel label, so the whole message (not a bare "cancelled") is pinned.
    assert.equal(
      receipt.message,
      "cancelled\n[approval] held for user approval (approved); calls that ran in this wave meanwhile under the wave-start verdict: none"
    );
    assert.equal(receipt.background, true);

    run.releaseSpawn();
    const pendingHandler = run.pendingHandler.promise;
    assert.ok(pendingHandler);
    task = (await pendingHandler) as BackgroundTaskReceipt;
    assert.deepEqual(run.manager.listLiveTasks(), [
      { task_id: task.task_id, conversation_id: conversationId },
    ]);

    const source = createQuitBackgroundTasks();
    source.register(run.manager);
    const bridge = createTuiBridge({
      dataDir: join(root, "data"),
      workspaceRoot: join(root, "work"),
      deps: makeDeps([]),
      inflight: createInflightRegistry(),
      listLiveBackgroundTasks: () => source.listLiveTasks(),
    });
    const plan = planQuitBusy({
      sessions: { main: { conversationId, runState: "idle" } },
      inflightTurns: new Map(),
      liveBackgroundTasks: bridge.listLiveBackgroundTasks(),
      subagents: [],
    });
    assert.equal(plan.needsSecondConfirm, true);
    assert.equal(plan.hasStoppableWork, true);
  } finally {
    run.releaseSpawn();
    run.caller.abort();
    try {
      if (run.pendingHandler.promise) {
        task = (await run.pendingHandler.promise) as BackgroundTaskReceipt;
      }
    } finally {
      run.child.emit("exit", 0, null);
      if (task) await waitForPersistedExit(task.log_path);
    }
  }
}

const root = process.argv[2];
assert.ok(root, "expected a temporary fixture root argument");
await verifyCancelledReceiptAndQuit(root);
process.stdout.write("quit-background-receipt:ok\n");
