/**
 * tests/tui/message-rows.test.ts
 *
 * #189 Commit 2：message-rows.ts SSOT 单元测试。
 *  - `rowsForText`：纯文本行数 SSOT = max(1, wrapText(text, cols).length)。
 *  - `measureMessage`：消息级 block-row 布局，`totalRows` 与现有
 *    `estimateMessageRows` 严格一致（保证 buildMessageRowSpans 的窗口数学
 *    与本模块的 block-level 切片坐标对齐）；kind 判别字段对每类块
 *    形态（user-text / thinking / redacted / text / tool_use）正确填充。
 *
 * 注：早期 markdown 子块行级高度测试（measureBlocks 套件）已随
 * rowRange 一起移除——该函数从 src/tui/markdown.tsx 反向收回（chat-view
 * 不再按块切片渲染），是孤立 API，无消费方。
 */
import { describe, expect, it } from "vitest";
import { measureMessage, rowsForText } from "../../src/tui/message-rows.js";
import type { AnthropicNativeMessage } from "../../src/harness/model-adapter/types.js";

describe("rowsForText（纯文本行数 SSOT）", () => {
  it("空文本占 1 行", () => {
    expect(rowsForText("", 80)).toBe(1);
  });

  it("短文本 1 行", () => {
    expect(rowsForText("hello", 80)).toBe(1);
  });

  it("按 cols 折行（bytes）", () => {
    // 20 chars at cols=6 → ceil(20/6)=4 行
    expect(rowsForText("a".repeat(20), 6)).toBe(4);
  });

  it("显式换行算独立行", () => {
    expect(rowsForText("a\nb\nc", 80)).toBe(3);
  });
});

describe("measureMessage（消息级 block-row 布局）", () => {
  it("user 空文本：totalRows=0，无 blocks", () => {
    const msg: AnthropicNativeMessage = {
      role: "user",
      content: [{ type: "text", text: "   " }],
    };
    const r = measureMessage(msg, 80);
    expect(r.totalRows).toBe(0);
    expect(r.blocks).toHaveLength(0);
  });

  it("user 短文本：rows=1 + margin = 2", () => {
    const msg: AnthropicNativeMessage = {
      role: "user",
      content: [{ type: "text", text: "hi" }],
    };
    const r = measureMessage(msg, 80);
    expect(r.totalRows).toBe(2);
    expect(r.blocks[0]?.rows).toBe(1);
  });

  it("user 长文本折行：20a at cols=8 → rows=4 + margin = 5", () => {
    const msg: AnthropicNativeMessage = {
      role: "user",
      content: [{ type: "text", text: "a".repeat(20) }],
    };
    expect(measureMessage(msg, 8).totalRows).toBe(5);
  });

  it("assistant 简单文本：1 row + margin = 2", () => {
    const msg: AnthropicNativeMessage = {
      role: "assistant",
      content: [{ type: "text", text: "hello" }],
    };
    expect(measureMessage(msg, 80).totalRows).toBe(2);
  });

  it("assistant 多 text 块：各 +margin = 4", () => {
    const msg: AnthropicNativeMessage = {
      role: "assistant",
      content: [
        { type: "text", text: "a" },
        { type: "text", text: "b" },
      ],
    };
    expect(measureMessage(msg, 80).totalRows).toBe(4);
  });

  it("assistant 纯 tool_use：summary row + margin = 2", () => {
    const msg: AnthropicNativeMessage = {
      role: "assistant",
      content: [{ type: "tool_use", id: "x", name: "bash", input: {} }],
    };
    expect(measureMessage(msg, 80).totalRows).toBe(2);
  });

  it("assistant 空 content：totalRows=0", () => {
    const msg: AnthropicNativeMessage = {
      role: "assistant",
      content: [],
    };
    expect(measureMessage(msg, 80).totalRows).toBe(0);
  });

  it("thinking 折叠：summary row + text + margin = 3", () => {
    const msg: AnthropicNativeMessage = {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "a", signature: "s" },
        { type: "text", text: "answer" },
      ],
    };
    expect(measureMessage(msg, 80).totalRows).toBe(3);
  });

  it("thinking 展开 + redacted + text：1+1+1+margin = 4", () => {
    const msg: AnthropicNativeMessage = {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "a", signature: "s" },
        { type: "redacted_thinking", data: "x" },
        { type: "text", text: "answer" },
      ],
    };
    expect(measureMessage(msg, 80, { thinkingExpanded: true }).totalRows).toBe(
      4
    );
  });

  it("user blocks 的 startRow 累加（单 unit：contentStart=0）", () => {
    const msg: AnthropicNativeMessage = {
      role: "user",
      content: [{ type: "text", text: "hi" }],
    };
    const r = measureMessage(msg, 80);
    expect(r.blocks).toHaveLength(1);
    expect(r.blocks[0]?.startRow).toBe(0);
    expect(r.blocks[0]?.rows).toBe(1);
    // 文本块总行 = contentRows + 1 margin
    expect(r.totalRows).toBe(2);
  });
});

