/** @jsxImportSource @opentui/react */
/**
 * src/tui/message-blocks.tsx
 *
 * #343 T6-B：单条消息渲染器（OpenTUI 元素树版）。
 *
 * 与 archive/tui-ink/src/message-blocks.tsx 的差异（T6-B 删除清单）：
 *  - **删除 `MessageBlocksClipped`**：行级窗口切片路径。ChatView 改走
 *    `<scrollbox>` 全内容滚动，scrollbox 实测处理视口外的物理行。
 *  - **删除 `cloneElement` + `marginBottom` patch**：OpenTUI 直接按元素
 *    父子布局，无 ink margin 折叠规则，不必在末尾块裁 margin。
 *  - **thinking 折叠文案**收敛在本文件为常量（`THINKING_FOLD_LINE = "[思考]"`），
 *    替代码仓 archive 里同名导出（本文件是当前唯一 caller，作为 SSOT）。
 *  - 全部 `<box>` / `<text>` + fg 属性；禁 ink 原语（Box / Text）。
 *
 * 留存的子组件：
 *  - `ToolSummaryRow`：tool_use 摘要行（收口 + mark 染色）；
 *  - `ToolPreviewRows`：write_file / edit_file 统一 diff 预览（DiffView）；
 *  - `ThinkingSummary`：折叠态 thinking 摘要行；
 *  - `MessageBlocks`：完整消息渲染入口（user / assistant / tool_use / thinking）。
 *
 * 依赖：
 *  - `summarizeToolCall` / `toolPreviewRows` / `toolResultStatusMap`（tool-summary）
 *  - `clipOneLineVisual`（tool-summary 内联导出，归档 text.ts SSOT 已迁移）
 *  - `REDACTED_PLACEHOLDER` / `summarizeThinkingContent`（cli/format）
 *
 * 严禁 import：archive/tui-ink/*、markdown-lines、message-rows、row-window、
 * selection、selection-render、text、HighlightedLine——本文件应保持纯 OpenTUI
 * 渲染，无行账 / 裁剪 / 选区概念。
 */
import type { ReactNode } from "react";
import type {
  AnthropicContentBlock,
  AnthropicNativeMessage,
} from "../harness/model-adapter/types.js";
import { tuiPalette } from "./theme.js";
import { summarizeToolCall, toolPreviewRows } from "./tool-summary.js";
import { clipOneLineVisual } from "./tool-summary.js";
import { DiffView } from "./diff-view.js";
import { Markdown } from "./markdown.js";
import {
  REDACTED_PLACEHOLDER,
  summarizeThinkingContent,
} from "../cli/format.js";

type ToolUseBlock = Extract<AnthropicContentBlock, { type: "tool_use" }>;

/** 折叠态摘要行文案 SSOT（T6-B 收敛到本文件作为唯一来源，替代码仓 archive
 *  时代的同名导出）。2026-08-08 用户反馈去掉 "N 段" 计数与 "(Ctrl+O)"
 *  键位提示。 */
const THINKING_FOLD_LINE = "[思考]";

/** tool_use 摘要行：`[运行中]|[完成]|[失败] name · detail`。
 *  cols 收口：单行不折（tool-summary 视觉宽度）。 */
function ToolSummaryRow(props: {
  readonly tu: ToolUseBlock;
  readonly statusMap: ReadonlyMap<string, boolean>;
  readonly cols: number;
}): ReactNode {
  const { detail } = summarizeToolCall(
    props.tu.name,
    props.tu.input,
    props.cols
  );
  const hasResult = props.statusMap.has(props.tu.id);
  const failed = props.statusMap.get(props.tu.id) === true;
  const mark = !hasResult ? "[运行中]" : failed ? "[失败]" : "[完成]";
  const fg = failed ? tuiPalette.error : tuiPalette.dim;
  return (
    <text fg={fg} wrapMode="none">
      {mark} {props.tu.name} · {detail}
    </text>
  );
}

/** 工具内容预览（write_file / edit_file）：走 DiffView 红绿渲染；行数与
 *  OpenTUI 渲染逐行一致（toolPreviewRows SSOT）。 */
