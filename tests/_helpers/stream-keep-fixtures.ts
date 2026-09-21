/**
 * ADR-0108 interrupt frozen-prefix-keep — streaming fixtures shared across test files.
 *
 * Consolidates two near-identical copies in tests/harness/loop-engine.test.ts
 * and tests/session-api/hub-interrupt-frozen-prefix.test.ts: a byte-for-byte
 * duplicated `textOf` plus the streaming adapter factory that "emits scripted
 * text_delta then hangs until signal abort". The keep-side byte shape (deltas
 * share a source with the on-wall draft) used to require syncing two places on
 * any change, hence a single source. Consumed only by the test tree; src/
 * exports no test-only symbols.
 */
import type {
  AnthropicNativeMessage,
  AssistantTurnResult,
  HarnessStreamEvent,
  LoopAdapter,
  LoopState,
} from "../../src/harness/index.ts";
import { toAnthropicToolResults } from "../../src/harness/tools/tool-result.ts";
import type { ToolExecutionResult } from "../../src/harness/tools/types.ts";
import { assistantResult } from "../cli/_fixtures.ts";

/** Concatenate all text blocks in a message (tool_use / tool_result blocks excluded). */
export function textOf(msg: AnthropicNativeMessage): string {
  return msg.content
    .filter(
      (b): b is { type: "text"; text: string } =>
        b.type === "text" && typeof (b as { text?: unknown }).text === "string"
    )
    .map((b) => b.text)
    .join("");
}

/**
 * Script step: first emit `deltas` synchronously (simulating streamed output
 * whose bytes share a source with the on-wall draft); with `result`, deliver
 * the turn immediately; without `result`, hang until signal abort
 * (simulating an in-flight model that never delivers). Calls after the script
 * is exhausted (the closing-summary round) return an empty result at once so
 * tests never hang.
 */
export interface StreamKeepStep {
  readonly deltas?: ReadonlyArray<string>;
  readonly result?: AssistantTurnResult;
}

/**
 * Fixture adapter factory. `onFirstStream` is called after step 1 finishes
 * emitting its deltas, letting the test deterministically "see the stream
 * before interrupting". Each step records the state.messages it received
 * (stepPriors) as the observation surface for model priors.
 */
export function makeStreamKeepAdapter(
  steps: ReadonlyArray<StreamKeepStep>,
  opts?: { readonly onFirstStream?: () => void }
): {
  adapter: LoopAdapter;
  stepPriors: AnthropicNativeMessage[][];
} {
  const stepPriors: AnthropicNativeMessage[][] = [];
  let call = 0;
  const adapter: LoopAdapter = {
    encodeUserText: (text: string): AnthropicNativeMessage => ({
      role: "user",
      content: [{ type: "text", text }],
    }),
    encodeToolResults: (results: ReadonlyArray<ToolExecutionResult>) =>
      toAnthropicToolResults(results),
    step: async (
      state: LoopState,
      request: { onStream?: (event: HarnessStreamEvent) => void },
      signal?: AbortSignal
    ): Promise<AssistantTurnResult> => {
      stepPriors.push([...state.messages]);
      const script = steps[Math.min(call, steps.length - 1)]!;
      const inRange = call < steps.length;
      const isFirst = call === 0;
      call += 1;
      for (const text of script.deltas ?? []) {
        request.onStream?.({ type: "text_delta", text });
      }
      if (isFirst) opts?.onFirstStream?.();
      if (!inRange || script.result !== undefined) {
        return (
          script.result ??
          assistantResult({ texts: [], toolCalls: [], supplierStop: "success" })
        );
      }
      await new Promise<void>((_resolve, reject) => {
        if (signal?.aborted) {
          reject(new DOMException("aborted", "AbortError"));
          return;
        }
        signal?.addEventListener(
          "abort",
          () => reject(new DOMException("aborted", "AbortError")),
          { once: true }
        );
      });
      throw new DOMException("aborted", "AbortError"); // unreachable
    },
  };
  return { adapter, stepPriors };
}
