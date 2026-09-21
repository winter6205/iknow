/**
 * Unit tests for the unified trigger decision `evaluateCompactTrigger`.
 *
 * Covers the 3 classification branches:
 *   - tokens over threshold + droppable prefix -> compact_via_window / windowed
 *   - tokens over threshold + no droppable prefix -> compact_via_full_summary / messages_too_few
 *   - tokens below threshold -> noop / below_token_threshold
 *
 * `preserveToolPairs` returns `slicedFrom === 0` when
 * `messages.length <= keepRecent`, so the messages_too_few path inherently
 * carries the "too few messages, all in the tail" semantics; the cases below
 * exploit that invariant directly.
 */
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  evaluateCompactTrigger,
  estimateMessagesTokens,
} from "../../../src/harness/compress/index.ts";
import type {
  AnthropicNativeMessage,
  TokenUsage,
} from "../../../src/harness/model-adapter/types.ts";

const text = (value: string): AnthropicNativeMessage => ({
  role: "user",
  content: [{ type: "text", text: value }],
});

describe("evaluateCompactTrigger — 统一触发判据 (plan compress-trigger-gate T1)", () => {
  it("token 已超 + messages.length=10(可丢前缀)→ compact_via_window / windowed", () => {
    // 10 texts of 9000 chars -> per-message estimate = floor((9000+3)/4) = 2250;
    // raw total = 22500; estimateMessagesTokens = ceil(22500 * 4/3) = 30000.
    // threshold=10000 is far below estimate -> window guard applies;
    // 10 > 6 (DEFAULT_KEEP_RECENT) -> slicedFrom > 0 -> windowed.
    const messages = Array.from({ length: 10 }, () => text("x".repeat(9000)));
    const estimate = estimateMessagesTokens(messages);
    assert.ok(estimate >= 30_000, `前置断言: estimate=${estimate} 应 ≥ 30k`);

    const decision = evaluateCompactTrigger(messages, {
      contextWindow: 200_000,
      threshold: 10_000,
    });
    assert.deepStrictEqual(decision, {
      action: "compact_via_window",
      reason: "windowed",
    });
  });

  it("token 已超 + messages.length=3(≤ keepRecent)→ compact_via_full_summary / messages_too_few", () => {
    // 3 texts of 60000 chars -> per-message estimate = floor((60000+3)/4) = 15000;
    // raw total = 45000; estimate ≈ 60000 (far over threshold). 3 ≤ 6
    // (DEFAULT_KEEP_RECENT) -> preserveToolPairs returns slicedFrom=0 -> messages_too_few.
    const messages = Array.from({ length: 3 }, () => text("x".repeat(60_000)));
    const estimate = estimateMessagesTokens(messages);
    assert.ok(estimate >= 60_000, `前置断言: estimate=${estimate} 应 ≥ 60k`);

    const decision = evaluateCompactTrigger(messages, {
      contextWindow: 200_000,
      threshold: 1_000,
    });
    assert.deepStrictEqual(decision, {
      action: "compact_via_full_summary",
      reason: "messages_too_few",
    });
  });

  it("messages.length=5 + 低 token(未达阈值)→ noop / below_token_threshold", () => {
    // 5 texts of 1000 chars -> per-message estimate = floor((1000+3)/4) = 250;
    // raw total = 1250; estimateMessagesTokens = ceil(1250 * 4/3) = 1667.
    // threshold=5000 is far above estimate -> below_token_threshold -> noop.
    const messages = Array.from({ length: 5 }, () => text("x".repeat(1000)));
    const estimate = estimateMessagesTokens(messages);
    assert.ok(
      estimate > 0 && estimate < 5_000,
      `前置断言: estimate=${estimate}`
    );

    const decision = evaluateCompactTrigger(messages, {
      contextWindow: 200_000,
      threshold: 5_000,
    });
    assert.deepStrictEqual(decision, {
      action: "noop",
      reason: "below_token_threshold",
    });
  });
});

describe("evaluateCompactTrigger — 仅含嵌套 image 的 tool_result 不崩 (SC9)", () => {
  it("纯 image tool_result(无 text)→ 不抛且返回合法判定", () => {
    // Invariant: an image-only tool_result must never throw under the compaction
    // decision, and must return a legal verdict of the three-branch union. The
    // formula is not pinned and no specific branch is asserted.
    const imageData =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==".repeat(
        64
      );
    const messages: AnthropicNativeMessage[] = [
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "img1",
            content: [
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: "image/png",
                  data: imageData,
                },
              },
            ],
          },
        ],
      },
    ];

    const evaluate = (threshold: number) =>
      evaluateCompactTrigger(messages, {
        contextWindow: 200_000,
        threshold,
      });

    assert.doesNotThrow(() => evaluate(1));
    assert.doesNotThrow(() => evaluate(1_000_000));
    for (const decision of [evaluate(1), evaluate(1_000_000)]) {
      assert.ok(
        decision.action === "noop" ||
          decision.action === "compact_via_full_summary" ||
          decision.action === "compact_via_window",
        `非法判定分支: ${JSON.stringify(decision)}`
      );
    }
  });
});

