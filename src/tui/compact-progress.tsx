/** @jsxImportSource @opentui/react */
/**
 * src/tui/compact-progress.tsx
 *
 * compact 压缩进度面板（design-25 视觉语言，与 /effort 档位面板同款圆角流光
 * 框 + 渐变读条 + 边界水线）。
 *
 * **读条是时间估计，不是真实进度** —— harness 只发 5 个离散事件
 * （`compaction_started {droppedCount}` / `compaction_text_delta` /
 * `compaction_completed` / `compaction_failed` / `compaction_cancelled`，
 * 见 src/harness/stream.ts:43-52），**没有** tick、百分比或 phase 信号。
 * 因此填充量只能按 elapsed 做渐近逼近（`compactBarFill`，上限 0.95），
 * 只有收到 completed 才走 1.0。面板不冒充真值：未完成的条永远留缺口。
 *
 * T1 纯函数（无 React 依赖，可独立单测）：
 *  - `reduceCompactionEvent`：事件归约状态机（identity 契约见下）；
 *  - `compactBarFill` / `compactStatusText` / `compactHintText` /
 *    `compactProgressRows`：填充估计、状态行、键位提示、行账 SSOT；
 *  - `startCompactPanel` / `settleCompactPanel`：面板建/终态入口。
 *
 * T2 渲染组件 `CompactProgress`：圆角流光框（8s 边框相位）+ 标题 + 状态行 +
 * 45 格 `█` 读条 + 键位提示，共 6 行（边框 2 + 内容 4），不含 marginBottom
 * （与 thinkingPickerRows / memoryPickerRows 同约定，由 chromeReserveRows +1
 * 入账）。宽度固定 PICKER_WIDTH（50），alignSelf="flex-start" 靠左。
 *
 * 事件是**快路径**，promise 结果是**终态权威**（plan D3.5）：pre-abort 早返回
 * （full-compact.ts 的 `signal_aborted` 早返回分支）与 catch 都不经任何
 * `compaction_*` 事件，只靠事件会让面板停在 95% 伪在途态。故宿主必须用
 * `settleCompactPanel` 兜底终态，并在 turn 的 finally 强制清扫。
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { TextAttributes, type Timeline } from "@opentui/core";
import { useTimeline } from "@opentui/react";
import type { HarnessStreamEvent } from "../harness/stream.js";
import { useTick } from "./components.js";
import { tuiPalette } from "./theme.js";
import { PICKER_WIDTH } from "./thinking-picker.js";
import { floorTo5BarLen } from "./designs/_geometry.js";
import {
  BORDER_CYCLE_MS,
  flowBorderColor,
  gradAt,
  mixHex,
  triangleWindow,
} from "./designs/_color.js";

// ── T1：状态模型 + 纯函数投影 ───────────────────────────────────────────

/** 面板来源：手动 `/compact`（可 Esc 取消）/ turn 内 auto-compact（Esc 打断 turn）。 */
export type CompactProgressSource = "manual" | "turn";

/** 终态分类。done = 压缩实际完成；failed = 摘要失败；cancelled = 用户取消。 */
export type CompactTerminalKind = "done" | "failed" | "cancelled";

/**
 * 面板状态（宿主 app.tsx 持有，按 conversationId 分键）。
 *
 *  - source：面板归属路径（决定键位提示文案，也决定面板由谁清扫）；
 *  - droppedCount：started 事件携带的待压缩消息条数（0 = 尚未收到 started，
 *    状态行显示 "preparing"）；
 *  - startedAt：面板建立时刻（elapsed 起算点，ms epoch）；
 *  - terminal：终态（null = 在途）。终态一旦确立，迟到事件一律忽略。
 */
export interface CompactProgressState {
  readonly source: CompactProgressSource;
  readonly droppedCount: number;
  readonly startedAt: number;
  readonly terminal: null | {
    readonly kind: CompactTerminalKind;
    readonly atMs: number;
  };
}

/** 读条上限（时间估计永不「跑满」——只有 completed 才 1.0）。 */
export const COMPACT_BAR_MAX_FILL = 0.95;
/** 时间常数：elapsed = tau 时约完成 63%（渐近逼近，见 compactBarFill）。 */
export const COMPACT_TAU_MS = 12_000;
/** 终态停留时长：让 100% / 失败色可见，之后宿主卸载面板。 */
export const COMPACT_HOLD_MS = 1_200;

