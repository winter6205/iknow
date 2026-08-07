import { describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  shouldAutoCompact,
  compactMessages,
  estimateMessagesTokens,
  estimateTokens,
  getAutoCompactThreshold,
  validateThreshold,
  COMPACTION_BOUNDARY_PLACEHOLDER,
  DEFAULT_KEEP_RECENT,
} from "../../../src/harness/compress/index.ts";
import type { AnthropicNativeMessage } from "../../../src/harness/model-adapter/types.ts";

const text = (value: string): AnthropicNativeMessage => ({
  role: "user",
  content: [{ type: "text", text: value }],
});

describe("shouldAutoCompact", () => {
  it("estimate < threshold → false", () => {
    // 单字符 → estimate = ceil(1 * 4/3) = 2;threshold 100 → 不触发
    const messages = [text("x")];
    assert.equal(
      shouldAutoCompact(messages, { contextWindow: 200_000, threshold: 100 }),
      false
    );
  });

  it("estimate >= threshold → true", () => {
    // 100 条 40 字符消息 → 每条 estimate = ceil(11 * 4/3) = 15;total ≈ 1500
    const messages = Array.from({ length: 100 }, () => text("a".repeat(40)));
    const estimate = estimateMessagesTokens(messages);
    assert.ok(estimate > 0);
    assert.equal(
      shouldAutoCompact(messages, {
        contextWindow: 200_000,
        threshold: estimate,
      }),
      true
    );
  });

  it("边界:estimate === threshold → true (>=)", () => {
    const messages = [text("hello world")]; // 11 chars → inner 3 → ceil(3*4/3) = 4
    const estimate = estimateMessagesTokens(messages);
    assert.equal(estimate, 4);
    assert.equal(
      shouldAutoCompact(messages, { contextWindow: 200_000, threshold: 4 }),
      true
    );
  });

  it("边界:空 messages → estimate=0, false", () => {
    assert.equal(estimateMessagesTokens([]), 0);
    assert.equal(
      shouldAutoCompact([], { contextWindow: 200_000, threshold: 1 }),
      false
    );
  });

  it("单条消息 estimate>0;threshold 设 0 → true", () => {
    const messages = [text("hello")];
    assert.ok(estimateMessagesTokens(messages) > 0);
    assert.equal(
      shouldAutoCompact(messages, { contextWindow: 200_000, threshold: 0 }),
      true
    );
  });

  it("混合 block 类型:padding 后 estimate 与阈值可比", () => {
    const mixed: AnthropicNativeMessage[] = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "hi" },
          { type: "tool_use", id: "u1", name: "read", input: { path: "/x" } },
        ],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "u1", content: "ok" }],
      },
    ];
    const estimate = estimateMessagesTokens(mixed);
    assert.ok(estimate > 0);
    // 恰好等于 estimate 的阈值 → 触发;比 estimate 大 1 → 不触发
    assert.equal(
      shouldAutoCompact(mixed, { contextWindow: 200_000, threshold: estimate }),
      true
    );
    assert.equal(
      shouldAutoCompact(mixed, {
        contextWindow: 200_000,
        threshold: estimate + 1,
      }),
      false
    );
  });

  it("纯函数 / 无副作用:相同输入多次结果一致", () => {
    const messages = [text("repeatable")];
    const a = shouldAutoCompact(messages, {
      contextWindow: 200_000,
      threshold: 1_000,
    });
    const b = shouldAutoCompact(messages, {
      contextWindow: 200_000,
      threshold: 1_000,
    });
    assert.equal(b, a);
  });
});

describe("index re-exports 公共 API 可用性", () => {
  it("compactMessages 可经 index 直接调用", () => {
    const messages = Array.from({ length: 10 }, (_, i) => text(String(i)));
    const result = compactMessages(messages);
    assert.notStrictEqual(result, messages);
    assert.deepStrictEqual(result[0], {
      role: "user",
      content: [{ type: "text", text: COMPACTION_BOUNDARY_PLACEHOLDER }],
    });
  });

  it("estimate 层 helper 可经 index 调用", () => {
    assert.equal(estimateTokens(""), 0);
    assert.equal(estimateMessagesTokens([]), 0);
  });

  it("threshold 层 helper 可经 index 调用", () => {
    assert.equal(getAutoCompactThreshold(200_000, 10_000), 10_000);
    assert.equal(validateThreshold(200_000, 10_000), true);
  });

  it("constant 可经 index 引用", () => {
    assert.equal(DEFAULT_KEEP_RECENT, 6);
    assert.ok(COMPACTION_BOUNDARY_PLACEHOLDER.length > 0);
  });
});
