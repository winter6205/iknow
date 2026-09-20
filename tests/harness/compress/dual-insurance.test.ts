/**
 * Proactive + reactive dual-insurance coexistence tests.
 *
 * Proactive estimation triggering and reactive PromptTooLongError triggering
 * (ADR-0013) form the dual insurance: they share `compactMessages` with no
 * threshold/priority conflict. This file focuses on the "coexistence"
 * semantics; each side alone (proactive estimation / reactive retry) is
 * covered by index.test.ts and loop-engine.test.ts. Only the relationship
 * between them is asserted:
 *   a. proactive (estimate-triggered) works independently, unaffected by reactive;
 *   b. reactive (error-triggered) works independently, unaffected by proactive —
 *      even when a high threshold blocks the estimate, reactive still compacts
 *      and the retry succeeds (no threshold conflict);
 *   c. both paths reuse the same `compactMessages` and produce the same shape
 *      (boundary placeholder + trailing DEFAULT_KEEP_RECENT messages).
 */
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  shouldAutoCompact,
  compactMessages,
  estimateMessagesTokens,
  COMPACTION_BOUNDARY_PLACEHOLDER,
  DEFAULT_KEEP_RECENT,
} from "../../../src/harness/compress/index.ts";
import { PromptTooLongError } from "../../../src/harness/errors.ts";
import { run } from "../../../src/harness/loop-engine.ts";
import { createRegistry } from "../../../src/harness/tools/registry.ts";
import { createExecutor } from "../../../src/harness/tools/executor.ts";
import { createStubTool } from "../../../src/harness/stubs/stub-tool.ts";
import { assistantResult } from "../../cli/_fixtures.ts";
import type {
  AnthropicContentBlock,
  AnthropicNativeMessage,
  AssistantTurnResult,
  LoopState,
} from "../../../src/harness/model-adapter/types.ts";

const text = (value: string): AnthropicNativeMessage => ({
  role: "user",
  content: [{ type: "text", text: value }],
});

/**
 * Minimal flaky adapter needed for the reactive path:
 *   - encodeUserText: same shape as stub-model, encodes the prompt as a native message;
 *   - encodeToolResults: empty return (no tool invocation);
 *   - step: first call throws PromptTooLongError, second returns success —
 *     simulating "model rejects before compaction -> reactive triggers compaction ->
 *     model accepts after compaction".
 */
function makeFlakyAdapter(opts: {
  readonly retryText: string;
  readonly attemptCount: { value: number };
}) {
  return Object.freeze({
    encodeUserText: (t: string): AnthropicNativeMessage => ({
      role: "user",
      content: [{ type: "text", text: t }],
    }),
    encodeToolResults: (): AnthropicContentBlock[] => [],
    step: async (
      _state: LoopState,
      request: { readonly tools?: unknown }
    ): Promise<AssistantTurnResult> => {
      opts.attemptCount.value += 1;
      if (opts.attemptCount.value === 1) {
        throw new PromptTooLongError("synthetic 400 prompt-too-long");
      }
      // full-compact summary round (tools === undefined) returns empty text ->
      // empty_response -> fallback placeholder (shared compactMessages product).
      if (request.tools === undefined) {
        return assistantResult({
          texts: [],
          toolCalls: [],
          supplierStop: "success",
        });
      }
      return assistantResult({
        texts: [opts.retryText],
        toolCalls: [],
        supplierStop: "success",
      });
    },
  });
}

