/** @jsxImportSource @opentui/react */
/**
 * tests/tui/subagent-kill-key.test.tsx
 *
 * TUI keybinding test: Ctrl+X force-kills the subagent focused by chrome-focus;
 * no focus → no-op.
 *
 * Layering:
 *   - the pure "whom to kill" dispatch (row order / stale row / illegal row) is
 *     covered directly by tests/tui/subagent-kill.test.ts;
 *   - this file pins the app-layer wiring: after Down enters the subagent ring,
 *     Ctrl+X must call `bridge.abortSubagentTask(focusedRow.taskId)` exactly
 *     once; with focus on input Ctrl+X must not call the bridge and must not
 *     crash; stale focus (subagent already terminal) must not call the bridge.
 *   - the last group (end-to-end) swaps in a real bridge + real manager + real
 *     executor: Ctrl+X must make the parent-side foreground `waitFor` reject
 *     with `SubAgentAbortError` — the downstream half the fake-bridge group
 *     cannot assert.
 *
 * Why the other groups use a fake bridge: the real manager's SIGTERM→SIGKILL
 * chain belongs to tests/subagent/manager.test.ts (abortTask) and real-bridge
 * pass-through to tests/tui/hub-bridge.test.ts; this test only pins the
 * app-layer "keypress → whom it calls".
 */
import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { testRender } from "@opentui/react/test-utils";
import type { TestRendererSetup } from "@opentui/core/testing";
import { TuiApp, createToolEventSink } from "../../src/tui/app.js";
import type { TuiBridge, TuiPostResult } from "../../src/tui/hub-bridge.js";
import {
  createInflightRegistry,
  createTuiBridge,
} from "../../src/tui/hub-bridge.js";
import { createTuiAskUserBridge } from "../../src/tui/ask-user.js";
import { createPermissionModeContext } from "../../src/harness/permission/index.js";
import { createSessionGrants } from "../../src/harness/permission/session-grants.js";
import type { SessionFileV1 } from "../../src/session-api/store/schema.js";
import { createSubAgentManager } from "../../src/harness/subagent/manager.js";
import type { SubagentInfo } from "../../src/harness/subagent/manager.js";
// End-to-end group: real ACI registry + real executor + real manager (only the
// worker child process is faked) — same assembly as
// tests/tui/wait-cancel-abort.test.tsx.
import { createDefaultAciRegistry } from "../../src/harness/aci/tools/registry.js";
import { createAciExecutor } from "../../src/harness/aci/aci-executor.js";
import { createExecutor } from "../../src/harness/tools/executor.js";
import { createStubModel } from "../../src/harness/stubs/stub-model.js";
import { assistantResult } from "../cli/_fixtures.ts";
import type { LoopEngineDeps } from "../../src/harness/index.js";

const COLS = 80;
const ROWS = 30;

/** Minimal valid env (the registry only consumes the web fields). */
const webEnv = { web: { searchUrl: undefined, proxy: undefined } };

/** Fake worker that never emits (killed only on abort / shutdown). */
function makeFakeChild(): ChildProcess {
  return Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    pid: 424_242,
    kill: () => true,
    exitCode: null,
  }) as unknown as ChildProcess;
}

/** Poll until cond is true (stdin async parsing and React commits both lag). */
async function until(
  cond: () => boolean,
  ms = 8000,
  label = ""
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`until timeout: ${label}`);
}

function makeSubagent(overrides: Partial<SubagentInfo>): SubagentInfo {
  return {
    taskId: "task-a",
    state: "running",
    taskPreview: "查找文档",
    startedAt: new Date().toISOString(),
    ...overrides,
  };
}

interface KilledCall {
  readonly taskId: string;
}

