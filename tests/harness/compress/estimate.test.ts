import { describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  estimateTokens,
  estimateMessagesTokens,
} from "../../../src/harness/compress/estimate.ts";
import {
  evaluateCompactTrigger,
  getAutoCompactThreshold,
} from "../../../src/harness/compress/index.ts";
import { TOKEN_ESTIMATION_PADDING } from "../../../src/harness/compress/constant.ts";
import type {
  AnthropicNativeMessage,
  AnthropicContentBlock,
} from "../../../src/harness/model-adapter/types.ts";

describe("estimateTokens", () => {
  it("空串 → 0", () => assert.equal(estimateTokens(""), 0));
  it("单字符 → 1 (minimum floor)", () => assert.equal(estimateTokens("a"), 1));
  it("'hello world' (11 chars) → Math.floor((11+3)/4) = 3", () =>
    assert.equal(estimateTokens("hello world"), 3));
  it("纯 emoji 串 → 按字符长度估算 (e.g. '👋🌍' = 4 chars → 1)", () => {
    // A surrogate pair counts as 2 JS code units; length = 4 -> floor((4+3)/4) = 1
    assert.equal(estimateTokens("👋🌍"), 1);
  });
  it("超大文本 (>= 10000 字符) → length/4 楼梯,无溢出", () => {
    const big = "a".repeat(10_000);
    assert.equal(estimateTokens(big), Math.floor((10_000 + 3) / 4));
  });
});

