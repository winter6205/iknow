/**
 * Trace panel entry helpers (ADR-0020, plan T5) — pure functions extracted
 * from TracePanel / SessionSidebar so the web package (no render test
 * framework, spec A8/A10) can unit-test entry semantics under root vitest.
 */

/** Trace panel session summary shape (conversation_id + mtime only). */
export interface TraceSessionPick {
  readonly conversation_id: string;
  readonly mtime: number;
}

/**
 * Deep-link URL from a chat conversation id to its trace panel view.
 * `encodeURIComponent` guards ids that contain URL-unsafe chars (the backend
 * rejects path separators; other chars stay legal and must round-trip).
 */
export function traceDeepLink(conversationId: string): string {
  return `/trace?session=${encodeURIComponent(conversationId)}`;
}

/**
 * Initial session selection for the trace panel (SC-V 23 + deep-link):
 * `?session=` param present AND in the list → that session; param present
 * but NOT in the list (deep-link session missing) → silent fallback to the
 * most-recent session; no param → most-recent; empty list → null.
 * Pure: never throws, never mutates input.
 */
export function pickInitialTraceSession(
  sessions: ReadonlyArray<TraceSessionPick>,
  sessionParam: string | null
): string | null {
  if (sessions.length === 0) return null;
  if (sessionParam !== null) {
    const hit = sessions.find((s) => s.conversation_id === sessionParam);
    if (hit) return hit.conversation_id;
  }
  const latest = [...sessions].sort((a, b) => b.mtime - a.mtime)[0];
  return latest.conversation_id;
}
