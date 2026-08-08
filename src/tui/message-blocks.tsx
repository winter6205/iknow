/**
 * src/tui/message-blocks.tsx — #189 行级窗口：消息渲染器。
 *
 * 两块组件：
 *  - `MessageBlocks`：完整渲染，保留 Markdown 全功能；
 *  - `MessageBlocksClipped`：行级裁剪渲染（partial slice）——直接渲染
 *    `messageRender`（message-rows.ts）的 flat 物理行切片，与全可见路径
 *    逐行一致（#189 渲染漂移修复：旧实现对 markdown 源码 wrapText 切片，
 *    产出裸 fence 反引号 / `##` 标记行）。
 *
 * 共享子组件 `ToolSummaryRow`（tool_use 摘要行）+ `ThinkingSummary`（折叠
 * 摘要行）；tool_use 行在裁剪路径按 `BlockRowSpan.kind` 定位并保留染色。
 */
import type { ReactElement } from "react";
import { Box, Text } from "ink";
import type {
  AnthropicContentBlock,
  AnthropicNativeMessage,
} from "../harness/model-adapter/types.js";
import { tuiPalette } from "./theme.js";
import { summarizeToolCall, toolPreviewLines } from "./tool-summary.js";
import { Markdown } from "./markdown.js";
import type { BlockRowSpan } from "./message-rows.js";
import {
  REDACTED_PLACEHOLDER,
  summarizeThinkingContent,
} from "../cli/format.js";
import type { RowSlice } from "./row-window.js";
import type { Selection } from "./selection.js";
import { HighlightedLine } from "./selection-render.js";

type ToolUseBlock = Extract<AnthropicContentBlock, { type: "tool_use" }>;

/** tool_use 摘要行：`[运行中]|[失败]|[完成] name · detail`。
 *  cols 收口（tool-summary.ts）：装饰 + 名 + detail 单行不折。 */
function ToolSummaryRow(props: {
  readonly tu: ToolUseBlock;
  readonly statusMap: Map<string, boolean>;
  readonly cols: number;
}): ReactElement {
  const { detail } = summarizeToolCall(
    props.tu.name,
    props.tu.input,
    props.cols
  );
  const hasResult = props.statusMap.has(props.tu.id);
  const failed = props.statusMap.get(props.tu.id) === true;
  const mark = !hasResult ? "[运行中]" : failed ? "[失败]" : "[完成]";
  return (
    <Text color={failed ? tuiPalette.error : tuiPalette.dim}>
      {mark} {props.tu.name} · {detail}
    </Text>
  );
}

/** 工具内容预览行（write_file/edit_file）：dim 逐行渲染；行数与
 *  messageRender 行账共用 toolPreviewLines 单源，全可见/裁剪路径一致。 */
function ToolPreviewRows(props: {
  readonly tu: ToolUseBlock;
  readonly cols: number;
}): ReactElement | null {
  const lines = toolPreviewLines(props.tu.name, props.tu.input, props.cols);
  if (lines.length === 0) return null;
  return (
    <>
      {lines.map((l, i) => (
        <Text key={`tp-${i}`} color={tuiPalette.dim}>
          {l}
        </Text>
      ))}
    </>
  );
}

/** 折叠态 thinking 摘要行（dim 配色 + `[思考] ` 前缀）。 */
function ThinkingSummary(props: { readonly summary: string }): ReactElement {
  return (
    <Box marginBottom={1}>
      <Text color={tuiPalette.dim}>[思考] {props.summary}</Text>
    </Box>
  );
}

