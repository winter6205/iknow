/**
 * Shared `console.warn` capture — the `[memory/*]` warn-seam test surface.
 *
 * Converges the hand-rolled pattern that lived per file: install a warn spy,
 * record each call with its arguments joined by a single space (the separator
 * the consumers themselves build their lines with), restore in `finally` so a
 * failing assertion cannot leak the spy into the next case.
 *
 * API shape follows `capture-stderr.ts` (wrap the run, return what was said).
 * A throw from `run` propagates, because several cases assert on it
 * (`assert.throws(...)`); the optional `sink` is how such a caller keeps the
 * lines warned before the throw.
 */
import { vi } from "vitest";

export interface ConsoleWarnCapture<T> {
  /** Every recorded warn line, arguments joined with " ". */
  readonly messages: string[];
  /** What `run` returned — absent when `run` threw, since nothing is returned. */
  readonly result: T;
}

/** Record `console.warn` across a synchronous run. */
export function captureConsoleWarn<T>(
  run: () => T,
  sink: string[] = []
): ConsoleWarnCapture<T> {
  const restore = installWarnRecorder(sink);
  try {
    return { messages: sink, result: run() };
  } finally {
    restore();
  }
}

/** Record `console.warn` across an async run (the writer/consumer paths). */
export async function captureConsoleWarnAsync<T>(
  run: () => Promise<T>,
  sink: string[] = []
): Promise<ConsoleWarnCapture<T>> {
  const restore = installWarnRecorder(sink);
  try {
    return { messages: sink, result: await run() };
  } finally {
    restore();
  }
}

/** Replace `console.warn` with a recorder; returns the restore closure. */
function installWarnRecorder(messages: string[]): () => void {
  const spy = vi
    .spyOn(console, "warn")
    .mockImplementation((...args: unknown[]) => {
      messages.push(args.map(String).join(" "));
    });
  return () => spy.mockRestore();
}
