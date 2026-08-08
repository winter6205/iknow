/**
 * tests/tui/message-rows.test.ts
 *
 * #189 修复版：message-rows.ts 行账 SSOT 单元测试。
 *  - 行账对齐 ink 实测渲染（不再用旧字符数 wrapText 模型）；
 *  - `messageRender` 的 flat 物理行数组与 `<MessageBlocks>` 渲染行数一致
 *    （由 chat-view parity 测试交叉验证）；
 *  - kind 判别字段对每类块形态（user-text / thinking / redacted / text /
 *    tool_use）正确填充（空 thinking 与 tool_use 碰撞回归）。
 */
import { describe, expect, it } from "vitest";
import { measureMessage, messageRender } from "../../src/tui/message-rows.js";
import type { AnthropicNativeMessage } from "../../src/harness/model-adapter/types.js";

describe("messageRender（flat 物理行 SSOT）", () => {
  it("user 空文本：totalRows=0，无 blocks，lines 空", () => {
    const msg: AnthropicNativeMessage = {
      role: "user",
      content: [{ type: "text", text: "   " }],
    };
    const r = messageRender(msg, 80);
    expect(r.totalRows).toBe(0);
    expect(r.blocks).toHaveLength(0);
    expect(r.lines).toHaveLength(0);
  });

  it("user 短文本：1 行内容 + margin = totalRows 2", () => {
    const msg: AnthropicNativeMessage = {
      role: "user",
      content: [{ type: "text", text: "hi" }],
    };
    const r = messageRender(msg, 80);
    expect(r.lines).toEqual(["❯ hi"]);
    expect(r.totalRows).toBe(2);
  });

  it("user 长文本：视觉宽度折行（首行 ❯ 前缀在 cols 内）", () => {
    const msg: AnthropicNativeMessage = {
      role: "user",
      content: [{ type: "text", text: "abcdefghij" }],
    };
    const r = messageRender(msg, 8);
    // cols=8：整体 wrapVisual("❯ abcdefghij", 8)，❯ 占 1 列 → 「❯ abcdef」
    // (宽 8) + 「ghij」 = 2 行 + 1 margin
    expect(r.lines).toEqual(["❯ abcdef", "ghij"]);
    expect(r.totalRows).toBe(3);
  });

  it("assistant 简单文本：markdownToLines 1 行 + margin = totalRows 3", () => {
    const msg: AnthropicNativeMessage = {
      role: "assistant",
      content: [{ type: "text", text: "hello" }],
    };
    const r = messageRender(msg, 80);
    expect(r.lines).toEqual(["hello", " "]);
    expect(r.totalRows).toBe(3);
  });

  it("assistant fence：边框行计入行账（markdownToLines parity）", () => {
    const msg: AnthropicNativeMessage = {
      role: "assistant",
      content: [{ type: "text", text: "```ts\nconst x = 1;\n```" }],
    };
    const r = messageRender(msg, 80);
    // fence 行账：┌┐ 1 + lang 1 + 内容 1 + └┘ 1 + margin = 5 行内容 + 1 margin
    expect(r.lines.length).toBe(5);
    expect(r.lines[0]).toMatch(/^┌─/);
    expect(r.totalRows).toBe(6);
  });

  it("assistant 纯 tool_use：1 行摘要（无 own margin）+ 外层 margin", () => {
    const msg: AnthropicNativeMessage = {
      role: "assistant",
      content: [{ type: "tool_use", id: "x", name: "bash", input: {} }],
    };
    const r = messageRender(msg, 80);
    expect(r.lines.length).toBe(1);
    expect(r.lines[0]).toMatch(/^bash · /);
    expect(r.totalRows).toBe(2);
  });

  it("assistant 空 content：totalRows=0", () => {
    const msg: AnthropicNativeMessage = {
      role: "assistant",
      content: [],
    };
    expect(messageRender(msg, 80).totalRows).toBe(0);
  });

  it("thinking 折叠 + text：[思考] 行 + margin + text + margin", () => {
    const msg: AnthropicNativeMessage = {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "raw", signature: "s" },
        { type: "text", text: "answer" },
      ],
    };
    const r = messageRender(msg, 80);
    expect(r.lines).toEqual(["[思考]", " ", "answer", " "]);
    expect(r.totalRows).toBe(5);
  });

  it("thinking 展开：每段 thinking 原文行 + margin", () => {
    const msg: AnthropicNativeMessage = {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "first", signature: "s1" },
        { type: "thinking", thinking: "second", signature: "s2" },
        { type: "text", text: "ok" },
      ],
    };
    const r = messageRender(msg, 80, { thinkingExpanded: true });
    expect(r.lines).toEqual(["first", " ", "second", " ", "ok", " "]);
    expect(r.totalRows).toBe(7);
  });

  it("CJK 文本按视觉宽度折行（2 列/字，不按字符数低估）", () => {
    const msg: AnthropicNativeMessage = {
      role: "assistant",
      content: [{ type: "text", text: "一二三四五六七八九十" }],
    };
    const r = messageRender(msg, 10);
    // 10 个 CJK × 2 列 = 20 列，cols=10 → 2 行
    expect(r.lines.filter((l) => l !== " ")).toEqual([
      "一二三四五",
      "六七八九十",
    ]);
  });
});