/**
 * Occupancy numerator (ADR-0118): the compared number is context occupancy,
 * resolved by priority this-beat measurement (finite && > 0) -> previous-beat
 * occupancy from last successful API usage -> chars estimate. Absence or
 * invalidity of a measurement must fall through the chain, never collapse
 * into `below_token_threshold`.
 *
 * Baseline fixture below: 10 texts of 100 chars -> per-message estimate =
 * floor((100+3)/4) = 25; raw total = 250; estimateMessagesTokens = 334
 * (derived at runtime, not hardcoded). 10 > DEFAULT_KEEP_RECENT so an
 * over-threshold verdict is compact_via_window.
 */
describe("evaluateCompactTrigger — context occupancy 优先级 (ADR-0118)", () => {
  const messages = Array.from({ length: 10 }, () => text("x".repeat(100)));
  const estimate = estimateMessagesTokens(messages);
  // threshold strictly above the estimate: estimate-alone would noop.
  const threshold = estimate + 1;
  const over = {
    inputTokens: threshold * 10,
    outputTokens: 0,
    cacheCreationInputTokens: null,
    cacheReadInputTokens: null,
  } satisfies TokenUsage;
  const under = {
    inputTokens: 10,
    outputTokens: 0,
    cacheCreationInputTokens: null,
    cacheReadInputTokens: null,
  } satisfies TokenUsage;

  const evaluate = (
    ctx: Partial<{
      thisBeatOccupancy: number;
      previousUsage: TokenUsage;
    }> = {}
  ) =>
    evaluateCompactTrigger(messages, {
      contextWindow: 200_000,
      threshold,
      ...ctx,
    });

  it("empty: 无本拍实测、无上拍 usage、估算低于阈值 → noop / below_token_threshold", () => {
    assert.ok(estimate < threshold, `前置断言: estimate=${estimate}`);
    assert.deepStrictEqual(evaluate(), {
      action: "noop",
      reason: "below_token_threshold",
    });
  });

  it("overflow: 上拍 usage occupancy 超阈值而估算低于 → 不得 noop", () => {
    assert.deepStrictEqual(evaluate({ previousUsage: over }), {
      action: "compact_via_window",
      reason: "windowed",
    });
  });

  it("concurrent: 本拍 countTokens 与上拍 occupancy 不一致 → 本拍优先(低于阈值 → noop)", () => {
    // previous usage is over, but this beat measures a small occupancy.
    assert.deepStrictEqual(
      evaluate({ thisBeatOccupancy: 10, previousUsage: over }),
      {
        action: "noop",
        reason: "below_token_threshold",
      }
    );
  });

  it("concurrent: 本拍 countTokens 高于阈值而上拍低于 → 本拍优先 → 不 noop", () => {
    assert.deepStrictEqual(
      evaluate({ thisBeatOccupancy: threshold, previousUsage: under }),
      {
        action: "compact_via_window",
        reason: "windowed",
      }
    );
  });

  it("exception: 本拍实测非有限或 ≤0 (NaN/Infinity/-1/0) → 穿透到上拍 occupancy", () => {
    for (const invalid of [NaN, Infinity, -Infinity, -1, 0]) {
      assert.deepStrictEqual(
        evaluate({ thisBeatOccupancy: invalid, previousUsage: over }),
        { action: "compact_via_window", reason: "windowed" },
        `本拍实测 ${invalid} 应视为无实测，落到上拍 occupancy`
      );
    }
  });

  it("exception: 本拍无效 + 上拍 usage 非法(NaN) → 继续穿透到估算，估算超阈值不 noop", () => {
    const nanUsage: TokenUsage = {
      inputTokens: NaN,
      outputTokens: 0,
      cacheCreationInputTokens: null,
      cacheReadInputTokens: null,
    };
    const lowThreshold = estimate - 1;
    const decision = evaluateCompactTrigger(messages, {
      contextWindow: 200_000,
      threshold: lowThreshold,
      thisBeatOccupancy: NaN,
      previousUsage: nanUsage,
    });
    assert.deepStrictEqual(decision, {
      action: "compact_via_window",
      reason: "windowed",
    });
  });

  it("exception: 本拍无效 + 上拍 occupancy 低于阈值 → 比较数确为低于阈值才 noop，不得因缺失收成 noop", () => {
    // previous usage is present and legitimately under threshold here.
    assert.deepStrictEqual(
      evaluate({ thisBeatOccupancy: NaN, previousUsage: under }),
      {
        action: "noop",
        reason: "below_token_threshold",
      }
    );
  });

  it("本拍实测有效时即使估算很低也按本拍判定(估算不参与)", () => {
    assert.deepStrictEqual(evaluate({ thisBeatOccupancy: threshold }), {
      action: "compact_via_window",
      reason: "windowed",
    });
  });
});
