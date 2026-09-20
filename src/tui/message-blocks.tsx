/** @jsxImportSource @opentui/react */
/**
 * Single-message renderer (OpenTUI element tree).
 *
 * ChatView scrolls the full content via <scrollbox>, so this file keeps no
 * line-window clipping and no ink-style margin patching: OpenTUI lays out by
 * element parentage directly. Only <box>/<text> + fg attributes; ink
 * primitives (Box / Text) are forbidden.
 *
 * Thinking fold text is a single source in ./think-fold.ts
 * (formatThinkingFold / formatThinkingLive); this file only calls it — the
 * same generator the chat-view.tsx streaming fold line uses (2026-08-14).
 *
 * Message spacing: user / assistant read theme tokens userBg / assistantBg
 * via box.backgroundColor, paddingX={1} horizontal indent, paddingY=0 so the
 * fill hugs content (paddingY=1 stacked on marginTop gave 3 blank lines per
 * message — user feedback 2026-08-13). The 1-line rhythm between messages is
 * the root marginTop prop (ChatView passes `visibleIndex===0?0:1`). It lives
 * on this component since 2026-08-22, not on a ChatView wrapper: wrapper
 * margins survived messages rendering as null and left phantom gaps.
 * OpenTUI has no lineHeight API — spacing is margin-only.
 *
 * Import-forbidden: archive/tui-ink/*, markdown-lines, message-rows,
 * row-window, selection, selection-render, text, HighlightedLine — this file
 * stays pure OpenTUI rendering, no line-ledger / clipping / selection
 * concepts.
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
import type { SubagentCardLines } from "./subagent-message-lines.js";
import { SubagentCardView } from "./subagent-card-view.js";
import {
  deriveSlot,
  isLiveNoise,
  isLiveSignal,
  settledColorToFg,
} from "./tool-settled.js";
import { MessageShell } from "./message-shell.js";
import { Markdown } from "./markdown.js";
import { renderActivityBlockRows } from "./activity-block-rows.js";
import type { ActivityBlockLine } from "./turn-fold-lines.js";
import {
  REDACTED_PLACEHOLDER,
  summarizeThinkingContent,
} from "../cli/format.js";
import { formatThinkingFold } from "./think-fold.js";
import { isTuiHiddenUserMessage } from "./session-state.js";
import { projectSkillLoadUserText } from "./session-state.js";
import { stripPrefetchOverlay } from "../harness/memory/prefetch.js";

type ToolUseBlock = Extract<AnthropicContentBlock, { type: "tool_use" }>;

/** tool_use summary line: running and settled use the English process line
 *  `name · detail` (no status parenthesis); failed uses
 *  `[失败] name · detail`; subagent tools render only the detail (identity is
 *  carried by the spawn card projection / SubagentPanel). Line assembly
 *  delegates to `formatToolStatusLine` (tool-summary SSOT) so history and
 *  live render the same bytes. Tool counts stay off this line: retract counts
 *  belong to the activity block title (`deriveActivityBlocks` +
 *  `formatToolUseCounts`); keep tools show no count — they are real cards
 *  outside the block. Clipped to one visual line (tool-summary width). */
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
  // Color derives from deriveSlot's color token: failed → error, accent-class
  // success → accent, default → body text. Tool title lines no longer use
  // dim; dim is reserved for decoration (result preview prefix/overflow, fold
  // lines). Running also lands on default, lifting its title from dim to
  // text — the action the user is waiting for should be clearly visible.
  const slot = hasResult
    ? deriveSlot(props.tu.name, { running: false, failed })
    : deriveSlot(props.tu.name, { running: true, failed: false });
  const fg = settledColorToFg(slot.color, {
    default: tuiPalette.text,
    accent: tuiPalette.accent,
    error: tuiPalette.error,
  });
  // accent-class titles get bold: theme.ts accent (#e8e4d8) is nearly the
  // same color as body text (#e6e4dc), so bold — rather than a new color —
  // makes named rare capabilities (skill / worktree lifecycle) stand out in
  // the terminal.
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
 * Data source for the one-line short error: a bash failure's resultText is a
 * JSON envelope (`{code, stdout, stderr}`) — take stderr first, stdout as
 * fallback, matching bashPreview's field semantics; non-JSON text (mutate
 * gate receipts, etc.) passes through unchanged. Empty text, or both fields
 * empty after parsing → empty string (the render layer skips blank error
 * lines).
 *
 * This **intentionally diverges** from the live path (`run.message ??
 * run.detail` in live-tool-preview): history only has the persisted
 * tool_result text to parse, no live side fields. The shared contract is
 * clipErrorLine's single-line truncation discipline, not byte-identical
 * error text.
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

