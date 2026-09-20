/** @jsxImportSource @opentui/react */
/**
 * src/tui/message-row.tsx
 *
 * ChatView's "mounted message row" extracted as a sibling component.
 *
 * Load-bearing contracts (measured):
 *  - the root `<box id={`tmsg-${visibleIndex}`} width={contentWidth} flexShrink={0}>`
 *    must be kept — ChatView's `useLayoutEffect` measures every message-row
 *    height via `sb.getRenderable` keyed by that DOM id;
 *  - `visibleIndex` is computed by ChatView (= mountWindow.startIndex + i) and
 *    passed in via prop; it must not be recomputed inside the component from
 *    the map index (the spacerBefore offset would corrupt it).
 *
 * Two render branches:
 *  (a) `renderInContentOrder === true`: the message is split by
 *     activitySegments into multiple clusters (tool→text→tool); fold rows are
 *     inserted per segment at their original positions;
 *  (b) normal path: a single MessageBlocks + all of the message's fold rows
 *     flattened at the tail.
 *
 * Per-segment rendering is handled by `<TurnFoldSegment>` (a private subcomponent
 * in this file), splitting the former ~60-line cc=12 inner closure into
 * multiple smaller components.
 */
import type { ReactNode } from "react";
import type { AnthropicNativeMessage } from "../harness/model-adapter/types.js";
import { MessageBlocks } from "./message-blocks.js";
import type { SubagentCardLines } from "./subagent-message-lines.js";
import { MessageShell } from "./message-shell.js";
import type { ActivityBlockLine } from "./turn-fold-lines.js";
import {
  firstPartThinkingBlocks,
  renderInContentOrder,
  segmentActivityBlocks,
  pickMessageSegments,
} from "./turn-fold-lines.js";
import type {
  FoldLinesBySegmentIndex,
  ShownThinkingMsValues,
} from "./turn-fold-lines.js";
import type { TurnActivitySegment } from "./turn-activity.js";
import { tuiPalette } from "./theme.js";
import { thinkingMsToSeconds } from "./turn-activity.js";

interface SegmentWithIndex {
  readonly segmentIndex: number;
  readonly segment: TurnActivitySegment;
}

export interface MessageRowProps {
  readonly message: AnthropicNativeMessage;
  readonly visibleIndex: number;
  readonly contentWidth: number;
  readonly messageThinkingMs: number;
  readonly messageSegments: ReadonlyArray<SegmentWithIndex>;
  readonly foldLinesBySegmentIndex: FoldLinesBySegmentIndex;
  /** This message's activity-block lines (with anchors, ascending
   *  contentBlockIndex; specs/tui-activity-block.md). MessageBlocks inserts
   *  the titles into the content order at their anchors; no cross-message
   *  merging. */
  readonly activityBlocks: ReadonlyArray<ActivityBlockLine>;
  readonly shownThinkingMsValues: ShownThinkingMsValues;
  readonly statusMap: ReadonlyMap<string, boolean>;
  readonly resultTextMap: ReadonlyMap<string, string>;
  /** specs/tui-subagent-transcript-live.md: toolUseId → two-line subagent card
   *  projection (projected once by ChatView, shared by history and live
   *  cards). Absent → byte-identical rendering to before the feature. */
  readonly subagentCards?: ReadonlyMap<string, SubagentCardLines>;
  readonly thinkingExpanded: boolean;
}

