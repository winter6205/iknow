/** @jsxImportSource @opentui/react */
/**
 * src/tui/transcript-tail.tsx
 *
 * #986：把 ChatView 末尾段（spacerAfter、crunched、tailSlots、流式
 * thinking 面板、legacy liveToolLines、askLine、Spinner）抽成 sibling
 * 组件。逻辑由纯派生 `decideTailLayout` 计算渲染决策，组件只挂 JSX。
 *
 * 渲染顺序（spec D3/D7，与原 chat-view 一致）：
 *   crunched 行 → tail slots → thinking 面板 → legacy liveToolLines →
 *   askLine → spinner。
 *
 * `currentTurnHasFold` / `currentTurnHasThinkingFold` 由 ChatView 计算
 * 后透传（与消息流 fold 行决策共用 foldLinesBySegmentIndex）；本组件
 * 只决策 JSX，不再做 fold 派生。
 */
import type { ReactNode } from "react";
import { Markdown } from "./markdown.js";
import { MessageShell } from "./message-shell.js";
import { Spinner } from "./components.js";
import { formatCrunched } from "./run-stats.js";
import { formatThinkingLive, thinkingPeekLines } from "./think-fold.js";
import type { LiveTailSlot, LiveToolRun } from "./live-tool-state.js";
import { tuiPalette } from "./theme.js";

/** 复用 `live-tool-state` 的 `LiveTailSlot` 联合 —— 同源消费侧不重定义。 */
export type TailSlotDecision = LiveTailSlot;

export interface TranscriptTailProps {
  readonly contentWidth: number;
  readonly running: boolean;
  readonly crunchedSeconds: number;
  readonly tailSlots: ReadonlyArray<TailSlotDecision>;
  readonly renderLiveRuns: (runs: ReadonlyArray<LiveToolRun>) => ReactNode;
  readonly deferredThinkingDrafts: string;
  readonly thinkingExpanded: boolean;
  readonly currentTurnHasFold: boolean;
  readonly currentTurnHasThinkingFold: boolean;
  readonly liveToolLines: ReadonlyArray<string>;
  readonly askLine: string | undefined;
}

export function TranscriptTail(props: TranscriptTailProps): ReactNode {
  const pal = tuiPalette;
  const showThinkingPanel =
    props.running &&
    props.deferredThinkingDrafts.length > 0 &&
    !props.currentTurnHasFold &&
    !props.currentTurnHasThinkingFold;
  return (
    <>
      {props.crunchedSeconds > 0 && (
        <text fg={pal.dim} wrapMode="none">
          {formatCrunched(props.crunchedSeconds)}
        </text>
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
      {showThinkingPanel && (
        <ThinkingPanel
          contentWidth={props.contentWidth}
          deferredThinkingDrafts={props.deferredThinkingDrafts}
          thinkingExpanded={props.thinkingExpanded}
        />
      )}
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
      {props.running && <Spinner />}
    </>
  );
}

function slotKey(slot: TailSlotDecision, i: number): string {
  return slot.kind === "tools" ? `live-tools-${i}` : `live-draft-${i}`;
}

/** 单 tail slot：tools 组 → 列容器；draft 段 → 仅 running 渲染 + MessageShell。 */
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

/** 流式 thinking 面板：折叠态 `思考中…` + ≤3 行预览；展开态走 Markdown。 */
function ThinkingPanel(props: {
  readonly contentWidth: number;
  readonly deferredThinkingDrafts: string;
  readonly thinkingExpanded: boolean;
}): ReactNode {
  const pal = tuiPalette;
  if (props.thinkingExpanded) {
    return (
      <box flexDirection="column" width={props.contentWidth}>
        <box width={props.contentWidth}>
          <Markdown
            text={props.deferredThinkingDrafts}
            width={props.contentWidth}
            streaming
          />
        </box>
      </box>
    );
  }
  return (
    <box flexDirection="column" width={props.contentWidth}>
      <text fg={pal.dim} wrapMode="none">
        {formatThinkingLive()}
      </text>
      {thinkingPeekLines(props.deferredThinkingDrafts).map((line, i) => (
        <text key={`think-peek-${i}`} fg={pal.dim} wrapMode="none">
          {line}
        </text>
      ))}
    </box>
  );
}

/** spacer 撑住挂载高度（viewport 后的尾段）。 */
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
