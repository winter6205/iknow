/**
 * src/tui/message-rows.ts — 消息 / markdown 块行级高度 SSOT（#189 Commit 2）。
 *
 * 目标：把 ChatView 行级滚动的「消息 → 物理行」映射做成单一权威来源，
 * 供两处消费：
 *  1. 窗口选消息（buildMessageRowSpans 的 totalRows 累加，保持与旧的
 *     `estimateMessageRows` 语义逐字节一致）；
 *  2. 行级切片（markdown.tsx 的 `rowRange` + chat-view.tsx 的
 *     `MessageBlocksRowRange`）——块级 startRow/rows 精确坐标，才能把
 *     视口窗口落到"块内部"（fence 前几行 / 段落折叠某几行）。
 *
 * 行高规则必须与 src/tui/markdown.tsx 的实际渲染严格对齐（见各块注释）。
 * 纯文本折行统一走 `rowsForText`（max(1, wrapText)。SSOT）。
 */
import type { AnthropicNativeMessage } from "../harness/model-adapter/types.js";
import { wrapText } from "./text.js";
import {
  REDACTED_PLACEHOLDER,
  summarizeThinkingContent,
} from "../cli/format.js";
import type { MdBlock } from "./markdown.js";

/** 纯文本按 cols 折行的物理行数 SSOT：max(1, wrapText(text, cols).length)。 */
export function rowsForText(text: string, cols: number): number {
  return Math.max(1, wrapText(text, cols).length);
}

/** 单个 markdown 块的行级跨度（块内部坐标，从块起始累计）。 */
export interface BlockRowSpan {
  readonly block: MdBlock;
  /** 块在 message content 内的起始物理行（相对 message 顶部，不含 margin）。 */
  readonly startRow: number;
  /** 块内容物理行数（不含块尾 margin）。 */
  readonly rows: number;
}

/** 一条消息的块级行映射。 */
export interface MessageBlockRowSpans {
  readonly message: AnthropicNativeMessage;
  readonly blocks: ReadonlyArray<BlockRowSpan>;
  readonly totalRows: number;
}

/**
 * 单个 markdown 块的行数（不含尾 margin）。与 markdown.tsx 渲染逐块对齐：
 *  - fence：lang !== "" 时 header 1 行 + 每个 source line 1 行；
 *  - table：每个 row 1 行；
 *  - heading：内容 1 行；level 1 额外 +1 marginTop；
 *  - quote：每个 source line 1 行（外层 box 不占行）；
 *  - list：每个 item 1 行（item 内 wrap 不额外占行，渲染为单 flex row）；
 *  - blank：1 行（<Text> </Text>）；
 *  - paragraph：rowsForText（1 + wrap 额外行）。
 */
export function blockRows(block: MdBlock, cols: number): number {
  switch (block.type) {
    case "fence":
      return (block.lang !== "" ? 1 : 0) + block.lines.length;
    case "table":
      return block.rows.length;
    case "heading":
      return 1 + (block.level === 1 ? 1 : 0);
    case "quote":
      return block.lines.length;
    case "list":
      return block.items.length;
    case "blank":
      return 1;
    case "paragraph":
      return rowsForText(block.text, cols);
  }
}

/**
 * 纯函数：blocks 序列 → 块级行映射（startRow 从 0 累计，不含块尾 margin）。
 * chat-view.tsx 的 `MessageBlocksRowRange` 用它做块内切片坐标。
 */
export function measureBlocks(
  blocks: ReadonlyArray<MdBlock>,
  cols: number
): ReadonlyArray<BlockRowSpan> {
  const out: BlockRowSpan[] = [];
  let cursor = 0;
  for (const block of blocks) {
    const rows = blockRows(block, cols);
    // 0 行块跳过（如空 fence）：不占坐标，也不产生渲染行。
    if (rows === 0) continue;
    out.push({ block, startRow: cursor, rows });
    cursor += rows;
  }
  return out;
}

/**
 * 组装纯文本消息（user 或 assistant 的裸 text 折叠）为单一块行映射。
 * text 块：rowsForText(text, cols-2)（❯ 前缀占 2 列）+ 尾 margin 1。
 */
function measureTextMessage(
  message: AnthropicNativeMessage,
  texts: ReadonlyArray<string>,
  cols: number
): MessageBlockRowSpans {
  const joined = texts.join("\n");
  const rows = rowsForText(joined, Math.max(1, cols - 2));
  const block: BlockRowSpan = {
    block: { type: "paragraph", text: joined },
    startRow: 0,
    rows,
  };
  return {
    message,
    blocks: [block],
    totalRows: rows + 1, // +1 尾 margin
  };
}

/**
 * 顶层入口：一条 AnthropicNativeMessage → 块级行映射。totalRows 语义与
 * chat-view.tsx 的 `estimateMessageRows` 逐字节一致（两个实现必须同步，
 * 否则 buildMessageRowSpans 的窗口坐标与行级切片坐标错位）。
 */
export function measureMessage(
  message: AnthropicNativeMessage,
  cols: number,
  opts?: { readonly thinkingExpanded?: boolean }
): MessageBlockRowSpans {
  if (message.role === "user") {
    const texts = message.content
      .filter((b): b is { type: "text"; text: string } => b.type === "text")
      .map((b) => b.text);
    if (!texts.join("").trim()) {
      return { message, blocks: [], totalRows: 0 };
    }
    return measureTextMessage(message, texts, cols);
  }

  // assistant：thinking 折叠面板 + text/tool_use 块。
  // 行数账目必须与 chat-view.tsx 的 `estimateMessageRows` 逐字节一致：
  //  - thinking 折叠摘要 / 展开 thinking / redacted 占位均**不加** margin
  //    （estimate 只给 text 块 +1）；这保证 buildMessageRowSpans 的窗口
  //    坐标与本模块的块内切片坐标对齐（thinking margin 是 estimate 既有的
  //    保守近似，此处不引入第二套账目）。
  const blocks: BlockRowSpan[] = [];
  let cursor = 0;
  const summary = summarizeThinkingContent(message.content);
  if (summary !== "") {
    if (opts?.thinkingExpanded) {
      for (const block of message.content) {
        if (block.type === "thinking") {
          const rows = rowsForText(block.thinking, cols);
          blocks.push({
            block: { type: "paragraph", text: block.thinking },
            startRow: cursor,
            rows,
          });
          cursor += rows;
        } else if (block.type === "redacted_thinking") {
          blocks.push({
            block: { type: "paragraph", text: REDACTED_PLACEHOLDER },
            startRow: cursor,
            rows: 1,
          });
          cursor += 1;
        }
      }
    } else {
      blocks.push({
        block: { type: "paragraph", text: summary },
        startRow: cursor,
        rows: 1,
      });
      cursor += 1;
    }
  }

  for (const block of message.content) {
    if (block.type === "text" && block.text.trim().length > 0) {
      const rows = rowsForText(block.text, cols);
      blocks.push({
        block: { type: "paragraph", text: block.text },
        startRow: cursor,
        rows,
      });
      cursor += rows + 1; // +1 marginBottom
    } else if (block.type === "tool_use") {
      // 工具摘要单行 + 视觉余量 1（与 estimate 的 rows+=2 一致）。
      blocks.push({
        block: { type: "paragraph", text: "" }, // 仅坐标消费
        startRow: cursor,
        rows: 1,
      });
      cursor += 2;
    }
  }

  const totalRows = cursor;
  if (totalRows === 0) return { message, blocks: [], totalRows: 0 };
  return { message, blocks, totalRows };
}
