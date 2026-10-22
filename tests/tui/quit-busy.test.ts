/**
 * tests/tui/quit-busy.test.ts
 *
 * Pins the `/quit` busy contract as a pure function (no renderer): a session is
 * outstanding when it has an attributed in-flight turn promise, OR a non-idle
 * runState, OR live background bash tasks, OR live subagents.
 *
 * Why clause "in-flight promise" is not read off `runState`: `runTurnOnce`
 * applies `turnFinished` (runState → idle) before its own promise resolves, so
 * a session can be idle while its turn is still outstanding. A test built on
 * `runState` alone under-reports in that window.
 */
import { describe, expect, test } from "bun:test";
import {
  planQuitBusy,
  quitBusyNoticeLines,
  sessionHasOutstandingWork,
  type QuitBusyInputs,
} from "../../src/tui/quit-busy.js";
import {
  createDraftSession,
  type SessionRunState,
  type TuiSessionState,
} from "../../src/tui/session-state.js";
import type { SubagentInfo } from "../../src/harness/subagent/manager.js";
import type { BackgroundLiveTask } from "../../src/harness/background/manager.js";

function session(over: Partial<TuiSessionState>): TuiSessionState {
  return Object.freeze({ ...createDraftSession(), ...over });
}

function inputs(over: Partial<QuitBusyInputs>): QuitBusyInputs {
  return {
    runState: "idle",
    inflightTurn: false,
    liveBackgroundTasks: 0,
    liveSubagents: 0,
    ...over,
  };
}

function bgTask(taskId: string, conversationId: string): BackgroundLiveTask {
  return { task_id: taskId, conversation_id: conversationId };
}

function subagent(
  taskId: string,
  conversationId: string | undefined,
  state: SubagentInfo["state"],
  foreground = false
): SubagentInfo {
  return {
    taskId,
    state,
    taskPreview: `worker ${taskId}`,
    startedAt: "2026-10-10T00:00:00.000Z",
    // The manager's projection leaves both keys absent rather than writing
    // false / undefined, so the fixtures stay byte-shaped like production.
    ...(conversationId === undefined ? {} : { conversationId }),
    ...(foreground ? { foreground: true } : {}),
  };
}

function runStateOf(state: SessionRunState): TuiSessionState {
  return session({ conversationId: "conv-1", runState: state });
}

const emptyInflight = new Map<string, ReadonlySet<Promise<unknown>>>();

describe("sessionHasOutstandingWork — 一处规则，四个来源", () => {
  test("idle + 一个 live 后台 bash 任务 → outstanding（headline bug）", () => {
    expect(sessionHasOutstandingWork(inputs({ liveBackgroundTasks: 1 }))).toBe(
      true
    );
  });

  test("idle + live 子代理 → outstanding", () => {
    expect(sessionHasOutstandingWork(inputs({ liveSubagents: 2 }))).toBe(true);
  });

  test("idle + 无后台任务 + 无子代理 + 无在途 promise → NOT outstanding", () => {
    expect(sessionHasOutstandingWork(inputs({}))).toBe(false);
  });

  test("idle（runState）但 turn promise 仍在落定 → outstanding", () => {
    expect(sessionHasOutstandingWork(inputs({ inflightTurn: true }))).toBe(
      true
    );
  });

  test("running-fg 无其它活 → outstanding（不回归既有行为）", () => {
    expect(sessionHasOutstandingWork(inputs({ runState: "running-fg" }))).toBe(
      true
    );
  });

  test("running-bg 无其它活 → outstanding（不回归既有行为）", () => {
    expect(sessionHasOutstandingWork(inputs({ runState: "running-bg" }))).toBe(
      true
    );
  });

  test("四个来源各自单独在场都能判 outstanding（OR，无遗漏）", () => {
    const singleSources = [
      inputs({ runState: "running-fg" }),
      inputs({ inflightTurn: true }),
      inputs({ liveBackgroundTasks: 1 }),
      inputs({ liveSubagents: 1 }),
    ];
    for (const one of singleSources) {
      expect(sessionHasOutstandingWork(one)).toBe(true);
    }
  });
});