/**
 * 读条填充量（时间估计，**不是**真实进度）。
 *
 * `min(0.95, 0.05 + 0.90 * (1 - exp(-max(0,elapsed)/12000)))`：
 *  - 起点 0.05（面板一出现就有可见填充，不是空条）；
 *  - 渐近上限 0.95（时间流逝永不冒充「完成」）；
 *  - 负 elapsed 钳制到 0（startedAt 落在未来 / 时钟回拨）。
 *
 * completed 的 1.0 由组件按 `terminal.kind === "done"` 单独处理，不走本函数
 * （本函数只表达「在途」的估计）。
 */
export function compactBarFill(elapsedMs: number): number {
  const t = Math.max(0, elapsedMs);
  return Math.min(
    COMPACT_BAR_MAX_FILL,
    0.05 + 0.9 * (1 - Math.exp(-t / COMPACT_TAU_MS))
  );
}

/**
 * 状态行文案（SSOT 纯函数）。elapsed = floor(max(0, now-startedAt)/1000) 秒：
 *
 *  - 在途且 droppedCount === 0 → `◐  {n}s · preparing`（started 未到）；
 *  - 在途 → `◐  {n}s · {droppedCount} messages folded`；
 *  - done → `✓  {n}s · done`；failed → `✗  {n}s · summary failed`；
 *    cancelled → `—  {n}s · cancelled`。
 */
export function compactStatusText(
  state: CompactProgressState,
  nowMs: number
): string {
  const elapsed = Math.floor(Math.max(0, nowMs - state.startedAt) / 1000);
  if (state.terminal === null) {
    const detail =
      state.droppedCount === 0
        ? "preparing"
        : `${state.droppedCount} messages folded`;
    return `◐  ${elapsed}s · ${detail}`;
  }
  switch (state.terminal.kind) {
    case "done":
      return `✓  ${elapsed}s · done`;
    case "failed":
      return `✗  ${elapsed}s · summary failed`;
    case "cancelled":
      return `—  ${elapsed}s · cancelled`;
    default: {
      // 判别联合收窄后不可达；仅未来新增 kind 时兜底（不静默吞掉新状态）。
      const _exhaustive: never = state.terminal.kind;
      throw new Error(`unknown compact terminal kind: ${String(_exhaustive)}`);
    }
  }
}

/**
 * 键位提示：manual → `[Esc] cancel`；turn → `[Esc] interrupt`。
 *
 * turn 路径没有独立的压缩取消通道 —— Esc 打断的是 turn 本身，压缩随之
 * abort（loop-engine 把同一 signal 传进 applyCompactAttachment），故文案
 * 必须说 interrupt 而不是 cancel，避免许诺一个不存在的精确操作。
 */
export function compactHintText(source: CompactProgressSource): string {
  return source === "manual" ? "[Esc] cancel" : "[Esc] interrupt";
}

/** 面板总终端行数（行账 SSOT）：边框 2 + 内容 4。不含 marginBottom=1。 */
export function compactProgressRows(): number {
  return 6;
}

/** 新建面板（startedAt=nowMs，droppedCount 0，在途）。 */
export function startCompactPanel(
  source: CompactProgressSource,
  nowMs: number
): CompactProgressState {
  return { source, droppedCount: 0, startedAt: nowMs, terminal: null };
}

/**
 * 终态入口（promise 结果是终态权威，plan D3.5）。
 *
 * 已终态 → 原样返回（引用相等）：不许迟到路径改写已呈现的结局，也不重置
 * 停留计时（atMs 是首次 settle 的时刻）。
 */
export function settleCompactPanel(
  state: CompactProgressState,
  kind: CompactTerminalKind,
  nowMs: number
): CompactProgressState {
  if (state.terminal !== null) return state;
  return { ...state, terminal: { kind, atMs: nowMs } };
}

/**
 * 终态事件的「无面板」短路：无面板可更新 → undefined（不无中生有）。
 * 三个终态事件共用，把分支从 reduceCompactionEvent 里提出来（复杂度预算）。
 */
function settleIfPresent(
  state: CompactProgressState | undefined,
  kind: CompactTerminalKind,
  nowMs: number
): CompactProgressState | undefined {
  return state === undefined
    ? undefined
    : settleCompactPanel(state, kind, nowMs);
}

