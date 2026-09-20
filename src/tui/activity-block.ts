/**
 * Activity ("process") blocks, purely derived.
 *
 * Input = messages (persisted history) + live runs (uncommitted live tool
 * state) + a live-thinking flag + thinkingMsAtVisible (per-message thinking
 * duration). Output = `ActivityBlock[]` anchored after assistant messages,
 * each with a one-line title, one body slot and a `live` flag. ChatView /
 * message-blocks.tsx only consume this list — they never re-derive process
 * chrome.
 *
 * Invariants:
 *  - one assistant message may split into several blocks (cut by text /
 *    keep / accent / failure), but blocks stay chronological; a turn is
 *    never collapsed into a one-line stub.
 *  - thinking + adjacent quiet tools = welded (nothing between them: no
 *    text / keep / accent / failure). Adjacency is judged on the *raw*
 *    tool_use sequence (same scan as `orderedTurnActivitySegments`), not on
 *    filtered clusters.
 *  - failures cut across: a failed item joins no block and takes no dim
 *    preview slot, and it separates the quiet clusters on both sides (same
 *    treatment as keep / accent).
 *  - keep / accent = real cards outside blocks (uncounted), but they still
 *    separate blocks.
 *  - the slot belongs at any moment either to the thinking stream or to one
 *    dim tool-preview line (`tool-preview` text comes from
 *    `formatRunningToolLine`; no second template).
 *  - liveThinking -> block title = `Thinking…` (`formatThinkingLive`), slot
 *    owned by thinking; when welding with the last history segment, the
 *    "next block is a new thinking" rule holds (no write-back).
 *  - pure function: no React / IO / Date.now(). Early returns are marked
 *    `// EXIT:` per repo convention.
 */
import type { AnthropicNativeMessage } from "../harness/model-adapter/types.js";
import {
  formatToolUseCounts,
  thinkingMsToSeconds,
  toolUseIdsOf,
  type ToolUseCount,
} from "./turn-activity.js";
import { formatThinkingFold, formatThinkingLive } from "./think-fold.js";
import type { LiveToolRun } from "./live-tool-state.js";
import { formatRunningToolLine } from "./live-tool-state.js";
import { isLiveNoise } from "./tool-settled.js";

/** Anchor: insertion point as messageIndex + contentBlockIndex. */
export interface ActivityBlockAnchor {
  readonly messageIndex: number;
  readonly contentBlockIndex: number;
}

/** Body-slot ownership; at most one kind at a time. */
export type ActivityBlockSlot =
  | { readonly kind: "thinking" }
  | { readonly kind: "tool-preview"; readonly text: string }
  | { readonly kind: "none" };

/** Process block: title + anchor + slot + live flag. */
export interface ActivityBlock {
  readonly anchor: ActivityBlockAnchor;
  readonly title: string;
  readonly slot: ActivityBlockSlot;
  readonly live: boolean;
}

/** Input: messages + live runs + thinking durations + live-thinking flag + fold-counting resolver. */
export interface ActivityBlockInput {
  readonly messages: ReadonlyArray<AnthropicNativeMessage>;
  /** Start index (inclusive). NaN / <0 / >=length -> treated as 0 (same
   *  negative handling as `sliceTurnFrom`); past the end -> all history is
   *  dropped while live blocks still render at messages.length. */
  readonly start?: number;
  readonly thinkingMsAtVisible: (visibleIndex: number) => number;
  readonly liveThinking?: boolean;
  readonly liveRuns?: ReadonlyArray<LiveToolRun>;
  /** Same as ChatView: only items with `deriveSlot(...).inFoldCount` true
   *  are counted; default = count everything (pure-function fallback, same
   *  default as `orderedTurnActivitySegments`'s `inFoldCountOf`). */
  readonly inFoldCountOf?: (
    call: Readonly<{ id: string; name: string }>
  ) => boolean;
}

/** Default inFoldCountOf: even unregistered names fall back to retract (matches the existing default). */
function alwaysInFold(): boolean {
  return true;
}

