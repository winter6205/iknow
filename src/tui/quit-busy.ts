/**
 * The `/quit` busy set: one rule, consulted by the second-confirmation gate and
 * by the promises teardown waits for.
 *
 * Why a separate module instead of inlining into app.tsx: app.tsx is under
 * complexity pressure, and a pure
 * function here means unit tests need no renderer.
 *
 * A session is outstanding when ANY of:
 *  - it has an in-flight `postMessage` promise, attributed to its conversation;
 *  - its `runState` is not idle (covers a backgrounded turn between requests,
 *    e.g. a queued gap send);
 *  - it has live background bash tasks in its manager;
 *  - it has live subagents.
 *
 * The in-flight promise is a source of its own rather than a read of `runState`:
 * `runTurnOnce` applies `turnFinished` (`runState` -> idle) before its own
 * promise settles, so a session can be idle while its turn is still outstanding.
 *
 * `needsSecondConfirm` is the other half of the rule: a press only has to ask
 * about work it does not already stop, so the interruptible conversation's own
 * turn is exempt while a detached task, another conversation's worker, or a row
 * no session row claims is not.
 *
 * Scope boundary: this does not change the 「运行中」 chrome line, which stays
 * pinned to the parent turn (docs/CONTEXT.md 运行中 vs 后景残留提示). Live bash
 * tasks are also projected into the chat chrome so they stay visible before
 * the operator asks to quit.
 */
import type { SessionRunState, TuiSessionState } from "./session-state.js";
import { isLiveSubagent } from "./subagent-message-lines.js";
import type { SubagentInfo } from "../harness/subagent/manager.js";
import type { BackgroundLiveTask } from "../harness/background/manager.js";

export interface QuitBusyInputs {
  readonly runState: SessionRunState;
  readonly inflightTurn: boolean;
  readonly liveBackgroundTasks: number;
  readonly liveSubagents: number;
}

/** The one place the four sources are combined. */
export function sessionHasOutstandingWork(input: QuitBusyInputs): boolean {
  if (input.inflightTurn) return true;
  if (input.runState !== "idle") return true;
  return input.liveBackgroundTasks > 0 || input.liveSubagents > 0;
}

/** The session fields the busy set reads (tab-keyed records satisfy this as-is). */
export type QuitBusySessionView = Pick<
  TuiSessionState,
  "conversationId" | "runState"
>;

export interface QuitBusySources {
  readonly sessions: Readonly<Record<string, QuitBusySessionView>>;
  /** Outstanding turn promises per conversation; several per conversation is
   *  legal — a gap send lands while the previous turn is still settling. */
  readonly inflightTurns: ReadonlyMap<string, ReadonlySet<Promise<unknown>>>;
  readonly liveBackgroundTasks: Iterable<BackgroundLiveTask>;
  readonly subagents: Iterable<SubagentInfo>;
  /** The conversation whose outstanding turn this same keypress aborts, so that
   *  turn is not a reason to ask first (`quit-abort.ts` semantics, pinned by
   *  SC12 in `tests/tui/wait-cancel-abort.test.tsx`). */
  readonly interruptibleConversationId?: string;
}

export interface QuitBusyPlan {
  readonly outstandingConversationIds: ReadonlyArray<string>;
  /** Promises belonging to the outstanding conversations — what /quit awaits. */
  readonly waitSet: ReadonlyArray<Promise<unknown>>;
  /** Whether the first press has to stop and ask instead of quitting. */
  readonly needsSecondConfirm: boolean;
  /**
   * Whether live background tasks or live subagents are in play at all: the
   * process-exit reap STOPS them, so a notice promising persistence would be
   * false. Read only when `needsSecondConfirm` fired.
   */
  readonly hasStoppableWork: boolean;
}

/** Stable signature for detecting work added or replaced after the first prompt. */
export function quitBusyFingerprint(
  sources: Pick<
    QuitBusySources,
    "sessions" | "inflightTurns" | "liveBackgroundTasks" | "subagents"
  >
): string {
  const sessionRows = Object.entries(sources.sessions)
    .filter(([, session]) => session.runState !== "idle")
    .map(([key, session]) =>
      JSON.stringify([key, session.conversationId ?? null, session.runState])
    )
    .sort();
  const inflightRows = [...sources.inflightTurns.entries()]
    .filter(([, turns]) => turns.size > 0)
    .map(([conversationId, turns]) =>
      JSON.stringify([conversationId, turns.size])
    )
    .sort();
  const backgroundRows = [...sources.liveBackgroundTasks]
    .map((task) => JSON.stringify([task.task_id, task.conversation_id]))
    .sort();
  const subagentRows = [...sources.subagents]
    .filter(isLiveSubagent)
    .map((task) =>
      JSON.stringify([
        task.taskId,
        task.conversationId ?? null,
        task.state,
        task.foreground === true,
      ])
    )
    .sort();
  return JSON.stringify([
    sessionRows,
    inflightRows,
    backgroundRows,
    subagentRows,
  ]);
}

