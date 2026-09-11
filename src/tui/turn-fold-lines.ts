/**
 * src/tui/turn-fold-lines.ts
 *
 * #986 + plans/issue-986-chatview-split.md：把 ChatView 内联的 turn /
 * fold 派生（行 307–504）抽成纯模块，渲染由 ChatView 仍负责。
 *
 * SSOT = plans/tui-chrome-interaction.md T1 + spec
 * specs/tui-tool-settled-appearance.md D3：
 *  - 折叠按**已完成单元**判定，不再被 running 整轮压制；
 *  - 折叠簇思考秒数 = anchor 消息的 thinkingMs（per-message 并行数组），
 *    不跨段归并；
 *  - 同一 assistant messageIndex 拆出的多簇共享 thinkingMs，重复展示
 *    时后续簇按 0 计；
 *  - 上一段折叠后无折叠行但有已完成 live 工具 → 把折叠行挂到最近 text 段尾。
 *
 * 本模块纯函数、无 React / IO 依赖；调用方（ChatView）把结果 Map 喂回
 * 渲染层。`turn-fold-lines.test.ts` 五类边界（empty / negative /
 * overflow / concurrent / exception）。
 */
import type { AnthropicNativeMessage } from "../harness/model-adapter/types.js";
import {
  formatTurnActivityFold,
  mergeToolUseCounts,
  shouldShowRetractFold,
  shouldShowThinkingFold,
  thinkingMsToSeconds,
  type ToolUseCount,
  type TurnActivitySegment,
} from "./turn-activity.js";

/** anchor 消息下标 → 折叠行（unit fold，0 或 1 行）。 */
export type FoldLinesBySegmentIndex = ReadonlyMap<
  number,
  ReadonlyArray<string>
>;

/** 已被折叠行覆盖的 ms 值集合（hideThinking 用，按派生值不反推显示文案）。 */
export type ShownThinkingMsValues = ReadonlySet<number>;

/** 每条 anchor 消息是否已画过带时长段折叠行（同消息去重用）。 */
export type DrawnThinkingForMessageIndex = ReadonlySet<number>;

/** `thinkingMsAtVisible(visibleIndex)` 的注入形态 —— 渲染层做 sourceIndex →
 *  visibleIndex 映射，本模块只看 visible 下标。 */
export type ThinkingMsAtVisible = (visibleIndex: number) => number;

export interface FoldDerivationContext {
  readonly activitySegments: ReadonlyArray<TurnActivitySegment>;
  readonly thinkingMsAtVisible: ThinkingMsAtVisible;
  readonly running: boolean;
  /** 最后一条 tool 段的 segmentIndex；-1 = 没有任何 tools 段。 */
  readonly lastToolSegmentIndex: number;
  /** live 已完成工具计数（fold-fallback 用）。 */
  readonly liveCompletedCounts: ReadonlyArray<ToolUseCount>;
}

export interface FoldDerivationResult {
  readonly foldLinesBySegmentIndex: FoldLinesBySegmentIndex;
  readonly drawnThinkingForMessageIndex: DrawnThinkingForMessageIndex;
  readonly shownThinkingMsValues: ShownThinkingMsValues;
  /** fold-fallback 实际写入了行（即使 fallback 命中 last text 段）。 */
  readonly fallbackApplied: boolean;
}

/** 内部 scratch 集合（foldMap + 两组去重 set）—— 单次 build 调用内共享。 */
interface FoldSets {
  readonly foldLinesBySegmentIndex: Map<number, ReadonlyArray<string>>;
  readonly drawnThinkingForMessageIndex: Set<number>;
  readonly shownThinkingMsValues: Set<number>;
}

/** 内部 per-segment 上下文：tools 段 + 数组下标（foldMap key）。 */
interface ToolSegmentSlot {
  readonly segment: TurnActivitySegment & { readonly kind: "tools" };
  readonly segmentIndex: number;
}

/**
 * 计算 anchor 消息对应的折叠行集合。plans T1：fold-fallback 路径与
 * running 解耦 —— 已完成单元照折。
 */
export function buildFoldLinesBySegmentIndex(
  ctx: FoldDerivationContext
): FoldDerivationResult {
  const sets: FoldSets = {
    foldLinesBySegmentIndex: new Map(),
    drawnThinkingForMessageIndex: new Set(),
    shownThinkingMsValues: new Set(),
  };
  for (let i = 0; i < ctx.activitySegments.length; i++) {
    const segment = ctx.activitySegments[i];
    if (segment === undefined || segment.kind !== "tools") continue;
    const entries =
      i === ctx.lastToolSegmentIndex
        ? mergeToolUseCounts(segment.entries, ctx.liveCompletedCounts)
        : segment.entries;
    pushFoldLineForSegment({ segment, segmentIndex: i }, entries, ctx, sets);
  }
  const fallbackApplied =
    sets.foldLinesBySegmentIndex.size === 0 &&
    ctx.liveCompletedCounts.length > 0
      ? pushFallbackFoldLine(ctx, sets)
      : false;
  return {
    foldLinesBySegmentIndex: sets.foldLinesBySegmentIndex,
    drawnThinkingForMessageIndex: sets.drawnThinkingForMessageIndex,
    shownThinkingMsValues: sets.shownThinkingMsValues,
    fallbackApplied,
  };
}

