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
 *    （工具标题行收掉）后渲染为 null 的消息仍残留 wrapper margin，
 *    每条空消息留 1 行幻影空白、连成大空位。
 *    OpenTUI 无 lineHeight API，行距 = 消息块间 margin + 块内段落 margin，不自
 *    造真 leading。2026-08-13 用户反馈 paddingY=1 让消息块上下各 1 行空白叠加
 *    marginTop 造成 3 行/消息间距「太宽了」，改为 paddingY=0（底色贴内容） +
 *    marginTop=1（消息间 1 行节奏）。
 *
 * 留存的子组件：
 *  - `ToolSummaryRow`：tool_use 摘要行（收口 + mark 染色 + 完成态 bash
 *    命令可见）；
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
  formatToolStatusLine,
  completedToolPreview,
  resultToolPreview,
  clipErrorLine,
  type CompletedToolPreview,
  type ResultPreview,
} from "./tool-summary.js";
import { clipOneLineVisual } from "./tool-summary.js";
import { CompletedToolPreviewView } from "./completed-tool-preview-view.js";
import { deriveSlot, settledColorToFg } from "./tool-settled.js";
import { MessageShell } from "./message-shell.js";
import { Markdown } from "./markdown.js";
import {
  REDACTED_PLACEHOLDER,
  summarizeThinkingContent,
} from "../cli/format.js";
import { formatThinkingFold } from "./think-fold.js";
import { isTuiHiddenUserMessage } from "./session-state.js";
import { projectSkillLoadUserText } from "./session-state.js";
import { stripPrefetchOverlay } from "../harness/memory/prefetch.js";

type ToolUseBlock = Extract<AnthropicContentBlock, { type: "tool_use" }>;

/** tool_use 摘要行：运行中走英文过程行 `name · detail`（spec D1，无状态
 *  括号），落定走 `name · detail`，失败走 `[失败] name · detail`；子代理
 *  工具只画 detail（身份由 identity strip / SubagentPanel 承担）。
 *  文案拼装统一委托 `formatToolStatusLine`（tool-summary SSOT，#693 T1 D7），
 *  历史 + live 两侧字节一致。
 *  工具计数不在本行：它只由 turn 级 `formatTurnActivityFold` 的
 *  `Thought for … · name × N` 一行承担（spec D2 / CONTEXT `unit fold`）。
 *  cols 收口：单行不折（tool-summary 视觉宽度）。 */
function ToolSummaryRow(props: {
  readonly tu: ToolUseBlock;
  readonly statusMap: ReadonlyMap<string, boolean>;
  readonly cols: number;
}): ReactNode {
  const hasResult = props.statusMap.has(props.tu.id);
  const failed = props.statusMap.get(props.tu.id) === true;
  const status: "running" | "ok" | "failed" = !hasResult
    ? "running"
    : failed
      ? "failed"
      : "ok";
  const line = formatToolStatusLine({
    toolName: props.tu.name,
    input: props.tu.input,
    status,
    cols: props.cols,
  });
  // 颜色由 deriveSlot 的 color token 派生（spec D5/D6）：failed → error、
  // accent 类成功 → accent；default 落正文色（#tui-render-overhaul T2）：
  // 工具标题行不再走 dim —— dim 只属装饰（结果预览前缀/溢出、折叠行）。
  // running 态也是 default 色 → 副作用是 running 标题也从 dim 升 text，
  // 更醒目（用户诉求：running 是用户在等的动作，该清楚）。
  const slot = hasResult
    ? deriveSlot(props.tu.name, { running: false, failed })
    : deriveSlot(props.tu.name, { running: true, failed: false });
  const fg = settledColorToFg(slot.color, {
    default: tuiPalette.text,
    accent: tuiPalette.accent,
    error: tuiPalette.error,
  });
  // accent 类标题行加 bold（#tui-render-overhaul T2）：theme.ts 的 accent
  // #e8e4d8 与正文 #e6e4dc 几乎同色（视觉区分 < 1 步），不改色值 → 加 bold
  // 让「点名的稀有能力（skill / worktree 生命周期）」在终端里看得出来。
  const isAccentTitle = slot.color === "accent";
  return isAccentTitle ? (
    <text fg={fg} wrapMode="none">
      <b>{line}</b>
    </text>
  ) : (
    <text fg={fg} wrapMode="none">
      {line}
    </text>
  );
}

