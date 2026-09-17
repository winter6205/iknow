/**
 * src/tui/turn-fold-lines.ts
 *
 * #986 + plans/issue-986-chatview-split.md：把 ChatView 内联的 turn /
 * fold 派生（行 307–504）抽成纯模块，渲染由 ChatView 仍负责。
 *
 * T7（specs/tui-activity-block.md / plans T7）：旧 `buildFoldLinesBySegmentIndex`
 * 路径（unit fold 行）整体退役 —— 块列表（`buildActivityBlockFoldLines`）
 * 是折叠的唯一来源；本模块只保留：
 *  - `pickMessageSegments` / `renderInContentOrder`（MessageRow 渲染切分用）
 *  - `makeThinkingMsAtVisibleFromSource`（visibleIndex → sourceIndex 映射）
 *  - `segmentActivityBlocks` / `firstPartThinkingBlocks`（段渲染切片）
 *  - `shouldShowLiveThinkingPanel`（live thinking 让位判定）
 *  - `buildActivityBlockFoldLines`（活动块标题 / 预览 / hideThinking 派生）
 *
 * 本模块纯函数、无 React / IO 依赖；调用方（ChatView）把结果 Map 喂回
 * 渲染层。
 */
import type { AnthropicNativeMessage } from "../harness/model-adapter/types.js";
import type { LiveToolRun } from "./live-tool-state.js";
import type { TurnActivitySegment } from "./turn-activity.js";
import {
  deriveActivityBlocks,
  type ActivityBlock,
  type ActivityBlockInput,
} from "./activity-block.js";

/** anchor 消息下标 → 折叠行（unit fold，0 或 1 行）—— T7 后保留类型以
 *  兼容 MessageRow / ChatScrollbox 调用面，但本模块不再填充；传恒空 map。 */
export type FoldLinesBySegmentIndex = ReadonlyMap<
  number,
  ReadonlyArray<string>
>;

/** 已被折叠行覆盖的 ms 值集合（hideThinking 用，按派生值不反推显示文案）。 */
export type ShownThinkingMsValues = ReadonlySet<number>;

/** `thinkingMsAtVisible(visibleIndex)` 的注入形态 —— 渲染层做 sourceIndex →
 *  visibleIndex 映射，本模块只看 visible 下标。 */
export type ThinkingMsAtVisible = (visibleIndex: number) => number;

/**
 * live thinking 面板（open unit）让位判定 —— docs/CONTEXT.md `open unit`：
 * 已画活动块（`Thought for` / `calling / called`）**不是**关掉后续思考
 * panel 的信号；让位的唯一理由是**该 burst 已关闭**（draft 缓冲在每条
 * `text_delta` / `tool_call_start` 清空 — `closeThinkingPhase`）。任何 tool
 * running（包括同一 burst 内后续调起的工具）都不再关闭 panel —— 这正是
 * live-signal 锁句 7：不准用「任意 tool running」关下一块思考。
 *
 * 注意：本函数在 T4 live-signal 之后仅保留**纯函数出口**（盖子 + 测
 * 试覆盖），不再被任何生产代码调用 —— ChatView 经 `liveThinking` 字段
 * 直接驱动 unanchored 活动块、ThinkingPanel 组件已退役。保留导出只
 * 为历史夹具与 `thinkingDraftMasked` 闸子的语义文档。
 */