/** Turn live tool names into `ToolUseCount[]` (first-seen order + totals), same accounting as `formatToolUseCounts`. */
function liveToolCounts(
  liveRuns: ReadonlyArray<LiveToolRun>
): ReadonlyArray<ToolUseCount> {
  const order: string[] = [];
  const counts = new Map<string, number>();
  for (const run of liveRuns) {
    const name = run.name;
    if (!counts.has(name)) order.push(name);
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return order.map((name) => ({ name, count: counts.get(name) ?? 0 }));
}

/** Title construction: duration segment + count segment.
 *  - no thinking segment and no counts -> empty string (no title drawn);
 *  - only one segment -> used directly;
 *  - both -> duration + `, ` + counts; tools within one batch joined by ` · `.
 *  - the count segment must go through `formatToolUseCounts` first — name
 *    joining and zero filtering live in that single SSOT, never a second
 *    hardcoded copy. */
function buildTitle(
  thinkingSeconds: number,
  hasWeld: boolean,
  verb: "calling" | "called",
  countsText: string
): string {
  const think = thinkingSeconds > 0 ? formatThinkingFold(thinkingSeconds) : "";
  if (think.length === 0 && countsText.length === 0) return "";
  if (think.length === 0) return `${verb} ${countsText}`;
  if (countsText.length === 0) return think;
  // Welded -> duration + `, ` + counts; unwelded (standalone block) ->
  // duration only (counts belong to the separate block). Titles only name
  // tools associated with the calling block.
  return hasWeld ? `${think}, ${verb} ${countsText}` : think;
}

/** Quiet cluster membership = retract and not failed; welding checks only
 *  this layer. Same source as "not counted" — `deriveSlot`'s `inFoldCount`
 *  is already false for failed / non-retract items, so filtering yields the
 *  weld-in set; failures (`failed:true`) fall out naturally. */
function isWeldable(
  id: string,
  name: string,
  inFoldCountOf: (call: Readonly<{ id: string; name: string }>) => boolean
): boolean {
  // Must pass the real `id`: ChatView's resolver looks failure up in
  // `toolResultStatusMap` by id; an empty id would make genuine history
  // items look unpaired and drop them from the cluster.
  return inFoldCountOf({ id, name });
}

/** Main function: pure derivation. See the module header. */
export function deriveActivityBlocks(
  input: ActivityBlockInput
): ReadonlyArray<ActivityBlock> {
  const {
    messages,
    thinkingMsAtVisible,
    liveThinking = false,
    liveRuns = [],
  } = input;

  let start = input.start ?? 0;
  if (!Number.isFinite(start) || start < 0) start = 0;

  const inFoldCountOf = input.inFoldCountOf ?? alwaysInFold;
  const blocks: ActivityBlock[] = [];

  // Out-of-range start: drop all history, but live blocks (thinking stream
  // / live quiet tools) still render at messages.length (the virtual
  // messageIndex of the uncommitted phase).
  const historyStart = Math.min(start, messages.length);

  try {
    // Single pass: accumulate counts and recognize cut boundaries. Each
    // block's duration segment comes from the first block's thinking
    // duration; when a message has several thinking segments only the first
    // carries the duration (no cross-message summation — matches
    // `thinkingMsAtVisible`'s per-message meaning).
    const scratch: ScratchState = {
      pending: null,
      blocks,
      drawnThinkingMessageIndices: new Set<number>(),
      thinkingMsAtVisible,
      liveRuns,
    };

    // Tool uses: i indexes messages (not visible) — one message may split
    // into several clusters; cut points = text / keep / accent / failure.
    const startIndex = Math.trunc(historyStart);
    for (let i = startIndex; i < messages.length; i++) {
      scanMessage(i, messages[i], inFoldCountOf, scratch);
    }
  } catch {
    // EXIT: malformed messages draw no blocks (same fallback as `orderedTurnActivitySegments`).
    return [];
  }

  // Live phase: uncommitted tools + thinking stream -> standalone blocks at
  // `messages.length` (history block counts untouched; this is the source of
  // "a new message opens a new block" and "hideThinking follows only the
  // slot owner"). Blocks carry **only** retract-class runs (same source as
  // history's `inFoldCountOf`) — keep / accent / failure stay on the tail
  // tool cards (live-tool-preview) and history blocks, otherwise the
  // original tail path would double-draw them.
  appendLiveBlocks(blocks, {
    messageIndex: messages.length,
    contentBlockIndex: 0,
    liveRuns: liveRuns.filter((run) => !toolUseIdsOf(messages).has(run.id)),
    liveThinking,
  });

  return blocks;
}

/** Render the live tool cluster and thinking stream at messages.length; pure tail append. */
function appendLiveBlocks(
  blocks: ReadonlyArray<ActivityBlock>,
  args: {
    messageIndex: number;
    contentBlockIndex: number;
    liveRuns: ReadonlyArray<LiveToolRun>;
    liveThinking: boolean;
  }
): void {
  const { messageIndex, contentBlockIndex, liveRuns, liveThinking } = args;
  const list = blocks as ActivityBlock[];
  // Thinking-at-bottom: within one burst the thinking block is appended
  // last — a still-streaming thinking segment sits at the bottom of the
  // batch in document order, and any action it already drove appears above
  // it.
  //
  // Live quiet cluster: only live-noise names enter unanchored blocks.
  // web_search / web_fetch go to real cards (live signal), never into block
  // counts / slot previews. Failure / keep / accent keep the original tail /
  // history path to avoid double drawing. The predicate is `isLiveNoise`
  // (settled counting unchanged; web_* still retract).
  const retractRuns = liveRuns.filter(
    (run) => run.status !== "failed" && isLiveNoise(run.name)
  );
  const counts = liveToolCounts(retractRuns);
  if (counts.length > 0) {
    const verb = retractRuns.some((run) => run.status === "running")
      ? "calling"
      : "called";
    const lastRunning = [...retractRuns]
      .reverse()
      .find((run) => run.status === "running");
    list.push({
      anchor: { messageIndex, contentBlockIndex },
      title: `${verb} ${formatToolUseCounts(counts)}`,
      slot:
        lastRunning !== undefined
          ? { kind: "tool-preview", text: formatRunningToolLine(lastRunning) }
          : { kind: "none" },
      live: verb === "calling",
    });
  }
  if (liveThinking) {
    list.push({
      anchor: { messageIndex, contentBlockIndex },
      title: formatThinkingLive(),
      slot: { kind: "thinking" },
      live: true,
    });
  }
}

/** Scan scratch state: pending accumulator + produced blocks + per-message
 *  thinking dedupe set + thinkingMs closure (so helpers don't re-thread
 *  params). Keeping scan state in one place avoids cyclomatic-complexity
 *  growth in the main function. */
interface PendingAccumulator {
  readonly messageIndex: number;
  readonly contentBlockIndex: number;
  readonly counts: Map<string, number>;
  readonly order: string[];
  /** tool_use ids covered by this block — paired with live run ids to
   *  decide "welded cluster still has running items -> calling + preview slot". */
  readonly toolUseIds: Set<string>;
  readonly hasWeld: boolean; // block contains weldable quiet items
  readonly weldedThinkingSeconds: number; // thinking duration welded into this block's title
}

interface ScratchState {
  pending: PendingAccumulator | null;
  blocks: ActivityBlock[];
  drawnThinkingMessageIndices: Set<number>;
  thinkingMsAtVisible: (visibleIndex: number) => number;
  liveRuns: ReadonlyArray<LiveToolRun>;
}

/** Scan one assistant message (complexity split): skip non-assistant /
 *  non-array content; classifyBlock each content block; flushPending at the
 *  end to materialize accumulated pending. */
function scanMessage(
  messageIndex: number,
  message: AnthropicNativeMessage | undefined,
  inFoldCountOf: (call: Readonly<{ id: string; name: string }>) => boolean,
  scratch: ScratchState
): void {
  if (message === undefined) return;
  if (message.role !== "assistant") return;
  if (!Array.isArray(message.content)) {
    // EXIT: non-array content cannot safely join the ordered activity projection.
    return;
  }
  // Same-message dedupe: flush the previous message's pending before
  // re-entering a message. This rule also serves as the "text cuts blocks"
  // mechanism — arriving text blocks flush the same way.
  for (const [contentBlockIndex, block] of message.content.entries()) {
    classifyBlock(
      block,
      contentBlockIndex,
      messageIndex,
      inFoldCountOf,
      scratch
    );
  }
  // End of message -> flush.
  flushPending(scratch);
}

/** Classify + accumulate one block (complexity split: dispatch moved out of
 *  the main scan). Text / keep / failure cut points flush in place here;
 *  thinking / tool_use accumulate into scratch.pending. */
function classifyBlock(
  block: AnthropicNativeMessage["content"][number],
  contentBlockIndex: number,
  messageIndex: number,
  inFoldCountOf: (call: Readonly<{ id: string; name: string }>) => boolean,
  scratch: ScratchState
): void {
  if (block === null || block === undefined) {
    // EXIT: skip null/undefined blocks instead of throwing (malformed-shape tolerance).
    return;
  }
  if (block.type === "text") {
    // Text cut point: flush current pending (applies within and across messages).
    flushPending(scratch);
    return;
  }
  if (block.type === "thinking" || block.type === "redacted_thinking") {
    absorbThinking(messageIndex, contentBlockIndex, scratch);
    return;
  }
  if (block.type !== "tool_use") return;
  if (!isWeldable(block.id, block.name, inFoldCountOf)) {
    // keep / accent / failure item -> flush current pending and skip the item itself.
    flushPending(scratch);
    return;
  }
  absorbToolUse(block, contentBlockIndex, messageIndex, scratch);
}

/** Thinking segment: thinkingMs stays per-message; the first segment carries the duration. */
function absorbThinking(
  messageIndex: number,
  contentBlockIndex: number,
  scratch: ScratchState
): void {
  if (scratch.pending !== null) {
    // Pending already exists (previous block is in the same message) -> do not accumulate duration again.
    return;
  }
  // Do not flush immediately — the next segment decides whether the title welds in.
  const seconds = thinkingMsToSeconds(
    scratch.thinkingMsAtVisible(messageIndex)
  );
  if (seconds === 0) return;
  if (scratch.drawnThinkingMessageIndices.has(messageIndex)) return;
  scratch.pending = {
    messageIndex,
    contentBlockIndex,
    counts: new Map(),
    order: [],
    toolUseIds: new Set<string>(),
    hasWeld: false,
    weldedThinkingSeconds: seconds,
  };
  scratch.drawnThinkingMessageIndices.add(messageIndex);
}

/** Weldable tool_use: accumulate counts and decide block cuts (cross-message flush / same-message weld upgrade). */
function absorbToolUse(
  block: { id: string; name: string },
  contentBlockIndex: number,
  messageIndex: number,
  scratch: ScratchState
): void {
  if (scratch.pending === null) {
    scratch.pending = createWeldPending(messageIndex, contentBlockIndex);
  } else if (scratch.pending.messageIndex !== messageIndex) {
    // Cross-message -> flush the previous message's pending, start a fresh block.
    flushPending(scratch);
    scratch.pending = createWeldPending(messageIndex, contentBlockIndex);
  } else if (scratch.pending.weldedThinkingSeconds > 0) {
    // Same-message weld — thinking segment + tool_use coexisting = welded.
    scratch.pending = { ...scratch.pending, hasWeld: true };
  }
  const pending = scratch.pending;
  if (!pending.counts.has(block.name)) pending.order.push(block.name);
  pending.counts.set(block.name, (pending.counts.get(block.name) ?? 0) + 1);
  pending.toolUseIds.add(block.id);
}

function createWeldPending(
  messageIndex: number,
  contentBlockIndex: number
): PendingAccumulator {
  return {
    messageIndex,
    contentBlockIndex,
    counts: new Map(),
    order: [],
    toolUseIds: new Set<string>(),
    hasWeld: true,
    weldedThinkingSeconds: 0,
  };
}

/** Flush accumulated pending -> emit a block (nothing accumulated or empty title -> no block). */
function flushPending(scratch: ScratchState): void {
  const pending = scratch.pending;
  if (pending === null) return;
  const hasCounts = pending.counts.size > 0;
  if (!pending.hasWeld && !hasCounts && pending.weldedThinkingSeconds === 0) {
    // EXIT: nothing accumulated (no weld items, no counted thinking segment) -> draw no block.
    scratch.pending = null;
    return;
  }
  const { isStillRunning, lastRunningRun } = resolveLiveRunning(
    pending.toolUseIds,
    scratch.liveRuns
  );
  const title = composePendingTitle(pending, hasCounts, isStillRunning);
  if (title.length === 0) {
    scratch.pending = null;
    return;
  }
  scratch.blocks.push({
    anchor: {
      messageIndex: pending.messageIndex,
      contentBlockIndex: pending.contentBlockIndex,
    },
    title,
    slot:
      lastRunningRun !== undefined
        ? {
            kind: "tool-preview",
            text: formatRunningToolLine(lastRunningRun),
          }
        : { kind: "none" },
    live: isStillRunning,
  });
  scratch.pending = null;
}

/** Resolve the live running state for a pending block: a live run with a
 *  matching id means the block is still evolving; the preview slot shows the
 *  last running one. */
function resolveLiveRunning(
  toolUseIds: ReadonlySet<string>,
  liveRuns: ReadonlyArray<LiveToolRun>
): { isStillRunning: boolean; lastRunningRun: LiveToolRun | undefined } {
  const liveRunByToolUseId = new Map<string, LiveToolRun>();
  for (const run of liveRuns) {
    if (run.status !== "running") continue;
    if (toolUseIds.has(run.id)) {
      liveRunByToolUseId.set(run.id, run);
    }
  }
  return {
    isStillRunning: liveRunByToolUseId.size > 0,
    lastRunningRun: [...liveRunByToolUseId.values()].pop(),
  };
}

/** Compose the block title: thinking duration segment + welded counts + calling/called verb. */
function composePendingTitle(
  pending: PendingAccumulator,
  hasCounts: boolean,
  isStillRunning: boolean
): string {
  const verb: "calling" | "called" =
    hasCounts && !isStillRunning ? "called" : "calling";
  return buildTitle(
    pending.weldedThinkingSeconds,
    pending.hasWeld && hasCounts,
    verb,
    hasCounts
      ? formatToolUseCounts(
          pending.order.map((name) => ({
            name,
            count: pending.counts.get(name) ?? 0,
          }))
        )
      : ""
  );
}