/**
 * per-segment 循环体（clean as own function —— ACR 实测）。plans T1：
 * per-segment 闸门与 running 解耦 —— retract 完成即入折叠；thinkingMs
 * 冻结即显示秒数。
 */
function pushFoldLineForSegment(
  slot: ToolSegmentSlot,
  entries: ReadonlyArray<ToolUseCount>,
  ctx: FoldDerivationContext,
  sets: FoldSets
): void {
  let clusterMs = ctx.thinkingMsAtVisible(slot.segment.messageIndex);
  // 同消息去重：同一 assistant 拆出多簇（tool→text→tool）共享
  // thinkingMs，重复展示时后续簇按 0 计（只画工具计数）。
  if (
    clusterMs > 0 &&
    sets.drawnThinkingForMessageIndex.has(slot.segment.messageIndex)
  ) {
    clusterMs = 0;
  }
  const clusterSeconds = thinkingMsToSeconds(clusterMs);
  const segmentRetractTotal = entries.reduce((n, e) => n + e.count, 0);
  if (
    !shouldShowRetractFold({
      running: ctx.running,
      segmentRetractTotal,
    }) &&
    !shouldShowThinkingFold({
      running: ctx.running,
      hasThinkingMs: clusterSeconds > 0,
    })
  ) {
    return; // EXIT: 双闸门拒绝 → 本段不渲染折叠行。
  }
  const lines = formatTurnActivityFold(clusterSeconds, entries);
  if (lines.length === 0) return; // EXIT: 闸门过但格式产出空行（无秒数无计数）。
  sets.foldLinesBySegmentIndex.set(slot.segmentIndex, lines);
  if (clusterSeconds > 0) {
    sets.drawnThinkingForMessageIndex.add(slot.segment.messageIndex);
    sets.shownThinkingMsValues.add(clusterMs);
  }
}

/**
 * fallback 路径：无 tools 段但有 liveCompletedCounts → 把折叠行挂到最近
 * text 段尾（invert 原 `if (!A && !B) {} else {}` 嵌套为 early-return）。
 */
function pushFallbackFoldLine(
  ctx: FoldDerivationContext,
  sets: FoldSets
): boolean {
  const lastTextIndex = findLastTextSegmentIndex(ctx.activitySegments);
  if (lastTextIndex < 0) return false;
  const lastText = ctx.activitySegments[lastTextIndex];
  if (lastText === undefined || lastText.kind !== "text") return false;
  const clusterMs = ctx.thinkingMsAtVisible(lastText.messageIndex);
  const clusterSeconds = thinkingMsToSeconds(clusterMs);
  const segmentRetractTotal = ctx.liveCompletedCounts.reduce(
    (n, e) => n + e.count,
    0
  );
  if (
    !shouldShowRetractFold({
      running: ctx.running,
      segmentRetractTotal,
    }) &&
    !shouldShowThinkingFold({
      running: ctx.running,
      hasThinkingMs: clusterSeconds > 0,
    })
  ) {
    return false; // EXIT: 双闸门拒绝 → 保留空 foldLinesBySegmentIndex。
  }
  const lines = formatTurnActivityFold(clusterSeconds, ctx.liveCompletedCounts);
  if (lines.length === 0) return false;
  sets.foldLinesBySegmentIndex.set(lastTextIndex, lines);
  if (clusterSeconds > 0) {
    sets.shownThinkingMsValues.add(clusterMs);
  }
  return true;
}

/** `findLastTextSegment` 的位置版本 —— 内部 fallback 用，避免 caller 重新扫一遍。 */
function findLastTextSegmentIndex(
  segments: ReadonlyArray<TurnActivitySegment>
): number {
  for (let i = segments.length - 1; i >= 0; i--) {
    const seg = segments[i];
    if (seg !== undefined && seg.kind === "text") return i;
  }
  return -1;
}

/**
 * 当前 turn 折叠行判定 —— fold 行 anchor（segmentIndex 落在
 * lastQueryVisible 之后）已展开 fold 行 → live thinking 面板让位。
 */
export function currentTurnHasFoldFor(opts: {
  readonly activitySegments: ReadonlyArray<TurnActivitySegment>;
  readonly foldLinesBySegmentIndex: FoldLinesBySegmentIndex;
  readonly lastQueryVisible: number;
}): boolean {
  if (opts.lastQueryVisible < 0) return false;
  return segmentBelongsToCurrentTurn(opts, false);
}

/**
 * 当前 turn 是否已有带时长的折叠行 —— 用于 live thinking 面板让位判定
 * （按派生值 drawnThinkingForMessageIndex，不反推显示文案）。
 */