async function mountApp(subagents: ReadonlyArray<SubagentInfo>): Promise<{
  readonly setup: TestRendererSetup;
  readonly killed: KilledCall[];
  readonly pressDown: () => Promise<void>;
  readonly pressCtrlX: () => Promise<void>;
  readonly setSubagents: (next: ReadonlyArray<SubagentInfo>) => void;
  /** Wait for the 1Hz subagents poll to refresh app state (needed by the stale-focus case). */
  readonly waitForSubagentPoll: () => Promise<void>;
  readonly destroy: () => Promise<void>;
}> {
  const killed: KilledCall[] = [];
  let current = subagents;
  const inflight = createInflightRegistry();
  const file: SessionFileV1 = {
    schemaVersion: 3,
    conversation_id: "conv-kill",
    title: "",
    cwd: "/tmp/proj",
    sanitized_at: new Date().toISOString(),
    messages: [],
    jsonMode: false,
    turnCount: 0,
    updatedAt: new Date().toISOString(),
    checkpoints: [],
  };
  const reply: TuiPostResult = {
    conversationId: "conv-kill",
    finalText: "",
    stopReason: "completed",
    turnCount: 0,
    jsonMode: false,
    lastUsage: null,
  };
  const bridge: TuiBridge = {
    hub: undefined as never,
    store: undefined as never,
    ensureSession: async (id) => id ?? "conv-kill",
    postMessage: async () => reply,
    listSessions: async () => [],
    loadSessionFile: async () => file,
    compactSession: async () => ({
      compacted: false,
      reason: "below_token_threshold" as const,
    }),
    continueSession: async () => {
      throw new Error("unused");
    },
    rewindSession: async () => ({ file }),
    listRewindTargets: async () => [],
    inflight,
    contextWindow: 200_000,
    listSubagents: () => current,
    abortSubagentTask: (taskId) => {
      killed.push({ taskId });
      return true;
    },
    abortSessionForegroundWork: () => [],
    subscribeSubagentTerminal: () => () => undefined,
    wakeFromSubagent: async () => undefined,
  };

  const dataDir = mkdtempSync(join(tmpdir(), "iknow-kill-key-"));
  const setup = await testRender(
    <TuiApp
      bridge={bridge}
      askBridge={createTuiAskUserBridge()}
      toolEventSink={createToolEventSink()}
      cwd="/tmp/proj"
      dataDir={dataDir}
      permissionMode={createPermissionModeContext("default")}
      sessionGrants={createSessionGrants()}
    />,
    { width: COLS, height: ROWS, exitOnCtrlC: false, consoleMode: "disabled" }
  );
  await setup.waitForVisualIdle();

  /**
   * After each keypress wait for React to commit new state before sending the
   * next. A bare 120ms is occasionally not enough under load (Down's
   * setChromeFocus uncommitted → the next Down reads a stale row, or Ctrl+X
   * reads a stale focus), so converge via waitForVisualIdle instead of a raw
   * sleep: a stable frame means the state has committed.
   */
  const settle = async (ms = 120): Promise<void> => {
    await new Promise((r) => setTimeout(r, ms));
    await setup.renderOnce();
    await setup.waitForVisualIdle();
  };

  return {
    setup,
    killed,
    pressDown: async () => {
      setup.mockInput.pressArrow("down");
      await settle();
    },
    pressCtrlX: async () => {
      setup.mockInput.pressKey("x", { ctrl: true });
      await settle();
    },
    setSubagents: (next) => {
      current = next;
    },
    waitForSubagentPoll: async () => {
      // 1Hz poll + React commit: 1200ms covers one full tick.
      await settle(1200);
    },
    destroy: async () => {
      if (!setup.renderer.isDestroyed) setup.renderer.destroy();
    },
  };
}