describe("planQuitBusy — 会话归属、live 过滤、等待集", () => {
  test("idle 会话带 live 后台任务 → 该会话进 outstanding，无 promise 则等待集为空", () => {
    const plan = planQuitBusy({
      sessions: { "conv-1": runStateOf("idle") },
      inflightTurns: emptyInflight,
      liveBackgroundTasks: [bgTask("bg-1", "conv-1")],
      subagents: [],
    });

    expect(plan.outstandingConversationIds).toEqual(["conv-1"]);
    expect(plan.waitSet).toEqual([]);
  });

  test("子代理只数 live 行：running/starting 计入，completed/failed 不计", () => {
    const plan = planQuitBusy({
      sessions: {
        "conv-live": session({ conversationId: "conv-live" }),
        "conv-done": session({ conversationId: "conv-done" }),
      },
      inflightTurns: emptyInflight,
      liveBackgroundTasks: [],
      subagents: [
        subagent("t1", "conv-live", "running"),
        subagent("t2", "conv-live", "starting"),
        subagent("t3", "conv-done", "completed"),
        subagent("t4", "conv-done", "failed"),
      ],
    });

    expect(plan.outstandingConversationIds).toEqual(["conv-live"]);
  });

  test("后台任务结束后离开集合（同一会话，行消失即 idle）", () => {
    const sources = [bgTask("bg-1", "conv-1")];
    const withTask = planQuitBusy({
      sessions: { "conv-1": runStateOf("idle") },
      inflightTurns: emptyInflight,
      liveBackgroundTasks: sources,
      subagents: [],
    });
    expect(withTask.outstandingConversationIds).toEqual(["conv-1"]);

    const settled = planQuitBusy({
      sessions: { "conv-1": runStateOf("idle") },
      inflightTurns: emptyInflight,
      liveBackgroundTasks: [],
      subagents: [],
    });
    expect(settled.outstandingConversationIds).toEqual([]);
  });

  test("他会话的后台任务 / 子代理不算到本会话（per-conversation 归属）", () => {
    const plan = planQuitBusy({
      sessions: { "conv-1": runStateOf("idle") },
      inflightTurns: emptyInflight,
      liveBackgroundTasks: [bgTask("bg-other", "conv-other")],
      subagents: [subagent("t-other", "conv-other", "running")],
    });

    expect(plan.outstandingConversationIds).toEqual([]);
  });

  test("同一会话两个在途 promise 都被等（gap send 叠在上一轮落定前）", () => {
    const first = Promise.resolve("first");
    const second = Promise.resolve("second");
    const inflight = new Map<string, ReadonlySet<Promise<unknown>>>([
      ["conv-1", new Set<Promise<unknown>>([first, second])],
    ]);

    const plan = planQuitBusy({
      sessions: { "conv-1": runStateOf("idle") },
      inflightTurns: inflight,
      liveBackgroundTasks: [],
      subagents: [],
    });

    expect(plan.outstandingConversationIds).toEqual(["conv-1"]);
    expect(plan.waitSet.length).toBe(2);
    expect(plan.waitSet).toContain(first);
    expect(plan.waitSet).toContain(second);
  });

  test("非 outstanding 会话对等待集没有贡献", () => {
    const plan = planQuitBusy({
      sessions: {
        "conv-1": session({ conversationId: "conv-1" }),
        "conv-2": session({ conversationId: "conv-2" }),
      },
      inflightTurns: emptyInflight,
      liveBackgroundTasks: [],
      subagents: [],
    });

    expect(plan.outstandingConversationIds).toEqual([]);
    expect(plan.waitSet).toEqual([]);
  });

  test("outstanding 会话的在途 promise 全部进等待集，含多会话混合", () => {
    const bgPromise = Promise.resolve("bg-turn");
    const turnPromise = Promise.resolve("turn");
    const plan = planQuitBusy({
      sessions: {
        "conv-bg": session({ conversationId: "conv-bg" }),
        "conv-turn": session({ conversationId: "conv-turn", runState: "idle" }),
        "conv-clean": session({ conversationId: "conv-clean" }),
      },
      inflightTurns: new Map<string, ReadonlySet<Promise<unknown>>>([
        ["conv-bg", new Set<Promise<unknown>>([bgPromise])],
        ["conv-turn", new Set<Promise<unknown>>([turnPromise])],
      ]),
      liveBackgroundTasks: [bgTask("bg-1", "conv-bg")],
      subagents: [],
    });

    expect(plan.outstandingConversationIds).toEqual(["conv-bg", "conv-turn"]);
    expect(plan.waitSet.length).toBe(2);
    expect(plan.waitSet).toContain(bgPromise);
    expect(plan.waitSet).toContain(turnPromise);
  });

  test("tab 已关但 promise 在途 → 仍 outstanding 且被等（不漏等一个有 promise 的会话）", () => {
    const orphan = Promise.resolve("orphan");
    const plan = planQuitBusy({
      sessions: { "conv-1": session({ conversationId: "conv-1" }) },
      inflightTurns: new Map<string, ReadonlySet<Promise<unknown>>>([
        ["conv-closed", new Set<Promise<unknown>>([orphan])],
      ]),
      liveBackgroundTasks: [],
      subagents: [],
    });

    expect(plan.outstandingConversationIds).toEqual(["conv-closed"]);
    expect(plan.waitSet).toEqual([orphan]);
  });

  test("draft 行（conversationId undefined）不产生 id，也不被他会话的活标记", () => {
    const plan = planQuitBusy({
      sessions: { DRAFT: createDraftSession() },
      inflightTurns: emptyInflight,
      liveBackgroundTasks: [bgTask("bg-1", "conv-1")],
      subagents: [subagent("t1", "conv-1", "running")],
    });

    expect(plan.outstandingConversationIds).toEqual([]);
    expect(plan.waitSet).toEqual([]);
  });

  test("running-bg 会话（无后台任务 / 无子代理）仍进集合 —— 既有确认提示不回归", () => {
    const plan = planQuitBusy({
      sessions: { "conv-1": runStateOf("running-bg") },
      inflightTurns: emptyInflight,
      liveBackgroundTasks: [],
      subagents: [],
    });

    expect(plan.outstandingConversationIds).toEqual(["conv-1"]);
  });

  test("empty: 无任何会话与来源 → 空集合空等待集", () => {
    const plan = planQuitBusy({
      sessions: {},
      inflightTurns: emptyInflight,
      liveBackgroundTasks: [],
      subagents: [],
    });

    expect(plan.outstandingConversationIds).toEqual([]);
    expect(plan.waitSet).toEqual([]);
  });
});

