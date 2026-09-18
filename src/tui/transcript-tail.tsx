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
 *   crunched 行 → 未锚定非思考块（unanchoredBlocks 中非 thinking）→ tail slots
 *   → legacy liveToolLines → askLine → 未锚定思考块（unanchoredBlocks 中 thinking）
 *   → spinner。
 *
 * 过程块 spec：块列表（`buildActivityBlockFoldLines`）是折叠 / 预览的唯一
 * 来源；旧 `live activity group` 一行英文摘要（`Listing × N · Reading × M`）
 * 与 `unit fold`（`Thought for Ns · name × M`）互斥闸整体退役 —— 同批
 * retract 只在块 called 计数出现一次（spec S7）。
 *
 * Thinking-at-bottom revision（plans/tui-thinking-at-bottom.md 锁句 1–3）：
 * 还在流的思考段是 transcript 最底 —— 思考块（`slot.kind === "thinking"`）
 * 从 unanchoredBlocks 拆分出来，单独挂在 askLine 之后、Spinner 之前；非
 * 思考块（live noise / signal 已落定计数行）走原路径（crunched 之后、
 * tail slots 之前）。`Thinking…` 标题 + 预览/展开 只画一次。ThinkingPanel
 * 已退役，`ThinkingBlockSlot` 仍承担思考块的视觉（peek / Markdown 展开）。
 */
import type { ReactNode } from "react";
import { Markdown } from "./markdown.js";
import { MessageShell } from "./message-shell.js";
import { renderActivityBlockRows } from "./activity-block-rows.js";
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
  // Thinking-at-bottom revision：unanchoredBlocks 拆成两组 —— 非思考块
  // 走原路径（crunched → tail slots 之前），思考块挂到 askLine 之后、
  // Spinner 之前；同一帧内 `Thinking…` 仅出现一次（位置合同）。
  const nonThinkingBlocks: ActivityBlock[] = [];
  const thinkingBlocks: ActivityBlock[] = [];
  for (const block of props.unanchoredBlocks) {
    if (block.slot.kind === "thinking") {
      thinkingBlocks.push(block);
    } else {
      nonThinkingBlocks.push(block);
    }
  }
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
 * 与 MessageRow 的 renderBlockTitles 形态对齐。
 *
 * Thinking-at-bottom revision（plans/tui-thinking-at-bottom.md 锁句 1–3）：
 * 思考块（`slot.kind === "thinking"`）从本壳里剥离，挂到 `UnanchoredThinkingBlocks`，
 * 独立绘制在 askLine 之后、Spinner 之前 —— 同一 burst 内思考是 transcript 最底。
 * 思考块的视觉（peek / Markdown 展开）由 `ThinkingBlockSlot` 单源承担，
 * `Thinking…` 标题在屏上**恰好一次**。
 */
function UnanchoredActivityBlocks(props: {
  readonly blocks: ReadonlyArray<ActivityBlock>;
  readonly contentWidth: number;
}): ReactNode {
  // 行装配单源：非思考块的「标题 + 可选预览」模板走
  // `renderActivityBlockRows`（与 MessageRow 同源，不再各自漂移）。
  // 块按数组序渲染 —— 连续段合成一次 rows 调用，保持文档顺序与「连续的非
  // 思考段合成一行模板」的合并行为（spec / message-blocks 同款）。
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
 * Thinking-at-bottom revision（plans/tui-thinking-at-bottom.md 锁句 1–3）：
 * 还在流的思考段作为 transcript 最底元素 —— 单独挂载在 askLine 之后、
 * Spinner 之前。视觉与原 ThinkingPanel 同形态（dim `Thinking…` 标题 + peek
 * 预览或 Markdown 展开）；思考标题在屏上仅出现一次（与 unanchored noise
 * 计数行物理隔离，避免「思考钉在工具卡上方」旧行为）。
 */
function UnanchoredThinkingBlocks(props: {
  readonly blocks: ReadonlyArray<ActivityBlock>;
  readonly contentWidth: number;
  readonly deferredThinkingDrafts: string;
  readonly thinkingExpanded: boolean;
}): ReactNode {
  // 单一思考块（thinking 是位置合同的「一个」主语 —— `appendLiveBlocks`
  // 只产一个 thinking 块；多思考块场景由下一段思考另起一个 anchor 进入
  // unanchoredBlocks）。`Thinking…` 仍由 activity-block 单源产出，本组件
  // 不复制文案。
  return (
    <MessageShell key="unanchored-thinking-blocks" cols={props.contentWidth}>
      {props.blocks.map((block, idx) => {
        // 非思考块不应出现在本壳里 —— 直接渲染会丢可视槽位、且破坏最底
        // 位置合同；早退兜底（防御性，调用方已拆分）。
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