export function MessageRow(props: MessageRowProps): ReactNode {
  const {
    message,
    visibleIndex,
    contentWidth,
    messageThinkingMs,
    messageSegments,
    foldLinesBySegmentIndex,
    activityBlocks,
    shownThinkingMsValues,
    statusMap,
    resultTextMap,
    subagentCards,
    thinkingExpanded,
  } = props;
  const messageThinkingSeconds = thinkingMsToSeconds(messageThinkingMs);
  const foldInOrder = renderInContentOrder(
    messageSegments,
    foldLinesBySegmentIndex
  );
  const thisMessageHasFoldLine = messageSegments.some(({ segmentIndex }) =>
    foldLinesBySegmentIndex.has(segmentIndex)
  );
  const hideThinkingForThisMessage =
    (thisMessageHasFoldLine ||
      (messageThinkingMs > 0 &&
        shownThinkingMsValues.has(messageThinkingMs))) &&
    !thinkingExpanded;
  return (
    <box
      id={`tmsg-${visibleIndex}`}
      key={visibleIndex}
      width={contentWidth}
      flexShrink={0}
    >
      {foldInOrder ? (
        <TurnFoldSegments
          message={message}
          visibleIndex={visibleIndex}
          contentWidth={contentWidth}
          messageSegments={messageSegments}
          foldLinesBySegmentIndex={foldLinesBySegmentIndex}
          shownThinkingMsValues={shownThinkingMsValues}
          statusMap={statusMap}
          resultTextMap={resultTextMap}
          subagentCards={subagentCards}
          thinkingExpanded={thinkingExpanded}
          messageThinkingMs={messageThinkingMs}
          messageThinkingSeconds={messageThinkingSeconds}
        />
      ) : (
        <>
          <MessageBlocks
            message={message}
            cols={contentWidth}
            statusMap={statusMap}
            resultTextMap={resultTextMap}
            subagentCards={subagentCards}
            thinkingExpanded={thinkingExpanded}
            thinkingSeconds={messageThinkingSeconds}
            hideThinking={hideThinkingForThisMessage}
            marginTop={visibleIndex === 0 ? 0 : 1}
            activityBlocks={activityBlocks}
          />
          {messageSegments.flatMap(({ segmentIndex }) =>
            renderFoldLines(
              foldLinesBySegmentIndex,
              segmentIndex,
              contentWidth,
              "turn-fold"
            )
          )}
        </>
      )}
    </box>
  );
}

/**
 * Per-segment container: when the same messageIndex splits into multiple
 * clusters, draw MessageBlocks + per-segment tail fold rows in
 * message.content order. The fold rows are wrapped by `<TurnFoldLines>`
 * around MessageShell (ChatView's original renderFoldLines contract).
 */
function TurnFoldSegments(props: {
  readonly message: AnthropicNativeMessage;
  readonly visibleIndex: number;
  readonly contentWidth: number;
  readonly messageSegments: ReadonlyArray<SegmentWithIndex>;
  readonly foldLinesBySegmentIndex: FoldLinesBySegmentIndex;
  readonly shownThinkingMsValues: ShownThinkingMsValues;
  readonly statusMap: ReadonlyMap<string, boolean>;
  readonly resultTextMap: ReadonlyMap<string, string>;
  readonly subagentCards?: ReadonlyMap<string, SubagentCardLines>;
  readonly thinkingExpanded: boolean;
  readonly messageThinkingMs: number;
  readonly messageThinkingSeconds: number;
}): ReactNode {
  const { message, visibleIndex } = props;
  return props.messageSegments.map(({ segment, segmentIndex }, partIndex) => {
    const blockIndex = segment.contentBlockIndex;
    const nextSegment = props.messageSegments[partIndex + 1]?.segment;
    const endIndex =
      nextSegment !== undefined && nextSegment.messageIndex === visibleIndex
        ? nextSegment.contentBlockIndex
        : message.content.length;
    const activityBlocks = segmentActivityBlocks(
      message,
      segment,
      blockIndex,
      endIndex
    );
    const thinkingBlocks =
      partIndex === 0 ? firstPartThinkingBlocks(message) : [];
    const segmentMessage: AnthropicNativeMessage = {
      ...message,
      content: [...thinkingBlocks, ...activityBlocks],
    };
    return (
      <TurnFoldSegment
        key={`turn-segment-${visibleIndex}-${segmentIndex}`}
        segmentMessage={segmentMessage}
        visibleIndex={visibleIndex}
        partIndex={partIndex}
        segmentIndex={segmentIndex}
        contentWidth={props.contentWidth}
        foldLinesBySegmentIndex={props.foldLinesBySegmentIndex}
        shownThinkingMsValues={props.shownThinkingMsValues}
        statusMap={props.statusMap}
        resultTextMap={props.resultTextMap}
        subagentCards={props.subagentCards}
        thinkingExpanded={props.thinkingExpanded}
        messageThinkingSeconds={props.messageThinkingSeconds}
        messageThinkingMs={props.messageThinkingMs}
      />
    );
  });
}