/** Tool content preview (write_file / edit_file + bash / skill result
 *  preview): callers mount this only after `completedToolPreview` /
 *  `resultToolPreview` report non-empty — an empty shell box would keep a
 *  folded message from converging to null and leave phantom spacing. Shares
 *  the live-path windows: WRITE_CREATE_PREVIEW_WINDOW (10 lines for new
 *  files) / RESULT_PREVIEW_WINDOW (result tail window); edit diffs get no
 *  new-file cap. Truncation is the fold. */
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

/** Folded thinking summary: the settled state is always one line
 *  `Thought for <duration>`. Tool counts are no longer a second line here —
 *  they are welded into the activity block title (`Thought for …,
 *  calling/called name × N`, single-sourced in `deriveActivityBlocks`), so no
 *  duplicate counting. */
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

/** Activity block row nodes: rendered through the shared
 *  `renderActivityBlockRows` template (same assembly as unanchored tail
 *  blocks, so width / color tokens cannot drift apart). Block titles and
 *  previews are always dim single lines. */
function activityRowsNode(
  rows: ReadonlyArray<ActivityBlockLine>,
  cols: number,
  keyPrefix: string
): ReactNode {
  return (
    <box flexDirection="column">
      {renderActivityBlockRows(
        rows.map((row) => row.title),
        rows.map((row) => row.preview),
        cols,
        (idx) => `${keyPrefix}-${idx}`
      )}
    </box>
  );
}

/** Assembles the assistant content body (pure function, extracted from
 *  MessageBlocks for complexity control): thinking summary / expanded
 *  thinking text / anchored activity-block title insertion / body and tool
 *  cards. Returning null means the message has nothing visible — the caller
 *  skips mounting so no phantom spacing remains.
 *
 *  Activity block titles are inserted into content order by anchor: the
 *  anchor is the index of the block's content block, and the title renders
 *  before it. An anchor on a content block that renders as null (e.g. an
 *  entirely-skipped noise tool_use) still emits the title there — title
 *  presence depends on timeline position, not on the content block's
 *  visibility. Residual blocks with out-of-range anchors (index ≥
 *  content.length) render after the body; `deriveActivityBlocks` always
 *  yields legal indices, so that branch only fires on malformed input. */
