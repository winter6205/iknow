/** @jsxImportSource @opentui/react */
/**
 * src/tui/chat-view.tsx
 *
 * Session view (OpenTUI full-content scrolling, superseding the earlier
 * simplified shell and the ink line-window path). To keep ChatView within
 * the S5 complexity gate (errors 0, nesting <= 4, complexity <= 10), the
 * fold-line derivation lives in `turn-fold-lines.ts`, the banner in
 * `transcript-banner.tsx`, mounted message rows in `message-row.tsx`, and
 * the tail in `transcript-tail.tsx`; this file keeps hooks + memo derivations
 * + scrollbox assembly.
 *
 * Scrolling discipline:
 *  - everything goes through the built-in
 *    `<scrollbox stickyScroll stickyStart="bottom">` — layout positions come
 *    from scrollbox measurements (scrollTop / scrollHeight /
 *    viewport.height via the ChatViewHandle.scrollbox ref); this file does no
 *    line accounting / line-window math and never estimates message line
 *    counts (the archived row-window modules are fully deleted).
 *  - sticky smart mode: appended content follows the bottom by default;
 *    scrolling up stops following, and returning within +/-1 row of the
 *    bottom resumes automatically.
 *  - Forced bottom channel: ChatViewHandle.scrollToBottom().
 *
 * Rendered content (everything inside the scrollbox, full width, self-scrolling):
 *  - banner section (when props.bannerLines provided): first segment, sharing
 *    the scroll space with messages; implemented by `<TranscriptBanner>`.
 *  - **Viewport mounting** (`transcript-viewport.ts`): the full session stays
 *    in `session.messages`; the OpenTUI tree mounts only messages inside the
 *    viewport + overscan, with spacers holding up `scrollHeight`. No fixed
 *    tail-window counts / row math. The live tail is not part of the
 *    virtualized collection. The viewport window's scrollTop comes from the
 *    `verticalScrollBar` `change` event (assigning scrollTop emits it too);
 *    patching the setter / rAF polling is forbidden.
 *  - each **mounted** message → `<MessageRow>` (passing visibleIndex /
 *    foldLinesBySegmentIndex / derived messageSegments).
 *  - tail (streaming thinking / draft panels + liveToolRuns + legacy
 *    liveToolLines + askLine + spinner): handled by `<TranscriptTail>`.
 *
 * Tool-output expansion location:
 *  - **previews inside historical messages**: rendered inside
 *    `<MessageRow>` via `MessageBlocks.ToolPreviewRows` →
 *    `CompletedToolPreviewView`;
 *  - **live tail**: `<TranscriptTail>` takes the `liveToolPreviewBox` path.
 *
 * Streaming concurrency defense: `draftSegments` and `thinkingDraftMasked`
 * pass through useDeferredValue — high-frequency updates downgrade to low
 * priority, forming two-way defense with the app-layer startTransition.
 *
 * Forbidden (orthogonal to the archived row-window):
 *  - line counting / line-window math;
 *  - markdown-lines / message-rows / row-window / chat-flow (archived row-accounting modules);
 *  - mirror render trees (one component taking both MessageBlocks and Clipped paths);
 *  - selection / onWindow / HighlightedLine (the OpenTUI renderer handles selection).
 *
 * ChatViewHandle stays: scrollToBottom + scrollbox ref direct query.
 */
