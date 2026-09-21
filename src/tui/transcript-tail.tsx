/** @jsxImportSource @opentui/react */
/**
 * src/tui/transcript-tail.tsx
 *
 * ChatView's tail segment (spacerAfter, crunched, unanchoredBlocks,
 * tailSlots, legacy liveToolLines, askLine, Spinner) split out as a sibling
 * component. The logic is pushed down into ChatView's pure derivations
 * (`buildActivityBlockFoldLines` yields `unanchoredBlocks`, `liveTailSlots`
 * yields `tailSlots`); this component only mounts JSX.
 *
 * Render order: crunched line → unanchored non-thinking blocks
 * (non-thinking among unanchoredBlocks) → tail slots → legacy liveToolLines →
 * askLine → background residual-hint line → unanchored thinking blocks
 * (thinking among unanchoredBlocks) → spinner.
 *
 * The block list (`buildActivityBlockFoldLines`) is the sole source of
 * folding / preview; the old one-line `live activity group` summary
 * (`Listing × N · Reading × M`) and the `unit fold`
 * (`Thought for Ns · name × M`) mutual-exclusion gate have retired wholesale —
 * a same-batch retract now counts once in the block's called tally.
 *
 * Thinking-at-bottom: the still-streaming thinking segment sits at the
 * transcript's bottom — thinking blocks (`slot.kind === "thinking"`) are
 * split out of unanchoredBlocks and mounted separately after askLine and
 * before the Spinner; non-thinking blocks (settled live noise / signal count
 * lines) keep the old path (after crunched, before tail slots). The
 * `Thinking…` title + preview/expand is drawn exactly once. ThinkingPanel has
 * retired; `ThinkingBlockSlot` still carries the thinking block's visuals
 * (peek / Markdown expand).
 */
import type { ReactNode } from "react";
import { Markdown } from "./markdown.js";
import { MessageShell } from "./message-shell.js";
import { renderActivityBlockRows } from "./activity-block-rows.js";
import { Spinner } from "./components.js";
import { formatCrunched } from "./run-stats.js";
import { formatThinkingLive, thinkingPeekLines } from "./think-fold.js";
import { formatBackgroundRunningHint } from "./subagent-message-lines.js";
import type { LiveTailSlot, LiveToolRun } from "./live-tool-state.js";
import { tuiPalette } from "./theme.js";
import type { ActivityBlock } from "./activity-block.js";

/** Reuses `LiveTailSlot` from `live-tool-state` — the consuming side does not redefine it. */
export type TailSlotDecision = LiveTailSlot;

export interface TranscriptTailProps {
  readonly contentWidth: number;
  readonly running: boolean;
  readonly crunchedSeconds: number;
  readonly tailSlots: ReadonlyArray<TailSlotDecision>;
  readonly renderLiveRuns: (runs: ReadonlyArray<LiveToolRun>) => ReactNode;
  readonly deferredThinkingDrafts: string;
  readonly thinkingExpanded: boolean;
  readonly liveToolLines: ReadonlyArray<string>;
  readonly askLine: string | undefined;
  /** Live background (`wait:false`) worker count for the residual hint line
   *  (docs/CONTEXT.md background-residual hint). 0 / absent → no line. Tail chrome only
   *  — never a model message, never the parent's 「运行中」 ("running"). */
  readonly backgroundRunningCount?: number;
  /** Activity blocks not anchored to a messageIndex — live blocks
   *  (uncommitted thinking / quiet tools) must appear in the tail. Each block
   *  renders as "title + one preview line", the same shape as blocks inside
   *  MessageRow. Empty → nothing drawn. */
  readonly unanchoredBlocks: ReadonlyArray<ActivityBlock>;
}