describe("measureMessage（kind 判别字段）", () => {
  it("user 文本块：kind=user-text, text=原文, rows=rowsForText(joined, cols-2)", () => {
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
    expect(span?.rows).toBe(2); // join("\n") 显式换行算独立行
    expect(span?.startRow).toBe(0);
  });

  it("assistant thinking 折叠：kind=thinking, text=summarizeThinkingContent(...), rows=1", () => {
    const msg: AnthropicNativeMessage = {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "raw thought", signature: "s" },
        { type: "text", text: "ok" },
      ],
    };
    const r = measureMessage(msg, 80);
    // 第一个 span 是折叠 thinking 摘要（synthesized by summarizeThinkingContent）
    const thinking = r.blocks[0];
    expect(thinking?.kind).toBe("thinking");
    expect(thinking?.rows).toBe(1);
    expect(thinking?.text).toBe("思考（1 段）");
  });

  it("assistant thinking 展开：每段 thinking 各自 kind=thinking, text=原文", () => {
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
    expect(r.blocks[0]?.rows).toBe(1);
    expect(r.blocks[1]?.kind).toBe("thinking");
    expect(r.blocks[1]?.text).toBe("second");
    expect(r.blocks[1]?.startRow).toBe(1);
  });

  it("assistant redacted_thinking：kind=redacted, text=REDACTED_PLACEHOLDER, rows=1", () => {
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

  it("assistant text 块：kind=text, text=原文, rows=rowsForText(text, cols)", () => {
    const msg: AnthropicNativeMessage = {
      role: "assistant",
      content: [{ type: "text", text: "hello world" }],
    };
    const r = measureMessage(msg, 80);
    expect(r.blocks).toHaveLength(1);
    const span = r.blocks[0];
    expect(span?.kind).toBe("text");
    expect(span?.text).toBe("hello world");
    expect(span?.rows).toBe(1);
  });

  it("assistant tool_use：kind=tool_use, text='', rows=2（含 1 margin）", () => {
    const msg: AnthropicNativeMessage = {
      role: "assistant",
      content: [{ type: "tool_use", id: "x", name: "bash", input: {} }],
    };
    const r = measureMessage(msg, 80);
    expect(r.blocks).toHaveLength(1);
    const span = r.blocks[0];
    expect(span?.kind).toBe("tool_use");
    expect(span?.text).toBe("");
    expect(span?.rows).toBe(2);
  });

  it("kind 判别：text 块与 tool_use 块不会与空 thinking 串碰撞", () => {
    // Primitive Obsession 气味（伪 MdBlock + text==="" 判别）的回归保护：
    // 显式空 thinking 不应被误判为 tool_use。
    const msg: AnthropicNativeMessage = {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "", signature: "s" },
        { type: "text", text: "ok" },
      ],
    };
    const r = measureMessage(msg, 80, { thinkingExpanded: true });
    expect(r.blocks[0]?.kind).toBe("thinking");
    expect(r.blocks[0]?.text).toBe("");
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