function assistantBodyNode(args: {
  readonly message: AnthropicNativeMessage;
  readonly cols: number;
  readonly statusMap: ReadonlyMap<string, boolean>;
  readonly resultTextMap?: ReadonlyMap<string, string>;
  readonly subagentCards?: ReadonlyMap<string, SubagentCardLines>;
  readonly thinkingSeconds?: number;
  readonly hideThinking?: boolean;
  readonly thinkingExpanded: boolean;
  readonly activityBlocks?: ReadonlyArray<ActivityBlockLine>;
}): ReactNode {
  const { message, cols } = args;
  const pal = tuiPalette;
  const summary = summarizeThinkingContent(message.content);
  // MessageShell is pass-through (no paddingX), so inner width = cols rather
  // than cols-2; Markdown / tool lines / thinking summary all render full
  // width, matching the contentWidth chat-view passes down.
  const innerCols = Math.max(1, cols);
  const nodes: ReactNode[] = [];
  // 1-line rhythm between assistant inner blocks: add a blank line between
  // adjacent nodes (fold lines / thinking text / prose / tool lines / error
  // lines), none before the first block. OpenTUI `marginTop` inside the
  // parent column container (MessageShell's pass-through
  // `<box flexDirection="column">`, no paddingX / backgroundColor) acts as a
  // line break there.
  const withBlockSpacing = (key: string, node: ReactNode): ReactNode =>
    nodes.length === 0 ? (
      node
    ) : (
      <box key={`${key}-gap`} flexDirection="column" marginTop={1}>
        {node}
      </box>
    );
  // hideThinking only hides this message's own thinking (folded summary +
  // expanded text); the anchored activity block titles below are not under
  // its control.
  const showThinking = summary !== "" && args.hideThinking !== true;
  if (showThinking) {
    if (formatThinkingFold(args.thinkingSeconds).length > 0) {
      nodes.push(
        withBlockSpacing(
          "tk-sum",
          <ThinkingSummary
            key="tk-sum-inner"
            message={message}
            cols={innerCols}
            thinkingSeconds={args.thinkingSeconds}
          />
        )
      );
    }
  }
  if (showThinking && args.thinkingExpanded) {
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
  const activityLines = args.activityBlocks ?? [];
  message.content.forEach((block, i) => {
    const anchorRows = activityLines.filter(
      (line) => line.contentBlockIndex === i
    );
    if (anchorRows.length > 0) {
      nodes.push(
        withBlockSpacing(
          `ab${i}`,
          activityRowsNode(anchorRows, innerCols, `ab-${i}`)
        )
      );
    }
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
      const node = renderToolUseBlock({
        block,
        statusMap: args.statusMap,
        resultTextMap: args.resultTextMap,
        innerCols,
        subagentCards: args.subagentCards,
      });
      if (node !== null) {
        nodes.push(withBlockSpacing(`u${i}`, node));
      }
    }
  });
  const tailRows = activityLines.filter(
    (line) => line.contentBlockIndex >= message.content.length
  );
  if (tailRows.length > 0) {
    nodes.push(
      withBlockSpacing(
        "ab-tail",
        activityRowsNode(tailRows, innerCols, "ab-tail")
      )
    );
  }
  if (nodes.length === 0) return null;
  // Return a bare array: MessageShell already provides the column container,
  // so a wrapping fragment adds nothing.
  return nodes;
}

/** Fixed-text SSOT for system interrupt messages. Rendered by a dedicated
 *  TUI branch that bypasses Markdown parsing; `Interrupted by user.` comes
 *  from the system content the loop injects on interrupt, and is also the
 *  fallback when the message has no text block. */
const SYSTEM_INTERRUPT_TEXT = "Interrupted by user.";

/** Interrupt warning prefix (orange running color + brackets). The human
 *  process lines retired the `[思考]`/`[运行中]` texts; this mark serves only
 *  the interrupt warning itself and does not follow those renames. */
const SYSTEM_INTERRUPT_MARK = "[已打断]";

/** tool_use block rendering:
 *  - live noise (isLiveNoise and not failed) → not rendered; the activity
 *    block takes it over
 *  - failed → failure overlay (keep the title + one-line short error)
 *  - web_search / web_fetch → real cards: still render the title after
 *    settling (`Search <q>` / `Fetch <url>`); TOOL_SETTLED_CLASS still
 *    classifies them retract with slot.showTitle false, so an
 *    `isLiveSignal && !failed` fallback keeps them visible
 *  - other retract / keep → consume deriveSlot
 *  Returning null means ChatView mounts nothing.
 */
type ToolUseView = {
  readonly showTitle: boolean;
  readonly showPreview: boolean;
  readonly errorLine: string;
  readonly preview: CompletedToolPreview;
  readonly resultPreview: ResultPreview;
};

/** Derives tool_use render decisions (pure data, no React).
 *  Early exit: live noise that has not failed → the whole block is not
 *  mounted (the activity block owns it exclusively). */