/**
 * 事件归约（纯函数，identity 契约见下）。宿主按 conversationId 分键调用。
 *
 * **identity 契约**：非 compaction 事件原样返回**同一引用** —— app.tsx 的
 * onStream 逐事件链据此做引用相等守卫，非压缩事件不触发任何 setState
 * （否则每个 text_delta 都会 re-render 整个 chrome）。
 *
 *  - `compaction_started`：在途 → 更新 droppedCount（保留 source/startedAt，
 *    不重置计时）；已终态 → 忽略（迟到）；无面板 → 按 opts 建立；
 *  - `compaction_completed` / `_failed` / `_cancelled`：无面板 → undefined
 *    （无面板可更新，不无中生有）；已终态 → 忽略（迟到）；在途 → settle；
 *  - `compaction_text_delta`：恒 identity（活动信号；填充是时间估计，文本
 *    增量不推进任何状态）。
 */
export function reduceCompactionEvent(
  state: CompactProgressState | undefined,
  event: HarnessStreamEvent,
  opts: { readonly source: CompactProgressSource; readonly nowMs: number }
): CompactProgressState | undefined {
  switch (event.type) {
    case "compaction_started":
      if (state === undefined) {
        return {
          source: opts.source,
          droppedCount: event.droppedCount,
          startedAt: opts.nowMs,
          terminal: null,
        };
      }
      if (state.terminal !== null) return state; // 迟到的 started
      return { ...state, droppedCount: event.droppedCount };
    case "compaction_completed":
      return settleIfPresent(state, "done", opts.nowMs);
    case "compaction_failed":
      return settleIfPresent(state, "failed", opts.nowMs);
    case "compaction_cancelled":
      return settleIfPresent(state, "cancelled", opts.nowMs);
    default:
      // compaction_text_delta：恒 identity（摘要文本流只证明「还活着」，
      // 不参与进度估计）。非 compaction 事件同理 —— identity 是 app 层
      // 引用相等守卫的依据。
      return state;
  }
}

// ── 渲染常量（design-25 同款） ──────────────────────────────────────────

/** 边界水线左右流动一趟的时长（alternate ping-pong 单程）。 */
const EDGE_FLOW_MS = 2400;
/** 水线晃动幅度（相对 segLen 的半幅，± 0.9 段）。 */
const EDGE_SWAY = 0.9;
/** 水线最亮处向 logoGold 的混合上限。 */
const EDGE_MIX = 1;
/** 读条心跳周期（elapsed 秒级跳字 + 水线推进的驱动源）。 */
const TICK_MS = 100;

/**
 * CompactProgress —— design-25 风格压缩进度面板。
 *
 * 常驻 overlay：无入场动画，宽度固定 PICKER_WIDTH、alignSelf flex-start 靠左；
 * 行数恒定 6（2 边框 + 4 内容：标题 / 状态行 / 读条 / 键位提示）。
 * 配色与动效逐字对齐 thinking-picker 的 effort 面板（同一视觉语言）。
 */