import {
  forwardRef,
  useDeferredValue,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { ScrollBoxRenderable } from "@opentui/core";
import type { AnthropicNativeMessage } from "../harness/model-adapter/types.js";
import type { SubagentInfo } from "../harness/subagent/manager.js";
import { chatWheelScrollAccel } from "./wheel-scroll.js";
import {
  attachScrollbarHover,
  scrollbarThumbColor,
  scrollbarTrackColor,
} from "./scrollbar-style.js";
import {
  isTuiHiddenUserMessage,
  type TuiSessionState,
} from "./session-state.js";
import { liveTailSlots, type LiveToolRun } from "./live-tool-state.js";
import { liveToolRunsBox } from "./live-tool-preview.js";
import {
  subagentCardLinesMap,
  subagentCardsKey,
  type SubagentCardLines,
} from "./subagent-message-lines.js";
import {
  syncToolIndex,
  type TranscriptToolIndex,
} from "./tool-result-index.js";
import {
  listenScrollBoxTop,
  resolveScrollCommitStep,
  selectViewportMountWindow,
  shouldCommitScrollTop,
  type ViewportMountWindow,
} from "./transcript-viewport.js";
import { orderedTurnActivitySegments } from "./turn-activity.js";
import { isLiveNoise } from "./tool-settled.js";
import { TranscriptBanner } from "./transcript-banner.js";
import { MessageRow, messageSegmentsOfVisible } from "./message-row.js";
import {
  TranscriptTail,
  TailSpacer,
  type TailSlotDecision,
} from "./transcript-tail.js";
import {
  buildActivityBlockFoldLines,
  makeThinkingMsAtVisibleFromSource,
  stabilizeActivityBlockLines,
  type ActivityBlockLine,
  type FoldLinesBySegmentIndex,
  type FoldLinesCache,
  type ShownThinkingMsValues,
  type ThinkingMsAtVisible,
} from "./turn-fold-lines.js";
import type { TurnActivitySegment } from "./turn-activity.js";

/** Stable empty array for rows without activity-block lines (the render-side
 *  `?? EMPTY` fallback must not mint a new array per render — MessageBlocks'
 *  memo shallow-compare depends on the reference). */
const EMPTY_ACTIVITY_BLOCKS: ReadonlyArray<ActivityBlockLine> = [];

interface ProjectionState {
  readonly conversationId: string | undefined;
  readonly head: AnthropicNativeMessage | undefined;
  readonly length: number;
  readonly epoch: number;
}

/**
 * Projection-identity transition: the reset unit is the transcript
 * projection, not just the session id. The explicit reset signals are
 * (a) conversationId change, (b) head identity change, (c) the array
 * shrinking (`length < prev.length`) — appends never shrink, so a shrink
 * (rewind-to-prefix / truncation) resets even when the head object survives.
 * Reference-reuse on rehydration keeps the head object across turn-end
 * appends, so (b) alone only fires on a real head replacement (compact);
 * (c) covers the prefix-returning shapes. On reset, itemHeights / scrollTop
 * / the quantization cursor are all stale and the TUI follows the new
 * projection bottom. Null = same projection.
 */
function projectionTransition(
  prev: ProjectionState,
  conversationId: string | undefined,
  head: AnthropicNativeMessage | undefined,
  length: number
): ProjectionState | null {
  if (
    prev.conversationId === conversationId &&
    prev.head === head &&
    length >= prev.length
  ) {
    return null; // EXIT: pure append / unchanged — keep the user position
  }
  return { conversationId, head, length, epoch: prev.epoch + 1 };
}

export interface ChatViewHandle {
  /**
   * Force scroll to bottom (called by the app layer when the user sends a new
   * message / a turn completes): scrollTop goes straight to
   * scrollHeight - viewport, sticky state resets accordingly, and subsequent
   * appends resume following.
   */
  scrollToBottom(): void;
  /**
   * Direct query entry to the scrollbox renderable (layout-measurement SSOT):
   * scrollTop / scrollHeight / viewport.height / scrollBy / scrollTo. Null before mount.
   */
  readonly scrollbox: ScrollBoxRenderable | null;
}

export interface ChatViewProps {
  /** Session state machine. Messages + runState + streaming boundaries. */
  readonly session: TuiSessionState;
  /** Read-only subagent projection (the app layer's 1Hz polling of
   *  `bridge.listSubagents()`). This component joins by `toolUseId` onto the
   *  spawn card; absent / empty → cards stay byte-identical to before (single-
   *  line summaries for history cards, existing shape for live cards). */
  readonly subagents?: ReadonlyArray<SubagentInfo>;
  /** Scroll area width (terminal columns). */
  readonly cols: number;
  /** Scroll area height budget (input box / status bar are mounted separately at the app layer). */
  readonly rows: number;
  /**
   * Per-event tool lines appearing during a turn (legacy formatLiveToolEvent
   * string lines). When liveToolRuns is structured this degrades to a tail
   * supplement (coexists with the structured form; kept for backward compat).
   */
  readonly liveToolLines: ReadonlyArray<string>;
  /**
   * Structured real-time tool-call state. Running entries render as
   * `[运行中] name`; completed entries use the unified diff preview.
   * liveToolReduce maintains order; default = empty array.
   */
  readonly liveToolRuns?: ReadonlyArray<LiveToolRun>;
  /** Streaming-accumulated masked assistant text (draft). Rendered before the
   *  spinner while running-fg. Single-segment compat: draftsMasked alone is
   *  treated as one segment. */
  readonly draftsMasked?: string;
  /** Draft segments split by seal. When present it takes precedence over
   *  draftsMasked and interleaves with liveToolRuns by draftEpoch. */
  readonly draftSegments?: ReadonlyArray<string>;
  /** Streaming thinking draft masked text. thinkingExpanded decides collapsed / expanded. */
  readonly thinkingDraftMasked?: string;
  /** Runtime-seconds snapshot of the most recent completed turn (written by
   *  the app layer's runTurnOnce finally when crunchedOf === activeKey).
   *  Renders `Crunched for X` at the end of the message stream: shown after
   *  the session ends, cleared while running (the app layer owns crunchedOf
   *  attribution; ChatView only conditionally renders). Undefined → not
   *  rendered. */
  readonly crunchedSeconds?: number;
  /** askUser pending prompt (undefined = no pending ask). */
  readonly askLine?: string;
  /** thinking collapse-panel expanded state (false = hide thinking plaintext). */
  readonly thinkingExpanded?: boolean;
  /**
   * Banner as the scroll area's first segment (sharing the scroll space with
   * messages). When the eye fits, banner.ts draws the full 13-line eye; only
   * when the dot matrix itself does not fit does it fall back to one line.
   */
  readonly bannerLines?: ReadonlyArray<string>;
}

export const ChatView = forwardRef<ChatViewHandle, ChatViewProps>(
  function ChatView(props, ref) {
    const sbRef = useRef<ScrollBoxRenderable | null>(null);
    const [scrollTop, setScrollTop] = useState(Number.MAX_SAFE_INTEGER);
    const [itemHeights, setItemHeights] = useState<ReadonlyArray<number>>([]);
    const conversationId = props.session.conversationId;
    // Projection tracking: itemHeights / scrollTop reset when the
    // transcript projection is replaced (see projectionTransition).
    const messagesHead = props.session.messages[0];
    const messagesLength = props.session.messages.length;
    const [projection, setProjection] = useState<ProjectionState>({
      conversationId,
      head: messagesHead,
      length: messagesLength,
      epoch: 0,
    });
    const nextProjection = projectionTransition(
      projection,
      conversationId,
      messagesHead,
      messagesLength
    );
    if (nextProjection !== null) {
      setProjection(nextProjection);
      setItemHeights([]);
      setScrollTop(Number.MAX_SAFE_INTEGER);
    }
    const projectionEpoch = projection.epoch;
    const [scrollbarHovered, setScrollbarHovered] = useState(false);
    useScrollboxBindings({
      sbRef,
      setScrollbarHovered,
      setScrollTop,
      ref,
      // On projection reset (session switch or head replacement) itemHeights /
      // scrollTop go stale (see above) — the commit-quantization cursor must
      // reset too: a cursor from the old projection would classify the new
      // one's first sub-threshold change as "step not crossed" and drop it,
      // leaving the new window stuck at the old position.
      projectionEpoch,
    });
    // Concurrency defense: high-frequency streaming drafts update at low priority.
    const draftSegments = useMemo((): ReadonlyArray<string> => {
      if (props.draftSegments !== undefined) {
        return props.draftSegments;
      }
      if (props.draftsMasked !== undefined && props.draftsMasked.length > 0) {
        return [props.draftsMasked];
      }
      return [];
    }, [props.draftSegments, props.draftsMasked]);
    const deferredSegments = useDeferredValue(draftSegments);
    const deferredThinkingDrafts = useDeferredValue(
      props.thinkingDraftMasked ?? ""
    );
    // Incremental tool_use_id index: statusMap / resultTextMap are
    // byte-equivalent to the tool-summary.ts full-build SSOT but maintained
    // across message-array changes — the append-mostly transcript plus the
    // reference-reuse rehydration makes turn-end updates a pure append, and
    // a tool-free append keeps the previous map references outright. The
    // refs stay stable across renders (MessageBlocks memo contract).
    const toolIndexRef = useRef<TranscriptToolIndex | null>(null);
    const toolIndex = useMemo(() => {
      const next = syncToolIndex(toolIndexRef.current, props.session.messages);
      toolIndexRef.current = next;
      return next;
    }, [props.session.messages]);
    const statusMap = toolIndex.statusMap;
    const resultTextMap = toolIndex.resultTextMap;
    const running = props.session.runState === "running-fg";
    const thinkingExpanded = props.thinkingExpanded === true;
    // Message content width leaves room for the scrollbar / safe margin
    // (scrollbox-measured; no line-count estimation).
    const contentWidth = Math.max(1, props.cols - 2);
    const liveToolRuns = props.liveToolRuns ?? [];
    // Card-level two-line projection (toolUseId → two lines). One projection
    // feeds both hosts (history cards via MessageRow→MessageBlocks, and the
    // live tail via liveToolRunsBox); the four consumption rules stay single-
    // source and cannot drift.
    //
    // The dependency is a **content signature** (not the array reference):
    // the app layer's 1Hz polling produces a new array on every setSubagents,
    // and using the reference as dependency would create a new Map each
    // second → the memoized downstream history blocks (MessageBlocks shallow-
    // compares subagentCards) would rebuild their whole element tree every
    // second.
    const subagentsKey = subagentCardsKey(props.subagents ?? []);
    const subagentCards = useMemo(
      () => subagentCardLinesMap(props.subagents ?? [], contentWidth),
      // eslint-disable-next-line react-hooks/exhaustive-deps -- see above: the signature is the content
      [subagentsKey, contentWidth]
    );
    // Live-adjacent keep cards get one blank row between them — the spacing
    // converges inside liveToolRunsBox (history-side MessageBlocks gives each
    // block its own rhythm).
    const renderLiveRuns = (runs: ReadonlyArray<LiveToolRun>) =>
      liveToolRunsBox(runs, contentWidth, subagentCards);
    const bannerLines = props.bannerLines ?? [];
    // The visible list drops hidden user messages (agent_status / drain), so
    // it is shorter than the on-disk array. All thinkingMs lookups must map
    // back to sourceIndex, otherwise `Thought for` reads a null slot, the
    // fold line disappears, and hideThinking then clips the summary out of the
    // message box too.
    const visibleEntries = useMemo(
      () =>
        props.session.messages
          .map((message, sourceIndex) => ({ message, sourceIndex }))
          .filter(({ message }) => !isTuiHiddenUserMessage(message)),
      [props.session.messages]
    );
    const visibleMessages = useMemo(
      () => visibleEntries.map((entry) => entry.message),
      [visibleEntries]
    );
    const sourceIndexOfVisible = useMemo(
      () => visibleEntries.map((entry) => entry.sourceIndex),
      [visibleEntries]
    );
    const thinkingMsAtVisible = useMemo(
      () =>
        makeThinkingMsAtVisibleFromSource(
          props.session.thinkingMs,
          sourceIndexOfVisible
        ),
      [props.session.thinkingMs, sourceIndexOfVisible]
    );
    const measuredViewport = sbRef.current?.viewport.height ?? 0;
    const viewportHeight = measuredViewport > 0 ? measuredViewport : props.rows;
    const mountWindow = useMemo(
      () =>
        selectViewportMountWindow(visibleMessages, {
          scrollTop,
          viewportHeight,
          heights: itemHeights,
        }),
      [visibleMessages, scrollTop, viewportHeight, itemHeights]
    );
    useLayoutEffect(() => {
      measureMountedHeights(
        sbRef.current,
        visibleMessages,
        itemHeights,
        mountWindow.startIndex,
        mountWindow.endIndex,
        setItemHeights
      );
    }, [
      mountWindow.startIndex,
      mountWindow.endIndex,
      visibleMessages,
      itemHeights,
    ]);
    // Fold counting aggregates only successful retract-class tools — the
    // resolver derives each item's slot from statusMap (tool_use_id →
    // failed?); unpaired ones (live running / cancelled) do not enter the
    // count. Wrapped in `useMemo`: the closure would otherwise be a new
    // reference every render, and the `activitySegments` useMemo below depends
    // on it, so without stabilization everything recomputes per render.
    // Deliberately not reusing `deriveSlot(...).inFoldCount` (declared SSOT
    // fork): this resolver consumes the **block-counting caliber** — the
    // live-signal revision also counts "unpaired = still-running noise" (noise
    // still running in history must show as calling), while `deriveSlot` is
    // the **card-slot caliber** (unpaired = running card). The two calibers
    // differing on unpaired items is contractual, not drift; `isLiveNoise` is
    // the shared single-source class decision for both.
    const inFoldCountOf = useMemo(
      () =>
        (
          call: Readonly<{ readonly id: string; readonly name: string }>
        ): boolean => {
          // Only live-noise names count (never invent a second classification
          // table). web_search / web_fetch never enter `calling`/`called`:
          // TOOL_SETTLED_CLASS still classifies them retract (counting caliber
          // unchanged), but the live-signal card path does not go through
          // block counting.
          if (isLiveNoise(call.name)) {
            if (!statusMap.has(call.id)) return true; // unpaired = running
            return (
              statusMap.get(call.id) !== true // failures cut across
            );
          }
          return false;
        },
      [statusMap]
    );
    // Folding applies to the whole turn history — no more slicing to
    // lastTurnSlice. The scan is bounded to the current mount
    // window (segments only feed mounted rows, and the unit-fold path that
    // once needed whole-turn aggregation is retired); scrolling still walks
    // the full history because every window shift re-derives over the new
    // range.
    const activitySegments = useMemo(
      () =>
        orderedTurnActivitySegments(visibleMessages, mountWindow.startIndex, {
          inFoldCountOf,
          end: mountWindow.endIndex,
        }),
      [
        visibleMessages,
        inFoldCountOf,
        mountWindow.startIndex,
        mountWindow.endIndex,
      ]
    );
    // The already-drawn foldLinesBySegmentIndex is the **only** signal that a
    // fold exists — the whole-turn `currentTurnHasFold` /
    // `currentTurnHasThinkingFold` panel gates and the `foldDisplayLines.length`
    // fold gate were deleted (a turn-level boolean would swallow the current
    // **open unit**'s thinking panel together with the progress group).
    //
    // The tail removes only tool_use ids **already present in history** (draw
    // each row once); it no longer second-filters by "already folded this
    // turn" — that was a double delete stacked onto the reducer's direct deletion.
    const turnLiveRuns = useMemo(
      () => liveToolRuns.filter((run) => !toolIndex.toolUseIds.has(run.id)),
      [liveToolRuns, toolIndex]
    );
    // Retired `formatLiveActivitySummary` / `splitLiveActivityRuns` from the
    // production call surface — activity blocks (unanchoredBlocks) are the
    // sole live tense for in-progress **class collapse** and keep / aggregated
    // bash. Idle settling still goes through block counting (settled state of
    // activity blocks); the old unit-fold path never stacks on top.
    // Activity blocks = block titles + body slots; the block list is derived
    // via `deriveActivityBlocks`, and results are grouped by messageIndex to
    // feed MessageRow directly. The scan is bounded to the mount
    // window — blocks are per-message derivations (flushed at message end),
    // so in-window rows derive exactly what the full-table pass produced;
    // scrolling up still reaches the same content because each window shift
    // re-derives its own range. `historyToolUseIds` feeds the incremental
    // index so no O(history) dedup scan runs per commit.
    //
    // Thinking body text lives in the unanchored activity block's body slot —
    // the ThinkingPanel component is retired; the liveThinking gate keeps the
    // "draft non-empty" meaning. Any tool running (including later tools in
    // the same burst) no longer closes thinking.
    // Hoisted out of the parent component to keep its cyclomatic complexity
    // under the S5 hard gate.
    const liveThinking = liveThinkingFromDraft(
      running,
      props.thinkingDraftMasked
    );
    const foldDerived = useMemo(
      () =>
        buildActivityBlockFoldLines({
          messages: visibleMessages,
          visibleStart: mountWindow.startIndex,
          visibleCount: visibleMessages.length,
          visibleEnd: mountWindow.endIndex,
          thinkingMsAtVisible,
          // tool_use items already in the transcript may still be running:
          // the full liveRuns must go to the derivation (resolveLiveRunning).
          // unanchored appends exclude history ids inside derive to avoid
          // double-drawing calling. Tail cards still use turnLiveRuns.
          liveRuns: liveToolRuns,
          liveThinking,
          inFoldCountOf,
          historyToolUseIds: toolIndex.toolUseIds,
        }),
      [
        visibleMessages,
        mountWindow.startIndex,
        mountWindow.endIndex,
        thinkingMsAtVisible,
        liveToolRuns,
        inFoldCountOf,
        liveThinking,
        toolIndex,
      ]
    );
    // Window shifts re-derive the range; rows whose message object and lines
    // are unchanged keep their previous array reference so still-visible
    // MessageBlocks memo-hit instead of re-rendering the whole viewport.
    const foldCacheRef = useRef<FoldLinesCache | null>(null);
    const activityBlockFoldLines = useMemo(() => {
      const stable = stabilizeActivityBlockLines(
        foldCacheRef.current,
        foldDerived.blockLinesByMessage,
        visibleMessages
      );
      foldCacheRef.current = stable.cache;
      return {
        blockLinesByMessage: stable.byMessage,
        shownThinkingMsValues: foldDerived.shownThinkingMsValues,
        unanchoredBlocks: foldDerived.unanchoredBlocks,
      };
    }, [foldDerived, visibleMessages]);
    // Set of ms values covered by blocks (for the hideThinking dual gate).
    // The old `foldLinesBySegmentIndex` path is fully retired — hideThinking's
    // `shownThinkingMsValues` gate has only the block list left, no union needed.
    const mergedShownThinkingMsValues =
      activityBlockFoldLines.shownThinkingMsValues;
    // The old `foldLinesBySegmentIndex` (unit-fold lines) is retired entirely —
    // the block list (`buildActivityBlockFoldLines`) is the single source of
    // folding; passing an empty map here routes ChatScrollbox through the one
    // path (block list → MessageRow → renderBlockTitles) and never draws
    // double lines (old `Thought for Ns · read_file × 1` + new `Thought for Ns`).
    const foldLinesBySegmentIndex: FoldLinesBySegmentIndex = useMemo(
      () => new Map(),
      []
    );
    // Detail slot / progress group: collapsed-class items enter the progress-
    // group count, running items occupy the single detail slot, the rest go
    // one-by-one. ThinkingPanel is retired (thinking lives in the unanchored
    // block's body slot), so no `showThinkingPanel` is derived here and
    // TranscriptTail no longer accepts that prop.
    // Activity blocks replace the old live-activity-group double tense —
    // `formatLiveActivitySummary` / `splitLiveActivityRuns` are no longer
    // called by production code; same-batch retract appears exactly once in
    // block called-counting. `liveTailSlots` still handles the **per-item
    // surface** (draftEpoch interleaves tool groups with draft segments;
    // details in transcript-tail.tsx).
    const tailSlots = useMemo(
      () => liveTailSlots(turnLiveRuns, deferredSegments),
      [turnLiveRuns, deferredSegments]
    );
    return (
      <ChatScrollbox
        sbRef={sbRef}
        cols={props.cols}
        rows={props.rows}
        scrollbarHovered={scrollbarHovered}
        bannerLines={bannerLines}
        mountWindow={mountWindow}
        contentWidth={contentWidth}
        activitySegments={activitySegments}
        foldLinesBySegmentIndex={foldLinesBySegmentIndex}
        blockLinesByMessage={activityBlockFoldLines.blockLinesByMessage}
        shownThinkingMsValues={mergedShownThinkingMsValues}
        statusMap={statusMap}
        resultTextMap={resultTextMap}
        subagentCards={subagentCards}
        thinkingExpanded={thinkingExpanded}
        thinkingMsAtVisible={thinkingMsAtVisible}
        running={running}
        tailSlots={tailSlots}
        renderLiveRuns={renderLiveRuns}
        deferredThinkingDrafts={deferredThinkingDrafts}
        liveToolLines={props.liveToolLines}
        askLine={props.askLine}
        crunchedSeconds={props.crunchedSeconds ?? 0}
        unanchoredBlocks={activityBlockFoldLines.unanchoredBlocks}
      />
    );
  }
);

/**
 * Height measurement for viewport-mounted rows (hoisted out of ChatView).
 * Each mounted message's root node DOM id is `tmsg-${i}` (the id contract
 * inside `MessageRow`); this function reads real heights via
 * `scrollbox.getRenderable` by visible index and writes them back to
 * itemHeights. setState fires only on change, avoiding pointless re-renders.
 */
function measureMountedHeights(
  sb: ScrollBoxRenderable | null,
  visibleMessages: ReadonlyArray<AnthropicNativeMessage>,
  prevHeights: ReadonlyArray<number>,
  startIndex: number,
  endIndex: number,
  setHeights: (next: ReadonlyArray<number>) => void
): void {
  if (sb === null) return; // EXIT: unmounted during measure
  // The next array is copied lazily: a scroll commit that finds no mounted
  // height change must not allocate an O(history) array nor churn the
  // itemHeights reference the viewport memo depends on.
  let next: number[] | null = null;
  for (let i = startIndex; i < endIndex; i++) {
    const node = sb.getRenderable(`tmsg-${i}`);
    const h = node?.height;
    if (
      Number.isFinite(h) &&
      (h as number) > 0 &&
      (prevHeights[i] ?? 0) !== (h as number)
    ) {
      next ??= Array.from(
        { length: visibleMessages.length },
        (_, j) => prevHeights[j] ?? 0
      );
      next[i] = h as number;
    }
  }
  if (next !== null) setHeights(next); // EXIT: nothing changed → no setState
}

/**
 * Scrollbox element + ref bindings (hoisted out of ChatView). Two
 * `useLayoutEffect`s (scrollTop tracking + scrollbar hover binding) and
 * `useImperativeHandle` (ChatViewHandle exposes scrollToBottom + scrollbox
 * direct query). Carried invariant: the scrollbox element and ref bindings
 * are called unconditionally at ChatView's top level and must not move into
 * a render helper.
 */
function useScrollboxBindings(args: {
  readonly sbRef: { current: ScrollBoxRenderable | null };
  readonly setScrollbarHovered: (hovered: boolean) => void;
  readonly setScrollTop: (next: number | ((prev: number) => number)) => void;
  readonly ref: React.Ref<ChatViewHandle>;
  /** Projection epoch: bumped whenever the transcript projection is replaced
   *  (session switch / compact / rewind head change) → resubscribe and reset
   *  the quantization cursor (see call site). */
  readonly projectionEpoch: number;
}): void {
  const { sbRef, setScrollbarHovered, setScrollTop, ref, projectionEpoch } =
    args;
  useLayoutEffect(() => {
    const sb = sbRef.current;
    if (sb === null) return; // EXIT: unmounted scrollbox
    // Official OpenTUI path: slider change → scrollbar `change` { position }.
    // Do not patch scrollTop (Feature Envy) or rAF-poll (sticky still 0).
    //
    // Quantized commits (spec invariant 8): every `change` used to call
    // `setScrollTop`, re-rendering the whole ChatView (markdown included) per
    // pixel. Two details matter here:
    //  - the gate is evaluated BEFORE the call — a same-value updater still
    //    schedules a React render, so skipping the *call* is what skips work;
    //  - the step is resolved per change, not once at effect time, because
    //    `sb.viewport.height` is still 0 while this layout effect runs (the
    //    box has not been laid out yet) and the effect does not re-run when
    //    it settles. Resolving from 0 would pin the step at its 1-row floor.
    // Crossing the step, hitting bottom, or hitting top still commits.
    // `resolveScrollCommitStep` keeps step <= overscan, so a skipped change
    // can never unmount what the viewport shows.
    //
    // `committed` lives for one subscription. The effect re-runs on
    // `projectionEpoch` change, so the cursor starts fresh (null → always
    // commit) for the first change after a session switch — the same reset the
    // render body applies to itemHeights / scrollTop.
    let committed: number | null = null; // null = nothing committed yet → always commit
    const stopTracking = listenScrollBoxTop(sb, (next) => {
      const maxScrollTop = Math.max(0, sb.scrollHeight - sb.viewport.height);
      const step = resolveScrollCommitStep(
        sb.viewport.height > 0 ? sb.viewport.height : sb.height
      );
      const base = committed ?? Number.NaN;
      if (!shouldCommitScrollTop(base, next, { step, maxScrollTop })) {
        return; // quantized: no React state update for this change
      }
      committed = next;
      setScrollTop((prev) => (prev === next ? prev : next));
    });
    // The hover slot attaches to the scrollbar renderable (Slider itself only accepts down/drag/up).
    const stopHover = attachScrollbarHover(
      sb.verticalScrollBar,
      setScrollbarHovered
    );
    return () => {
      stopTracking();
      stopHover();
    };
  }, [sbRef, setScrollTop, setScrollbarHovered, projectionEpoch]);
  useImperativeHandle(ref, () => ({
    scrollToBottom() {
      const sb = sbRef.current;
      if (sb === null) return; // EXIT: unmounted
      sb.scrollTop = Math.max(0, sb.scrollHeight - sb.viewport.height);
    },
    get scrollbox() {
      return sbRef.current;
    },
  }));
}

/**
 * The `<scrollbox>` render (hoisted out of ChatView). All branches (banner /
 * spacerBefore / mounted map / TranscriptTail) and props pass-through
 * concentrate in this component; ChatView's top level keeps only hook wiring
 * + memo derivations, bringing complexity back to <= 10.
 *
 * Every prop is an already-derived / useMemo-stabilized reference from
 * ChatView (statusMap / resultTextMap / visibleMessages /
 * foldLinesBySegmentIndex etc.); this component only mounts JSX and derives
 * nothing.
 */
function ChatScrollbox(props: {
  readonly sbRef: { current: ScrollBoxRenderable | null };
  readonly cols: number;
  readonly rows: number;
  readonly scrollbarHovered: boolean;
  readonly bannerLines: ReadonlyArray<string>;
  readonly mountWindow: ViewportMountWindow<AnthropicNativeMessage>;
  readonly contentWidth: number;
  readonly activitySegments: ReadonlyArray<TurnActivitySegment>;
  readonly foldLinesBySegmentIndex: FoldLinesBySegmentIndex;
  /** Activity-block lines grouped by messageIndex (anchors included; the
   *  Thinking-at-bottom revision contract). MessageBlocks uses this to insert
   *  titles into content order per anchor (no cross-message merging). */
  readonly blockLinesByMessage: ReadonlyMap<
    number,
    ReadonlyArray<ActivityBlockLine>
  >;
  readonly shownThinkingMsValues: ShownThinkingMsValues;
  readonly statusMap: ReadonlyMap<string, boolean>;
  readonly resultTextMap: ReadonlyMap<string, string>;
  /** toolUseId → subagent card two-line projection (produced once by
   *  ChatView's `subagentCardLinesMap`, shared by history and live cards). */
  readonly subagentCards: ReadonlyMap<string, SubagentCardLines>;
  readonly thinkingExpanded: boolean;
  readonly thinkingMsAtVisible: ThinkingMsAtVisible;
  readonly running: boolean;
  readonly tailSlots: ReadonlyArray<TailSlotDecision>;
  readonly renderLiveRuns: (runs: ReadonlyArray<LiveToolRun>) => ReactNode;
  readonly deferredThinkingDrafts: string;
  readonly liveToolLines: ReadonlyArray<string>;
  readonly askLine: string | undefined;
  readonly crunchedSeconds: number;
  readonly unanchoredBlocks: ReadonlyArray<
    import("./activity-block.js").ActivityBlock
  >;
}): ReactNode {
  return (
    <scrollbox
      ref={props.sbRef}
      width={props.cols}
      height={props.rows}
      stickyScroll={true}
      stickyStart="bottom"
      scrollAcceleration={chatWheelScrollAccel}
      verticalScrollbarOptions={{
        trackOptions: {
          backgroundColor: scrollbarTrackColor(),
          foregroundColor: scrollbarThumbColor(props.scrollbarHovered),
        },
      }}
    >
      {props.bannerLines.length > 0 && (
        <TranscriptBanner bannerLines={props.bannerLines} />
      )}
      {props.mountWindow.spacerBefore > 0 && (
        <box
          key="transcript-spacer-before"
          width={props.contentWidth}
          height={props.mountWindow.spacerBefore}
          flexShrink={0}
        />
      )}
      {props.mountWindow.mounted.map((message, i) => {
        const visibleIndex = props.mountWindow.startIndex + i;
        const messageThinkingMs = props.thinkingMsAtVisible(visibleIndex);
        return (
          <MessageRow
            key={visibleIndex}
            message={message}
            visibleIndex={visibleIndex}
            contentWidth={props.contentWidth}
            messageThinkingMs={messageThinkingMs}
            messageSegments={messageSegmentsOfVisible(
              props.activitySegments,
              visibleIndex
            )}
            foldLinesBySegmentIndex={props.foldLinesBySegmentIndex}
            activityBlocks={
              props.blockLinesByMessage.get(visibleIndex) ??
              EMPTY_ACTIVITY_BLOCKS
            }
            shownThinkingMsValues={props.shownThinkingMsValues}
            statusMap={props.statusMap}
            resultTextMap={props.resultTextMap}
            subagentCards={props.subagentCards}
            thinkingExpanded={props.thinkingExpanded}
          />
        );
      })}
      <TailSpacer
        height={props.mountWindow.spacerAfter}
        contentWidth={props.contentWidth}
      />
      <TranscriptTail
        contentWidth={props.contentWidth}
        running={props.running}
        crunchedSeconds={props.crunchedSeconds}
        tailSlots={props.tailSlots}
        renderLiveRuns={props.renderLiveRuns}
        deferredThinkingDrafts={props.deferredThinkingDrafts}
        thinkingExpanded={props.thinkingExpanded}
        liveToolLines={props.liveToolLines}
        askLine={props.askLine}
        unanchoredBlocks={props.unanchoredBlocks}
      />
    </scrollbox>
  );
}

/** Live-thinking gate: draft non-empty + turn in progress — after the
 *  tool-running lock was lifted this gate no longer reacts to running tools;
 *  hoisted to a pure function so the parent's cyclomatic complexity stays
 *  under the S5 hard gate. */
function liveThinkingFromDraft(
  running: boolean,
  thinkingDraftMasked: string | undefined
): boolean {
  return (
    running &&
    thinkingDraftMasked !== undefined &&
    thinkingDraftMasked.length > 0
  );
}