export function shouldShowLiveThinkingPanel(opts: {
  readonly running: boolean;
  readonly thinkingDraft: string;
}): boolean {
  return opts.running && opts.thinkingDraft.length > 0;
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
 * `visibleIndex → sourceIndex` 后查表。sourceIndex 缺席时按 0 兜底。
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

/**
 * 活动块 fold-line 派生（specs/tui-activity-block.md）：把
 * `deriveActivityBlocks` 的块标题按 messageIndex 路由到 MessageRow，
 * 同一 messageIndex 多块按 contentBlockIndex 升序消费。
 *
 * 关键映射（per-message，**不**跨消息合并 — spec S5）：
 *  - 块锚点 (messageIndex, contentBlockIndex) → messageIndex 直接匹配，
 *    不再走 `orderedTurnActivitySegments` 的跨消息合并（那是旧 unit fold 合同）。
 *  - 同 messageIndex 拆出多块时按 contentBlockIndex 升序配对 fold-line 行号。
 *  - 没有匹配 messageIndex 的块（live 思考块、live 工具簇块）落入
 *    `unanchoredBlocks`，由 ChatView 转给 TranscriptTail 渲染。
 *
 * 不变式：
 *  - 块标题文本 = `ActivityBlock.title`（`formatToolUseCounts` 单源，不另拼）；
 *  - 块覆盖的 thinkingMs 进 `shownThinkingMsValues`，hideThinking 双门用之；
 *  - 旧 `foldLinesBySegmentIndex`（unit fold 行）由 caller 单独合并使用。
 */
export interface ActivityBlockFoldDerivation {
  /** messageIndex（visible）→ 块标题行（多块时多行，按 contentBlockIndex 升序）。 */
  readonly foldLineMapByMessage: ReadonlyMap<number, ReadonlyArray<string>>;
  /** 块覆盖的 thinkingMs 值集合（hideThinking 用）。 */
  readonly shownThinkingMsValues: ReadonlySet<number>;
  /** 未匹配到任何 messageIndex 的块（live 块）—— tail 用。 */
  readonly unanchoredBlocks: ReadonlyArray<ActivityBlock>;
  /** T5（spec S2–S4）：messageIndex（visible）→ 槽预览文本数组（多块时多
   *  行，按 contentBlockIndex 升序）。`null` = 该块无预览行（settled 块
   *  slot.kind === "none"、或思考槽），renderer 跳过该块不画预览；非 null
   *  才在块标题下画一行 dim 当前预览。 */
  readonly slotPreviewsByMessage: ReadonlyMap<
    number,
    ReadonlyArray<string | null>
  >;
}

/**
 * 主函数：纯派生 —— 见模块头注释。
 *
 * 入参 = `deriveActivityBlocks` 同形态。返回的 `foldLineMapByMessage`
 * 按 messageIndex（visible 平铺下标）索引，每个 messageIndex 多块按
 * contentBlockIndex 升序消费，每块一行标题。
 */
export function buildActivityBlockFoldLines(args: {
  readonly messages: ReadonlyArray<AnthropicNativeMessage>;
  readonly visibleStart?: number;
  readonly visibleCount: number;
  readonly thinkingMsAtVisible: (visibleIndex: number) => number;
  readonly liveRuns?: ReadonlyArray<LiveToolRun>;
  readonly liveThinking?: boolean;
  readonly inFoldCountOf?: ActivityBlockInput["inFoldCountOf"];
}): ActivityBlockFoldDerivation {
  const { messages } = args;
  const blocks = deriveActivityBlocks({
    messages,
    start: args.visibleStart,
    thinkingMsAtVisible: args.thinkingMsAtVisible,
    liveRuns: args.liveRuns,
    liveThinking: args.liveThinking,
    inFoldCountOf: args.inFoldCountOf,
  });
  // 按 messageIndex 分组，按 contentBlockIndex 升序排（活动块的 contentBlockIndex
  // = cluster 首块的下标）。
  const byMessage = new Map<
    number,
    Array<{
      readonly contentBlockIndex: number;
      readonly title: string;
      readonly slotText: string | null;
    }>
  >();
  const shownThinkingMsValues = new Set<number>();
  const unanchoredBlocks: ActivityBlock[] = [];

  for (const block of blocks) {
    if (block.anchor.messageIndex >= args.visibleCount) {
      // EXIT: 盘上下标 ≥ visibleCount → live 块（未提交相），落 tail。
      unanchoredBlocks.push(block);
      continue;
    }
    const arr = byMessage.get(block.anchor.messageIndex) ?? [];
    arr.push({
      contentBlockIndex: block.anchor.contentBlockIndex,
      title: block.title,
      slotText: block.slot.kind === "tool-preview" ? block.slot.text : null,
    });
    byMessage.set(block.anchor.messageIndex, arr);
    const ms = args.thinkingMsAtVisible(block.anchor.messageIndex);
    if (ms > 0) shownThinkingMsValues.add(ms);
  }
  // 排序 + 转只读。
  const foldLineMapByMessage = new Map<number, ReadonlyArray<string>>();
  const slotPreviewsByMessage = new Map<number, ReadonlyArray<string | null>>();
  for (const [mi, list] of byMessage) {
    list.sort((a, b) => a.contentBlockIndex - b.contentBlockIndex);
    foldLineMapByMessage.set(
      mi,
      list.map((entry) => entry.title)
    );
    slotPreviewsByMessage.set(
      mi,
      list.map((entry) => entry.slotText)
    );
  }

  return {
    foldLineMapByMessage,
    shownThinkingMsValues,
    unanchoredBlocks,
    slotPreviewsByMessage,
  };
}
