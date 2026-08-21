/**
 * plan compress-trigger-gate T1:统一触发判据 `evaluateCompactTrigger` 单测。
 *
 * 覆盖 3 个分类分支:
 *   - token 已超阈值 + 有可丢前缀 → compact_via_window / windowed
 *   - token 已超阈值 + 无可丢前缀 → compact_via_full_summary / messages_too_few
 *   - token 未达阈值 → noop / below_token_threshold
 *
 * `preserveToolPairs` 在 `messages.length <= keepRecent` 时返回
 * `slicedFrom === 0`,因此 messages_too_few 路径天然包含"消息条数过少 +
 * 全在尾部"的语义;下方 case 直接用此不变量构造。
 */
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  evaluateCompactTrigger,
  estimateMessagesTokens,
} from "../../../src/harness/compress/index.ts";
import type { AnthropicNativeMessage } from "../../../src/harness/model-adapter/types.ts";

const text = (value: string): AnthropicNativeMessage => ({
  role: "user",
  content: [{ type: "text", text: value }],
});

describe("evaluateCompactTrigger — 统一触发判据 (plan compress-trigger-gate T1)", () => {
  it("token 已超 + messages.length=10(可丢前缀)→ compact_via_window / windowed", () => {
    // 10 条 9000-char 文本 → 单条 estimate = floor((9000+3)/4) = 2250;
    // 总 raw = 22500;estimateMessagesTokens = ceil(22500 * 4/3) = 30000。
    // threshold=10000 远低于 estimate → 走窗口守门,10 > 6(DEFAULT_KEEP_RECENT)
    // → slicedFrom > 0 → windowed。
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
    // 3 条 60000-char 文本 → 单条 estimate = floor((60000+3)/4) = 15000;
    // 总 raw = 45000;estimate ≈ 60000(远超阈值)。3 ≤ 6(DEFAULT_KEEP_RECENT)
    // → preserveToolPairs 返 slicedFrom=0 → messages_too_few。
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
    // 5 条 1000-char 文本 → 单条 estimate = floor((1000+3)/4) = 250;
    // 总 raw = 1250;estimateMessagesTokens = ceil(1250 * 4/3) = 1667。
    // threshold=5000 远高于 estimate → below_token_threshold → noop。
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
