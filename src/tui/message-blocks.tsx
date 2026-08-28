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
 *  - **thinking 折叠文案**收敛在 `./think-fold.ts`（SSOT：`formatThinkingFold` /
 *    `formatThinkingLive`），本文件仅调用，不再另写
 *    模板字符串；与 chat-view.tsx 流式折叠行同源收敛（2026-08-14）。
 *  - 全部 `<box>` / `<text>` + fg 属性；禁 ink 原语（Box / Text）。
 *  - **T7 消息间距 + 底色**：user / assistant 分支用 box.backgroundColor
 *    （读 theme.ts userBg / assistantBg token）+ paddingX={1} 水平缩进
 *    （无 paddingY，底色块贴合内容）。消息间 1 行节奏由根节点 `marginTop`
 *    prop 提供（ChatView 传 `visibleIndex===0?0:1`，首条无顶部 margin，避免
 *    进入会话时第一行无谓下推造成的间距抖动）。2026-08-22 起 margin 挂在
 *    本组件根节点、随消息存亡：此前由 ChatView wrapper 提供，折叠
 *    （hideToolSummaries）后渲染为 null 的消息仍残留 wrapper margin，
 *    每条空消息留 1 行幻影空白、连成大空位。
 *    OpenTUI 无 lineHeight API，行距 = 消息块间 margin + 块内段落 margin，不自
 *    造真 leading。2026-08-13 用户反馈 paddingY=1 让消息块上下各 1 行空白叠加
 *    marginTop 造成 3 行/消息间距「太宽了」，改为 paddingY=0（底色贴内容） +
 *    marginTop=1（消息间 1 行节奏）。
 *
 * 留存的子组件：
 *  - `ToolSummaryRow`：tool_use 摘要行（收口 + mark 染色 + 完成态 bash
 *    `，ran N command(s)` 折叠摘要 — T4）；
 *  - `ToolPreviewRows`：write_file / edit_file 完成态截断预览（与 live 同源
 *    `completedToolPreview`；新文件代码、覆盖/编辑 diff）；
 *  - `ThinkingSummary`：折叠态 thinking 摘要行；
 *  - `MessageBlocks`：完整消息渲染入口（user / assistant / tool_use / thinking）。
 *
 * 依赖：
 *  - `completedToolPreview` / `toolResultStatusMap`（tool-summary）
 *  - `clipOneLineVisual`（tool-summary 内联导出，归档 text.ts SSOT 已迁移）
 *  - `REDACTED_PLACEHOLDER` / `summarizeThinkingContent`（cli/format）
 *  - `CompletedToolPreviewView`（与 live 共用完成态预览 JSX）
 *
 * 严禁 import：archive/tui-ink/*、markdown-lines、message-rows、row-window、
 * selection、selection-render、text、HighlightedLine——本文件应保持纯 OpenTUI
 * 渲染，无行账 / 裁剪 / 选区概念。
 */
import { memo, type ReactNode } from "react";
import type {
  AnthropicContentBlock,
  AnthropicNativeMessage,
} from "../harness/model-adapter/types.js";
import { tuiPalette } from "./theme.js";
import {
  summarizeToolCall,
  completedToolPreview,
  formatRanSuffix,
  countBashCalls,
  isSubagentTool,
  subagentDisplayMark,
  SUBAGENT_TOOL_LABEL,
  type CompletedToolPreview,
} from "./tool-summary.js";
import { clipOneLineVisual } from "./tool-summary.js";
import { CompletedToolPreviewView } from "./completed-tool-preview-view.js";
import { Markdown } from "./markdown.js";
import {
  REDACTED_PLACEHOLDER,
  summarizeThinkingContent,
} from "../cli/format.js";
import { formatThinkingFold } from "./think-fold.js";
import { isTuiHiddenUserMessage } from "./session-state.js";
import { stripPrefetchOverlay } from "../harness/memory/prefetch.js";

type ToolUseBlock = Extract<AnthropicContentBlock, { type: "tool_use" }>;

/** tool_use 摘要行：`[运行中]|[完成]|[失败] name · detail`。
 *  子代理工具（spawn_subagent / subagent_result）走独立视觉
 *  `${mark} 子代理 · ${detail}`，glyph（▣/✓/✗）已表状态，
 *  不与普通工具共用 `[运行中]/[完成]/[失败] name` 形态。
 *  2026-08-14：不再拼 `，ran N command(s)` 后缀 —— 工具计数只由
 *  ThinkingSummary（有秒数时）统一汇总一次（`思考了 N 秒 · ran M …`），
 *  避免「思考折叠行 + 工具行」双处重复计数造成结束状态混乱观感。
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
  // 子代理工具专属形态：glyph + 子代理标签 + detail。
  if (isSubagentTool(props.tu.name)) {
    const mark = !hasResult
      ? subagentDisplayMark("running")
      : failed
        ? subagentDisplayMark("failed")
        : subagentDisplayMark("ok");
    return (
      <text fg={failed ? tuiPalette.error : tuiPalette.dim} wrapMode="none">
        {mark} {SUBAGENT_TOOL_LABEL} · {detail}
      </text>
    );
  }
  const mark = !hasResult ? "[运行中]" : failed ? "[失败]" : "[完成]";
  const fg = failed ? tuiPalette.error : tuiPalette.dim;
  return (
    <text fg={fg} wrapMode="none">
      {mark} {props.tu.name} · {detail}
    </text>
  );
}

/** 工具内容预览（write_file / edit_file）：调用方先经 `completedToolPreview`
 *  判定非空再挂载（空预览 / 未配对不产节点 —— 折叠态下空壳 box 会让
 *  消息无法收敛为 null，残留幻影间距）。与 live 完成态同一
 *  `completedToolPreview` + `TOOL_PREVIEW_WINDOW`。截断即折叠。 */