describe("Ctrl+X 强杀聚焦子代理（SC14 / SC15 empty）", () => {
  test("SC15 empty: focus 在 input（未 Down）→ Ctrl+X 不杀、不崩", async () => {
    const app = await mountApp([
      makeSubagent({ taskId: "task-a", role: "explore" }),
    ]);
    try {
      await app.pressCtrlX();
      expect(app.killed).toEqual([]);
      // No exception, UI still there (input placeholder line present).
      expect(app.setup.captureCharFrame()).toContain("❯");
    } finally {
      await app.destroy();
    }
  }, 30_000);

  test("SC14: Down 进 subagent 环 → Ctrl+X 强杀该行（taskId 精确）", async () => {
    const app = await mountApp([
      makeSubagent({ taskId: "task-a", role: "explore" }),
      makeSubagent({
        taskId: "task-b",
        role: "general-purpose",
        taskPreview: "第二件事",
      }),
    ]);
    try {
      await app.pressDown();
      await app.pressCtrlX();
      expect(app.killed).toEqual([{ taskId: "task-a" }]);
      // Receipt lands as a notice (never silent).
      expect(app.setup.captureCharFrame()).toContain("已强杀子代理");
    } finally {
      await app.destroy();
    }
  }, 30_000);

  test("SC14: Down 两次 → 聚焦第 1 行，Ctrl+X 杀 task-b（行序 = live 序）", async () => {
    const app = await mountApp([
      makeSubagent({ taskId: "task-a", role: "explore" }),
      makeSubagent({
        taskId: "task-b",
        role: "general-purpose",
        taskPreview: "第二件事",
      }),
    ]);
    try {
      await app.pressDown();
      await app.pressDown();
      await app.pressCtrlX();
      expect(app.killed).toEqual([{ taskId: "task-b" }]);
    } finally {
      await app.destroy();
    }
  }, 30_000);

  test("陈旧焦点：聚焦行已终态（live 缩到 0）→ Ctrl+X 不调 bridge，不崩", async () => {
    const app = await mountApp([
      makeSubagent({ taskId: "task-a", role: "explore" }),
    ]);
    try {
      await app.pressDown();
      // Subagent terminal: wait for the 1Hz poll to refresh app state to the
      // "no live" projection; chromeFocus row 0 is now stale (the clamp effect
      // has not pulled it back to input yet).
      app.setSubagents([
        makeSubagent({
          taskId: "task-a",
          role: "explore",
          state: "completed",
          endedAt: new Date().toISOString(),
        }),
      ]);
      await app.waitForSubagentPoll();
      await app.pressCtrlX();
      expect(app.killed).toEqual([]);
    } finally {
      await app.destroy();
    }
  }, 30_000);
});

/**
 * End-to-end: real bridge + real manager + real executor (only the worker child
 * process is faked).
 *
 * The fake-bridge group above can only pin "keypress → which taskId reaches
 * abortSubagentTask"; this group adds the downstream half — after Ctrl+X the
 * **parent-side foreground waitFor really rejects with SubAgentAbortError**
 * (the upstream fact behind "the parent turn receives cancelled"). Same shape
 * as the Ctrl+C group in tests/tui/wait-cancel-abort.test.tsx (same real
 * assembly); the only difference is the trigger arm: there it aborts via the
 * caller's signal, here via the manager's per-task abortTask.
 */