export function currentTurnHasThinkingFoldFor(opts: {
  readonly activitySegments: ReadonlyArray<TurnActivitySegment>;
  readonly foldLinesBySegmentIndex: FoldLinesBySegmentIndex;
  readonly drawnThinkingForMessageIndex: DrawnThinkingForMessageIndex;
  readonly lastQueryVisible: number;
}): boolean {
  if (opts.lastQueryVisible < 0) return false;
  return segmentBelongsToCurrentTurn(opts, true);
}

function segmentBelongsToCurrentTurn(
  opts: {
    readonly activitySegments: ReadonlyArray<TurnActivitySegment>;
    readonly foldLinesBySegmentIndex: FoldLinesBySegmentIndex;
    readonly drawnThinkingForMessageIndex?: DrawnThinkingForMessageIndex;
    readonly lastQueryVisible: number;
  },
  requireDrawn: boolean
): boolean {
  for (const segmentIndex of opts.foldLinesBySegmentIndex.keys()) {
    const seg = opts.activitySegments[segmentIndex];
    if (seg === undefined || seg.kind !== "tools") continue;
    if (seg.messageIndex < opts.lastQueryVisible) continue;
    if (
      requireDrawn &&
      opts.drawnThinkingForMessageIndex !== undefined &&
      !opts.drawnThinkingForMessageIndex.has(seg.messageIndex)
    ) {
      continue;
    }
    return true;
  }
  return false;
}

/**
 * `messageSegments` —— 给定 messageIndex 对应的所有 activitySegments
 * 子集（同一消息可能拆出多簇：tool → text → tool）。从全量 activity
 * 中筛出 `segment.messageIndex === visibleIndex` 的子集。
 */
export function pickMessageSegments(
  activitySegments: ReadonlyArray<TurnActivitySegment>,
  visibleIndex: number
): ReadonlyArray<{
  readonly segmentIndex: number;
  readonly segment: TurnActivitySegment;
}> {
  const out: Array<{
    readonly segmentIndex: number;
    readonly segment: TurnActivitySegment;
  }> = [];
  for (let i = 0; i < activitySegments.length; i++) {
    const seg = activitySegments[i];
    if (seg !== undefined && seg.messageIndex === visibleIndex) {
      out.push({ segmentIndex: i, segment: seg });
    }
  }
  return out;
}

/** 给定 messageSegments，是否存在多段且至少一段有折叠行 —— 控制是否走
 * 「in content order」渲染分支。 */
export function renderInContentOrder(
  messageSegments: ReadonlyArray<{
    readonly segmentIndex: number;
    readonly segment: TurnActivitySegment;
  }>,
  foldLinesBySegmentIndex: FoldLinesBySegmentIndex
): boolean {
  if (messageSegments.length <= 1) return false;
  for (const { segmentIndex } of messageSegments) {
    if (foldLinesBySegmentIndex.has(segmentIndex)) return true;
  }
  return false;
}

/**
 * 把 `visibleMessages` / `thinkingMs` 拍平成 `thinkingMsAtVisible`：映射
 * `visibleIndex → sourceIndex` 后查表。sourceIndex 缺席时按 0 兜底
 * （与 `sumThinkingMsInRange` 的同款越界防御）。
 */
export function makeThinkingMsAtVisibleFromSource(
  thinkingMs: ReadonlyArray<number | null> | undefined,
  sourceIndexOfVisible: ReadonlyArray<number>
): ThinkingMsAtVisible {
  return (visibleIndex: number): number => {
    const sourceIndex = sourceIndexOfVisible[visibleIndex] ?? visibleIndex;
    if (thinkingMs === undefined) return 0;
    const value = thinkingMs[sourceIndex];
    if (value === null || value === undefined) return 0;
    if (!Number.isFinite(value) || value <= 0) return 0;
    return value;
  };
}

/** `activitySegments` 中最后一个 tools 段的下标；无 → -1。 */
export function findLastToolSegmentIndex(
  segments: ReadonlyArray<TurnActivitySegment>
): number {
  for (let i = segments.length - 1; i >= 0; i--) {
    const seg = segments[i];
    if (seg !== undefined && seg.kind === "tools") return i;
  }
  return -1;
}

/**
 * segment 到 message content 的活动块切片（`text` 取单段、`tools` 取
 * blockIndex..endIndex 的 tool_use）。原 ChatView 内层段渲染器从
 * message.content 抽「该 segment 的活动块」+（first part）thinkingBlocks。
 */
export function segmentActivityBlocks(
  message: AnthropicNativeMessage,
  segment: TurnActivitySegment,
  blockIndex: number,
  endIndex: number
): AnthropicNativeMessage["content"] {
  if (segment.kind === "text") {
    const block = message.content[blockIndex];
    return block === undefined ? [] : [block];
  }
  return message.content
    .slice(blockIndex, endIndex)
    .filter((b) => b.type === "tool_use");
}

/** first part 的 thinking blocks（thinking + redacted_thinking） —— 仅首
 * 段附加。 */
export function firstPartThinkingBlocks(
  message: AnthropicNativeMessage
): AnthropicNativeMessage["content"] {
  return message.content.filter(
    (b) => b.type === "thinking" || b.type === "redacted_thinking"
  );
}
