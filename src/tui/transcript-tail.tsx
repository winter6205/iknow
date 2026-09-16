/** @jsxImportSource @opentui/react */
/**
 * src/tui/transcript-tail.tsx
 *
 * #986：把 ChatView 末尾段（spacerAfter、crunched、unanchoredBlocks、
 * tailSlots、流式 thinking 面板、legacy liveToolLines、askLine、Spinner）
 * 抽成 sibling 组件。逻辑由纯派生（`buildActivityBlockFoldLines` 提
 * `unanchoredBlocks`、`liveTailSlots` 提 `tailSlots`、`shouldShowLiveThinkingPanel`
 * 判定 thinking panel 是否让位）下放 ChatView，本组件只挂 JSX。
 *
 * 渲染顺序（spec D7 + 过程块 spec）：
 *   crunched 行 → 未锚定块（unanchoredBlocks）→ tail slots → thinking 面板 →
 *   legacy liveToolLines → askLine → spinner。
 *
 * 过程块 spec：块列表（`buildActivityBlockFoldLines`）是折叠 / 预览的唯一
 * 来源；旧 `live activity group` 一行英文摘要（`Listing × N · Reading × M`）
 * 与 `unit fold`（`Thought for Ns · name × M`）互斥闸整体退役 —— 同批
 * retract 只在块 called 计数出现一次（spec S7）。
 */
import type { ReactNode } from "react";
import { Markdown } from "./markdown.js";
import { MessageShell } from "./message-shell.js";
import { renderActivityBlockRows } from "./message-row.js";
import { Spinner } from "./components.js";
import { formatCrunched } from "./run-stats.js";
import { formatThinkingLive, thinkingPeekLines } from "./think-fold.js";
import type { LiveTailSlot, LiveToolRun } from "./live-tool-state.js";
import { tuiPalette } from "./theme.js";
import type { ActivityBlock } from "./activity-block.js";

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
  /** open-unit 让位判定（`shouldShowLiveThinkingPanel`）由 ChatView 派生。 */
  readonly showThinkingPanel: boolean;
  readonly liveToolLines: ReadonlyArray<string>;
  readonly askLine: string | undefined;
  /** T5（spec S2–S4 / plans T5）：未锚定到 messageIndex 的活动块 —— live
   *  块（未提交的思考 / 安静工具）必须出现在 tail。每块按「标题 + 预览
   *  一行」形态渲染，与 MessageRow 内块同形态。空 → 不画。 */
  readonly unanchoredBlocks: ReadonlyArray<ActivityBlock>;
}

export function TranscriptTail(props: TranscriptTailProps): ReactNode {
  const pal = tuiPalette;
  return (
    <>
      {props.crunchedSeconds > 0 && (
        <text fg={pal.dim} wrapMode="none">
          {formatCrunched(props.crunchedSeconds)}
        </text>
      )}
      {props.unanchoredBlocks.length > 0 && (
        <UnanchoredActivityBlocks
          blocks={props.unanchoredBlocks}
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
      {props.showThinkingPanel && (
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

/**
 * T5（spec S2–S4 / plans T5）：未锚定到 messageIndex 的活动块（live 块）
 * 在 tail 渲染 —— 块标题 + 预览行（settled → 仅标题，running → 标题 + 预览）。
 * 与 MessageRow 的 renderBlockTitles 形态对齐，但全部块装在同一 MessageShell 里。
 */
function UnanchoredActivityBlocks(props: {
  readonly blocks: ReadonlyArray<ActivityBlock>;
  readonly contentWidth: number;
}): ReactNode {
  return (
    <MessageShell key="unanchored-activity-blocks" cols={props.contentWidth}>
      {renderActivityBlockRows(
        props.blocks.map((block) => block.title),
        props.blocks.map((block) =>
          block.slot.kind === "tool-preview" ? block.slot.text : null
        ),
        props.contentWidth,
        (blockIdx) => `unanchored-block-${blockIdx}`
      )}
    </MessageShell>
  );
}