function resolveToolUseView(
  block: ToolUseBlock,
  statusMap: ReadonlyMap<string, boolean>,
  resultTextMap: ReadonlyMap<string, string> | undefined,
  innerCols: number
): ToolUseView | null {
  const failed = statusMap.get(block.id) === true;
  if (!failed && isLiveNoise(block.name)) {
    return null;
  }
  const settled = statusMap.has(block.id);
  const slot = deriveSlot(block.name, { running: !settled, failed });
  // The web subset of live signals keeps its title after settling (query /
  // URL on one line); the name list comes from `isLiveSignal` as the single
  // source rather than re-listing tool names here.
  const showTitle = slot.showTitle || (isLiveSignal(block.name) && !failed);
  const { preview, resultPreview, hasPreviewContent } = resolveToolUsePreviews(
    block,
    settled,
    resultTextMap
  );
  const showPreview = slot.showPreview && hasPreviewContent;
  const errorLine =
    failed && showTitle
      ? clipErrorLine(
          failureTextOf(block.name, resultTextMap?.get(block.id)),
          innerCols
        )
      : "";
  return { showTitle, showPreview, errorLine, preview, resultPreview };
}

function resolveToolUsePreviews(
  block: ToolUseBlock,
  settled: boolean,
  resultTextMap: ReadonlyMap<string, string> | undefined
): {
  readonly preview: CompletedToolPreview;
  readonly resultPreview: ResultPreview;
  readonly hasPreviewContent: boolean;
} {
  const preview: CompletedToolPreview = settled
    ? completedToolPreview(block.name, block.input)
    : { kind: "empty" };
  const resultPreview: ResultPreview = settled
    ? resultToolPreview(block.name, block.input, {
        resultText: resultTextMap?.get(block.id),
      })
    : { kind: "empty" };
  const hasPreviewContent =
    preview.kind !== "empty" || resultPreview.kind !== "empty";
  return { preview, resultPreview, hasPreviewContent };
}

function renderToolUseBlock(args: {
  readonly block: ToolUseBlock;
  readonly statusMap: ReadonlyMap<string, boolean>;
  readonly resultTextMap?: ReadonlyMap<string, string>;
  readonly innerCols: number;
  /** toolUseId → two-line card projection. Hit and not failed → this spawn
   *  renders `SubagentCardView`; absent / missed / failed → byte-identical to
   *  the pre-card rendering. */
  readonly subagentCards?: ReadonlyMap<string, SubagentCardLines>;
}): ReactNode {
  const { block, statusMap, resultTextMap, innerCols } = args;
  const view = resolveToolUseView(block, statusMap, resultTextMap, innerCols);
  if (view === null) return null;
  const card = args.subagentCards?.get(block.id);
  const failed = statusMap.get(block.id) === true;
  if (card !== undefined && !failed) {
    return (
      <box flexDirection="column">
        <SubagentCardView card={card} />
      </box>
    );
  }
  if (!view.showTitle && !view.showPreview) return null;
  return (
    <box flexDirection="column">
      {view.showTitle && (
        <ToolSummaryRow tu={block} statusMap={statusMap} cols={innerCols} />
      )}
      {view.errorLine !== "" && (
        <text fg={tuiPalette.error} wrapMode="none">
          {view.errorLine}
        </text>
      )}
      {view.showPreview && (
        <ToolPreviewRows
          preview={view.preview}
          resultPreview={view.resultPreview}
          cols={innerCols}
        />
      )}
    </box>
  );
}

/** Renders system interrupt messages: warning color + fixed text, bypassing
 *  Markdown / thinking logic. Text comes from the first text block (trimmed),
 *  falling back to the fixed text when empty. Extracted from MessageBlocks for
 *  complexity control. */
function systemInterruptNode(
  message: AnthropicNativeMessage,
  cols: number,
  marginTop: number | undefined
): ReactNode {
  const texts = message.content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("\n");
  const body = texts.trim() !== "" ? texts.trim() : SYSTEM_INTERRUPT_TEXT;
  return (
    <box flexDirection="column" marginTop={marginTop ?? 0}>
      <text fg={tuiPalette.running} wrapMode="word" width={cols}>
        {`${SYSTEM_INTERRUPT_MARK} ${body}`}
      </text>
    </box>
  );
}

