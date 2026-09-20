/**
 * src/harness/sandbox/violation-executor.ts
 *
 * Wiring glue: wraps an Executor with the violation kill-session hook so
 * every tool result is observed by the violation counter. When the counter
 * escalates to `shouldKill = true`, the configured `onKill` callback fires
 * (typically `wireKillSessionNotification` which writes a stderr line and
 * sets `process.exitCode = 1`).
 *
 * The wrapper is intentionally simple: it executes the inner Executor with
 * the same args and observes each result through the hook. It does not
 * affect the inner executor's behavior — it's an observer, not a modifier.
 */

import type {
  Executor,
  ToolCall,
  ToolExecutionContext,
  ToolExecutionResult,
} from "../tools/types.js";
import type { HarnessStreamEvent } from "../stream.js";
import type { PostToolUseHook } from "../permission/types.js";
import {
  createKillSessionHook,
  createViolationCounter,
  wireKillSessionNotification,
  type ViolationCounter,
} from "./violation-handling.js";

export interface WrapWithViolationHookOpts {
  readonly inner: Executor;
  readonly counter?: ViolationCounter;
  readonly onKill: (reason: string) => void;
  /** Optional custom hook; default uses createKillSessionHook. */
  readonly postToolUse?: PostToolUseHook;
}

export function wrapWithViolationHook(
  opts: WrapWithViolationHookOpts
): Executor {
  const counter = opts.counter ?? createViolationCounter();
  const hook: PostToolUseHook =
    opts.postToolUse ?? createKillSessionHook({ counter, onKill: opts.onKill });

  return Object.freeze({
    executeAll: async (
      calls: ReadonlyArray<ToolCall>,
      signal?: AbortSignal,
      timeoutMs?: number,
      conversationId?: string,
      onSettled?: (
        result: ToolExecutionResult,
        index: number
      ) => void | Promise<void>,
      turnId?: string,
      onStream?: (event: HarnessStreamEvent) => void,
      messages?: ToolExecutionContext["messages"]
    ): Promise<ReadonlyArray<ToolExecutionResult>> => {
      const seen = new Set<number>();
      // observe is async: PostToolUseHook may now return a Promise, and an
      // unhandled rejection would surface as unhandledRejection. Catch and
      // ignore — this wrapper is an observer and must not alter results
      // (diagnostics already have the host-side onHookError channel), keeping
      // the contract that the wrapper never affects the inner executor.
      const observe = async (
        r: ToolExecutionResult,
        i: number
      ): Promise<void> => {
        if (seen.has(i)) return;
        const call = calls[i];
        if (!call) return;
        seen.add(i);
        const message =
          r.kind === "execution_failed" || r.kind === "validation_failed"
            ? r.message
            : undefined;
        const payload = r.kind === "ok" ? r.payload : undefined;
        try {
          await hook({
            toolUseId: r.toolUseId,
            name: call.name,
            input: call.input,
            kind: r.kind,
            message,
            payload,
          });
        } catch {
          // EXIT: post-hook failures only affect observation, never the tool
          // result (same fire-and-forget rationale as permission-executor
          // runAllowed).
        }
      };
      const out = await opts.inner.executeAll(
        calls,
        signal,
        timeoutMs,
        conversationId,
        async (result, index) => {
          await observe(result, index);
          await onSettled?.(result, index);
        },
        turnId,
        onStream,
        messages
      );
      for (let i = 0; i < out.length; i += 1) {
        const r = out[i];
        if (r) await observe(r, i);
      }
      return out;
    },
  });
}

/**
 * Convenience helper for the three CLI entry points: build a counter + an
 * `onKill` that writes to stderr + sets exit code, wrap the inner executor,
 * return both wrapped executor and counter. Callers needing access to the
 * counter (e.g. to log it) get it directly.
 */
export interface BuildViolationWiringResult {
  readonly executor: Executor;
  readonly counter: ViolationCounter;
}

export function buildViolationWiring(
  inner: Executor,
  opts: {
    readonly sink?: (line: string) => void;
    readonly counter?: ViolationCounter;
  } = {}
): BuildViolationWiringResult {
  const counter = opts.counter ?? createViolationCounter();
  const sink =
    opts.sink ??
    ((line: string) => {
      process.stderr.write(line + "\n");
    });
  const onKill = wireKillSessionNotification({ sink });
  const executor = wrapWithViolationHook({ inner, counter, onKill });
  return { executor, counter };
}