describe("hasStoppableWork — 确认文案要说清哪种结局", () => {
  test("live 后台任务让它 outstanding → 有可停止的工作", () => {
    const plan = planQuitBusy({
      sessions: { "conv-1": runStateOf("idle") },
      inflightTurns: emptyInflight,
      liveBackgroundTasks: [bgTask("bg-1", "conv-1")],
      subagents: [],
    });

    expect(plan.hasStoppableWork).toBe(true);
  });

  test("live 子代理同样算可停止的工作", () => {
    const plan = planQuitBusy({
      sessions: { "conv-1": runStateOf("idle") },
      inflightTurns: emptyInflight,
      liveBackgroundTasks: [],
      subagents: [subagent("t-1", "conv-1", "running")],
    });

    expect(plan.hasStoppableWork).toBe(true);
  });

  test("只有 running-bg 轮次 → 没有可停止的工作（它会自己落盘）", () => {
    const plan = planQuitBusy({
      sessions: { "conv-1": runStateOf("running-bg") },
      inflightTurns: emptyInflight,
      liveBackgroundTasks: [],
      subagents: [],
    });

    expect(plan.outstandingConversationIds).toEqual(["conv-1"]);
    expect(plan.hasStoppableWork).toBe(false);
  });

  test("终态子代理不算可停止的工作", () => {
    const plan = planQuitBusy({
      sessions: { "conv-1": runStateOf("running-bg") },
      inflightTurns: emptyInflight,
      liveBackgroundTasks: [],
      subagents: [subagent("t-1", "conv-1", "completed")],
    });

    expect(plan.hasStoppableWork).toBe(false);
  });
});

describe("quitBusyNoticeLines — 文案不承诺相反结局", () => {
  test("有可停止工作 → 说明退出会停止本 TUI 所有工作", () => {
    const [line] = quitBusyNoticeLines(true);

    expect(line).toContain("停止当前 TUI 拥有的全部工作");
    expect(line).toContain("Esc 取消");
    expect(line).toContain("其他 iknow 进程不受影响");
  });

  test("只有后台会话轮次 → 仍说明退出会停止本 TUI 所有工作", () => {
    const [line] = quitBusyNoticeLines(false);

    expect(line).toContain("停止当前 TUI 拥有的全部工作");
    expect(line).toContain("其他 iknow 进程不受影响");
  });
});

