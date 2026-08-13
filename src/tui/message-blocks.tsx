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
 *  - **T7 消息间距 + 底色**：user / assistant 分支用 box.backgroundColor
 *    （读 theme.ts userBg / assistantBg token）+ paddingX={1} 水平缩进
 *    （无 paddingY，底色块贴合内容）。消息间 1 行节奏由 ChatView wrapper
 *    `<box marginTop={i===0?0:1}>` 提供（首条不带顶部 margin，避免进入会话
 *    时第一行无谓下推造成间距抖动）；本组件根 box 不再产 marginTop。
 *    OpenTUI 无 lineHeight API，行距 = 消息块间 margin + 块内段落 margin，不自
 *    造真 leading。2026-08-13 用户反馈 paddingY=1 让消息块上下各 1 行空白叠加
 *    marginTop 造成 3 行/消息间距「太宽了」，改为 paddingY=0（底色贴内容） +
 *    marginTop=1（消息间 1 行节奏，由 wrapper 提供）。
 *
 * 留存的子组件：
 *  - `ToolSummaryRow`：tool_use 摘要行（收口 + mark 染色 + 完成态 bash
 *    `，ran N command(s)` 折叠摘要 — T4）；
 *  - `ToolPreviewRows`：write_file / edit_file 统一 diff 预览（固定高度
 *    `<ScrollableOutputRegion>` 内嵌，不再直接 `<DiffView>` — T3）；
 *  - `ThinkingSummary`：折叠态 thinking 摘要行；
 *  - `MessageBlocks`：完整消息渲染入口（user / assistant / tool_use / thinking）。
 *
 * 依赖：
 *  - `summarizeToolCall` / `toolPreviewRows` / `toolResultStatusMap`（tool-summary）
 *  - `clipOneLineVisual`（tool-summary 内联导出，归档 text.ts SSOT 已迁移）
 *  - `REDACTED_PLACEHOLDER` / `summarizeThinkingContent`（cli/format）
 *  - `diffRowTexts`（diff-view）＋ `ScrollableOutputRegion`（scrollable-output-region）
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
import {
  summarizeToolCall,
  toolPreviewRows,
  formatRanSuffix,
  countBashCalls,
} from "./tool-summary.js";
import { clipOneLineVisual } from "./tool-summary.js";
import { diffRowTexts } from "./diff-view.js";
import { ScrollableOutputRegion } from "./scrollable-output-region.js";
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
 *  完成态 bash 追加 `，ran N command(s)`（T4）：runCount = 该 assistant 消息内
 *  同名工具调用次数（MessageBlocks 整消息一次聚合），缺省 0 → 无后缀。
 *  cols 收口：单行不折（tool-summary 视觉宽度）。 */
function ToolSummaryRow(props: {
  readonly tu: ToolUseBlock;
  readonly statusMap: ReadonlyMap<string, boolean>;
  readonly cols: number;
  readonly runCount?: number;
}): ReactNode {
  const { detail } = summarizeToolCall(
    props.tu.name,
    props.tu.input,
    props.cols
  );
  const hasResult = props.statusMap.has(props.tu.id);
  const failed = props.statusMap.get(props.tu.id) === true;
  const mark = !hasResult ? "[运行中]" : failed ? "[失败]" : "[完成]";
  const ran =
    hasResult && !failed && props.tu.name === "bash"
      ? formatRanSuffix(props.runCount ?? 0)
      : "";
  const fg = failed ? tuiPalette.error : tuiPalette.dim;
  return (
    <text fg={fg} wrapMode="none">
      {mark} {props.tu.name} · {detail}
      {ran}
    </text>
  );
}

/** 预览固定高度（write/edit diff 通常 6–20 行，6 行折叠 + 内部滚动是
 *  合理默认；摘要行在主消息流保持单行，不撑开布局）。 */
const TOOL_PREVIEW_HEIGHT = 6;

/** 工具内容预览（write_file / edit_file）：diff 行（toolPreviewRows SSOT）
 *  经 diffRowTexts 展平为文本行，收进固定高度 `<ScrollableOutputRegion>`
 *  内部滚动（T3）——不再直接 `<DiffView>`，主消息流只显摘要行。 */
function ToolPreviewRows(props: {
  readonly tu: ToolUseBlock;
  readonly cols: number;
}): ReactNode {
  const rows = toolPreviewRows(props.tu.name, props.tu.input, props.cols);
  const lines = diffRowTexts(rows, props.cols);
  if (lines.length === 0) return null;
  return (
    <ScrollableOutputRegion
      lines={lines}
      cols={props.cols}
      height={TOOL_PREVIEW_HEIGHT}
    />
  );
}