/** Inner box of the user ❯ bubble (shared by skill-load chips and normal
 *  input): userBg fill + paddingX=1 indent + cols-2 inner width. Missing
 *  palette token → skip the fill and fall back to the terminal default. */
function userBubble(cols: number, text: string): ReactNode {
  const pal = tuiPalette;
  const userFill = pal.userBg.length > 0 ? pal.userBg : undefined;
  return (
    <box
      flexDirection="column"
      backgroundColor={userFill}
      paddingX={1}
      paddingY={0}
    >
      <text fg={pal.accent} wrapMode="word" width={Math.max(1, cols - 2)}>
        {`❯ ${text}`}
      </text>
    </box>
  );
}

/** User message rendering: skill-load chip projection hit → chip +
 *  remainder; normal input → ❯ bubble. Pure tool_result (no text) and hidden
 *  agent_status → null (summary lines already cover them). Extracted from
 *  MessageBlocks for complexity control. */
function userMessageNode(
  message: AnthropicNativeMessage,
  cols: number,
  marginTop: number | undefined
): ReactNode {
  const pal = tuiPalette;
  const texts = message.content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("\n");
  if (texts.trim() === "") return null; // pure tool_result: summary lines cover it.
  if (isTuiHiddenUserMessage(message)) return null;
  // Skill-load chip projection: when the closed envelope form
  // `[skill-load name="X"]\n<body>[+\n\n<remainder>]` matches, the body never
  // enters the ❯ bubble. Visible form: a `loading skill <name>` chip plus the
  // remainder (if any). The model history still receives the
  // `buildSkillLoadText` envelope (session-api side untouched); the TUI
  // strips the body at render time, and the persisted full text projects to
  // the same chip after reload. Rejected forms (short prefix hit but name
  // unclosed / not starting with `[skill-load `) take the normal user-text
  // path.
  const projection = projectSkillLoadUserText(texts);
  if (projection !== null) {
    const { name, remainder } = projection;
    return (
      <box flexDirection="column" marginTop={marginTop ?? 0}>
        <text fg={pal.dim} wrapMode="none">
          {`loading skill ${name}`}
        </text>
        {remainder.length > 0 && (
          <box flexDirection="column" marginTop={1}>
            {userBubble(cols, remainder)}
          </box>
        )}
      </box>
    );
  }
  return (
    <box flexDirection="column" marginTop={marginTop ?? 0}>
      {userBubble(cols, stripPrefetchOverlay(texts))}
    </box>
  );
}

/** Full message rendering (keeps Markdown in full + tool_use summary +
 *  thinking fold panel).
 *
 *  props:
 *  - `message`: the authoritative AnthropicNativeMessage (straight from
 *    session.messages);
 *  - `cols`: terminal width (shared by Markdown wrap and ToolSummaryRow
 *    single-line clipping);
 *  - `statusMap`: `toolResultStatusMap(session.messages)` (tool_use → failed
 *    or not);
 *  - `thinkingExpanded`: thinking fold-panel state (false = thinking text
 *    hidden; the `Thought for <N>s` summary renders only with positive
 *    seconds — no seconds, no summary, no fallback to `[思考]`); Ctrl+O
 *    toggles folding; /thinking is a separate thinking-enabled switch and
 *    does not change fold state. Session restarts fall back to folded.
 *  - `noTrailingSelfMargin`: when true, strips the last block's marginBottom
 *    — OpenTUI `marginBottom` has no "collapse" semantics, so elements keep
 *    natural gaps. Deprecated in ChatView (scrollbox scrolls full content
 *    with no line ledger, so there is no trailing double-blank issue). Kept
 *    only for external API compatibility; **currently ignored by the
 *    implementation**.
 *
 *  Wrapped in `memo` (shallow compare): every streaming delta or unrelated
 *  parent-state update in ChatView rebuilds the mounted message tree, and
 *  without memo every historical message reruns markdown parsing — 24 turns
 *  of history mean ~96 `marked.lexer` calls per delta, O(history size). All
 *  props above are primitives or useMemo-stable references on the ChatView
 *  side (`message` from session.messages, `statusMap` from
 *  toolResultStatusMap), so a shallow compare hits. Regression gate:
 *  tests/tui/history-rerender-cost.test.tsx.
 */
