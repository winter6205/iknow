/** @jsxImportSource @opentui/react */
/**
 * tests/tui/subagent-kill-key.test.tsx
 *
 * spec Slice D / SC14 + SC15（`specs/agent-control-surface.md`）/ plan task 8
 * 的 TUI 键位测：Ctrl+X 强杀 chrome-focus 聚焦的子代理；无聚焦 → 空操作。
 *
 * 分层：
 *   - 「杀谁」的纯分派（行序 / 陈旧行 / 非法 row）由
 *     tests/tui/subagent-kill.test.ts 直驱覆盖；
 *   - 本文件钉 app 层接线：Down 进 subagent 环后 Ctrl+X 必须调
 *     `bridge.abortSubagentTask(聚焦行的 taskId)` 且只调一次；focus 在 input
 *     时 Ctrl+X 不调 bridge（SC15 empty）也不崩；陈旧焦点（子代理已终态）
 *     不调 bridge。
 *   - 末组用例（SC14 端到端）换真 bridge + 真 manager + 真 executor：Ctrl+X
 *     必须让父侧前景 `waitFor` 以 `SubAgentAbortError` 拒绝 —— 即上面那层
 *     fake bridge 断言不了的下游一半。
 *
 * 为什么其余组用 fake bridge：真实 manager 的 SIGTERM→SIGKILL 链路归
 * tests/subagent/manager.test.ts（abortTask）与真实 bridge 的透传归
 * tests/tui/hub-bridge.test.ts；本测只钉 app 层「按键 → 调谁」。
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
// SC14 端到端组：真 ACI registry + 真 executor + 真 manager（只 fake worker
// 子进程）—— 与 tests/tui/wait-cancel-abort.test.tsx 同一套装配。
import { createDefaultAciRegistry } from "../../src/harness/aci/tools/registry.js";
import { createAciExecutor } from "../../src/harness/aci/aci-executor.js";
import { createExecutor } from "../../src/harness/tools/executor.js";
import { createStubModel } from "../../src/harness/stubs/stub-model.js";
import { assistantResult } from "../cli/_fixtures.ts";
import type { LoopEngineDeps } from "../../src/harness/index.js";

const COLS = 80;
const ROWS = 30;

/** 合法最小 env（registry 只消费 web 字段）。 */
const webEnv = { web: { searchUrl: undefined, proxy: undefined } };

/** 永不 emit 的 fake worker（只在 abort / shutdown 时被 kill）。 */
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

/** 轮询直到 cond 为真（stdin 异步解析 + React commit 都有延迟）。 */
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
  /** 等 1Hz subagents 轮询把 app state 刷成新投影（陈旧焦点场景必需）。 */
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
    rewindSession: async () => file,
    listRewindTargets: async () => [],
    inflight,
    contextWindow: 200_000,
    listSubagents: () => current,
    abortSubagentTask: (taskId) => {
      killed.push({ taskId });
      return true;
    },
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
   * 每次按键后等 React commit 新 state 再发下一键。120ms 在负载高的机器上
   * 偶尔不够（Down 的 setChromeFocus 未提交 → 下一次 Down 读到旧 row，
   * 或 Ctrl+X 读到旧 focus），故用 waitForVisualIdle 收敛而不是裸 sleep：
   * 帧稳定即 state 已提交。
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
      // 1Hz 轮询 + React commit：1200ms 覆盖一个完整 tick。
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
      // 无异常、界面仍在（输入框占位行仍在）。
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
      // 回执落 notice（不静默）。
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
      // 子代理终态：等 1Hz 轮询把 app state 刷成「无 live」投影；此时
      // chromeFocus 的 row 0 已陈旧（clamp effect 尚未把它拉回 input）。
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
 * SC14 端到端：真 bridge + 真 manager + 真 executor（只 fake worker 子进程）。
 *
 * 上面那组用 fake bridge 只能钉「按键 → 调 abortSubagentTask(谁)」；本组补上
 * 下游一半 —— Ctrl+X 之后**父侧前景 waitFor 真的以 SubAgentAbortError 拒绝**
 * （即「父 turn 收到 cancelled」的上游事实）。做法与
 * tests/tui/wait-cancel-abort.test.tsx 的 Ctrl+C 组同形（同一套真装配），差别
 * 只在触发臂：那里 abort 调用方 signal，这里走 manager 的单任务 abortTask。
 */
async function mountRealKillApp(): Promise<{
  readonly setup: TestRendererSetup;
  readonly events: string[];
  readonly waitRejected: () => unknown;
  /** 等 React commit 新 state（focusedRow 等）再发下一键。 */
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
  // 观测真实出口：Ctrl+X 抵达时 waitFor 必须以 SubAgentAbortError 拒绝。
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
      // 真实 adapter 对每个 tool_use 恒发 `tool_call_start`（live tail 据此
      // 建卡）；stub 须补同一事件，否则 spawn 执行期间屏上没有承载两行的卡
      // —— 该 e2e 的 Down 聚焦目标就无从谈起。
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
  /** 逐键 60ms：mockInput 走 stdin 异步解析，连发会丢键。 */
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
  // specs/tui-subagent-transcript-live.md：两行画在 spawn 卡上（live tail），
  // 卡由 `tool_call_start` 流事件建条（真实 adapter 对每个 tool_use 恒发；
  // 本测的 stub 由 setUp 的 streamEventsByStep 补齐同一事件）。子代理行
  // 出现 = 该卡已 join 到子代理投影，Down / Ctrl+X 的目标行已就位。
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