export function TranscriptTail(props: TranscriptTailProps): ReactNode {
  const pal = tuiPalette;
  // Thinking-at-bottom: unanchoredBlocks is split into two groups — non-thinking
  // blocks take the old path (crunched → before tail slots), thinking blocks
  // mount after askLine and before the Spinner; `Thinking…` appears once per
  // frame at most (position contract).
  const nonThinkingBlocks: ActivityBlock[] = [];
  const thinkingBlocks: ActivityBlock[] = [];
  for (const block of props.unanchoredBlocks) {
    if (block.slot.kind === "thinking") {
      thinkingBlocks.push(block);
    } else {
      nonThinkingBlocks.push(block);
    }
  }
  // After askLine / before the thinking blocks: the residual hint is the
  // last line of the tail when the parent is idle, and never displaces the
  // thinking-at-bottom position contract while a turn streams.
  const bgHint = formatBackgroundRunningHint(props.backgroundRunningCount);
  return (
    <>
      {props.crunchedSeconds > 0 && (
        <text fg={pal.dim} wrapMode="none">
          {formatCrunched(props.crunchedSeconds)}
        </text>
      )}
      {nonThinkingBlocks.length > 0 && (
        <UnanchoredActivityBlocks
          blocks={nonThinkingBlocks}
          contentWidth={props.contentWidth}
        />
      )}
      {props.tailSlots.map((slot, i) => (
        <TailSlotBox
          key={slotKey(slot, i)}
          slot={slot}
          index={i}
          running={props.running}
          contentWidth={props.contentWidth}
          renderLiveRuns={props.renderLiveRuns}
        />
      ))}
      {props.liveToolLines.length > 0 && (
        <box flexDirection="column" width={props.contentWidth}>
          {props.liveToolLines.map((line, i) => (
            <text key={`legacy-${i}`} fg={pal.dim} wrapMode="none">
              {line === "" ? " " : line}
            </text>
          ))}
        </box>
      )}
      {props.askLine !== undefined && (
        <text fg={pal.running} wrapMode="word" width={props.contentWidth}>
          {props.askLine}
        </text>
      )}
      {bgHint !== undefined && (
        <text fg={pal.dim} wrapMode="none">
          {bgHint}
        </text>
      )}
      {thinkingBlocks.length > 0 && (
        <UnanchoredThinkingBlocks
          blocks={thinkingBlocks}
          contentWidth={props.contentWidth}
          deferredThinkingDrafts={props.deferredThinkingDrafts}
          thinkingExpanded={props.thinkingExpanded}
        />
      )}
      {props.running && <Spinner />}
    </>
  );
}

function slotKey(slot: TailSlotDecision, i: number): string {
  return slot.kind === "tools" ? `live-tools-${i}` : `live-draft-${i}`;
}

/** A single tail slot: tools group → column container; draft segment → renders only while running + MessageShell. */
function TailSlotBox(props: {
  readonly slot: TailSlotDecision;
  readonly index: number;
  readonly running: boolean;
  readonly contentWidth: number;
  readonly renderLiveRuns: (runs: ReadonlyArray<LiveToolRun>) => ReactNode;
}): ReactNode {
  const slotGap = props.index === 0 ? 0 : 1;
  if (props.slot.kind === "tools") {
    return (
      <box
        flexDirection="column"
        width={props.contentWidth}
        marginTop={slotGap}
      >
        {props.renderLiveRuns(props.slot.runs)}
      </box>
    );
  }
  if (!props.running) return null;
  return (
    <MessageShell
      key={`live-draft-${props.index}`}
      cols={props.contentWidth}
      marginTop={slotGap}
    >
      <Markdown
        text={props.slot.text}
        width={Math.max(1, props.contentWidth - 2)}
        streaming
      />
    </MessageShell>
  );
}

/** Spacer holds the mounted height (the tail segment after the viewport). */
export function TailSpacer(props: {
  readonly height: number;
  readonly contentWidth: number;
}): ReactNode {
  if (props.height <= 0) return null;
  return (
    <box
      key="transcript-spacer-after"
      width={props.contentWidth}
      height={props.height}
      flexShrink={0}
    />
  );
}

/**
 * Activity blocks not anchored to a messageIndex (live blocks) rendered in
 * the tail — block title + preview line (settled → title only, running →
 * title + preview). Aligned with MessageRow's renderBlockTitles shape.
 *
 * Thinking-at-bottom: thinking blocks (`slot.kind === "thinking"`) are peeled
 * off from this shell and mounted on `UnanchoredThinkingBlocks`, drawn
 * separately after askLine and before the Spinner — within one burst, thinking
 * is the transcript's bottom. The thinking block's visuals (peek / Markdown
 * expand) are carried by the single source `ThinkingBlockSlot`, and the
 * `Thinking…` title appears exactly once on screen.
 */
