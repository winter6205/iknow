import type { AutoMemoryHook, AutoMemoryTurn } from "./auto-hook.js";

export type NotifyAutoMemoryOptions = AutoMemoryTurn & {
  readonly hook?: AutoMemoryHook;
  readonly onError: (error: unknown) => void;
};

export function notifyAutoMemory(opts: NotifyAutoMemoryOptions): void {
  if (opts.hook === undefined) return;
  try {
    opts.hook.onTurnComplete({
      stopReason: opts.stopReason,
      transcript: opts.transcript,
      ...(opts.sessionKey !== undefined ? { sessionKey: opts.sessionKey } : {}),
    });
  } catch (error: unknown) {
    // EXIT: log-and-continue — a memory hook failure must not fail the user turn.
    opts.onError(error);
  }
}