describe("estimateMessagesTokens", () => {
  it("空 messages → 0", () => assert.equal(estimateMessagesTokens([]), 0));

  it("混合 block 类型 (text + tool_use + tool_result + thinking):thinking 不计入", () => {
    const messages: AnthropicNativeMessage[] = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "hi" }, // 1
          {
            type: "tool_use",
            id: "u1",
            name: "read", // 1
            input: { path: "/x" }, // JSON.stringify → 14 chars → floor((14+3)/4) = 4
          },
          { type: "thinking", thinking: "secret", signature: "sig" }, // 0
        ],
        // inner total = 1 + 1 + 4 + 0 = 6; ceil(6 * 4/3) = 8
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "u1",
            content: "ok", // String() → 'ok' (2 chars) → floor((2+3)/4) = 1
          },
          { type: "redacted_thinking", data: "red" }, // 0
        ],
        // inner total = 1 + 0 = 1
      },
    ];
    // combined inner total = 6 + 1 = 7; ceil(7 * 4/3) = ceil(9.333...) = 10
    assert.equal(estimateMessagesTokens(messages), 10);
  });

  it("redacted_thinking 同 thinking,均不计入输入 token", () => {
    const messages: AnthropicNativeMessage[] = [
      {
        role: "assistant",
        content: [{ type: "redacted_thinking", data: "x".repeat(10_000) }],
      },
    ];
    assert.equal(estimateMessagesTokens(messages), 0);
  });

  it("tool_result.content 为非法非字符串值 → 走非零有界降级", () => {
    const messages: AnthropicNativeMessage[] = [
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "u1", content: 42 }, // '42' = 2 chars → 1
        ],
      },
      {
        role: "user",
        content: [
          // Malformed objects get a fixed non-zero degraded estimate; String(array) is never called.
          { type: "tool_result", tool_use_id: "u2", content: { a: 1 } },
        ],
      },
    ];
    // inner = 1 + 1 = 2; ceil(2 * 4/3) = ceil(2.666...) = 3
    assert.equal(estimateMessagesTokens(messages), 3);
  });

  it("tool_result.content 缺席、空数组、空串 → 有界小估算且不抛", () => {
    const messages = [
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "missing" },
          { type: "tool_result", tool_use_id: "array", content: [] },
          { type: "tool_result", tool_use_id: "string", content: "" },
        ],
      },
    ] as unknown as AnthropicNativeMessage[];

    assert.doesNotThrow(() => estimateMessagesTokens(messages));
    assert.equal(estimateMessagesTokens(messages), 0);
  });

  it("非法内容及非 text block → 不估成 0，且 evaluateCompactTrigger 不崩", () => {
    const messages = [
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "number", content: 42 },
          { type: "tool_result", tool_use_id: "object", content: { a: 1 } },
          {
            type: "tool_result",
            tool_use_id: "block",
            content: [{ type: "image", source: { data: "opaque" } }],
          },
        ],
      },
    ] as unknown as AnthropicNativeMessage[];

    const estimated = estimateMessagesTokens(messages);
    assert.ok(estimated > 0, "非法内容必须走非零降级估算");
    assert.doesNotThrow(() =>
      evaluateCompactTrigger(messages, {
        contextWindow: 200_000,
        threshold: 1,
      })
    );
  });

  it("仅含嵌套 image、无 text 的 tool_result → 估算 > 0（SC9）", () => {
    // Invariant: a pure-image tool_result must not estimate to 0, otherwise an
    // image-heavy session looks empty to the compaction decision. The exact
    // formula is not pinned; only > 0 is.
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
    assert.ok(estimateMessagesTokens(messages) > 0);
  });

  it("超长 text block 数组 → 估算足以跨越 compact threshold", () => {
    const content = [{ type: "text", text: "x".repeat(600_000) }];
    const messages: AnthropicNativeMessage[] = [
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "long", content }],
      },
    ];

    const estimated = estimateMessagesTokens(messages);
    const threshold = getAutoCompactThreshold(200_000, undefined);
    assert.ok(
      estimated > threshold,
      `正文应被计量为足够大的估算，实际为 ${estimated}`
    );
    assert.deepStrictEqual(
      evaluateCompactTrigger(messages, {
        contextWindow: 200_000,
        threshold,
      }),
      { action: "compact_via_full_summary", reason: "messages_too_few" }
    );
  });

  it("交叉估算两份 messages → 纯函数结果独立且稳定", () => {
    const first: AnthropicNativeMessage[] = [
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "first",
            content: [{ type: "text", text: "a".repeat(40_000) }],
          },
        ],
      },
    ];
    const second: AnthropicNativeMessage[] = [
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "second",
            content: [{ type: "text", text: "b".repeat(8_000) }],
          },
        ],
      },
    ];

    const firstEstimate = estimateMessagesTokens(first);
    const secondEstimate = estimateMessagesTokens(second);
    assert.equal(estimateMessagesTokens(first), firstEstimate);
    assert.equal(estimateMessagesTokens(second), secondEstimate);
    assert.ok(firstEstimate > secondEstimate);
  });

  it("text block 数组 → 远高于 String(array) 的 [object Object] 低估", () => {
    const content = [{ type: "text", text: "正文".repeat(100_000) }];
    const messages: AnthropicNativeMessage[] = [
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "compare", content }],
      },
    ];
    const legacyEstimate = estimateTokens(String(content));
    const actualEstimate = estimateMessagesTokens(messages);

    assert.equal(String(content), "[object Object]");
    assert.ok(
      actualEstimate > legacyEstimate * 100,
      `实际估算 ${actualEstimate} 应显著高于旧估算 ${legacyEstimate}`
    );
  });

  it("估算不改写 append-only messages", () => {
    const messages: AnthropicNativeMessage[] = [
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "immutable",
            content: [{ type: "text", text: "preserve me" }],
          },
        ],
      },
    ];
    const before = structuredClone(messages);

    estimateMessagesTokens(messages);

    assert.deepStrictEqual(messages, before);
  });

  it("padding 应用:total × 4/3 → Math.ceil", () => {
    // Build a case where total * 4/3 is non-integral: total = 1 -> 4/3 -> ceil = 2
    const messages: AnthropicNativeMessage[] = [
      { role: "user", content: [{ type: "text", text: "x" }] }, // total = 1
    ];
    assert.equal(
      estimateMessagesTokens(messages),
      Math.ceil(1 * TOKEN_ESTIMATION_PADDING)
    );
  });

  it("空 block 列表 → 0", () => {
    const messages: AnthropicNativeMessage[] = [{ role: "user", content: [] }];
    assert.equal(estimateMessagesTokens(messages), 0);
  });

  it("纯函数 / 无副作用:相同输入两次结果相同", () => {
    const messages: AnthropicNativeMessage[] = [
      {
        role: "assistant",
        content: [{ type: "text", text: "repeatable" }],
      },
    ];
    const a = estimateMessagesTokens(messages);
    const b = estimateMessagesTokens(messages);
    assert.equal(a, b);
  });
});
