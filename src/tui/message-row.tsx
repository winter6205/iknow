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
import * as React from "react";
import type { AnthropicNativeMessage } from "../harness/model-adapter/types.js";
import { MessageBlocks } from "./message-blocks.js";
import type { SubagentCardLines } from "./subagent-message-lines.js";
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
  /** T4–T7（specs/tui-activity-block.md）：本消息的活动块标题（按 contentBlockIndex 升序）。
   *  块标题按新合同取代旧 unit fold 行 —— 跨消息不合并；同 messageIndex 多块时
   *  按 contentBlockIndex 顺序排列。 */
  readonly blockTitles: ReadonlyArray<string>;
  /** T5（spec S2–S4）：每个块对应的预览文本（与 blockTitles 同序、同长）。
   *  null = 该块 settled（不画预览行）；非空 = `formatRunningToolLine` 输出，
   *  渲染在块标题之下一行 dim。 */
  readonly slotPreviews: ReadonlyArray<string | null>;
  readonly shownThinkingMsValues: ShownThinkingMsValues;
  readonly statusMap: ReadonlyMap<string, boolean>;
  readonly resultTextMap: ReadonlyMap<string, string>;
  /** specs/tui-subagent-transcript-live.md：toolUseId → 子代理卡两行投影
   *  （ChatView 单次投影，历史卡与 live 卡共用）。缺省 → 与改前逐字节一致。 */
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
    blockTitles,
    slotPreviews,
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
          />
          {messageSegments.flatMap(({ segmentIndex }) =>
            renderFoldLines(
              foldLinesBySegmentIndex,
              segmentIndex,
              contentWidth,
              "turn-fold"
            )
          )}
          {renderBlockTitles(
            blockTitles,
            slotPreviews,
            contentWidth,
            visibleIndex
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
  readonly subagentCards?: ReadonlyMap<string, SubagentCardLines>;
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

/**
 * 活动块标题 + 预览槽渲染（T4–T7 / specs/tui-activity-block.md）。
 *
 * 每个块按顺序画：标题一行 + 预览一行（仅当 slotPreviews[i] !== null；
 * settled 块 → null → 跳过预览行）。所有标题 / 预览都包在同一个
 * MessageShell 里（同 fold 行同形态），空数组 → 返回 null。
 *
 * T5（spec S2–S4）：预览槽只在 running 安静工具块下出现；settled / keep
 * / 失败 / 思考 only → null。预览文本 = `formatRunningToolLine` 输出（与
 * tail 预览同一来源，不另造模板）。
 *
 * 模板单源：具体 <text> 装配抽为 `renderActivityBlockRows`（本文件导出），
 * transcript-tail 的 `UnanchoredActivityBlocks` 复用同一 helper —— 两处
 * 面板宽距 / 颜色 token 不再各自漂移。
 */
export function renderBlockTitles(
  blockTitles: ReadonlyArray<string>,
  slotPreviews: ReadonlyArray<string | null>,
  contentWidth: number,
  visibleIndex: number
): ReactNode {
  if (blockTitles.length === 0) return null;
  return (
    <MessageShell
      key={`activity-block-shell-${visibleIndex}`}
      cols={contentWidth}
    >
      {renderActivityBlockRows(
        blockTitles,
        slotPreviews,
        contentWidth,
        (blockIdx) => `activity-block-${visibleIndex}-${blockIdx}`
      )}
    </MessageShell>
  );
}

/** 块标题 / 预览行的共享装配（renderBlockTitles 与 tail 的
 *  UnanchoredActivityBlocks 的单一模板来源）。keys 由调用方给（两侧的
 *  React key 前缀不同，模板本身一致）。 */
export function renderActivityBlockRows(
  blockTitles: ReadonlyArray<string>,
  slotPreviews: ReadonlyArray<string | null>,
  contentWidth: number,
  keyOf: (blockIdx: number) => string
): ReactNode {
  return blockTitles.map((title, blockIdx) => {
    const preview = slotPreviews[blockIdx] ?? null;
    return (
      <React.Fragment key={keyOf(blockIdx)}>
        <text
          fg={tuiPalette.dim}
          wrapMode="none"
          width={Math.max(1, contentWidth - 2)}
        >
          {title}
        </text>
        {preview !== null ? (
          <text
            fg={tuiPalette.dim}
            wrapMode="none"
            width={Math.max(1, contentWidth - 2)}
          >
            {preview}
          </text>
        ) : null}
      </React.Fragment>
    );
  });
}
