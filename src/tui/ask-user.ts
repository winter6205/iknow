/**
 * src/tui/ask-user.ts
 *
 * TUI-only AskUser bridge: in full-screen raw mode readline is unavailable,
 * so this follows createServeAskUser's queue-based, fail-closed discipline.
 * The resolve entry point lives in the TUI state machine (the user types
 * y/n/a or ↑↓+Enter in the permission modal).
 *
 * Semantics:
 *  - ask(ctx) allocates an `ask-N` id and arms a fail-closed timer
 *    (default 60s, unref);
 *  - only resolveAsk(id, true) grants; timeout / caller abort / unknown id → false;
 *  - pending() feeds the UI prompt (tool name + summaryHint + id).
 */
import type { AskUser } from "../harness/permission/types.js";

export interface TuiPendingAsk {
  readonly id: string;
  readonly tool: string;
  readonly summaryHint: string;
}

export interface TuiAskUserBridge {
  readonly ask: AskUser;
  readonly resolveAsk: (id: string, approved: boolean) => boolean;
  readonly pending: () => TuiPendingAsk | undefined;
  readonly pendingCount: () => number;
  /** Pending-change notification (fires once per enqueue / settle). The TUI
   *  uses it to mount / unmount the modal immediately. Returns unsubscribe. */
  readonly subscribe: (cb: () => void) => () => void;
}

const DEFAULT_TIMEOUT_MS = 60_000;

export function createTuiAskUserBridge(opts?: {
  readonly timeoutMs?: number;
}): TuiAskUserBridge {
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const queue = new Map<
    string,
    {
      readonly info: TuiPendingAsk;
      readonly resolve: (v: boolean) => void;
      readonly timer: ReturnType<typeof setTimeout>;
      readonly signal: AbortSignal | undefined;
      readonly onAbort: () => void;
    }
  >();
  let counter = 0;
  const subs = new Set<() => void>();
  const notify = (): void => {
    for (const cb of subs) cb();
  };

  function settle(id: string, approved: boolean): boolean {
    const entry = queue.get(id);
    if (!entry) return false;
    queue.delete(id);
    clearTimeout(entry.timer);
    entry.signal?.removeEventListener("abort", entry.onAbort);
    entry.resolve(approved);
    notify();
    return true;
  }

  const ask: AskUser = (ctx) => {
    if (ctx.signal?.aborted === true) return Promise.resolve(false);
    counter += 1;
    const id = `ask-${counter}`;
    return new Promise<boolean>((resolve) => {
      // Arm the fail-closed timer first so a same-tick resolveAsk can still win (settle clears the timer).
      const timer = setTimeout(() => {
        settle(id, false);
      }, timeoutMs);
      if (typeof timer.unref === "function") timer.unref();
      const onAbort = (): void => {
        settle(id, false);
      };
      queue.set(id, {
        info: {
          id,
          tool: ctx.tool,
          summaryHint: ctx.summaryHint,
        },
        resolve,
        timer,
        signal: ctx.signal,
        onAbort,
      });
      if (ctx.signal !== undefined) {
        ctx.signal.addEventListener("abort", onAbort, { once: true });
        if (ctx.signal.aborted) settle(id, false);
      }
      if (queue.has(id)) notify();
    });
  };

  return Object.freeze({
    ask: Object.freeze(ask),
    resolveAsk: (id: string, approved: boolean): boolean =>
      settle(id, approved),
    pending: (): TuiPendingAsk | undefined => queue.values().next().value?.info,
    pendingCount: () => queue.size,
    subscribe: (cb: () => void): (() => void) => {
      subs.add(cb);
      return () => {
        subs.delete(cb);
      };
    },
  });
}