async function mountRealKillApp(): Promise<{
  readonly setup: TestRendererSetup;
  readonly events: string[];
  readonly waitRejected: () => unknown;
  /** Wait for React to commit new state (focusedRow etc.) before the next key. */
  readonly settleAfterKey: () => Promise<void>;
  readonly dispose: () => Promise<void>;
}> {
  const events: string[] = [];
  let waitRejected: unknown;
  const manager = createSubAgentManager({
    spawn: () => {
      events.push("spawn");
      return makeFakeChild();
    },
    taskTimeoutMs: 60_000,
  });
  // Observe the real exit: when Ctrl+X lands, waitFor must reject with SubAgentAbortError.
  const realWaitFor = manager.waitFor.bind(manager);
  const observedManager: typeof manager = {
    ...manager,
    waitFor: (taskId, timeoutMs, signal) => {
      const pending = realWaitFor(taskId, timeoutMs, signal);
      pending.catch((err: unknown) => {
        events.push("waitFor-rejected");
        waitRejected = err;
      });
      return pending;
    },
  };
  const reg = createDefaultAciRegistry({
    env: webEnv as never,
    sandboxRoot: process.cwd(),
    subagentManager: observedManager,
  });
  const deps: LoopEngineDeps = {
    adapter: createStubModel({
      responses: [
        assistantResult({
          texts: [],
          toolCalls: [
            {
              id: "spawn-1",
              name: "spawn_subagent",
              input: { task: "sleep forever", wait: true },
            },
          ],
        }),
      ],
      // A real adapter always emits `tool_call_start` per tool_use (the live
      // tail builds its card from it); the stub must supply the same event or
      // no two-line card exists on screen during spawn execution — the Down
      // focus target of this e2e would be moot.
      streamEventsByStep: [
        [{ type: "tool_call_start", id: "spawn-1", name: "spawn_subagent" }],
      ],
    }),
    executor: createAciExecutor({
      inner: createExecutor(reg.inner),
      catalog: reg.catalog,
      askUser: async () => true,
    }),
    registry: reg.inner,
    maxTurns: 5,
  };
  const dataDir = mkdtempSync(join(tmpdir(), "iknow-kill-real-"));
  const bridge = createTuiBridge({
    dataDir,
    workspaceRoot: dataDir,
    deps,
    inflight: createInflightRegistry(),
    subagentManager: observedManager,
  });
  const setup = await testRender(
    <TuiApp
      bridge={bridge}
      askBridge={createTuiAskUserBridge()}
      toolEventSink={createToolEventSink()}
      cwd="/tmp/proj"
      dataDir={dataDir}
      permissionMode={createPermissionModeContext("default")}
      sessionGrants={createSessionGrants()}
    />,
    { width: COLS, height: ROWS, exitOnCtrlC: false, consoleMode: "disabled" }
  );
  await setup.waitForVisualIdle();
  /** 60ms per keypress: mockInput goes through async stdin parsing, bursts drop keys. */
  const typeText = async (text: string): Promise<void> => {
    for (const ch of text) {
      setup.mockInput.pressKey(ch);
      await new Promise((r) => setTimeout(r, 60));
      await setup.renderOnce();
    }
    setup.mockInput.pressEnter();
  };
  const settleAfterKey = async (): Promise<void> => {
    await new Promise((r) => setTimeout(r, 120));
    await setup.renderOnce();
    await setup.waitForVisualIdle();
  };
  await typeText("hi");
  await until(() => events.includes("spawn"), 8000, "spawn 未发生");
  // specs/tui-subagent-transcript-live.md: the two lines render on the spawn
  // card (live tail), created by the `tool_call_start` stream event (a real
  // adapter always emits it per tool_use; this test's stub supplies it via
  // streamEventsByStep above). Subagent line appearing = the card has joined
  // the subagent projection, so the Down / Ctrl+X target row is in place.
  await until(
    () => /running\.\.\./.test(setup.captureCharFrame()),
    8000,
    "子代理两行未出现在 spawn 卡上"
  );
  await settleAfterKey();
  return {
    setup,
    events,
    waitRejected: () => waitRejected,
    settleAfterKey,
    dispose: async () => {
      if (!setup.renderer.isDestroyed) setup.renderer.destroy();
      await manager.shutdown();
    },
  };
}

describe("Ctrl+X 端到端抵达父侧 wait（SC14）", () => {
  test("Down 聚焦 + Ctrl+X → waitFor 以 SubAgentAbortError 拒绝", async () => {
    const app = await mountRealKillApp();
    try {
      app.setup.mockInput.pressArrow("down");
      await app.settleAfterKey();
      app.setup.mockInput.pressKey("x", { ctrl: true });
      await until(
        () => app.events.includes("waitFor-rejected"),
        8000,
        "Ctrl+X 未抵达 waitFor"
      );
      expect(app.waitRejected()).toBeInstanceOf(Error);
      expect((app.waitRejected() as Error).name).toBe("SubAgentAbortError");
    } finally {
      await app.dispose();
    }
  }, 30_000);
});
