/** @jsxImportSource @opentui/react */
/**
 * src/tui/transcript-tail.tsx
 *
 * #986：把 ChatView 末尾段（spacerAfter、crunched、unanchoredBlocks、
 * tailSlots、legacy liveToolLines、askLine、Spinner）抽成 sibling 组件。
 * 逻辑由纯派生（`buildActivityBlockFoldLines` 提 `unanchoredBlocks`、
 * `liveTailSlots` 提 `tailSlots`）下放 ChatView，本组件只挂 JSX。
 *
 * 渲染顺序（spec D7 + 过程块 spec）：
 *   crunched 行 → 未锚定块（unanchoredBlocks）→ tail slots → legacy liveToolLines
 *   → askLine → spinner。
 *
 * 过程块 spec：块列表（`buildActivityBlockFoldLines`）是折叠 / 预览的唯一
 * 来源；旧 `live activity group` 一行英文摘要（`Listing × N · Reading × M`）
 * 与 `unit fold`（`Thought for Ns · name × M`）互斥闸整体退役 —— 同批
 * retract 只在块 called 计数出现一次（spec S7）。
 *
 * T4 live-signal revision（plans/tui-activity-block-live-signal.md 锁句 1）：
 * 思考始终活在它驱动的那块过程块的正文槽里 —— ThinkingPanel（独立 tail
 * 单元）已退役；`thinkingPeekLines` 改成在 UnanchoredActivityBlocks 内
 * 渲染思考块的预览行；展开态走 `thinkingExpanded` 全 Markdown（与原路径
 * 同形态）。本组件不再持有 `showThinkingPanel` / `ThinkingPanel` 装配。
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
          deferredThinkingDrafts={props.deferredThinkingDrafts}
          thinkingExpanded={props.thinkingExpanded}
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
 *
 * T4 live-signal revision：思考槽块（`slot.kind === "thinking"`）的预览行
 * 走 `thinkingPeekLines(deferredThinkingDrafts)`（≤3 行 dim 折叠态）；
 * 展开态（`thinkingExpanded`）走 Markdown 全文 —— 与原 ThinkingPanel 同形态，
 * 现在挂进块槽位（与块标题同行视觉，而非独立 tail 单元）。
 */
function UnanchoredActivityBlocks(props: {
  readonly blocks: ReadonlyArray<ActivityBlock>;
  readonly contentWidth: number;
  readonly deferredThinkingDrafts: string;
  readonly thinkingExpanded: boolean;
}): ReactNode {
  // 行装配单源：非思考块的「标题 + 可选预览」模板走
  // `renderActivityBlockRows`（与 MessageRow 同源，不再各自漂移）；
  // 思考块走 ThinkingBlockSlot（peek / 展开是 tail 特有形态）。
  // 块按数组序渲染 —— 连续的非思考段合成一次 rows 调用，保持文档顺序。
  const rows: ReactNode[] = [];
  let run: { titles: string[]; previews: Array<string | null> } | null = null;
  const flushRun = (startIdx: number) => {
    if (run === null) return;
    const runStart = startIdx;
    rows.push(
      renderActivityBlockRows(
        run.titles,
        run.previews,
        props.contentWidth,
        (i) => `unanchored-block-${runStart + i}`
      )
    );
    run = null;
  };
  props.blocks.forEach((block, blockIdx) => {
    if (block.slot.kind === "thinking") {
      flushRun(blockIdx);
      rows.push(
        <ThinkingBlockSlot
          key={`unanchored-thinking-${blockIdx}`}
          contentWidth={props.contentWidth}
          draft={props.deferredThinkingDrafts}
          expanded={props.thinkingExpanded}
        />
      );
      return;
    }
    if (run === null) run = { titles: [], previews: [] };
    run.titles.push(block.title);
    run.previews.push(
      block.slot.kind === "tool-preview" ? block.slot.text : null
    );
  });
  flushRun(props.blocks.length);
  return (
    <MessageShell key="unanchored-activity-blocks" cols={props.contentWidth}>
      {rows}
    </MessageShell>
  );
}

/** 单块：思考标题 + 思考预览（折叠 ≤3 行 / 展开 Markdown 全文）。
 *  与 `ThinkingPanel` 视觉同形态（dim 行、wrapMode="none"），唯一区别
 *  是挂载在 unanchored 块壳里而非独立 tail 单元。标题不透传 block.title ——
 *  live 块标题就是 `formatThinkingLive()`（activity-block 单源），这里不复制。 */
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
