/**
 * src/tui/ask-user.ts
 *
 * TUI-only AskUser bridge: in full-screen raw mode readline is unavailable,
 * so this follows createServeAskUser's queue-based, fail-closed discipline.
 * The resolve entry point lives in the TUI state machine (the user types
 * y/n/a or ↑↓+Enter in the permission modal).
 *
 * Semantics (ADR-0147 R1/R2/R4):
 *  - ask(ctx) allocates an `ask-N` id and enqueues a call-addressed entry
 *    (toolUseId + the wave's optional conversationId);
 *  - there is NO default timeout. A timer exists only when opts.timeoutMs is
 *    a positive number (unref); absent or `0` means the question waits until
 *    the user answers it or the caller aborts;
 *  - ending: resolveAsk(id, true) → {kind:"approved"}, resolveAsk(id, false)
 *    → {kind:"declined"}, a configured timeout → {kind:"timeout", afterMs},
 *    caller abort (during the wait or already-aborted at entry) →
 *    {kind:"cancelled"}. Only an explicit approval admits the call.
 *  - pending() feeds the UI prompt (tool name + summaryHint + id + the call
 *    identity: toolUseId / conversationId).
 */
import type { AskUser, AskUserOutcome } from "../harness/permission/types.js";
import type { AnswerChoice } from "../remote-api/protocol.js";

export interface TuiPendingAsk {
  readonly id: string;
  readonly tool: string;
  readonly summaryHint: string;
  /** The `tool_use` id of the call this question is about (ADR-0147 R1). */
  readonly toolUseId: string;
  /** The wave's conversation; absent only for a caller that has none. */
  readonly conversationId?: string;
  /** The call input from `ctx.input`, for a client that has no executor view
   *  of the call (the phone approval card). */
  readonly input: unknown;
}

/** Who ended a pending ask: an answer from either side, or the system
 *  (configured timeout / caller abort). */
export type TuiAskSettledBy = "local" | "remote" | "system";

export interface TuiAskUserBridge {
  readonly ask: AskUser;
  readonly resolveAsk: (
    id: string,
    approved: boolean,
    origin?: "local" | "remote",
    answer?: AnswerChoice
  ) => boolean;
  readonly pending: () => TuiPendingAsk | undefined;
  /** Every queued ask, FIFO (the phone lists them all, not just the head). */
  readonly pendingAll: () => readonly TuiPendingAsk[];
  readonly pendingCount: () => number;
  /** Pending-change notification (fires once per enqueue / settle). The TUI
   *  uses it to mount / unmount the modal immediately. Returns unsubscribe. */
  readonly subscribe: (cb: () => void) => () => void;
  /** Settlement notification, once per ask, after the answer is delivered.
   *  `answer` is the modal choice that ended it, absent for a system ending.
   *  Returns unsubscribe. */
  readonly onSettled: (
    cb: (
      ask: TuiPendingAsk,
      outcome: AskUserOutcome,
      by: TuiAskSettledBy,
      answer: AnswerChoice | undefined
    ) => void
  ) => () => void;
}

export function createTuiAskUserBridge(opts?: {
  /** Positive ms → fail-closed timeout. Absent or `0` → wait without limit. */
  readonly timeoutMs?: number;
}): TuiAskUserBridge {
  const configured = opts?.timeoutMs;
  const timeoutMs =
    configured !== undefined && configured > 0 ? configured : undefined;
  const queue = new Map<
    string,
    {
      readonly info: TuiPendingAsk;
      readonly resolve: (v: boolean | AskUserOutcome) => void;
      readonly timer: ReturnType<typeof setTimeout> | undefined;
      readonly signal: AbortSignal | undefined;
      readonly onAbort: () => void;
    }
  >();
  let counter = 0;
  const subs = new Set<() => void>();
  const notify = (): void => {
    for (const cb of subs) cb();
  };
  const settledSubs = new Set<
    (
      ask: TuiPendingAsk,
      outcome: AskUserOutcome,
      by: TuiAskSettledBy,
      answer: AnswerChoice | undefined
    ) => void
  >();

  function settle(
    id: string,
    outcome: AskUserOutcome,
    by: TuiAskSettledBy,
    answer?: AnswerChoice
  ): boolean {
    const entry = queue.get(id);
    if (!entry) return false;
    queue.delete(id);
    if (entry.timer !== undefined) clearTimeout(entry.timer);
    entry.signal?.removeEventListener("abort", entry.onAbort);
    entry.resolve(outcome);
    notify();
    for (const cb of [...settledSubs]) {
      try {
        cb(entry.info, outcome, by, answer);
      } catch {
        // Swallow observer faults: a broken settlement consumer must never
        // fail the ask or hide the settlement from the other subscribers.
      }
    }
    return true;
  }

  const ask: AskUser = (ctx) => {
    if (ctx.signal?.aborted === true) {
      return Promise.resolve({ kind: "cancelled" } as const);
    }
    counter += 1;
    const id = `ask-${counter}`;
    return new Promise<boolean | AskUserOutcome>((resolve) => {
      // Arm a configured timer first so a same-tick resolveAsk can still win
      // (settle clears the timer). No configured timeout → no timer at all.
      let timer: ReturnType<typeof setTimeout> | undefined;
      if (timeoutMs !== undefined) {
        timer = setTimeout(() => {
          settle(id, { kind: "timeout", afterMs: timeoutMs }, "system");
        }, timeoutMs);
        if (typeof timer.unref === "function") timer.unref();
      }
      const onAbort = (): void => {
        settle(id, { kind: "cancelled" }, "system");
      };
      queue.set(id, {
        info: {
          id,
          tool: ctx.tool,
          summaryHint: ctx.summaryHint,
          toolUseId: ctx.toolUseId,
          input: ctx.input,
          ...(ctx.conversationId !== undefined
            ? { conversationId: ctx.conversationId }
            : {}),
        },
        resolve,
        timer,
        signal: ctx.signal,
        onAbort,
      });
      if (ctx.signal !== undefined) {
        ctx.signal.addEventListener("abort", onAbort, { once: true });
        if (ctx.signal.aborted) settle(id, { kind: "cancelled" }, "system");
      }
      if (queue.has(id)) notify();
    });
  };

  return Object.freeze({
    ask: Object.freeze(ask),
    resolveAsk: (
      id: string,
      approved: boolean,
      origin: "local" | "remote" = "local",
      answer?: AnswerChoice
    ): boolean =>
      settle(id, { kind: approved ? "approved" : "declined" }, origin, answer),
    pending: (): TuiPendingAsk | undefined => queue.values().next().value?.info,
    pendingAll: (): readonly TuiPendingAsk[] =>
      [...queue.values()].map((entry) => entry.info),
    pendingCount: () => queue.size,
    subscribe: (cb: () => void): (() => void) => {
      subs.add(cb);
      return () => {
        subs.delete(cb);
      };
    },
    onSettled: (
      cb: (
        ask: TuiPendingAsk,
        outcome: AskUserOutcome,
        by: TuiAskSettledBy,
        answer: AnswerChoice | undefined
      ) => void
    ): (() => void) => {
      settledSubs.add(cb);
      return () => {
        settledSubs.delete(cb);
      };
    },
  });
}
