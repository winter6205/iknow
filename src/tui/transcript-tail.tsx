/** @jsxImportSource @opentui/react */
/**
 * src/tui/transcript-tail.tsx
 *
 * #986：把 ChatView 末尾段（spacerAfter、crunched、tailSlots、流式
 * thinking 面板、legacy liveToolLines、askLine、Spinner）抽成 sibling
 * 组件。逻辑由纯派生 `decideTailLayout` 计算渲染决策，组件只挂 JSX。
 *
 * 渲染顺序（spec D3/D7 + D9 栈序）：
 *   crunched 行 → tail slots → **live activity group** → thinking 面板 →
 *   legacy liveToolLines → askLine → spinner。
 *
 * D9 栈序（docs/CONTEXT.md `live activity group`）：过程组在上、thinking
 * 在下（近输入）；有工具 running 时 thinking panel 让位，两个 live panel
 * 不同屏叠。让位判定由 ChatView 派生（`shouldShowLiveThinkingPanel`）后经
 * `showThinkingPanel` 透传 —— 本组件只挂 JSX，不做 fold 派生。
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
  /** 进行中一行英文摘要（Listing × N · Running N shell commands）。
   *  由 ChatView 按 `running` 闸门派生 —— idle 恒 null（D9：idle 落定走
   *  unit fold + keep 标题，组是**进行中**的 chrome）。 */
  readonly groupSummary: string | null;
  /** open-unit 让位判定（`shouldShowLiveThinkingPanel`）由 ChatView 派生。 */
  readonly showThinkingPanel: boolean;
  readonly liveToolLines: ReadonlyArray<string>;
  readonly askLine: string | undefined;
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
      {props.groupSummary !== null && (
        <LiveActivityGroupLine
          summary={props.groupSummary}
          contentWidth={props.contentWidth}
          hasSlots={props.tailSlots.length > 0}
        />
      )}
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

/** 过程组摘要行 —— 一行英文、单行不折（`Listing × 1 · Reading × 3`）。
 *  色 token = `dim`：过程组是**进行中**的次级摘要，落定态由 unit fold 的
 *  `Thought for` 行接手（失败横切不进本组计数，故不出现 error 色）。 */
function LiveActivityGroupLine(props: {
  readonly summary: string;
  readonly contentWidth: number;
  readonly hasSlots: boolean;
}): ReactNode {
  return (
    <box
      flexDirection="column"
      width={props.contentWidth}
      marginTop={props.hasSlots ? 1 : 0}
    >
      <text
        fg={tuiPalette.dim}
        wrapMode="none"
        width={Math.max(1, props.contentWidth - 2)}
      >
        {props.summary}
      </text>
    </box>
  );
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
