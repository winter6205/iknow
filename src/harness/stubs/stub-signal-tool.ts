/**
 * Signal-aware stub tool.
 *
 * Honors ctx.signal: aborts immediately or mid-wait, rejecting with
 * DOMException("AbortError"), which the Executor converges to the unified
 * execution_failed label. Test-only; never wired into production assembly.
 */

import type { ToolDef } from "../tools/types.js";

export interface StubSignalToolOptions {
  readonly name?: string;
  /** Wait duration in ms (for "abort during wait" cases). Default 0. */
  readonly delayMs?: number;
}

export function createStubSignalTool(
  opts: StubSignalToolOptions = {}
): ToolDef {
  const name = opts.name ?? "stub_signal";
  const delayMs = opts.delayMs ?? 0;
  return Object.freeze<ToolDef>({
    name,
    description: `stub ${name}`,
    inputSchema: { type: "object" },
    handler: (async (input: unknown, ctx?: { signal?: AbortSignal }) => {
      const signal = ctx?.signal;
      // Already aborted at entry: reject before running any logic.
      if (signal?.aborted) {
        throw new DOMException("This operation was aborted", "AbortError");
      }
      if (delayMs > 0) {
        await new Promise<void>((resolve, reject) => {
          if (signal?.aborted) {
            reject(
              new DOMException("This operation was aborted", "AbortError")
            );
            return;
          }
          const timer = setTimeout(() => {
            signal?.removeEventListener("abort", onAbort);
            resolve();
          }, delayMs);
          const onAbort = (): void => {
            clearTimeout(timer);
            reject(
              new DOMException("This operation was aborted", "AbortError")
            );
          };
          signal?.addEventListener("abort", onAbort, { once: true });
        });
      }
      return input;
    }) as ToolDef["handler"],
  });
}
