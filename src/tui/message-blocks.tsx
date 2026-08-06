/**
 * src/tui/message-blocks.tsx — #189 行级窗口：消息渲染器。
 *
 * 从 chat-view.tsx 拆出（code review：Large Class / Long Method / 重复
 * 工具摘要行）。两块组件：
 *  - `MessageBlocks`：完整渲染，保留 Markdown 全功能；
 *  - `MessageBlocksClipped`：行级裁剪渲染（partial slice）。
 *
 * 共享逻辑下沉为子组件 `ToolSummaryRow`（tool_use 摘要行）+ `ThinkingSummary`
 * （折叠摘要行），与 `clipSpan` / `toolUseInSlice` / `clipUserRange` /
 * `clipTextRange`（row-window.ts）共同支撑裁剪路径。
 */
import type { ReactElement } from "react";
import { Box, Text } from "ink";
import type {
  AnthropicContentBlock,
  AnthropicNativeMessage,
} from "../harness/model-adapter/types.js";
import { tuiPalette } from "./theme.js";
import { summarizeToolCall } from "./tool-summary.js";
import { Markdown } from "./markdown.js";
import type { BlockRowSpan } from "./message-rows.js";
import {
  REDACTED_PLACEHOLDER,
  summarizeThinkingContent,
} from "../cli/format.js";
import {
  clipTextRange,
  clipUserRange,
  toolUseInSlice,
  type RowSlice,
} from "./row-window.js";

type ToolUseBlock = Extract<AnthropicContentBlock, { type: "tool_use" }>;

/** tool_use 摘要行：`[运行中]|[失败]|[完成] name · detail`。 */
function ToolSummaryRow(props: {
  readonly tu: ToolUseBlock;
  readonly statusMap: Map<string, boolean>;
}): ReactElement {
  const { detail } = summarizeToolCall(props.tu.name, props.tu.input);
  const hasResult = props.statusMap.has(props.tu.id);
  const failed = props.statusMap.get(props.tu.id) === true;
  const mark = !hasResult ? "[运行中]" : failed ? "[失败]" : "[完成]";
  return (
    <Text color={failed ? tuiPalette.error : tuiPalette.dim}>
      {mark} {props.tu.name} · {detail}
    </Text>
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
        <Box key={`u${i}`}>
          <ToolSummaryRow tu={block} statusMap={statusMap} />
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
 * 行级窗口里的 message 切片渲染（Fix2）。完全可见仍走 `MessageBlocks`；
 * 本组件仅做块级局部裁剪——按 `BlockRowSpan.kind` 判别（消除旧
 * `text === ""` sentinel 判别 tool_use 的 Primitive Obsession 气味）。
 */
export function MessageBlocksClipped(props: {
  readonly message: AnthropicNativeMessage;
  readonly blocks: ReadonlyArray<BlockRowSpan>;
  readonly cols: number;
  readonly statusMap: Map<string, boolean>;
  readonly slice: RowSlice;
}): ReactElement | null {
  const { message, blocks, cols, statusMap, slice } = props;
  const pal = tuiPalette;
  if (message.role === "user") {
    const block = blocks[0];
    if (block === undefined) return null;
    const { lines, prefixFirst } = clipUserRange(block.text, cols, slice);
    if (lines.length === 0) return null;
    return (
      <Box flexDirection="column" marginBottom={1}>
        {lines.map((ln, li) => (
          <Text key={li} color={pal.accent} wrap="wrap">
            {li === 0 && prefixFirst ? `❯ ${ln}` : ln}
          </Text>
        ))}
      </Box>
    );
  }
  // assistant：逐块切片；tool_use 伪块按出现顺序恒自增 toolIdx（与窗口
  // 是否相交无关），否则被切片跳过的伪块会让后续索引错位。
  const toolUses = message.content.filter(
    (b): b is ToolUseBlock => b.type === "tool_use"
  );
  let toolIdx = 0;
  const nodes: ReactElement[] = [];
  blocks.forEach((block, i) => {
    const isTool = block.kind === "tool_use";
    if (isTool) toolIdx += 1;
    if (isTool) {
      if (!toolUseInSlice(block, slice)) return;
      const tu = toolUses[toolIdx - 1];
      if (tu === undefined) return;
      nodes.push(
        <Box key={`u${i}`}>
          <ToolSummaryRow tu={tu} statusMap={statusMap} />
        </Box>
      );
      return;
    }
    const lines = clipTextRange(block, cols, slice);
    if (lines.length === 0) return;
    nodes.push(
      <Box key={`b${i}`} flexDirection="column">
        {lines.map((ln, li) => (
          <Text key={li} wrap="wrap">
            {ln}
          </Text>
        ))}
      </Box>
    );
  });
  if (nodes.length === 0) return null;
  return (
    <Box flexDirection="column" marginBottom={1}>
      {nodes}
    </Box>
  );
}
