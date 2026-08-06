/**
 * src/tui/message-rows.ts — 消息 / markdown 块行级高度 SSOT（#189 Commit 2）。
 *
 * 目标：把 ChatView 行级滚动的「消息 → 物理行」映射做成单一权威来源，
 * 供窗口选消息（totalRows 累加）以及行级裁剪（message-blocks.tsx 的
 * `MessageBlocksClipped` 块内裁剪，坐标经 row-window.ts 的
 * `clipSpan` / `toolUseInSlice` 消费）共同使用。
 *
 * 行高规则必须与 src/tui/markdown.tsx 的实际渲染严格对齐（见各块注释）。
 * 纯文本折行统一走 `rowsForText`（max(1, wrapText).SSOT）。
 *
 * 块类型现在以 `kind` 判别字段表达，取代了此前「伪 MdBlock」的写法——
 * 早期 measureMessage 把 tool_use / thinking / redacted 都铸成
 * `{type:"paragraph", text:""|"..."}` 块，渲染端再用 `text === ""` 反推
 * tool_use，但与空 thinking 串碰撞（Primitive Obsession 气味）。`kind` 显式
 * 收窄五种形态，渲染端用 `b.kind === "tool_use"` 直接判别。
 */
import type { AnthropicNativeMessage } from "../harness/model-adapter/types.js";
import { wrapText } from "./text.js";
import {
  REDACTED_PLACEHOLDER,
  summarizeThinkingContent,
} from "../cli/format.js";

/** 纯文本按 cols 折行的物理行数 SSOT：max(1, wrapText(text, cols).length)。 */
export function rowsForText(text: string, cols: number): number {
  return Math.max(1, wrapText(text, cols).length);
}

/** 一个 message 块在行级窗口中的形态判别字段。 */
export type BlockRowKind =
  "user-text" | "thinking" | "redacted" | "text" | "tool_use";

/** 单个 message 块的行级跨度（块内部坐标，从 message 顶部累计）。 */
export interface BlockRowSpan {
  /** 块类型判别，渲染端据此选摘要/段落/折叠等分支。 */
  readonly kind: BlockRowKind;
  /** 块在 message content 内的起始物理行（相对 message 顶部，不含块前 margin）。 */
  readonly startRow: number;
  /**
   * 块内容物理行数。
   *  - user-text / thinking / text：内容行数（不含块尾 margin，margin 由
   *    消费方按 +1 补齐，或由 cursor 步长隐式承担）。
   *  - tool_use：占位 2 行（1 行摘要 + 1 行视觉余量），与 cursor += 2
   *    的累计步长一致。
   */
  readonly rows: number;
  /**
   * 块内文本。
   *  - user-text / thinking / text：原文，供消费方按 cols 折行渲染。
   *  - redacted：固定占位串 REDACTED_PLACEHOLDER。
   *  - tool_use：空串（仅 kind 判别，不消费 text）。
   */
  readonly text: string;
}

/** 一条消息的块级行映射。 */
export interface MessageBlockRowSpans {
  readonly message: AnthropicNativeMessage;
  readonly blocks: ReadonlyArray<BlockRowSpan>;
  readonly totalRows: number;
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
    kind: "user-text",
    text: joined,
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
 * 顶层入口：一条 AnthropicNativeMessage → 块级行映射（SSOT，行级窗口
 * 与块内裁剪统一消费）。totalRows 是消息所占物理行数的唯一权威来源。
 *
 * 行数账目：
 *  - thinking 折叠摘要 / 展开 thinking / redacted 占位均**不加** margin
 *    （text 块才 +1）；这保证窗口坐标与块内切片坐标对齐（thinking margin
 *    是保守近似，此处不引入第二套账目）。
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
  const blocks: BlockRowSpan[] = [];
  let cursor = 0;
  const summary = summarizeThinkingContent(message.content);
  if (summary !== "") {
    if (opts?.thinkingExpanded) {
      for (const block of message.content) {
        if (block.type === "thinking") {
          const rows = rowsForText(block.thinking, cols);
          blocks.push({
            kind: "thinking",
            text: block.thinking,
            startRow: cursor,
            rows,
          });
          cursor += rows;
        } else if (block.type === "redacted_thinking") {
          blocks.push({
            kind: "redacted",
            text: REDACTED_PLACEHOLDER,
            startRow: cursor,
            rows: 1,
          });
          cursor += 1;
        }
      }
    } else {
      blocks.push({
        kind: "thinking",
        text: summary,
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
        kind: "text",
        text: block.text,
        startRow: cursor,
        rows,
      });
      cursor += rows + 1; // +1 marginBottom
    } else if (block.type === "tool_use") {
      // 工具摘要单行 + 视觉余量 1（与 estimate 的 rows+=2 一致）。rows
      // 包含 1 行 margin，与 cursor += 2 步长一一对应。
      blocks.push({
        kind: "tool_use",
        text: "",
        startRow: cursor,
        rows: 2,
      });
      cursor += 2;
    }
  }

  const totalRows = cursor;
  if (totalRows === 0) return { message, blocks: [], totalRows: 0 };
  return { message, blocks, totalRows };
}