/** 折叠态 thinking 摘要行（dim）。2026-08-13 用户反馈：「思考了几秒」直接
 *  替换 `[思考]` 标记，不要叠加 `[思考] 思考了 3 秒`。规则：
 *  - 有时间（流式面板）→ `思考了 {N} 秒` + 可选 `· ran {M} shell command(s)`；
 *  - 无时间（历史消息）→ `[思考]` + 可选 `· ran {M} shell command(s)`，避免
 *    伪精度「思考了 0 秒」；
 *  - 工具计数英文（与参考图 `ran 2 shell commands` 一致），思考部分全中文；
 *  - bash 数 = 0 → 省略 `· ran …` 段。 */
function ThinkingSummary(props: {
  readonly message: AnthropicNativeMessage;
  readonly cols: number;
  readonly thinkingSeconds?: number;
}): ReactNode {
  const bashCount = countBashCalls(props.message);
  const ranSuffix =
    bashCount > 0 ? formatRanSuffix(bashCount).replace(/^，/, " · ") : "";
  const head =
    props.thinkingSeconds !== undefined && props.thinkingSeconds > 0
      ? `思考了 ${props.thinkingSeconds} 秒`
      : THINKING_FOLD_LINE;
  const text = `${head}${ranSuffix}`;
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
 *  - `thinkingExpanded`：thinking 折叠面板展开态（false = 折叠成 1 行 [思考]）；
 *    折叠/展开由 Ctrl+O 翻转；/thinking 为独立开关（思考Enabled），不改折叠态。
 *    会话重启回退折叠。
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
  /** 折叠态 thinking 行附带「思考了 N 秒」。仅流式面板（chat-view 同步当前
   *  流的 streamDraft.thinkingSeconds()）传；历史消息缺省不传 → 折叠行只显
   *  `[思考] · ran N shell commands`，避免「思考了 0 秒」伪精度。 */
  readonly thinkingSeconds?: number;
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
      <text fg={pal.running} wrapMode="word" width={cols}>
        {`${SYSTEM_INTERRUPT_MARK} ${body}`}
      </text>
    );
  }
  if (message.role === "user") {
    const texts = message.content
      .filter((b): b is { type: "text"; text: string } => b.type === "text")
      .map((b) => b.text)
      .join("\n");
    if (texts.trim() === "") return null; // 纯 tool_result：摘要行已覆盖。
    // T7：user 底色块（pal.userBg + paddingX=1 水平缩进，无 paddingY 贴内容）。
    // 内部宽度 = cols-2（paddingX=1 两侧），text width 同步收窄避免溢出。
    return (
      <box flexDirection="column">
        <box
          flexDirection="column"
          backgroundColor={pal.userBg}
          paddingX={1}
          paddingY={0}
        >
          <text fg={pal.accent} wrapMode="word" width={Math.max(1, cols - 2)}>
            {`❯ ${texts}`}
          </text>
        </box>
      </box>
    );
  }
  // assistant
  const summary = summarizeThinkingContent(message.content);
  // T4：该 assistant 消息内 bash tool_use 总数（聚合 ran N 数据源），整消息算一次。
  const bashRunCount = countBashCalls(message);
  // T7：底色块 paddingX=1 两侧 → 内部内容宽度收窄 2 列。
  const innerCols = Math.max(1, cols - 2);
  const nodes: ReactNode[] = [];
  if (summary !== "") {
    nodes.push(
      <ThinkingSummary
        key="tk-sum"
        message={message}
        cols={innerCols}
        thinkingSeconds={props.thinkingSeconds}
      />
    );
  }
  if (summary !== "" && thinkingExpanded) {
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
      nodes.push(
        <box key={`u${i}`} flexDirection="column">
          <ToolSummaryRow
            tu={block}
            statusMap={statusMap}
            cols={innerCols}
            runCount={bashRunCount}
          />
          <ToolPreviewRows tu={block} cols={innerCols} />
        </box>
      );
    }
  });
  if (nodes.length === 0) return null;
  // T7：assistant 底色块（pal.assistantBg + paddingX=1 水平缩进，无 paddingY
  // 贴内容）+ 根 marginTop=1（消息间 1 行节奏）。
  return (
    <box flexDirection="column">
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
}