describe("measureMessage（向后兼容入口）", () => {
  it("totalRows = messageRender.totalRows", () => {
    const msg: AnthropicNativeMessage = {
      role: "assistant",
      content: [{ type: "text", text: "hello world" }],
    };
    expect(measureMessage(msg, 80).totalRows).toBe(
      messageRender(msg, 80).totalRows
    );
  });
});

describe("measureMessage（kind 判别字段）", () => {
  it("user 文本块：kind=user-text, text=原文", () => {
    const msg: AnthropicNativeMessage = {
      role: "user",
      content: [
        { type: "text", text: "hello" },
        { type: "text", text: "world" },
      ],
    };
    const r = measureMessage(msg, 80);
    expect(r.blocks).toHaveLength(1);
    const span = r.blocks[0];
    expect(span?.kind).toBe("user-text");
    expect(span?.text).toBe("hello\nworld");
    expect(span?.startRow).toBe(0);
  });

  it("assistant thinking 折叠：kind=thinking, text=摘要, rows=1", () => {
    const msg: AnthropicNativeMessage = {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "raw thought", signature: "s" },
        { type: "text", text: "ok" },
      ],
    };
    const r = measureMessage(msg, 80);
    const thinking = r.blocks[0];
    expect(thinking?.kind).toBe("thinking");
    expect(thinking?.rows).toBe(1);
    expect(thinking?.text).toBe("思考（1 段）");
  });

  it("assistant thinking 展开：每段 kind=thinking, text=原文", () => {
    const msg: AnthropicNativeMessage = {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "first", signature: "s1" },
        { type: "thinking", thinking: "second", signature: "s2" },
        { type: "text", text: "ok" },
      ],
    };
    const r = measureMessage(msg, 80, { thinkingExpanded: true });
    expect(r.blocks[0]?.kind).toBe("thinking");
    expect(r.blocks[0]?.text).toBe("first");
    expect(r.blocks[1]?.kind).toBe("thinking");
    expect(r.blocks[1]?.text).toBe("second");
  });

  it("assistant redacted_thinking：kind=redacted, text=REDACTED_PLACEHOLDER", () => {
    const msg: AnthropicNativeMessage = {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "before", signature: "s" },
        { type: "redacted_thinking", data: "x" },
      ],
    };
    const r = measureMessage(msg, 80, { thinkingExpanded: true });
    expect(r.blocks[0]?.kind).toBe("thinking");
    expect(r.blocks[1]?.kind).toBe("redacted");
    expect(r.blocks[1]?.text).toBe("[已加密思考]");
    expect(r.blocks[1]?.rows).toBe(1);
  });

  it("assistant text 块：kind=text, text=原文", () => {
    const msg: AnthropicNativeMessage = {
      role: "assistant",
      content: [{ type: "text", text: "hello world" }],
    };
    const r = measureMessage(msg, 80);
    expect(r.blocks).toHaveLength(1);
    const span = r.blocks[0];
    expect(span?.kind).toBe("text");
    expect(span?.text).toBe("hello world");
  });

  it("assistant tool_use：kind=tool_use, rows=1, toolUseId=id", () => {
    const msg: AnthropicNativeMessage = {
      role: "assistant",
      content: [{ type: "tool_use", id: "x", name: "bash", input: {} }],
    };
    const r = measureMessage(msg, 80);
    expect(r.blocks).toHaveLength(1);
    const span = r.blocks[0];
    expect(span?.kind).toBe("tool_use");
    expect(span?.rows).toBe(1);
    expect(span?.toolUseId).toBe("x");
  });

  it("kind 判别：空 thinking 与 tool_use 不碰撞（Primitive Obsession 回归）", () => {
    const msg: AnthropicNativeMessage = {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "", signature: "s" },
        { type: "text", text: "ok" },
      ],
    };
    const r = measureMessage(msg, 80, { thinkingExpanded: true });
    expect(r.blocks[0]?.kind).toBe("thinking");
    expect(r.blocks[1]?.kind).toBe("text");
  });

  it("user-text 块与 empty text 不触发（无 blocks）", () => {
    const msg: AnthropicNativeMessage = {
      role: "user",
      content: [{ type: "text", text: "" }],
    };
    const r = measureMessage(msg, 80);
    expect(r.blocks).toHaveLength(0);
    expect(r.totalRows).toBe(0);
  });
});