export const MessageBlocks = memo(function MessageBlocks(props: {
  readonly message: AnthropicNativeMessage;
  readonly cols: number;
  readonly statusMap: ReadonlyMap<string, boolean>;
  /** tool_use_id → tool_result text map (data source for historical result
   *  preview). Absent / unmatched → that tool_use renders no result preview
   *  (unpaired results are not rendered). */
  readonly resultTextMap?: ReadonlyMap<string, string>;
  /** toolUseId → two-line subagent card projection (produced by
   *  `subagentCardLinesMap`). Hit and not failed → the spawn card renders
   *  `{role} running...` + a dim summary, with a green `✓ Done` under the
   *  completed summary; absent → byte-identical to before. */
  readonly subagentCards?: ReadonlyMap<string, SubagentCardLines>;
  readonly thinkingExpanded?: boolean;
  /** Folded thinking lines carry `Thought for <N>s`. Passed only for the last
   *  message / streaming panel; absent or non-positive → no thinking summary
   *  line (no fallback to `[思考]`). */
  readonly thinkingSeconds?: number;
  /** When idle, ChatView already draws the turn-level fold line, so this
   *  block stops rendering the thinking summary. */
  readonly hideThinking?: boolean;
  /** 1-line rhythm between messages (ChatView passes `visibleIndex===0?0:1`).
   *  Lives on the root node and dies with the message — messages rendering
   *  as null (folded tool-only assistants, pure tool_result users) leave no
   *  phantom spacing. Absent = no gap. */
  readonly marginTop?: number;
  readonly noTrailingSelfMargin?: boolean;
  /** This message's anchored activity-block lines (ascending
   *  contentBlockIndex, single-sourced in `turn-fold-lines.ts`). Rendered by
   *  anchor: each title draws before its content block rather than the whole
   *  batch being dumped at the message tail. Absent = no activity blocks
   *  (byte-identical to before). */
  readonly activityBlocks?: ReadonlyArray<ActivityBlockLine>;
}): ReactNode {
  const { message, cols, statusMap, thinkingExpanded = false } = props;
  // noTrailingSelfMargin: unnecessary with scrollbox full-content scrolling
  // (the line ledger is gone); the field survives for API compatibility
  // only — no error, and the render layer does not differentiate.
  void props.noTrailingSelfMargin;
  if (message.role === "system") {
    return systemInterruptNode(message, cols, props.marginTop);
  }
  if (message.role === "user") {
    return userMessageNode(message, cols, props.marginTop);
  }
  // assistant
  const body = assistantBodyNode({
    message,
    cols,
    statusMap,
    resultTextMap: props.resultTextMap,
    subagentCards: props.subagentCards,
    thinkingSeconds: props.thinkingSeconds,
    hideThinking: props.hideThinking,
    thinkingExpanded,
    activityBlocks: props.activityBlocks,
  });
  if (body === null) return null;
  // Assistant carries no panel fill: MessageShell is pass-through (no
  // backgroundColor, no paddingX), just a `marginTop` rhythm container.
  // Markdown formatting stays (subtree has its own width / wrap).
  // The assistant shell is consolidated into MessageShell (memo-wrapped,
  // stable shallow compare) and shared with chat-view's streaming draft and
  // fold lines, removing the "shell jump" inconsistency.
  return (
    <MessageShell cols={cols} marginTop={props.marginTop ?? 0}>
      {body}
    </MessageShell>
  );
});
