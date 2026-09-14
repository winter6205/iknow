/**
 * src/harness/sandbox/violation-executor.ts
 *
 * T6 wiring glue: wraps an Executor with the violation kill-session hook so
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
      // #global-plugins T2:observe 变 async —— PostToolUseHook 放宽后可返回
      // Promise，拒绝无人接会成 unhandledRejection。捕获后忽略（本包装是
      // observer，不改变结果；诊断已有宿主侧 onHookError 通道），保持
      // 「wrapper 不影响 inner 行为」的既有契约。
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
          // EXIT: post hook 异常只影响观测，绝不改变工具结果（与
          // permission-executor runAllowed 的 fire-and-forget 同判据）。
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
