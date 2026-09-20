/**
 * Shared read-side IO error helpers (traceserver bounded context).
 *
 * Extracted from the duplicated isEnoent / wrapIoError copies in reader.ts
 * and sessions.ts. ENOENT is the common read-side contract:
 *   - a file/dir deleted (vanished mid-read) -> callers degrade silently per
 *     scenario (empty segment / skip that file);
 *   - any other IO error -> uniformly wrapped into TraceReadError, mapped to
 *     500 by http.ts, so low-level fs details never leak onto the wire.
 * Both reader modules import this module instead of private copies.
 */
import { TraceReadError } from "./types.js";

/** True when err is ENOENT (the read-side silent-degradation signal, not an error). */
export function isEnoent(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === "ENOENT"
  );
}

/**
 * Wrap an unknown IO error into TraceReadError (keeps the code, never the
 * raw message). The message carries no fs details, so http.ts's 500 mapping
 * cannot expose paths or permission info in the response body.
 */
export function wrapIoError(err: unknown): TraceReadError {
  const code =
    typeof err === "object" &&
    err !== null &&
    typeof (err as { code?: unknown }).code === "string"
      ? (err as { code: string }).code
      : "IO";
  return new TraceReadError(`trace file read failed: ${code}`);
}
