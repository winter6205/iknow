/**
 * Shared process.stderr capture helper (the writeErr SSOT test surface).
 *
 * Converges three former per-file copies:
 *   - tests/cli/chat-session-rebind.test.ts  (suppress, fn-wrapping)
 *   - tests/cli/workspace-root-error.test.ts (suppress, handle-based)
 *   - tests/subagent/rules-missing-dirs.test.ts (passthrough, fn-wrapping)
 *
 * Historical behavior differences are preserved via parameterization, not
 * silently unified:
 *   - `passthrough: false` (default) = record and SUPPRESS (return true) —
 *     for silence assertions (stderr must be empty / contain exactly X);
 *   - `passthrough: true` = record AND forward to the real stderr — keeps
 *     the rules-missing-dirs semantics (worker stderr stays observable).
 *
 * Two API shapes:
 *   - handle-based `captureStderr()` → `{ lines, restore }` for
 *     beforeEach/afterEach style tests;
 *   - `captureStderrOf(fn)` → wraps an async fn, restores in `finally`,
 *     resolves with the joined text.
 */
export interface CaptureStderrOptions {
  /** Record AND forward to the real stderr (default false = suppress). */
  readonly passthrough?: boolean;
}

export interface StderrCapture {
  readonly lines: string[];
  /** Restore the original `process.stderr.write`; returns the recorded lines. */
  restore(): string[];
}

export function captureStderr(opts: CaptureStderrOptions = {}): StderrCapture {
  const lines: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  // Node's `write` is an overloaded stream method (buffer+cb / str+encoding+cb),
  // so assign straight onto `process.stderr.write` and keep Node's own
  // signature instead of erasing it to a narrower local type. The trailing args
  // (encoding / callback) are forwarded generically, and a binary chunk is
  // decoded through Buffer — a bare `Uint8Array.toString()` takes no encoding.
  process.stderr.write = (
    chunk: string | Uint8Array,
    ...rest: unknown[]
  ): boolean => {
    lines.push(
      typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8")
    );
    if (opts.passthrough) {
      // The bound original keeps Node's overloads; the seam forwards whatever
      // the caller passed, so erase them only at this call.
      return (original as (...args: unknown[]) => boolean)(chunk, ...rest);
    }
    return true;
  };
  return {
    lines,
    restore: (): string[] => {
      process.stderr.write = original;
      return lines;
    },
  };
}

/** Wrap an async fn and resolve with everything it wrote to stderr as one string. */
export async function captureStderrOf(
  fn: () => Promise<void>,
  opts: CaptureStderrOptions = {}
): Promise<string> {
  const capture = captureStderr(opts);
  try {
    await fn();
  } finally {
    capture.restore();
  }
  return capture.lines.join("");
}
