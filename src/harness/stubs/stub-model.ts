/**
 * Stub model: test double for the ModelAdapter interface.
 *
 * Consumes a scripted AssistantTurnResult array one entry per step;
 * deterministic, no time/random/IO dependencies. Exhausted responses throw
 * ProtocolError. Never wired into production assembly. Also provides the
 * minimal encodeUserText / encodeToolResults entry points so the Loop
 * Engine can run a full closed loop (the stub does not model the real
 * Anthropic wire format).
 *
 * An optional injected delay before each step return (delayMs) supports
 * abort-during-wait tests; time dependence is allowed here because tests
 * control time.
 */

import { ProtocolError } from "../errors.js";
import { toAnthropicToolResults } from "../tools/tool-result.js";
import type {
  AnthropicContentBlock,
  AnthropicNativeMessage,
  AssistantTurnResult,
  LoopState,
  ModelAdapter,
} from "../model-adapter/types.js";
import type { ToolExecutionResult } from "../tools/types.js";
import type { HarnessStreamEvent } from "../stream.js";

export interface StubModelOptions {
  readonly responses: ReadonlyArray<AssistantTurnResult>;
  /** Injectable delay (ms) before each step return. Allowed because tests control time. */
  readonly delayMs?: number;
  /** Test-only: per-step event sequences emitted synchronously before the scripted
   *  response, index-paired with `responses`; a step without an entry emits nothing. */
  readonly streamEventsByStep?: ReadonlyArray<
    ReadonlyArray<HarnessStreamEvent>
  >;
}

export interface StubModelFull extends ModelAdapter {
  readonly encodeUserText: (userText: string) => AnthropicNativeMessage;
  readonly encodeToolResults: (
    results: ReadonlyArray<ToolExecutionResult>
  ) => AnthropicContentBlock[];
}

/**
 * Module-private abortable delay; rejects with DOMException("AbortError")
 * on abort, matching the Web/Node convention the Executor collapses into
 * its unified failure label.
 */
function delay(opts: {
  readonly ms: number;
  readonly signal?: AbortSignal;
}): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    // Already aborted at entry: reject without starting a timer.
    if (opts.signal?.aborted) {
      reject(new DOMException("This operation was aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(() => {
      // Normal resolve: drop the listener to avoid a leak.
      opts.signal?.removeEventListener("abort", onAbort);
      resolve();
    }, opts.ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new DOMException("This operation was aborted", "AbortError"));
    };
    // { once: true } keeps the listener single-fire.
    opts.signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function createStubModel(opts: StubModelOptions): StubModelFull {
  const queue = opts.responses.slice();
  const streamEventsQueue = opts.streamEventsByStep?.slice() ?? [];
  const delayMs = opts.delayMs ?? 0;
  return Object.freeze({
    async step(
      _state: LoopState,
      request: {
        tools?: unknown;
        onStream?: (event: HarnessStreamEvent) => void;
      },
      signal?: AbortSignal // optional, aligned with Adapter.step / LoopAdapter.step
    ): Promise<AssistantTurnResult> {
      // Optional injected delay + abort pass-through.
      if (delayMs > 0) {
        await delay({ ms: delayMs, signal });
      } else if (signal?.aborted) {
        throw new DOMException("This operation was aborted", "AbortError");
      }
      // Re-check: the signal may have fired while awaiting.
      if (signal?.aborted) {
        throw new DOMException("This operation was aborted", "AbortError");
      }
      // The full-compact summary round carries no tools — same request shape
      // as the closing-summary epilogue (runSummaryWithTimeout). Distinguish
      // them by the last user text: only the full-compact prompt contains the
      // BASE_COMPACT_PROMPT title line. For full-compact the stub returns
      // empty text (runFullCompact then reports empty_response and uses its
      // placeholder fallback) so the scripted queue is not drained early,
      // which would hand later main-loop turns an unexpected ProtocolError.
      if (request.tools === undefined) {
        const lastUserText = [..._state.messages]
          .reverse()
          .find((m) => m.role === "user")
          ?.content.filter(
            (b): b is { type: "text"; text: string } => b.type === "text"
          )
          .map((b) => b.text)
          .join("");
        const isFullCompact =
          lastUserText?.includes(
            "Your task is to create a detailed summary of the conversation so far"
          ) === true;
        if (isFullCompact) {
          const emptyNative: AnthropicNativeMessage = {
            role: "assistant",
            content: [],
          };
          return {
            nativeMessage: emptyNative,
            projection: {
              nativeMessage: emptyNative,
              texts: [],
              toolCalls: [],
            },
            supplierStop: "success",
            needsTools: false,
            isEmptyFinalResponse: true,
          };
        }
        // Closing summary (same no-tools shape) → consume the queued response normally.
      }
      const next = queue.shift();
      if (!next) {
        throw new ProtocolError(
          "stub-model: scripted responses exhausted (no further model reply)"
        );
      }
      for (const event of streamEventsQueue.shift() ?? []) {
        try {
          request.onStream?.(event);
        } catch {
          // The stub honors the observer rule: a throwing observer must not break the model turn.
        }
      }
      return next;
    },
    encodeUserText(userText: string): AnthropicNativeMessage {
      return {
        role: "user",
        content: [{ type: "text", text: userText }],
      };
    },
    encodeToolResults(
      results: ReadonlyArray<ToolExecutionResult>
    ): AnthropicContentBlock[] {
      return toAnthropicToolResults(results);
    },
  });
}
