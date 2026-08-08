/**
 * src/tui/message-rows.ts — 消息行级高度 SSOT（#189 修复版）。
 *
 * 动机（PR #219 合入后实测仍不达标的根因）：旧实现用 `wrapText(text, cols)`
 * 按**字符数**估 assistant 行数，但实际渲染走 `<Markdown>`（parseBlocks：
 * heading/fence/table/quote/list/blank/paragraph），行账系统性错位——
 *  1. fence 边框行、h1 marginTop、bullet 记号全未计入 → 窗口起点漂移；
 *  2. CJK 字符按 2 列显示，`wrapText` 按字节数低估近 2×；
 *  3. tool_use 估 2 行（实际 1，无 margin）→ 每条工具 +1 漂移。
 *
 * 修复：assistant 文本走 `markdownToLines`（与 `<Markdown>` 渲染逐行对齐），
 * user 文本走 `wrapTextVisual`（视觉宽度折行），tool_use=1，thinking/redacted
 * 各自 margin 显式。flat 物理行数组（含 self margin " " 占位行）由
 * `messageRender` 暴露给裁剪路径 `MessageBlocksClipped`，保证 measure / clip
 * 行账一致。
 *
 * 行账（与 ChatView 实测对齐）：
 *  - `messageRender.lines` = content + self margins（不含外层 margin），
 *    例如 text 块 = [...content, " "]，tool_use 块 = [...content]；
 *  - `totalRows = lines.length + 1`（外层 margin，渲染为「到下一条消息 / 尾
 *    部的间隔行」）。ChatView 用 `ΣtotalRows + tailRows` 作为总行空间 —
 *    ink 在 flexGrow 根下不折叠 trailing margin（实测 rawLines = ΣtotalRows
 *    完全相等），故无需在行账中做末端 −1 修正。
 */
import type { AnthropicNativeMessage } from "../harness/model-adapter/types.js";
import {
  REDACTED_PLACEHOLDER,
  summarizeThinkingContent,
} from "../cli/format.js";
import { summarizeToolCall, toolPreviewLines } from "./tool-summary.js";
import { markdownToLines } from "./markdown-lines.js";
import { clipOneLineVisual, wrapTextVisual } from "./text.js";

/** 块行级跨度。`rows` = 块内容行（不含块尾 margin）；坐标对齐 `lines` 数组。 */
export interface BlockRowSpan {
  readonly kind: BlockRowKind;
  readonly startRow: number;
  readonly rows: number;
  /** user-text / thinking / text：原文；tool_use：空串（仅 kind 判别）。 */
  readonly text: string;
  /** tool_use 专用：tool_use.id（供裁剪路径从 statusMap 取运行态 mark）。 */
  readonly toolUseId?: string;
}

export type BlockRowKind =
  "user-text" | "thinking" | "redacted" | "text" | "tool_use";

/** 一条消息的块级行映射。 */
export interface MessageBlockRowSpans {
  readonly message: AnthropicNativeMessage;
  readonly blocks: ReadonlyArray<BlockRowSpan>;
  /** 内容行 + self margin + 1（外层 margin）。 */
  readonly totalRows: number;
}

/** flat 物理行数组（与 MessageBlocks 渲染行数逐行对齐；含 self margin）。 */
export interface MessageRender {
  readonly message: AnthropicNativeMessage;
  readonly lines: ReadonlyArray<string>;
  /** block 跨度（content-only rows），与 lines 数组下标对齐。 */
  readonly blocks: ReadonlyArray<BlockRowSpan>;
  readonly totalRows: number;
}

const MARGIN_LINE = " "; // ink 折叠 `<Text>{""}</Text>`，空行用空格占位

/** 折叠态摘要行：`[思考] ` 标记（行账 1 行）。
 *  用户反馈（2026-08-08）：「N 段」计数无意义去掉；`(Ctrl+O)` 键位提示
 *  也嫌碍眼一并去掉（键位说明见 /help）。导出供 MessageBlocks 全量路径
 *  共用同一文案（SSOT，避免两条渲染路径漂移）。 */
export function thinkingFoldLine(): string {
  return "[思考]";
}

/** 顶层：消息 → flat 物理行（SSOT，给 measureMessage / MessageBlocksClipped 共享）。
 *  opts.omitTrailingSelfMargin：该消息是内容流最后一条且 tail 为空时置 true —
 *  去掉末尾块的 self margin 行（外层 margin 仍保留 1 行），把「末条消息 ↔
 *  输入框」之间的双空行收成 1 行（用户 2026-08-08 反馈空白块碍眼）。
 *  lines 不以 margin 结尾（user 消息 / tool_use 收尾）时无操作。 */