export function CompactProgress(props: {
  readonly state: CompactProgressState;
}): ReactNode {
  const pal = tuiPalette;
  const { state } = props;

  // ── Timeline 引用（useRef 锁首 render 实例，design-25 同款） ──
  const initialTimeline = useTimeline({
    duration: BORDER_CYCLE_MS,
    loop: true,
  });
  const timelineRef = useRef<Timeline | null>(null);
  if (timelineRef.current === null) timelineRef.current = initialTimeline;
  const tl = timelineRef.current;

  const edgeFirst = useTimeline({
    duration: EDGE_FLOW_MS,
    loop: true,
  });
  const edgeRef = useRef<Timeline | null>(null);
  if (edgeRef.current === null) edgeRef.current = edgeFirst;
  const tlEdge = edgeRef.current;

  // ── 常驻动效 state（每帧 setState） ──
  const [borderPhase, setBorderPhase] = useState(0);
  const [edgePhase, setEdgePhase] = useState(0.5); // 水线相位 0..1..0
  // elapsed 时钟：100ms 心跳（不用 useTimeline —— 秒级跳字是离散读数，
  // 不是连续插值动画）。返回值只作 re-render 触发源，elapsed 由 Date.now()
  // 现算，故不消费 tick 值。
  useTick(TICK_MS);

  // 边框流光相位：8s 线性循环（onComplete 归零避免 reset 陷阱）
  useEffect(() => {
    const target = { phase: 0 };
    tl.add(target, {
      phase: 4,
      duration: BORDER_CYCLE_MS,
      ease: "linear",
      onComplete: () => {
        target.phase = 0;
      },
      onUpdate: () => {
        const next = target.phase;
        setBorderPhase((prev) => (prev === next ? prev : next));
      },
    });
  }, [tl]);

  // 常驻：水线相位 0→1→0（alternate ping-pong），驱动边界左右小幅流动。
  // 填充几乎不动时水线仍在跑 —— 这是「还活着」的存活信号。
  useEffect(() => {
    const target = { p: 0 };
    tlEdge.add(target, {
      p: 1,
      duration: EDGE_FLOW_MS,
      ease: "linear",
      loop: true,
      alternate: true,
      onUpdate: () => setEdgePhase(target.p),
    });
  }, [tlEdge]);

  // ── 读条几何（共享 _geometry.ts）：宽度固定 PICKER_WIDTH，border 左右
  //    2 列 + paddingX 各 1 列 = 4 列固定开销，内宽 = PICKER_WIDTH - 4。
  const barLen = floorTo5BarLen(PICKER_WIDTH - 4);
  const segLen = barLen / 5;

  // ── 填充量：done 才 1.0（真实完成），其余按时间渐近（见模块头注释）。
  const terminalKind = state.terminal?.kind ?? null;
  const nowMs = Date.now();
  const fill =
    terminalKind === "done" ? 1 : compactBarFill(nowMs - state.startedAt);
  // 水线中心 = 填充前沿 ± 0.9*segLen 缓摆。
  const edgeCenter = fill * barLen - 1 + (edgePhase - 0.5) * segLen * EDGE_SWAY;

  /** 水线（半宽 segLen 的三角窗，越靠前沿越向 logoGold 过渡）。 */
  function crestColor(i: number): number {
    return triangleWindow(i, edgeCenter, segLen) * EDGE_MIX;
  }

  /**
   * 字符 i 的颜色：
   *  - 未填充 → 暗灰干轨（bg border / fg dim），水线不越界；
   *  - 已填充 → 紫渐变基色（gradAt 按前沿归一）+ 前沿水线混向 logoGold；
   *  - terminal failed → 已填充段整体混向 error（失败色铺满）；
   *  - terminal cancelled → 全条退化暗灰（会话原样，无成果可展示）。
   */
  function colorAt(i: number): { bg: string; fg: string } {
    if (terminalKind === "cancelled") {
      return { bg: pal.border, fg: pal.dim };
    }
    const filledEnd = Math.max(1, Math.ceil(fill * barLen));
    if (terminalKind === null && i >= filledEnd) {
      return { bg: pal.border, fg: pal.dim };
    }
    const base = gradAt(i / Math.max(1, filledEnd));
    const glowEdge = crestColor(i);
    const crest = mixHex(pal.logoInk, pal.logoGold, glowEdge);
    let bg = mixHex(base, crest, glowEdge);
    if (terminalKind === "failed") {
      // 失败：填充段整体向 error 倾斜（保留一点渐变骨架）。
      bg = mixHex(bg, pal.error, 0.72);
    }
    const fg = mixHex(bg, pal.logoInk, 0.5);
    return { bg, fg };
  }

  // ── 读条：铺满内宽，逐格 bg/fg 染色 ──
  const barCells: ReactNode[] = [];
  for (let i = 0; i < barLen; i++) {
    const { bg, fg } = colorAt(i);
    barCells.push(
      <span key={i} bg={bg} fg={fg}>
        █
      </span>
    );
  }

  const statusTone =
    terminalKind === "failed"
      ? pal.error
      : terminalKind === "done"
        ? pal.running
        : pal.dim;

  // ── 渲染 ──
  return (
    <box
      flexDirection="column"
      borderStyle="rounded"
      borderColor={flowBorderColor(borderPhase)}
      paddingX={1}
      paddingY={0}
      marginBottom={1}
      width={PICKER_WIDTH}
      alignSelf="flex-start"
    >
      {/* 标题 ◆─ Compacting（design-25 同款前缀，running 色 + BOLD 正文） */}
      <text>
        <span fg={pal.running}>{"◆─ "}</span>
        <span fg={pal.text} attributes={TextAttributes.BOLD}>
          Compacting
        </span>
      </text>

      {/* 状态行：◐/✓/✗/— + elapsed + 结果（文案 SSOT = compactStatusText） */}
      <text fg={statusTone} wrapMode="none">
        {compactStatusText(state, nowMs)}
      </text>

      {/* 读条：紫渐变填充 + 前沿流动水线（时间估计，非真实进度） */}
      <text wrapMode="none">{barCells}</text>

      {/* 键位提示（wrapMode none：窄终端 clip 不折行，保持固定 6 行行账） */}
      <text fg={pal.dim} wrapMode="none">
        {compactHintText(state.source)}
      </text>
    </box>
  );
}