/**
 * One segment: MessageBlocks + tail fold rows.
 *
 * hideThinking logic matches the original chat-view: the segment already drew
 * a fold row / its ms value is already covered by a fold row →
 * hideSegmentThinking = true (except in the expanded state / where
 * hideThinking is forced false).
 */
function TurnFoldSegment(props: {
  readonly segmentMessage: AnthropicNativeMessage;
  readonly visibleIndex: number;
  readonly partIndex: number;
  readonly segmentIndex: number;
  readonly contentWidth: number;
  readonly foldLinesBySegmentIndex: FoldLinesBySegmentIndex;
  readonly shownThinkingMsValues: ShownThinkingMsValues;
  readonly statusMap: ReadonlyMap<string, boolean>;
  readonly resultTextMap: ReadonlyMap<string, string>;
  readonly subagentCards?: ReadonlyMap<string, SubagentCardLines>;
  readonly thinkingExpanded: boolean;
  readonly messageThinkingSeconds: number;
  readonly messageThinkingMs: number;
}): ReactNode {
  const segmentHasFold = props.foldLinesBySegmentIndex.has(props.segmentIndex);
  // hideThinking double gate: the segment already drew a fold row OR this
  // segment's messageThinkingMs value is already covered by a fold row → hide;
  // the expanded state is exempt.
  const hideSegmentThinking =
    (segmentHasFold ||
      (props.messageThinkingMs > 0 &&
        props.shownThinkingMsValues.has(props.messageThinkingMs))) &&
    !props.thinkingExpanded;
  const marginTop = props.partIndex === 0 && props.visibleIndex !== 0 ? 1 : 0;
  return (
    <box
      key={`seg-wrap-${props.visibleIndex}-${props.segmentIndex}`}
      flexDirection="column"
    >
      <MessageBlocks
        message={props.segmentMessage}
        cols={props.contentWidth}
        statusMap={props.statusMap}
        resultTextMap={props.resultTextMap}
        subagentCards={props.subagentCards}
        thinkingExpanded={props.thinkingExpanded}
        thinkingSeconds={
          props.partIndex === 0 ? props.messageThinkingSeconds : undefined
        }
        hideThinking={hideSegmentThinking}
        marginTop={marginTop}
      />
      {renderFoldLines(
        props.foldLinesBySegmentIndex,
        props.segmentIndex,
        props.contentWidth,
        "turn-fold"
      )}
    </box>
  );
}

/**
 * Fold-row JSX: shares MessageShell with the assistant shell (no
 * backgroundColor, no paddingX — transparent), and the inner `<text>` forces
 * single-line no-wrap (wrapMode="none"). foldMap missing this segmentIndex →
 * return null.
 */
export function renderFoldLines(
  foldLinesBySegmentIndex: FoldLinesBySegmentIndex,
  segmentIndex: number,
  contentWidth: number,
  keyPrefix: string
): ReactNode {
  const lines = foldLinesBySegmentIndex.get(segmentIndex) ?? [];
  if (lines.length === 0) return null;
  return (
    <MessageShell
      key={`${keyPrefix}-shell-${segmentIndex}`}
      cols={contentWidth}
    >
      {lines.map((line, foldIdx) => (
        <text
          key={`${keyPrefix}-${segmentIndex}-${foldIdx}`}
          fg={tuiPalette.dim}
          wrapMode="none"
          width={Math.max(1, contentWidth - 2)}
        >
          {line}
        </text>
      ))}
    </MessageShell>
  );
}

/** pickMessageSegments wrapper — the render-layer call entry (paired with the visible index). */
export function messageSegmentsOfVisible(
  activitySegments: ReadonlyArray<TurnActivitySegment>,
  visibleIndex: number
): ReadonlyArray<SegmentWithIndex> {
  return pickMessageSegments(activitySegments, visibleIndex);
}

// Block-title rendering has moved to MessageBlocks (Thinking-at-bottom: titles
// are inserted into the message content order at their anchors). This file no
// longer holds the trailing whole-package render path (renderBlockTitles) or
// the shared template (renderActivityBlockRows → activity-block-rows.tsx
// single source).
