/**
 * `/quit` aborts the current foreground turn first, then waits for
 * teardown — it does not wait on per-task subagent wall clocks (default 7200s).
 *
 * Why a separate module instead of inlining into app.tsx: app.tsx is already
 * 3300+ lines under complexity pressure (same splitting discipline as the
 * chat-view.tsx god function), leaving just one call site here. This helper
 * is a pure function, so unit tests need not render the whole TUI.
 *
 * Semantic boundary (per the running-fg/running-bg state machine):
 *  - Only abort the **current active session's** foreground turn
 *    (`running-fg`) — spec wording: "abort the current foreground turn first".
 *  - Background sessions (`running-bg`) are **untouched**: the /quit
 *    second-confirmation branch still waits for them to persist; this helper
 *    does not change that existing semantics.
 *  - No controller (turn teardown already removed it from the table) / draft
 *    session (conversationId undefined) → no-op, no throw, no fabricated controller.
 *
 * abort exit path (verified; this helper only reuses it, does not open a new one):
 *   controller.abort() → bridge.postMessage({signal}) → hub.postMessage →
 *   run(…, opts.signal) → executor (interruptBehavior="cancel" pass-through) →
 *   spawn_subagent handler's ctx.signal → manager.waitFor(taskId, …,
 *   ctx.signal) → SubAgentAbortError.
 */
import { canInterrupt, type TuiSessionState } from "./session-state.js";

/** Minimal read-only surface of `aborters.current` (Map<string, AbortController>). */
export interface AbortControllerLookup {
  readonly get: (conversationId: string) => AbortController | undefined;
}

export interface QuitAbortInput {
  readonly session: TuiSessionState;
  readonly aborters: AbortControllerLookup;
}

/**
 * First step of /quit teardown: abort the current session's foreground turn.
 * Returns whether an abort was actually issued — the caller does not need the
 * value (idempotent teardown); it exists only so tests can observe "was there
 * an abort" without reading internal state.
 */
export function abortForegroundTurnOnQuit(input: QuitAbortInput): boolean {
  const { session, aborters } = input;
  // canInterrupt is the single predicate for `running-fg` (Esc / /quit consume
  // the same source) — do not re-write the `runState === "running-fg"` literal here.
  if (!canInterrupt(session)) return false;
  const id = session.conversationId;
  if (id === undefined) return false;
  const controller = aborters.get(id);
  if (controller === undefined) return false;
  controller.abort();
  return true;
}
