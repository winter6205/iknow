/** @jsxImportSource @opentui/react */
/**
 * src/tui/message-row.tsx
 *
 * #986：把 ChatView 内「挂载消息行」（原 650–768 行）抽成 sibling 组件。
 *
 * 承重契约（实测，详见 plans/issue-986-chatview-split.md）：
 *  - 根节点 `<box id={`tmsg-${visibleIndex}`} width={contentWidth} flexShrink={0}>`
 *    必须保留 —— `useLayoutEffect`（283–306）靠 DOM id 通过 `sb.getRenderable`
 *    量测每条消息行高度；
 *  - `visibleIndex` 由 ChatView 计算（= mountWindow.startIndex + i）后通过
 *    prop 传入；不得在组件内用 map index 重算（spacerBefore 偏移会污染）。
 *
 * 渲染双分支：
 *  (a) `renderInContentOrder === true`：消息被 activitySegments 拆成多簇
 *      （tool→text→tool），按段原位插入 fold 行；
 *  (b) 正常路径：单 MessageBlocks + 该消息所有 fold 行平铺到尾部。
 *
 * per-segment 渲染由 `<TurnFoldSegment>`（本文件内私有子组件）承担，
 * 把原内层 60 行 cc=12 闭包切成多个 ≤60 行组件。
 */
import type { ReactNode } from "react";
import type { AnthropicNativeMessage } from "../harness/model-adapter/types.js";
import { MessageBlocks } from "./message-blocks.js";
import { MessageShell } from "./message-shell.js";
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
  readonly shownThinkingMsValues: ShownThinkingMsValues;
  readonly statusMap: ReadonlyMap<string, boolean>;
  readonly resultTextMap: ReadonlyMap<string, string>;
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
    shownThinkingMsValues,
    statusMap,
    resultTextMap,
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
            thinkingExpanded={thinkingExpanded}
            thinkingSeconds={messageThinkingSeconds}
            hideThinking={hideThinkingForThisMessage}
            marginTop={visibleIndex === 0 ? 0 : 1}
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
 * per-segment 容器：同一 messageIndex 拆出多簇时按 message.content 顺序
 * 逐段画 MessageBlocks + 段尾 fold 行。fold 行由 `<TurnFoldLines>` 包装
 * MessageShell（chat-view renderFoldLines 原契约）。
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
        thinkingExpanded={props.thinkingExpanded}
        messageThinkingSeconds={props.messageThinkingSeconds}
        messageThinkingMs={props.messageThinkingMs}
      />
    );
  });
}

/**
 * 单段：MessageBlocks + 段尾 fold 行。
 *
 * hideThinking 逻辑与原 chat-view 一致：段已画 fold 行 / ms 值已被 fold
 * 行覆盖 → hideSegmentThinking = true（但展开态 / hideThinking 强制 false）。
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
  readonly thinkingExpanded: boolean;
  readonly messageThinkingSeconds: number;
  readonly messageThinkingMs: number;
}): ReactNode {
  const segmentHasFold = props.foldLinesBySegmentIndex.has(props.segmentIndex);
  // hideThinking 双重门：段已画 fold 行 OR 段内 messageThinkingMs 值已被
  // fold 行覆盖 → hide；展开态例外。
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
 * 折叠行 JSX（#693 T1 D1）：与 assistant 外壳共用 MessageShell（无
 * backgroundColor、无 paddingX —— T2 透传化），壳内 `<text>` 强制单行
 * 不折（wrapMode="none"）。foldMap 不含该 segmentIndex → 返回 null。
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

/** pickMessageSegments wrapper —— 渲染层调用入口（与可见下标配对）。 */
export function messageSegmentsOfVisible(
  activitySegments: ReadonlyArray<TurnActivitySegment>,
  visibleIndex: number
): ReadonlyArray<SegmentWithIndex> {
  return pickMessageSegments(activitySegments, visibleIndex);
}
