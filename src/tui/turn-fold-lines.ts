/**
 * Turn / fold derivation extracted out of ChatView into a pure module;
 * rendering remains ChatView's job.
 *
 * The old `buildFoldLinesBySegmentIndex` path (unit fold lines) is fully
 * retired — the block list (`buildActivityBlockFoldLines`) is the single
 * source of folding. This module keeps:
 *  - `pickMessageSegments` / `renderInContentOrder` (MessageRow render splitting)
 *  - `makeThinkingMsAtVisibleFromSource` (visibleIndex -> sourceIndex mapping)
 *  - `segmentActivityBlocks` / `firstPartThinkingBlocks` (segment render slices)
 *  - `shouldShowLiveThinkingPanel` (live-thinking yield check)
 *  - `buildActivityBlockFoldLines` (activity block title / preview / hideThinking derivation)
 *
 * Pure functions, no React / IO dependency; the caller (ChatView) feeds the
 * result maps back into the render layer.
 */
import type { AnthropicNativeMessage } from "../harness/model-adapter/types.js";
import type { LiveToolRun } from "./live-tool-state.js";
import type { TurnActivitySegment } from "./turn-activity.js";
import {
  deriveActivityBlocks,
  type ActivityBlock,
  type ActivityBlockInput,
} from "./activity-block.js";

/** Anchor message index -> fold lines (unit fold, 0 or 1 line). The type is
 *  kept for the MessageRow / ChatScrollbox call surface, but this module no
 *  longer populates it; an always-empty map is passed. */
export type FoldLinesBySegmentIndex = ReadonlyMap<
  number,
  ReadonlyArray<string>
>;

/** Set of ms values already covered by fold lines (for hideThinking; keyed on derived values, never reverse-parsed from display text). */
export type ShownThinkingMsValues = ReadonlySet<number>;

/** Injectable form of `thinkingMsAtVisible(visibleIndex)` — the render layer
 *  maps sourceIndex -> visibleIndex; this module only sees visible indices. */
export type ThinkingMsAtVisible = (visibleIndex: number) => number;

/**
 * Live thinking panel yield check — see docs/CONTEXT.md `open unit`:
 * already-drawn activity blocks (`Thought for` / `calling / called`) are
 * **not** a signal to close the following thinking panel; the only reason to
 * yield is that **the burst has closed** (the draft buffer clears on every
 * `text_delta` / `tool_call_start` — `closeThinkingPhase`). Any running tool
 * (including tools started later within the same burst) no longer closes the
 * panel — arbitrary "some tool is running" must never suppress the next
 * thinking block.
 *
 * Note: after the live-signal change this keeps only the **pure-function
 * exit** (a cap + test coverage); no production code calls it anymore —
 * ChatView drives unanchored activity blocks directly via the `liveThinking`
 * field and the ThinkingPanel component is retired. The export remains purely
 * as a historical fixture and semantic documentation of the
 * `thinkingDraftMasked` gate.
 */
export function shouldShowLiveThinkingPanel(opts: {
  readonly running: boolean;
  readonly thinkingDraft: string;
}): boolean {
  return opts.running && opts.thinkingDraft.length > 0;
}

/**
 * `messageSegments` — the subset of activitySegments belonging to one
 * messageIndex (a message may split into several clusters: tool -> text ->
 * tool). Filters `segment.messageIndex === visibleIndex` out of the full list.
 */
export function pickMessageSegments(
  activitySegments: ReadonlyArray<TurnActivitySegment>,
  visibleIndex: number
): ReadonlyArray<{
  readonly segmentIndex: number;
  readonly segment: TurnActivitySegment;
}> {
  const out: Array<{
    readonly segmentIndex: number;
    readonly segment: TurnActivitySegment;
  }> = [];
  for (let i = 0; i < activitySegments.length; i++) {
    const seg = activitySegments[i];
    if (seg !== undefined && seg.messageIndex === visibleIndex) {
      out.push({ segmentIndex: i, segment: seg });
    }
  }
  return out;
}

/** Given messageSegments: more than one segment and at least one carries
 *  fold lines — controls whether the "in content order" render branch runs. */
export function renderInContentOrder(
  messageSegments: ReadonlyArray<{
    readonly segmentIndex: number;
    readonly segment: TurnActivitySegment;
  }>,
  foldLinesBySegmentIndex: FoldLinesBySegmentIndex
): boolean {
  if (messageSegments.length <= 1) return false;
  for (const { segmentIndex } of messageSegments) {
    if (foldLinesBySegmentIndex.has(segmentIndex)) return true;
  }
  return false;
}

/**
 * Flatten `visibleMessages` / `thinkingMs` into `thinkingMsAtVisible`: map
 * `visibleIndex -> sourceIndex` then look up. Missing sourceIndex falls back to 0.
 */
export function makeThinkingMsAtVisibleFromSource(
  thinkingMs: ReadonlyArray<number | null> | undefined,
  sourceIndexOfVisible: ReadonlyArray<number>
): ThinkingMsAtVisible {
  return (visibleIndex: number): number => {
    const sourceIndex = sourceIndexOfVisible[visibleIndex] ?? visibleIndex;
    if (thinkingMs === undefined) return 0;
    const value = thinkingMs[sourceIndex];
    if (value === null || value === undefined) return 0;
    if (!Number.isFinite(value) || value <= 0) return 0;
    return value;
  };
}

/**
 * Activity-block slice from message content for one segment (`text` takes a
 * single block; `tools` takes the tool_use items in blockIndex..endIndex).
 * Previously the ChatView inner segment renderer extracted "this segment's
 * activity blocks" + (first part) thinkingBlocks from message.content.
 */