/**
 * D5 一行短错误的数据源：bash 失败的 resultText 是 JSON envelope
 * （`{code, stdout, stderr}`）——错误内容取 stderr 优先、stdout 兜底，
 * 与 bashPreview 的字段语义一致；非 JSON 文本（mutate 门禁回执等）原样
 * 透传。空文本 / 解析后两字段皆空 → 空串（渲染层不画空错误行）。
 *
 * 与 live 路径（live-tool-preview 的 `run.message ?? run.detail`）**有意
 * 分叉**：历史只有落盘 tool_result 文本可解析，无 live 旁路字段；两侧
 * 共享的契约 = clipErrorLine 单行截断纪律，不承诺错误文本字节一致。
 */
function failureTextOf(name: string, resultText: string | undefined): string {
  if (resultText === undefined || resultText.length === 0) return "";
  if (name !== "bash") return resultText;
  try {
    const parsed = JSON.parse(resultText) as Record<string, unknown>;
    const stderr = parsed.stderr;
    const stdout = parsed.stdout;
    if (typeof stderr === "string" && stderr.trim().length > 0) return stderr;
    if (typeof stdout === "string" && stdout.trim().length > 0) return stdout;
    return "";
  } catch {
    return resultText;
  }
}

/** 工具内容预览（write_file / edit_file + bash / skill 结果预览）：
 *  调用方先经 `completedToolPreview` / `resultToolPreview` 判定非空再挂载
 *  （空预览 / 未配对不产节点 —— 折叠态下空壳 box 会让消息无法收敛为 null，
 *  残留幻影间距）。与 live 完成态同一 `completedToolPreview` +
 *  `resultToolPreview` + WRITE_CREATE_PREVIEW_WINDOW（新建 10 行）/
 *  RESULT_PREVIEW_WINDOW（result preview 尾窗）；编辑 diff 不套新建帽。截断即折叠。 */
function ToolPreviewRows(props: {
  readonly preview: CompletedToolPreview;
  readonly resultPreview: ResultPreview;
  readonly cols: number;
}): ReactNode {
  if (props.preview.kind === "empty" && props.resultPreview.kind === "empty") {
    return null;
  }
  return (
    <box flexDirection="column">
      <CompletedToolPreviewView
        preview={props.preview}
        cols={props.cols}
        resultPreview={props.resultPreview}
      />
    </box>
  );
}

/** 折叠态 thinking 摘要：结束态恒 1 行 `Thought for <duration>`。
 *  spec D2 / CONTEXT `unit fold`：工具计数不再是本块的第二行 —— 它焊在
 *  turn 级 `formatTurnActivityFold` 的同一行（`Thought for … · name × N`）。
 *  这里不重复计数。 */
function ThinkingSummary(props: {
  readonly message: AnthropicNativeMessage;
  readonly cols: number;
  readonly thinkingSeconds?: number;
}): ReactNode {
  const fold = formatThinkingFold(props.thinkingSeconds);
  if (fold.length === 0) return null;
  return (
    <text fg={tuiPalette.dim} wrapMode="none">
      {clipOneLineVisual(fold, props.cols)}
    </text>
  );
}

/** system 中断消息固定文案 SSOT（#392 T3）。TUI 侧独立分支直接渲染，不走
 *  Markdown 解析；`Interrupted by user.` 来自 loop 中断时注入的 system
 *  content，无 text block 时 fallback 该文案。 */
const SYSTEM_INTERRUPT_TEXT = "Interrupted by user.";

/** 中断警示前缀（橙 running 色 + 方括号；人读过程行已废 `[思考]`/`[运行中]` 文案，
 *  本标记只服务中断警示自身，不随过程行改名）。 */
const SYSTEM_INTERRUPT_MARK = "[已打断]";