function ToolPreviewRows(props: {
  readonly tu: ToolUseBlock;
  readonly cols: number;
}): ReactNode {
  const rows = toolPreviewRows(props.tu.name, props.tu.input, props.cols);
  if (rows.length === 0) return null;
  return <DiffView rows={rows} cols={props.cols} />;
}

/** 折叠态 thinking 摘要行（dim）。clip 到视觉宽度保证单行不折。 */
function ThinkingSummary(props: { readonly cols: number }): ReactNode {
  return (
    <text fg={tuiPalette.dim} wrapMode="none">
      {clipOneLineVisual(THINKING_FOLD_LINE, props.cols)}
    </text>
  );
}

/** 完整消息渲染（保留 Markdown 全功能 + tool_use 摘要 + thinking 折叠面板）。
 *
 *  props：
 *  - `message`：权威 AnthropicNativeMessage（直接来自 session.messages）；
 *  - `cols`：终端列宽（Markdown wrap + ToolSummaryRow 单行收口共用）；
 *  - `statusMap`：`toolResultStatusMap(session.messages)`（tool_use → 是否失败）；
 *  - `thinkingExpanded`：thinking 折叠面板展开态（false = 折叠成 1 行 [思考]）；
 *    app 层 `/thinking` 斜杠切换。会话重启回退折叠。
 *  - `noTrailingSelfMargin`：true 时抹掉最后一个块的 marginBottom ——
 *    OpenTUI `marginBottom` 不存在「折叠」语义，元素之间天然有间距。
 *    本参数在 ChatView 已废除（scrollbox 全内容滚动不写行账，无 trailing
 *    双空行问题）。保留仅为对外 API 兼容，**当前实现忽略**。
 */
export function MessageBlocks(props: {
  readonly message: AnthropicNativeMessage;
  readonly cols: number;
  readonly statusMap: ReadonlyMap<string, boolean>;
  readonly thinkingExpanded?: boolean;
  readonly noTrailingSelfMargin?: boolean;
}): ReactNode {
  const { message, cols, statusMap, thinkingExpanded = false } = props;
  const pal = tuiPalette;
  // noTrailingSelfMargin：scrollbox 全内容滚动场景不再需要（行账已废除）；
  // 对外 API 兼容保留字段，不抛错，渲染层无需差异化。
  void props.noTrailingSelfMargin;
  if (message.role === "user") {
    const texts = message.content
      .filter((b): b is { type: "text"; text: string } => b.type === "text")
      .map((b) => b.text)
      .join("\n");
    if (texts.trim() === "") return null; // 纯 tool_result：摘要行已覆盖。
    return (
      <text fg={pal.accent} wrapMode="word" width={cols}>
        {`❯ ${texts}`}
      </text>
    );
  }
  // assistant
  const summary = summarizeThinkingContent(message.content);
  const nodes: ReactNode[] = [];
  if (summary !== "") {
    nodes.push(<ThinkingSummary key="tk-sum" cols={cols} />);
  }
  if (summary !== "" && thinkingExpanded) {
    message.content.forEach((block, i) => {
      if (block.type === "thinking") {
        nodes.push(
          <text key={`tk-b${i}`} wrapMode="word" width={cols}>
            {block.thinking}
          </text>
        );
      } else if (block.type === "redacted_thinking") {
        nodes.push(
          <text key={`tk-r${i}`} fg={pal.dim} wrapMode="word" width={cols}>
            {REDACTED_PLACEHOLDER}
          </text>
        );
      }
    });
  }
  message.content.forEach((block, i) => {
    if (block.type === "text" && block.text.trim().length > 0) {
      nodes.push(
        <box key={`t${i}`}>
          <Markdown text={block.text} width={cols} />
        </box>
      );
    } else if (block.type === "tool_use") {
      nodes.push(
        <box key={`u${i}`} flexDirection="column">
          <ToolSummaryRow tu={block} statusMap={statusMap} cols={cols} />
          <ToolPreviewRows tu={block} cols={cols} />
        </box>
      );
    }
  });
  if (nodes.length === 0) return null;
  return <box flexDirection="column">{nodes}</box>;
}