export function segmentActivityBlocks(
  message: AnthropicNativeMessage,
  segment: TurnActivitySegment,
  blockIndex: number,
  endIndex: number
): AnthropicNativeMessage["content"] {
  if (segment.kind === "text") {
    const block = message.content[blockIndex];
    return block === undefined ? [] : [block];
  }
  return message.content
    .slice(blockIndex, endIndex)
    .filter((b) => b.type === "tool_use");
}

/** Thinking blocks of the first part (thinking + redacted_thinking) — attached only to the first segment. */
export function firstPartThinkingBlocks(
  message: AnthropicNativeMessage
): AnthropicNativeMessage["content"] {
  return message.content.filter(
    (b) => b.type === "thinking" || b.type === "redacted_thinking"
  );
}

/**
 * Activity block line derivation (Thinking-at-bottom): route blocks from
 * `deriveActivityBlocks` to MessageRow by messageIndex while **keeping the
 * anchor** (contentBlockIndex) — settled titles are inserted by MessageBlocks
 * into the message content order, never dumped as a whole at the message tail.
 *
 * Key mapping (per-message, **no** cross-message merge):
 *  - block anchor (messageIndex, contentBlockIndex) matches messageIndex
 *    directly; the old cross-message merge of `orderedTurnActivitySegments`
 *    (unit-fold contract) is gone.
 *  - multiple blocks under one messageIndex are consumed ascending by
 *    contentBlockIndex.
 *  - blocks with no matching messageIndex (live thinking blocks, live tool
 *    clusters) fall into `unanchoredBlocks`, which ChatView hands to
 *    TranscriptTail.
 *
 * Invariants:
 *  - block title text = `ActivityBlock.title` (single source via
 *    `formatToolUseCounts`, never re-composed);
 *  - thinkingMs covered by blocks enters `shownThinkingMsValues`, used by the
 *    hideThinking double gate;
 *  - `hideThinking` hides only the non-slot-owner thinking body paths inside
 *    MessageBlocks and never touches the anchor titles derived here.
 */
/** One rendered line for an anchored activity block: anchor + title + optional preview. */
export interface ActivityBlockLine {
  readonly contentBlockIndex: number;
  readonly title: string;
  /** `null` = the block has no preview line (settled block with slot.kind
   *  === "none", or a thinking slot); non-null draws one dim current-preview
   *  line under the block title. */
  readonly preview: string | null;
}

export interface ActivityBlockFoldDerivation {
  /** messageIndex (visible) -> this message's activity block lines
   *  (ascending by contentBlockIndex, anchors kept for MessageBlocks'
   *  in-place insertion). */
  readonly blockLinesByMessage: ReadonlyMap<
    number,
    ReadonlyArray<ActivityBlockLine>
  >;
  /** thinkingMs values covered by blocks (for hideThinking). */
  readonly shownThinkingMsValues: ReadonlySet<number>;
  /** Blocks matching no messageIndex (live blocks) — for the tail. */
  readonly unanchoredBlocks: ReadonlyArray<ActivityBlock>;
}

/**
 * Main function: pure derivation — see the module header. Inputs share the
 * `deriveActivityBlocks` shape. The returned map is indexed by messageIndex
 * (flattened visible index); multiple blocks per messageIndex are consumed
 * ascending by contentBlockIndex, one title line per block.
 */
export function buildActivityBlockFoldLines(args: {
  readonly messages: ReadonlyArray<AnthropicNativeMessage>;
  readonly visibleStart?: number;
  readonly visibleCount: number;
  readonly thinkingMsAtVisible: (visibleIndex: number) => number;
  readonly liveRuns?: ReadonlyArray<LiveToolRun>;
  readonly liveThinking?: boolean;
  readonly inFoldCountOf?: ActivityBlockInput["inFoldCountOf"];
}): ActivityBlockFoldDerivation {
  const { messages } = args;
  const blocks = deriveActivityBlocks({
    messages,
    start: args.visibleStart,
    thinkingMsAtVisible: args.thinkingMsAtVisible,
    liveRuns: args.liveRuns,
    liveThinking: args.liveThinking,
    inFoldCountOf: args.inFoldCountOf,
  });
  // Group by messageIndex, keeping anchors; multiple blocks of one message
  // sort ascending by contentBlockIndex (a block's contentBlockIndex is the
  // index of its cluster's first block).
  const byMessage = new Map<number, Array<ActivityBlockLine>>();
  const shownThinkingMsValues = new Set<number>();
  const unanchoredBlocks: ActivityBlock[] = [];

  for (const block of blocks) {
    if (block.anchor.messageIndex >= args.visibleCount) {
      // EXIT: on-disk index >= visibleCount -> live block (uncommitted phase), falls to the tail.
      unanchoredBlocks.push(block);
      continue;
    }
    const arr = byMessage.get(block.anchor.messageIndex) ?? [];
    arr.push({
      contentBlockIndex: block.anchor.contentBlockIndex,
      title: block.title,
      preview: block.slot.kind === "tool-preview" ? block.slot.text : null,
    });
    byMessage.set(block.anchor.messageIndex, arr);
    const ms = args.thinkingMsAtVisible(block.anchor.messageIndex);
    if (ms > 0) shownThinkingMsValues.add(ms);
  }
  // Sort + freeze to read-only.
  const blockLinesByMessage = new Map<
    number,
    ReadonlyArray<ActivityBlockLine>
  >();
  for (const [mi, list] of byMessage) {
    list.sort((a, b) => a.contentBlockIndex - b.contentBlockIndex);
    blockLinesByMessage.set(mi, list);
  }

  return {
    blockLinesByMessage,
    shownThinkingMsValues,
    unanchoredBlocks,
  };
}