function ToolPreviewRows(props: {
  readonly preview: CompletedToolPreview;
  readonly cols: number;
}): ReactNode {
  return (
    <box flexDirection="column">
      <CompletedToolPreviewView preview={props.preview} cols={props.cols} />
    </box>
  );
}

/** 折叠态 thinking 摘要行（dim）。结束态只有 `思考了 N 秒`（可加 ran 后缀）；
 *  无可用秒数 → 不渲染（不回落 `[思考]`）。 */
function ThinkingSummary(props: {
  readonly message: AnthropicNativeMessage;
  readonly cols: number;
  readonly thinkingSeconds?: number;
}): ReactNode {
  const fold = formatThinkingFold(props.thinkingSeconds);
  if (fold.length === 0) return null;
  const bashCount = countBashCalls(props.message);
  const ranSuffix =
    bashCount > 0 ? formatRanSuffix(bashCount).replace(/^，/, " · ") : "";
  const text = `${fold}${ranSuffix}`;
  return (
    <text fg={tuiPalette.dim} wrapMode="none">
      {clipOneLineVisual(text, props.cols)}
    </text>
  );
}

/** system 中断消息固定文案 SSOT（#392 T3）。TUI 侧独立分支直接渲染，不走
 *  Markdown 解析；`Interrupted by user.` 来自 loop 中断时注入的 system
 *  content，无 text block 时 fallback 该文案。 */
const SYSTEM_INTERRUPT_TEXT = "Interrupted by user.";

/** 中断警示前缀（橙 running 色 + 方括号，同 [思考]/[运行中] 符号约定）。 */
const SYSTEM_INTERRUPT_MARK = "[已打断]";

/** 完整消息渲染（保留 Markdown 全功能 + tool_use 摘要 + thinking 折叠面板）。
 *
 *  props：
 *  - `message`：权威 AnthropicNativeMessage（直接来自 session.messages）；
 *  - `cols`：终端列宽（Markdown wrap + ToolSummaryRow 单行收口共用）；
 *  - `statusMap`：`toolResultStatusMap(session.messages)`（tool_use → 是否失败）；
 *  - `thinkingExpanded`：thinking 折叠面板展开态（false = 隐藏 thinking 明文；
 *    有正秒数才画 `思考了 N 秒`，无秒数不画摘要、不回落 `[思考]`）；
 *    折叠/展开由 Ctrl+O 翻转；/thinking 为独立开关（思考Enabled），不改折叠态。
 *    会话重启回退折叠。
 *  - `noTrailingSelfMargin`：true 时抹掉最后一个块的 marginBottom ——
 *    OpenTUI `marginBottom` 不存在「折叠」语义，元素之间天然有间距。
 *    本参数在 ChatView 已废除（scrollbox 全内容滚动不写行账，无 trailing
 *    双空行问题）。保留仅为对外 API 兼容，**当前实现忽略**。
 *
 *  `memo` 包裹（浅比较）：ChatView 每次流式增量 / 无关父状态更新都会重建
 *  整段挂载消息的元素树，未记忆时每条历史消息都要重跑 markdown 解析 ——
 *  24 轮历史下一次增量约 96 次 `marked.lexer`，成本 O(历史体量)。上面所有
 *  props 要么是原始值，要么是 ChatView 侧已 useMemo 稳定的引用
 *  （`message` 来自 session.messages、`statusMap` 来自 toolResultStatusMap），
 *  浅比较即可命中。回归闸：tests/tui/history-rerender-cost.test.tsx。
 */