/**
 * The gate's own rule: the first press only asks about work it has not already
 * dealt with. `interruptibleConversationId` is the conversation whose turn that
 * same press aborts (quit-abort.ts, SC12); a detached background task is never
 * abort-covered by it, a subagent of that conversation is.
 */
describe("needsSecondConfirm — 门只问这一下按下没有处理掉的工作", () => {
  test("可打断会话自己的前台轮次 → 不确认（一次按下就 abort）", () => {
    const plan = planQuitBusy({
      sessions: { "conv-1": runStateOf("running-fg") },
      inflightTurns: emptyInflight,
      liveBackgroundTasks: [],
      subagents: [],
      interruptibleConversationId: "conv-1",
    });

    expect(plan.needsSecondConfirm).toBe(false);
  });

  test("同一会话的 live 后台任务 → 仍确认（abort 停不掉 detached 进程）", () => {
    const plan = planQuitBusy({
      sessions: { "conv-1": runStateOf("running-fg") },
      inflightTurns: emptyInflight,
      liveBackgroundTasks: [bgTask("bg-1", "conv-1")],
      subagents: [],
      interruptibleConversationId: "conv-1",
    });

    expect(plan.needsSecondConfirm).toBe(true);
  });

  test("可打断会话的 wait:true 子代理 → 不确认（父轮的 running-fg 已代表它）", () => {
    const plan = planQuitBusy({
      sessions: { "conv-1": runStateOf("running-fg") },
      inflightTurns: emptyInflight,
      liveBackgroundTasks: [],
      subagents: [subagent("t1", "conv-1", "running", true)],
      interruptibleConversationId: "conv-1",
    });

    expect(plan.needsSecondConfirm).toBe(false);
  });

  test("可打断会话的 wait:false 子代理 → 确认（前台打断只选 foreground 行）", () => {
    const plan = planQuitBusy({
      sessions: { "conv-1": runStateOf("running-fg") },
      inflightTurns: emptyInflight,
      liveBackgroundTasks: [],
      subagents: [subagent("t1-bg", "conv-1", "running")],
      interruptibleConversationId: "conv-1",
    });

    expect(plan.needsSecondConfirm).toBe(true);
    expect(plan.hasStoppableWork).toBe(true);
  });

  test("无 conversationId 的 live 子代理（judge / 直接 manager 调用）→ 确认", () => {
    const plan = planQuitBusy({
      sessions: { "conv-1": runStateOf("idle") },
      inflightTurns: emptyInflight,
      liveBackgroundTasks: [],
      subagents: [subagent("t-judge", undefined, "running", true)],
    });

    expect(plan.outstandingConversationIds).toEqual([]);
    expect(plan.needsSecondConfirm).toBe(true);
    expect(plan.hasStoppableWork).toBe(true);
  });

  test("别的会话的活 → 确认（这一按只覆盖可打断的那个会话）", () => {
    const plan = planQuitBusy({
      sessions: { "conv-1": runStateOf("running-fg") },
      inflightTurns: emptyInflight,
      liveBackgroundTasks: [],
      subagents: [subagent("t2", "conv-2", "running")],
      interruptibleConversationId: "conv-1",
    });

    expect(plan.needsSecondConfirm).toBe(true);
  });

  test("没有会话行认领的 live 后台任务（空 conversation_id）→ 确认且算可停止", () => {
    const plan = planQuitBusy({
      sessions: { "conv-1": runStateOf("idle") },
      inflightTurns: emptyInflight,
      liveBackgroundTasks: [bgTask("bg-orphan", "")],
      subagents: [],
    });

    expect(plan.outstandingConversationIds).toEqual([]);
    expect(plan.needsSecondConfirm).toBe(true);
    expect(plan.hasStoppableWork).toBe(true);
  });

  test("无事 → 不确认", () => {
    const plan = planQuitBusy({
      sessions: { "conv-1": runStateOf("idle") },
      inflightTurns: emptyInflight,
      liveBackgroundTasks: [],
      subagents: [],
      interruptibleConversationId: "conv-1",
    });

    expect(plan.needsSecondConfirm).toBe(false);
  });
});
