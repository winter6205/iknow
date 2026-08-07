import { describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  estimateTokens,
  estimateMessagesTokens,
} from "../../../src/harness/compress/estimate.ts";
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
    // surrogate pair 在 JS string 中算 2 code units;length = 4 → floor((4+3)/4) = 1
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

  it("tool_result.content 为非字符串 (number / object) → String() 后估算", () => {
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
          // object → '[object Object]' = 15 chars → floor((15+3)/4) = 4
          { type: "tool_result", tool_use_id: "u2", content: { a: 1 } },
        ],
      },
    ];
    // inner = 1 + 4 = 5; ceil(5 * 4/3) = ceil(6.666...) = 7
    assert.equal(estimateMessagesTokens(messages), 7);
  });

  it("padding 应用:total × 4/3 → Math.ceil", () => {
    // 构造恰好使 total * 4/3 非整数:total = 1 → 4/3 → ceil = 2
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