/** 完整消息渲染（保留 Markdown 全功能 + tool_use 摘要 + thinking 折叠面板）。
 *
 *  props：
 *  - `message`：权威 AnthropicNativeMessage（直接来自 session.messages）；
 *  - `cols`：终端列宽（Markdown wrap + ToolSummaryRow 单行收口共用）；
 *  - `statusMap`：`toolResultStatusMap(session.messages)`（tool_use → 是否失败）；
 *  - `thinkingExpanded`：thinking 折叠面板展开态（false = 隐藏 thinking 明文；
 *    有正秒数才画 `Thought for <N>s`，无秒数不画摘要、不回落 `[思考]`）；
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
  /** #693 T4 D4:tool_use_id → tool_result 文本映射（历史结果预览数据源）。
   *  缺省 / 无匹配 → 该 tool_use 不画结果预览（与 spec D4「未配对不渲染」对齐）。 */
  readonly resultTextMap?: ReadonlyMap<string, string>;
  readonly thinkingExpanded?: boolean;
  /** 折叠态 thinking 行附带 `Thought for <N>s`。仅末条 / 流式面板传入；
   *  缺省或非正 → 不画思考摘要行（不回落 `[思考]`）。 */
  readonly thinkingSeconds?: number;
  /** idle 时当前 turn 已由 ChatView 画 turn 级折叠行：本块不再画思考摘要。 */
  readonly hideThinking?: boolean;
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
    // plans/tui-chrome-interaction.md Task 5：skill-load chip 投影 ——
    // 命中闭合形态的 `[skill-load name="X"]\n<body>[+\n\n<remainder>]`
    // 信封时，正文永进 ❯ 气泡。可见形态：`loading skill <name>` 芯片 +
    // remainder（若有）。模型历史仍收 `buildSkillLoadText` 信封（session-api
    // 侧不动），TUI 在 render 层剥 body；reload 后落盘全文同样投影为 chip。
    // 拒绝形态（短前缀命中但 name 没闭合 / 不以 `[skill-load ` 开头）→
    // 走现有 user 文本路径（视为普通 user 输入）。
    const projection = projectSkillLoadUserText(texts);
    if (projection !== null) {
      const { name, remainder } = projection;
      return (
        <box flexDirection="column" marginTop={props.marginTop ?? 0}>
          <text fg={pal.dim} wrapMode="none">
            {`loading skill ${name}`}
          </text>
          {remainder.length > 0 && (
            <box
              flexDirection="column"
              backgroundColor={pal.userBg}
              paddingX={1}
              paddingY={0}
            >
              <text
                fg={pal.accent}
                wrapMode="word"
                width={Math.max(1, cols - 2)}
              >
                {`❯ ${remainder}`}
              </text>
            </box>
          )}
        </box>
      );
    }
    const visible = stripPrefetchOverlay(texts);
    // T7 + Task 2：user 底色块（pal.userBg + paddingX=1 水平缩进，无
    // paddingY 贴内容）。内部宽度 = cols-2（paddingX=1 两侧），text
    // width 同步收窄避免溢出。
    // Task 2 acceptance 6:缺 palette token 不许把 transcript 刷白 ——
    // userBg 缺/空串时跳过 backgroundColor，回归终端默认。
    const userFill = pal.userBg.length > 0 ? pal.userBg : undefined;
    return (
      <box flexDirection="column" marginTop={props.marginTop ?? 0}>
        <box
          flexDirection="column"
          backgroundColor={userFill}
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
  // Task 2 (plans/tui-chrome-interaction.md T2)：MessageShell 透传,不再
  // 加 paddingX → 内部内容宽度 = cols（不再 -2）。Markdown / 工具行 /
  // 思考摘要全部按 cols 满宽排版,与 chat-view 透传的 contentWidth 对齐。
  const innerCols = Math.max(1, cols);
  const nodes: ReactNode[] = [];
  // #tui-render-overhaul T4:assistant 内部块间 1 行节奏 —— 相邻节点（折叠行 /
  // thinking 明文 / 文本 / 工具行 / 错误行）之间补 1 行空白,首块不补顶 margin。
  // OpenTUI `marginTop` 在父 column 容器里换行实现（父级为 MessageShell 内
  // 的 `<box flexDirection="column">`）。Task 2：MessageShell 透传（无
  // paddingX、无 backgroundColor），marginTop 即在父 column 中起换行作用。
  const withBlockSpacing = (key: string, node: ReactNode): ReactNode =>
    nodes.length === 0 ? (
      node
    ) : (
      <box key={`${key}-gap`} flexDirection="column" marginTop={1}>
        {node}
      </box>
    );
  if (summary !== "" && props.hideThinking !== true) {
    if (formatThinkingFold(props.thinkingSeconds).length > 0) {
      nodes.push(
        withBlockSpacing(
          "tk-sum",
          <ThinkingSummary
            key="tk-sum-inner"
            message={message}
            cols={innerCols}
            thinkingSeconds={props.thinkingSeconds}
          />
        )
      );
    }
  }
  if (summary !== "" && thinkingExpanded && props.hideThinking !== true) {
    message.content.forEach((block, i) => {
      if (block.type === "thinking") {
        nodes.push(
          withBlockSpacing(
            `tk-b${i}`,
            <text key={`tk-b${i}-inner`} wrapMode="word" width={innerCols}>
              {block.thinking}
            </text>
          )
        );
      } else if (block.type === "redacted_thinking") {
        nodes.push(
          withBlockSpacing(
            `tk-r${i}`,
            <text
              key={`tk-r${i}-inner`}
              fg={pal.dim}
              wrapMode="word"
              width={innerCols}
            >
              {REDACTED_PLACEHOLDER}
            </text>
          )
        );
      }
    });
  }
  message.content.forEach((block, i) => {
    if (block.type === "text" && block.text.trim().length > 0) {
      nodes.push(
        withBlockSpacing(
          `t${i}`,
          <box key={`t${i}-inner`}>
            <Markdown text={block.text} width={innerCols} />
          </box>
        )
      );
    } else if (block.type === "tool_use") {
      // D7（spec specs/tui-tool-settled-appearance.md）：渲染只消费 slot。
      // 落定态（statusMap 已配对 = idle 历史）：标题 iff showTitle、预览 iff
      // showPreview —— retract 标题与预览同假（核保证，渲染不再复活）；
      // 未配对（running 态 / cancelled）沿用 live 行为：标题行可见。
      const failed = statusMap.get(block.id) === true;
      const slot = statusMap.has(block.id)
        ? deriveSlot(block.name, { running: false, failed })
        : deriveSlot(block.name, { running: true, failed: false });
      const preview: CompletedToolPreview = statusMap.has(block.id)
        ? completedToolPreview(block.name, block.input)
        : { kind: "empty" };
      const resultPreview: ResultPreview = statusMap.has(block.id)
        ? resultToolPreview(block.name, block.input, {
            resultText: props.resultTextMap?.get(block.id),
          })
        : { kind: "empty" };
      const hasPreviewContent =
        preview.kind !== "empty" || resultPreview.kind !== "empty";
      const showTitle = slot.showTitle;
      const showPreview = slot.showPreview && hasPreviewContent;
      // D5：失败一行短错误 —— 长回执（如 `[worktree_isolation]`）截成单行,
      // 不以 dim ⎿ 结果预览块堆长文（showPreview 由核置假）。
      const errorLine =
        failed && showTitle
          ? clipErrorLine(
              failureTextOf(block.name, props.resultTextMap?.get(block.id)),
              innerCols
            )
          : "";
      if (!showTitle && !showPreview) return;
      nodes.push(
        withBlockSpacing(
          `u${i}`,
          <box key={`u${i}-inner`} flexDirection="column">
            {showTitle && (
              <ToolSummaryRow
                tu={block}
                statusMap={statusMap}
                cols={innerCols}
              />
            )}
            {errorLine !== "" && (
              <text fg={pal.error} wrapMode="none">
                {errorLine}
              </text>
            )}
            {showPreview && (
              <ToolPreviewRows
                preview={preview}
                resultPreview={resultPreview}
                cols={innerCols}
              />
            )}
          </box>
        )
      );
    }
  });
  if (nodes.length === 0) return null;
  // Task 2 (plans/tui-chrome-interaction.md T2)：assistant 不再带 panel
  // 填充 —— MessageShell 透传（无 backgroundColor、无 paddingX），仅
  // `marginTop` 节奏容器。Markdown 格式化保留（子树自带 width / wrap）。
  // #693 T1 D1：assistant 外壳收敛到 MessageShell（memo 包裹，浅比较稳定），
  // 与 chat-view 流式草稿 / 折叠行共用同一组件 —— 消除「外壳跳变」不一致。
  return (
    <MessageShell cols={cols} marginTop={props.marginTop ?? 0}>
      {nodes}
    </MessageShell>
  );
});