export const MessageBlocks = memo(function MessageBlocks(props: {
  readonly message: AnthropicNativeMessage;
  readonly cols: number;
  readonly statusMap: ReadonlyMap<string, boolean>;
  readonly thinkingExpanded?: boolean;
  /** 折叠态 thinking 行附带「思考了 N 秒」。仅末条 / 流式面板传入；
   *  缺省或非正 → 不画思考摘要行（不回落 `[思考]`）。 */
  readonly thinkingSeconds?: number;
  /** idle 时当前 turn 已由 ChatView 画 turn 级折叠行：本块不再画思考摘要。 */
  readonly hideThinking?: boolean;
  /** idle 时当前 turn 折叠：不画 `[完成] name · detail` 行；write/edit 预览仍留。 */
  readonly hideToolSummaries?: boolean;
  /** 消息间 1 行节奏（ChatView 传 `visibleIndex===0?0:1`）。挂在根节点上
   *  随消息存亡 —— 渲染为 null 的消息（折叠后的纯工具 assistant、纯
   *  tool_result user）不留幻影间距。缺省无间距。 */
  readonly marginTop?: number;
  readonly noTrailingSelfMargin?: boolean;
}): ReactNode {
  const { message, cols, statusMap, thinkingExpanded = false } = props;
  const pal = tuiPalette;
  // noTrailingSelfMargin：scrollbox 全内容滚动场景不再需要（行账已废除）；
  // 对外 API 兼容保留字段，不抛错，渲染层无需差异化。
  void props.noTrailingSelfMargin;
  if (message.role === "system") {
    // #392 T3：中断 system 消息走独立渲染分支——警示色 + 固定文案，不进
    // Markdown / thinking 逻辑。文案取首个 text block（trim），空则 fallback。
    const texts = message.content
      .filter((b): b is { type: "text"; text: string } => b.type === "text")
      .map((b) => b.text)
      .join("\n");
    const body = texts.trim() !== "" ? texts.trim() : SYSTEM_INTERRUPT_TEXT;
    return (
      <box flexDirection="column" marginTop={props.marginTop ?? 0}>
        <text fg={pal.running} wrapMode="word" width={cols}>
          {`${SYSTEM_INTERRUPT_MARK} ${body}`}
        </text>
      </box>
    );
  }
  if (message.role === "user") {
    const texts = message.content
      .filter((b): b is { type: "text"; text: string } => b.type === "text")
      .map((b) => b.text)
      .join("\n");
    if (texts.trim() === "") return null; // 纯 tool_result：摘要行已覆盖。
    if (isTuiHiddenUserMessage(message)) return null;
    const visible = stripPrefetchOverlay(texts);
    // T7：user 底色块（pal.userBg + paddingX=1 水平缩进，无 paddingY 贴内容）。
    // 内部宽度 = cols-2（paddingX=1 两侧），text width 同步收窄避免溢出。
    return (
      <box flexDirection="column" marginTop={props.marginTop ?? 0}>
        <box
          flexDirection="column"
          backgroundColor={pal.userBg}
          paddingX={1}
          paddingY={0}
        >
          <text fg={pal.accent} wrapMode="word" width={Math.max(1, cols - 2)}>
            {`❯ ${visible}`}
          </text>
        </box>
      </box>
    );
  }
  // assistant
  const summary = summarizeThinkingContent(message.content);
  // T7：底色块 paddingX=1 两侧 → 内部内容宽度收窄 2 列。
  const innerCols = Math.max(1, cols - 2);
  const nodes: ReactNode[] = [];
  if (summary !== "" && props.hideThinking !== true) {
    if (formatThinkingFold(props.thinkingSeconds).length > 0) {
      nodes.push(
        <ThinkingSummary
          key="tk-sum"
          message={message}
          cols={innerCols}
          thinkingSeconds={props.thinkingSeconds}
        />
      );
    }
  }
  if (summary !== "" && thinkingExpanded && props.hideThinking !== true) {
    message.content.forEach((block, i) => {
      if (block.type === "thinking") {
        nodes.push(
          <text key={`tk-b${i}`} wrapMode="word" width={innerCols}>
            {block.thinking}
          </text>
        );
      } else if (block.type === "redacted_thinking") {
        nodes.push(
          <text key={`tk-r${i}`} fg={pal.dim} wrapMode="word" width={innerCols}>
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
          <Markdown text={block.text} width={innerCols} />
        </box>
      );
    } else if (block.type === "tool_use") {
      const showSummary = props.hideToolSummaries !== true;
      const preview: CompletedToolPreview = statusMap.has(block.id)
        ? completedToolPreview(block.name, block.input)
        : { kind: "empty" };
      const showPreview = preview.kind !== "empty";
      // 摘要隐藏且无预览 → 不产节点：空壳 box 会撑住 nodes.length，让
      // 整条消息无法收敛为 null，折叠后残留幻影间距。
      if (!showSummary && !showPreview) return;
      nodes.push(
        <box key={`u${i}`} flexDirection="column">
          {showSummary && (
            <ToolSummaryRow tu={block} statusMap={statusMap} cols={innerCols} />
          )}
          {showPreview && (
            <ToolPreviewRows preview={preview} cols={innerCols} />
          )}
        </box>
      );
    }
  });
  if (nodes.length === 0) return null;
  // T7：assistant 底色块（pal.assistantBg + paddingX=1 水平缩进，无 paddingY
  // 贴内容）；消息间 1 行节奏由根节点 marginTop prop 提供（随消息存亡）。
  return (
    <box flexDirection="column" marginTop={props.marginTop ?? 0}>
      <box
        flexDirection="column"
        backgroundColor={pal.assistantBg}
        paddingX={1}
        paddingY={0}
      >
        {nodes}
      </box>
    </box>
  );
});
