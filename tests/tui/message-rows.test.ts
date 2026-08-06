/**
 * tests/tui/message-rows.test.ts
 *
 * #189 Commit 2：message-rows.ts SSOT 单元测试。
 *  - `rowsForText`：纯文本行数 SSOT = max(1, wrapText(text, cols).length)
 *  - `measureBlocks`：markdown 子块行级高度（paragraph / fence / heading /
 *    quote / list / blank / table），累加 startRow。
 *  - `measureMessage`：消息级 block-row 布局，totalRows 与现有
 *    `estimateMessageRows` 严格一致（保证 buildMessageRowSpans 的窗口数学
 *    与本模块的 block-level 切片坐标对齐）。
 */
import { describe, expect, it } from "vitest";
import {
  measureBlocks,
  measureMessage,
  rowsForText,
} from "../../src/tui/message-rows.js";
import { estimateMessageRows } from "../../src/tui/chat-view.js";
import { parseBlocks } from "../../src/tui/markdown.js";
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

describe("measureBlocks（markdown 子块行级高度）", () => {
  it("单 paragraph：1 行", () => {
    const blocks = parseBlocks("hello");
    const spans = measureBlocks(blocks, 80);
    expect(spans).toHaveLength(1);
    expect(spans[0]?.startRow).toBe(0);
    expect(spans[0]?.rows).toBe(1);
  });

  it("多个段落累加 startRow", () => {
    const blocks = parseBlocks("hello\n\nworld\n\nagain");
    // [paragraph "hello"(1), blank(1), paragraph "world"(1), blank(1), paragraph "again"(1)]
    const spans = measureBlocks(blocks, 80);
    expect(spans).toHaveLength(5);
    expect(spans[0]?.startRow).toBe(0);
    expect(spans[1]?.startRow).toBe(1);
    expect(spans[2]?.startRow).toBe(2);
    expect(spans[3]?.startRow).toBe(3);
    expect(spans[4]?.startRow).toBe(4);
    expect(spans.map((s) => s.rows)).toEqual([1, 1, 1, 1, 1]);
  });

  it("fence 带 lang：1 header + N lines", () => {
    const blocks = parseBlocks("```js\nconst x = 1;\nconst y = 2;\n```");
    // fence lang="js", lines=["const x = 1;","const y = 2;"]
    const spans = measureBlocks(blocks, 80);
    expect(spans[0]?.rows).toBe(3); // 1 header + 2 lines
  });

  it("fence 不带 lang：0 header + N lines", () => {
    const blocks = parseBlocks("```\nline1\n```");
    expect(blocks[0]?.type).toBe("fence");
    if (blocks[0]?.type === "fence") {
      expect(blocks[0].lang).toBe("");
      const spans = measureBlocks(blocks, 80);
      expect(spans[0]?.rows).toBe(1); // only the line, no header
    }
  });

  it("heading H1：1 + marginTop", () => {
    const blocks = parseBlocks("# Title");
    const spans = measureBlocks(blocks, 80);
    expect(spans[0]?.rows).toBe(2); // 1 + marginTop for level 1
  });

  it("heading H2：1 行", () => {
    const blocks = parseBlocks("## Title");
    const spans = measureBlocks(blocks, 80);
    expect(spans[0]?.rows).toBe(1);
  });

  it("quote：1 per line", () => {
    const blocks = parseBlocks("> a\n> b\n> c");
    const spans = measureBlocks(blocks, 80);
    expect(spans[0]?.rows).toBe(3);
  });

  it("list：1 per item", () => {
    const blocks = parseBlocks("- a\n- b\n- c");
    const spans = measureBlocks(blocks, 80);
    expect(spans[0]?.rows).toBe(3);
  });

  it("blank：1 行", () => {
    const blocks = parseBlocks("a\n\nb");
    // [paragraph "a", blank, paragraph "b"]
    const spans = measureBlocks(blocks, 80);
    expect(spans[1]?.rows).toBe(1);
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

  it("user 短文本：totalRows === estimateMessageRows", () => {
    const msg: AnthropicNativeMessage = {
      role: "user",
      content: [{ type: "text", text: "hi" }],
    };
    expect(measureMessage(msg, 80).totalRows).toBe(
      estimateMessageRows(msg, 80)
    );
  });

  it("user 长文本折行：totalRows === estimate", () => {
    const msg: AnthropicNativeMessage = {
      role: "user",
      content: [{ type: "text", text: "a".repeat(20) }],
    };
    expect(measureMessage(msg, 8).totalRows).toBe(estimateMessageRows(msg, 8));
  });

  it("assistant 简单文本：totalRows === estimate", () => {
    const msg: AnthropicNativeMessage = {
      role: "assistant",
      content: [{ type: "text", text: "hello" }],
    };
    expect(measureMessage(msg, 80).totalRows).toBe(
      estimateMessageRows(msg, 80)
    );
  });

  it("assistant 多 text 块：totalRows === estimate", () => {
    const msg: AnthropicNativeMessage = {
      role: "assistant",
      content: [
        { type: "text", text: "a" },
        { type: "text", text: "b" },
      ],
    };
    expect(measureMessage(msg, 80).totalRows).toBe(
      estimateMessageRows(msg, 80)
    );
  });

  it("assistant 纯 tool_use：totalRows === estimate (2)", () => {
    const msg: AnthropicNativeMessage = {
      role: "assistant",
      content: [{ type: "tool_use", id: "x", name: "bash", input: {} }],
    };
    expect(measureMessage(msg, 80).totalRows).toBe(
      estimateMessageRows(msg, 80)
    );
    expect(measureMessage(msg, 80).totalRows).toBe(2);
  });

  it("assistant 空 content：totalRows=0", () => {
    const msg: AnthropicNativeMessage = {
      role: "assistant",
      content: [],
    };
    expect(measureMessage(msg, 80).totalRows).toBe(0);
  });

  it("thinking 折叠：totalRows === estimate (3)", () => {
    const msg: AnthropicNativeMessage = {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "a", signature: "s" },
        { type: "text", text: "answer" },
      ],
    };
    expect(measureMessage(msg, 80).totalRows).toBe(
      estimateMessageRows(msg, 80)
    );
    expect(measureMessage(msg, 80).totalRows).toBe(3);
  });

  it("thinking 展开 + redacted + text：totalRows === estimate (4)", () => {
    const msg: AnthropicNativeMessage = {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "a", signature: "s" },
        { type: "redacted_thinking", data: "x" },
        { type: "text", text: "answer" },
      ],
    };
    expect(measureMessage(msg, 80, { thinkingExpanded: true }).totalRows).toBe(
      estimateMessageRows(msg, 80, { thinkingExpanded: true })
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