describe("compress 双保险共存 (proactive + reactive, ADR-0013)", () => {
  it("proactive 独立:估算触发不依赖 reactive 路径,压缩走 compactMessages", () => {
    // Estimate crosses the threshold -> proactive fires, bypassing
    // PromptTooLongError and the reactive entry. Whether reactive is
    // implemented/assembled never changes the shouldAutoCompact decision.
    const messages = Array.from({ length: 200 }, () => text("a".repeat(40)));
    const estimate = estimateMessagesTokens(messages);
    assert.ok(estimate > 0);

    // threshold = estimate -> fires; threshold = estimate + 1 -> doesn't.
    // Pure-function semantics, fully decoupled from the reactive entry point.
    assert.equal(
      shouldAutoCompact(messages, {
        contextWindow: 200_000,
        threshold: estimate,
      }),
      true
    );
    assert.equal(
      shouldAutoCompact(messages, {
        contextWindow: 200_000,
        threshold: estimate + 1,
      }),
      false
    );

    // The proactive compaction product = boundary placeholder +
    // DEFAULT_KEEP_RECENT tail, structurally identical to a direct
    // compactMessages call, proving the proactive path reuses the same function.
    const compressed = compactMessages(messages);
    assert.notStrictEqual(compressed, messages);
    assert.deepStrictEqual(compressed[0], {
      role: "user",
      content: [{ type: "text", text: COMPACTION_BOUNDARY_PLACEHOLDER }],
    });
    // Tail is exactly DEFAULT_KEEP_RECENT messages + 1 placeholder; no tool-pair expansion.
    assert.equal(compressed.length, 1 + DEFAULT_KEEP_RECENT);
    // The final tail message is byte-identical to the original's last (immutable tail preservation).
    assert.deepStrictEqual(
      compressed[compressed.length - 1],
      messages[messages.length - 1]
    );
  });

  it("reactive 独立:proactive 阈值拉高(估算不触发)仍能压缩并重试成功", async () => {
    // Assemble 12 small prior messages -> estimate far below the threshold ->
    // proactive firing doesn't hold, so the only compaction trigger left is the
    // reactive error path (no threshold conflict).
    const longPrior = Array.from({ length: 12 }, (_, i) => text(`prior-${i}`));
    const withQ: AnthropicNativeMessage[] = [
      ...longPrior,
      { role: "user", content: [{ type: "text", text: "Q" }] },
    ];
    const proactiveWouldFire = shouldAutoCompact(withQ, {
      contextWindow: 200_000,
      threshold: 10_000,
    });
    assert.equal(
      proactiveWouldFire,
      false,
      "前置断言:proactive 阈值 10000 >> estimate,估算触发不成立"
    );

    const tool = createStubTool({ name: "noop", next: () => ({}) });
    const reg = createRegistry([tool]);
    const exec = createExecutor(reg);
    const attemptCount = { value: 0 };
    const adapter = makeFlakyAdapter({
      retryText: "done after compact",
      attemptCount,
    });

    const { result } = await run(
      "Q",
      {
        adapter,
        executor: exec,
        registry: reg,
        maxTurns: 5,
        compress: { contextWindow: 200_000, thresholdTokens: 10_000 },
      },
      undefined,
      { priorMessages: longPrior }
    );

    // Reactive works alone: 1 throw -> full-compact summary step (fallback -> placeholder) -> retry -> success.
    assert.equal(result.stopReason, "completed");
    assert.equal(attemptCount.value, 3, "首次抛 + 摘要步 + 重试成功");
    // Compaction product: boundary placeholder + DEFAULT_KEEP_RECENT tail + closing assistant.
    assert.equal(
      result.messages.length,
      1 + DEFAULT_KEEP_RECENT + 1,
      `expected reactive-compressed length 8, got ${result.messages.length}`
    );
    assert.deepStrictEqual(result.messages[0], {
      role: "user",
      content: [{ type: "text", text: COMPACTION_BOUNDARY_PLACEHOLDER }],
    });
    assert.equal(result.finalText, "done after compact");
  });

  it("共用 compactMessages:proactive 与 reactive 压缩产物结构一致,无双叉逻辑", async () => {
    // Same module, same function: both paths (shouldAutoCompact -> compactMessages /
    // PromptTooLongError -> compactMessages) share one structural contract for their
    // products. Here proactive calls compactMessages directly while reactive is
    // triggered via loop-engine run; assert the two "compaction segments" are
    // per-message deepEqual.
    const longPrior = Array.from({ length: 12 }, (_, i) => text(`prior-${i}`));
    const encodedQ: AnthropicNativeMessage = {
      role: "user",
      content: [{ type: "text", text: "Q" }],
    };
    const preRunMessages: ReadonlyArray<AnthropicNativeMessage> = [
      ...longPrior,
      encodedQ,
    ];

    // Expected proactive compaction: compactMessages(preRunMessages) -> 7 messages
    // (boundary placeholder + DEFAULT_KEEP_RECENT tail; no tool-pair expansion).
    const proactiveCompact = compactMessages(preRunMessages);
    assert.equal(proactiveCompact.length, 1 + DEFAULT_KEEP_RECENT);
    assert.deepStrictEqual(proactiveCompact[0], {
      role: "user",
      content: [{ type: "text", text: COMPACTION_BOUNDARY_PLACEHOLDER }],
    });

    // Reactive side: same 12 priors + "Q", driven through run to hit the PromptTooLongError fallback.
    const tool = createStubTool({ name: "noop", next: () => ({}) });
    const reg = createRegistry([tool]);
    const exec = createExecutor(reg);
    const attemptCount = { value: 0 };
    const adapter = makeFlakyAdapter({
      retryText: "ok",
      attemptCount,
    });
    const { result } = await run(
      "Q",
      {
        adapter,
        executor: exec,
        registry: reg,
        maxTurns: 5,
        compress: { contextWindow: 200_000, thresholdTokens: 10_000 },
      },
      undefined,
      { priorMessages: longPrior }
    );

    // The reactive compaction segment = result.messages.slice(0, 1 + DEFAULT_KEEP_RECENT),
    // which must deepEqual proactive's direct compactMessages product — both paths
    // share one compaction function, no forked thresholds or logic.
    const reactiveCompact = result.messages.slice(0, 1 + DEFAULT_KEEP_RECENT);
    assert.deepStrictEqual(
      reactiveCompact,
      proactiveCompact,
      "proactive 与 reactive 压缩段必须 deepEqual(共用 compactMessages)"
    );
    // The last message is the successful retry's assistant closing turn, separate from the compaction segment.
    assert.equal(
      result.messages[result.messages.length - 1]?.role,
      "assistant"
    );
  });
});