/** Live background tasks per owning conversation. */
function countLiveBackgroundTasks(
  tasks: Iterable<BackgroundLiveTask>
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const task of tasks) {
    counts.set(
      task.conversation_id,
      (counts.get(task.conversation_id) ?? 0) + 1
    );
  }
  return counts;
}

/**
 * Live subagents per owning conversation, plus the live rows this press cannot
 * reach. `listSubagents` is the manager's full projection.
 *
 * `unreachable` counts a `wait:false` worker (`foreground !== true`), which
 * outlives the turn that spawned it, and a row with no `conversationId` (judge
 * / direct manager call), which belongs to no interruptible session. The
 * foreground interrupt fans out over `foreground === true` rows of one session
 * only, and `/quit` does not fan out at all, so neither kind is stopped by the
 * press; both are stopped by the exit reap.
 */
function countLiveSubagents(rows: Iterable<SubagentInfo>): {
  live: Map<string, number>;
  /** Every live row, attributed or not: the exit reap stops all of them. */
  total: number;
  unreachable: number;
} {
  const live = new Map<string, number>();
  let total = 0;
  let unreachable = 0;
  for (const row of rows) {
    if (!isLiveSubagent(row)) continue;
    total++;
    if (row.conversationId === undefined || row.foreground !== true) {
      unreachable++;
    }
    if (row.conversationId === undefined) continue;
    live.set(row.conversationId, (live.get(row.conversationId) ?? 0) + 1);
  }
  return { live, total, unreachable };
}

/**
 * Join the raw sources onto conversation ids. An id with a promise but no
 * session row (a closed tab whose turn is still in flight) still counts: no
 * outstanding promise may be dropped from the wait set.
 */
export function planQuitBusy(sources: QuitBusySources): QuitBusyPlan {
  const backgroundCounts = countLiveBackgroundTasks(
    sources.liveBackgroundTasks
  );
  const subagents = countLiveSubagents(sources.subagents);
  const byConversation = new Map<string, QuitBusySessionView>();
  for (const session of Object.values(sources.sessions)) {
    if (session.conversationId !== undefined) {
      byConversation.set(session.conversationId, session);
    }
  }

  const ids = new Set<string>([
    ...byConversation.keys(),
    ...sources.inflightTurns.keys(),
  ]);
  const outstanding: string[] = [];
  const waitSet: Promise<unknown>[] = [];
  for (const conversationId of ids) {
    const inflight = sources.inflightTurns.get(conversationId);
    if (
      !sessionHasOutstandingWork({
        runState: byConversation.get(conversationId)?.runState ?? "idle",
        inflightTurn: inflight !== undefined && inflight.size > 0,
        liveBackgroundTasks: backgroundCounts.get(conversationId) ?? 0,
        liveSubagents: subagents.live.get(conversationId) ?? 0,
      })
    ) {
      continue;
    }
    outstanding.push(conversationId);
    for (const promise of inflight ?? []) waitSet.push(promise);
  }

  const interruptible = sources.interruptibleConversationId;
  // The current foreground turn is aborted when /quit proceeds. Its signal
  // rejects a `wait:true` worker's waitFor, so awaiting the parent turn does not
  // wait out the worker timeout; manager shutdown reaps the worker at exit. A
  // detached task, `wait:false` worker, other conversation, or unclaimed row
  // has no abort route from that turn and still needs confirmation.
  const uncoveredWork =
    backgroundCounts.size > 0 ||
    subagents.unreachable > 0 ||
    [...subagents.live.keys()].some((id) => id !== interruptible);
  return {
    outstandingConversationIds: outstanding,
    waitSet,
    needsSecondConfirm:
      uncoveredWork || outstanding.some((id) => id !== interruptible),
    hasStoppableWork: backgroundCounts.size > 0 || subagents.total > 0,
  };
}

/**
 * The first-press notice names the ownership boundary and the stop behavior.
 */
export function quitBusyNoticeLines(
  hasStoppableWork: boolean
): ReadonlyArray<string> {
  return hasStoppableWork
    ? [
        "存在后台任务或子代理仍在运行；再次 /quit 确认停止当前 TUI 拥有的全部工作并退出，Esc 取消。其他 iknow 进程不受影响。",
      ]
    : [
        "当前 TUI 的其他会话仍在运行；再次 /quit 确认停止当前 TUI 拥有的全部工作并退出，Esc 取消。其他 iknow 进程不受影响。",
      ];
}

export function quitConfirmationRefreshLines(): ReadonlyArray<string> {
  return ["退出确认期间工作状态发生变化；再次 /quit 确认最新状态，Esc 取消。"];
}
