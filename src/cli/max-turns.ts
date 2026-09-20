/**
 * maxTurns-exceeded surface rendering (ADR-0011 / ADR-0012).
 *
 * Pure functions, imported directly by chat / ask. cli.ts itself has a
 * main() side effect and cannot be imported, so the presentation layer
 * lives here; tests import from the src/ path unaffected.
 *
 * Entry contract:
 *   - chat REPL uses maxTurnsNotice for the stderr line + output summary;
 *   - ask oneshot uses maxTurnsEnvelope for a JSON string on stderr + exitCode=1.
 */
import { MaxTurnsExceeded } from "../harness/errors.js";

/**
 * chat REPL rendering: stderr notice line + output summary text.
 *
 * Missing summary (epilogue failed / timed out / skipped) -> empty output
 * (avoids showing a dangling summary header). stopSummary length > 0 counts
 * as present.
 */
export function maxTurnsNotice(
  err: MaxTurnsExceeded,
  stopSummary?: string
): { readonly stderr: string; readonly output: string } {
  const stderr = `已达 maxTurns=${err.turnsRan} 轮上限（${err.reason}），终止`;
  const output =
    stopSummary !== undefined && stopSummary.length > 0
      ? `收尾摘要：\n${stopSummary}`
      : "";
  return { stderr, output };
}

/**
 * ask oneshot maxTurns JSON envelope (stderr + exitCode=1).
 *
 * Absent stopSummary -> field absent (byte-stable, same pattern as
 * thinking/toolCalls/lastUsage). `message` carries the human-readable
 * notice line, aligned with the chat-side stderr text.
 */
export function maxTurnsEnvelope(
  err: MaxTurnsExceeded,
  stopSummary?: string
): string {
  const payload: {
    error: "max_turns_exceeded";
    turnsRan: number;
    reason: string;
    message: string;
    stopSummary?: string;
  } = {
    error: "max_turns_exceeded",
    turnsRan: err.turnsRan,
    reason: err.reason,
    message: `已达 maxTurns=${err.turnsRan} 轮上限（${err.reason}），终止`,
  };
  if (stopSummary !== undefined && stopSummary.length > 0) {
    payload.stopSummary = stopSummary;
  }
  return JSON.stringify(payload);
}