export function messageRender(
  message: AnthropicNativeMessage,
  cols: number,
  opts?: {
    readonly thinkingExpanded?: boolean;
    readonly omitTrailingSelfMargin?: boolean;
  }
): MessageRender {
  const lines: string[] = [];
  const blocks: BlockRowSpan[] = [];
  const width = Math.max(1, cols);

  if (message.role === "user") {
    const texts = message.content
      .filter((b): b is { type: "text"; text: string } => b.type === "text")
      .map((b) => b.text);
    const joined = texts.join("\n");
    if (!joined.trim()) {
      return { message, lines: [], blocks: [], totalRows: 0 };
    }
    // 与 `<MessageBlocks>` 实际渲染一致：单 `<Text wrap="wrap">{"❯ "}{texts}</Text>`
    // 在 cols 内整体折行，ink 默认 wrap 按视觉宽度。故首行容量 = cols−2（"❯ "），
    // 续行容量 = cols。这里整体 wrapVisual("❯ "+joined, cols) 直接还原。
    const wrapped = wrapTextVisual(`❯ ${joined}`, width);
    for (const l of wrapped) lines.push(l);
    blocks.push({
      kind: "user-text",
      text: joined,
      startRow: 0,
      rows: wrapped.length,
    });
    return { message, lines, blocks, totalRows: wrapped.length + 1 };
  }

  // assistant
  const summary = summarizeThinkingContent(message.content);
  if (summary !== "") {
    if (opts?.thinkingExpanded) {
      for (const block of message.content) {
        if (block.type === "thinking") {
          const blockLines = wrapTextVisual(block.thinking, width);
          const startRow = lines.length;
          for (const l of blockLines) lines.push(l);
          lines.push(MARGIN_LINE);
          blocks.push({
            kind: "thinking",
            text: block.thinking,
            startRow,
            rows: blockLines.length,
          });
        } else if (block.type === "redacted_thinking") {
          const startRow = lines.length;
          lines.push(REDACTED_PLACEHOLDER);
          lines.push(MARGIN_LINE);
          blocks.push({
            kind: "redacted",
            text: REDACTED_PLACEHOLDER,
            startRow,
            rows: 1,
          });
        }
      }
    } else {
      const startRow = lines.length;
      // clip 到视觉宽度：极窄终端下防止折行破坏「折叠态 = 1 行」行账。
      lines.push(clipOneLineVisual(thinkingFoldLine(), width));
      lines.push(MARGIN_LINE);
      blocks.push({
        kind: "thinking",
        text: summary,
        startRow,
        rows: 1,
      });
    }
  }

  for (const block of message.content) {
    if (block.type === "text" && block.text.trim().length > 0) {
      const blockLines = markdownToLines(block.text, width);
      const startRow = lines.length;
      for (const l of blockLines) lines.push(l);
      lines.push(MARGIN_LINE);
      blocks.push({
        kind: "text",
        text: block.text,
        startRow,
        rows: blockLines.length,
      });
    } else if (block.type === "tool_use") {
      const startRow = lines.length;
      // cols 收口：摘要行保证单行不折（窄终端行账不漂移，tool-summary.ts）。
      const { detail } = summarizeToolCall(block.name, block.input, width);
      // 摘要行文本：与 ToolSummaryRow 内容一致（无颜色 / mark 标记），mark
      // 由裁剪路径根据 statusMap 注入。
      lines.push(`${block.name} · ${detail}`);
      // 内容可见性：write_file/edit_file 追加封顶预览行（SSOT 与
      // MessageBlocks 全可见路径共用 toolPreviewLines，行账逐行一致）。
      const preview = toolPreviewLines(block.name, block.input, width);
      for (const l of preview) lines.push(l);
      blocks.push({
        kind: "tool_use",
        text: "",
        startRow,
        rows: 1 + preview.length,
        toolUseId: block.id,
      });
    }
  }

  if (lines.length === 0) return { message, lines, blocks, totalRows: 0 };
  // 末条消息 + tail 为空：去掉末尾 self margin（外层 margin 保留 1 行），
  // 双空行 → 单空行。块跨度不含 margin 行，无需调整 blocks。
  if (
    opts?.omitTrailingSelfMargin === true &&
    lines[lines.length - 1] === MARGIN_LINE
  ) {
    lines.pop();
  }
  return { message, lines, blocks, totalRows: lines.length + 1 };
}

/**
 * 顶层入口（向后兼容）：返回块级行映射，totalRows 含外层 margin。
 * 行账与 `messageRender` 等价。
 */
export function measureMessage(
  message: AnthropicNativeMessage,
  cols: number,
  opts?: {
    readonly thinkingExpanded?: boolean;
    readonly omitTrailingSelfMargin?: boolean;
  }
): MessageBlockRowSpans {
  const r = messageRender(message, cols, opts);
  return { message: r.message, blocks: r.blocks, totalRows: r.totalRows };
}