/** 完整消息渲染（保留 Markdown 全功能，无窗口裁剪）。 */
export function MessageBlocks(props: {
  readonly message: AnthropicNativeMessage;
  readonly cols: number;
  readonly statusMap: Map<string, boolean>;
  /** T6 (D5):thinking 折叠面板展开态;默认折叠(摘要行)。 */
  readonly thinkingExpanded?: boolean;
}): ReactElement | null {
  const { message, cols, statusMap, thinkingExpanded = false } = props;
  const pal = tuiPalette;
  if (message.role === "user") {
    const texts = message.content
      .filter((b): b is { type: "text"; text: string } => b.type === "text")
      .map((b) => b.text)
      .join("\n");
    if (!texts.trim()) return null; // 纯 tool_result 消息：摘要行已覆盖
    return (
      <Box flexDirection="column" marginBottom={1}>
        <Text color={pal.accent} wrap="wrap">
          {"❯ "}
          {texts}
        </Text>
      </Box>
    );
  }
  const nodes: ReactElement[] = [];
  const summary = summarizeThinkingContent(message.content);
  if (summary !== "") {
    nodes.push(<ThinkingSummary key="tk-sum" summary={summary} />);
  }
  if (summary !== "" && thinkingExpanded) {
    message.content.forEach((block, i) => {
      if (block.type === "thinking") {
        nodes.push(
          <Box key={`tk-b${i}`} marginBottom={1}>
            <Text wrap="wrap">{block.thinking}</Text>
          </Box>
        );
      } else if (block.type === "redacted_thinking") {
        nodes.push(
          <Box key={`tk-r${i}`} marginBottom={1}>
            <Text color={pal.dim}>{REDACTED_PLACEHOLDER}</Text>
          </Box>
        );
      }
    });
  }
  message.content.forEach((block, i) => {
    if (block.type === "text" && block.text.trim().length > 0) {
      nodes.push(
        <Box key={`t${i}`} marginBottom={1}>
          <Markdown text={block.text} width={cols} />
        </Box>
      );
    } else if (block.type === "tool_use") {
      nodes.push(
        <Box key={`u${i}`} flexDirection="column">
          <ToolSummaryRow tu={block} statusMap={statusMap} cols={cols} />
          <ToolPreviewRows tu={block} cols={cols} />
        </Box>
      );
    }
  });
  if (nodes.length === 0) return null;
  return (
    <Box flexDirection="column" marginBottom={1}>
      {nodes}
    </Box>
  );
}

/**
 * 行级窗口里的 message 切片渲染（#189 修复版）：渲染 `messageRender` flat
 * 物理行 `[slice.start, slice.end)` 切片。行内容与全可见路径逐行一致
 * （共享 SSOT），仅 tool_use 行保留染色（按 `BlockRowSpan.kind` 定位，
 * mark 由 statusMap 决定）。ink 折叠 `<Text>{""}</Text>`，故空行一律用
 * `" "` 占位（与 messageRender MARGIN_LINE 对齐）。
 */
export function MessageBlocksClipped(props: {
  readonly message: AnthropicNativeMessage;
  readonly lines: ReadonlyArray<string>;
  readonly blocks: ReadonlyArray<BlockRowSpan>;
  readonly statusMap: Map<string, boolean>;
  readonly slice: RowSlice;
  /** 终端列宽：透传 ToolSummaryRow 的宽度收口（与 messageRender 行账同源）。 */
  readonly cols: number;
  /** #238 选区（normalize 由调用方保证）。undefined = 无选区，高亮空走。 */
  readonly selection?: Selection;
  /** 该消息在内容流中的首行行号（0-based；与 ChatView 透传的 measured[i].startRow 对齐）。 */
  readonly messageStartRow: number;
}): ReactElement | null {
  const {
    message,
    lines,
    blocks,
    statusMap,
    slice,
    cols,
    selection,
    messageStartRow,
  } = props;
  const start = Math.max(0, slice.start);
  const end = Math.min(lines.length, slice.end);
  if (end <= start) return null;

  const toolUses = message.content.filter(
    (b): b is ToolUseBlock => b.type === "tool_use"
  );
  const nodes: ReactElement[] = [];
  for (let row = start; row < end; row++) {
    const absRow = messageStartRow + row;
    // tool_use 块 span 落在该行 → 染色摘要行；其余行纯文本（user 行 accent 色）。
    const toolBlock = blocks.find(
      (b) => b.kind === "tool_use" && b.startRow === row
    );
    if (toolBlock !== undefined) {
      const tu = toolUses.find((t) => t.id === toolBlock.toolUseId);
      if (tu !== undefined) {
        nodes.push(
          <Box key={`u${row}`}>
            <ToolSummaryRow tu={tu} statusMap={statusMap} cols={cols} />
          </Box>
        );
        continue;
      }
    }
    const ln = lines[row] ?? "";
    nodes.push(
      <HighlightedLine
        key={`l${row}`}
        line={ln}
        row={absRow}
        selection={selection}
        color={message.role === "user" ? tuiPalette.accent : undefined}
      />
    );
  }
  if (nodes.length === 0) return null;
  return (
    <Box flexDirection="column" marginBottom={1}>
      {nodes}
    </Box>
  );
}