function UnanchoredActivityBlocks(props: {
  readonly blocks: ReadonlyArray<ActivityBlock>;
  readonly contentWidth: number;
}): ReactNode {
  // Single source for row assembly: the non-thinking block "title + optional
  // preview" template goes through `renderActivityBlockRows` (same source as
  // MessageRow, no more independent drift). Blocks render in array order —
  // consecutive runs collapse into one rows call, preserving document order
  // and the "merge consecutive non-thinking runs into one row template"
  // behaviour (same as message-blocks).
  const titles: string[] = [];
  const previews: Array<string | null> = [];
  for (const block of props.blocks) {
    titles.push(block.title);
    previews.push(block.slot.kind === "tool-preview" ? block.slot.text : null);
  }
  return (
    <MessageShell key="unanchored-activity-blocks" cols={props.contentWidth}>
      {renderActivityBlockRows(
        titles,
        previews,
        props.contentWidth,
        (i) => `unanchored-block-${i}`
      )}
    </MessageShell>
  );
}

/**
 * Thinking-at-bottom: the still-streaming thinking segment is the transcript's
 * bottommost element — mounted separately after askLine and before the
 * Spinner. Visually it matches the old ThinkingPanel (dim `Thinking…` title +
 * peek preview or Markdown expand); the thinking title appears only once on
 * screen (physically separated from the unanchored noise count rows, avoiding
 * the old "thinking pinned above the tool card" behaviour).
 */
function UnanchoredThinkingBlocks(props: {
  readonly blocks: ReadonlyArray<ActivityBlock>;
  readonly contentWidth: number;
  readonly deferredThinkingDrafts: string;
  readonly thinkingExpanded: boolean;
}): ReactNode {
  // Single thinking block (thinking is the "one" subject of the position
  // contract — `appendLiveBlocks` yields only one thinking block; multi-block
  // cases enter unanchoredBlocks as a fresh anchor from the next thinking
  // segment). `Thinking…` is still produced by the activity-block single
  // source; this component does not duplicate the text.
  return (
    <MessageShell key="unanchored-thinking-blocks" cols={props.contentWidth}>
      {props.blocks.map((block, idx) => {
        // Non-thinking blocks must not appear in this shell — rendering them
        // would drop visible slots and break the bottommost position contract;
        // early-return fallback (defensive, the caller already split them).
        if (block.slot.kind !== "thinking") return null;
        return (
          <ThinkingBlockSlot
            key={`unanchored-thinking-${idx}`}
            contentWidth={props.contentWidth}
            draft={props.deferredThinkingDrafts}
            expanded={props.thinkingExpanded}
          />
        );
      })}
    </MessageShell>
  );
}

/** One block: thinking title + thinking preview (folded ≤3 lines / expanded full Markdown).
 *  Visually matches `ThinkingPanel` (dim rows, wrapMode="none"); the only
 *  difference is mounting inside the unanchored block shell rather than a
 *  standalone tail unit. The title does not pass through block.title — a live
 *  block's title is `formatThinkingLive()` (activity-block single source), not copied here. */
function ThinkingBlockSlot(props: {
  readonly contentWidth: number;
  readonly draft: string;
  readonly expanded: boolean;
}): ReactNode {
  const pal = tuiPalette;
  const innerWidth = Math.max(1, props.contentWidth - 2);
  return (
    <>
      <text fg={pal.dim} wrapMode="none" width={innerWidth}>
        {formatThinkingLive()}
      </text>
      {props.expanded ? (
        <box flexDirection="column" width={props.contentWidth}>
          <Markdown text={props.draft} width={props.contentWidth} streaming />
        </box>
      ) : (
        <>
          {thinkingPeekLines(props.draft).map((line, i) => (
            <text
              key={`think-peek-${i}`}
              fg={pal.dim}
              wrapMode="none"
              width={innerWidth}
            >
              {line}
            </text>
          ))}
        </>
      )}
    </>
  );
}
