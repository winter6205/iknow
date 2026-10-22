/**
 * Foreground interruption and confirmed process exit use different scopes:
 * the foreground helper preserves Esc semantics, while process exit aborts
 * every controller owned by the current TUI before cleanup begins.
 *
 * Why a separate module instead of inlining into app.tsx: app.tsx is already
 * 3300+ lines under complexity pressure (same splitting discipline as the
 * chat-view.tsx god function), and now hosts three production helpers. This
 * helper is a pure function, so unit tests need not render the whole TUI.
 *
 * `abortForegroundTurnOnQuit` only aborts the **active session's** foreground
 * turn (`running-fg`) and leaves background sessions untouched. It currently
 * has no production call site (Esc goes through `interruptForegroundTurn` in
 * app.tsx); it is retained, and pinned by unit tests, as the reference
 * foreground-interrupt semantics. `abortOwnedWorkOnQuit` is used
 * only after exit confirmation and aborts every local turn plus manual
 * compaction.
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

export interface OwnedWorkAbortControllers {
  readonly values: () => Iterable<AbortController>;
}

export function trackOwnedTurnController(
  byConversation: Map<string, AbortController>,
  owned: Set<AbortController>,
  conversationId: string,
  controller: AbortController
): void {
  byConversation.set(conversationId, controller);
  owned.add(controller);
}

export function removeOwnedTurnController(
  byConversation: Map<string, AbortController>,
  owned: Set<AbortController>,
  conversationId: string,
  controller: AbortController
): void {
  owned.delete(controller);
  if (byConversation.get(conversationId) === controller) {
    byConversation.delete(conversationId);
  }
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

/** Stop every controller owned by this TUI after the user confirms process exit. */
export function abortOwnedWorkOnQuit(input: {
  readonly aborters: OwnedWorkAbortControllers;
  readonly compaction?: AbortController | null;
}): void {
  for (const controller of input.aborters.values()) {
    controller.abort();
  }
  input.compaction?.abort();
}
