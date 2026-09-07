/**
 * src/tui/turn-activity.ts
 *
 * 当前 turn 的工具折叠摘要（纯函数）。ChatView 把「本 turn 里每个工具
 * 调用了几次」收成一行（idle 与 running 在已有完成工具时共用），避免
 * 旧的逐条 `[思考]` / `[完成] bash` 与 turn 级折叠叠在一起。
 * 结束态两行：先 `思考了 N 秒`，下一行工具计数 `bash × N`。
 *
 * turn 边界与 `isTurnQuery` 同源：最后一条无 tool_result 的 user query
 * 起到会话末尾（含中间 tool_result user 消息）。
 */
import type { AnthropicNativeMessage } from "../harness/model-adapter/types.js";
import { isTurnQuery } from "../session-api/turn-projection.js";
import { formatThinkingFold } from "./think-fold.js";

export interface ToolUseCount {
  readonly name: string;
  readonly count: number;
}

export type TurnActivitySegment =
  | {
      readonly kind: "text";
      readonly messageIndex: number;
      readonly contentBlockIndex: number;
    }
  | {
      readonly kind: "tools";
      readonly messageIndex: number;
      readonly contentBlockIndex: number;
      readonly entries: ReadonlyArray<ToolUseCount>;
    };

export interface TurnActivityOptions {
  /**
   * D3（spec specs/tui-tool-settled-appearance.md）：折叠计数行只聚合本判定
   * 为 true 的 tool_use（成功且 retract）。resolver 缺省 = 全部计入（纯函数
   * 兜底与计数助手一致）；生产调用方传 `deriveSlot(name, {running, failed})`
   * 派生的判定，failed 数据源 = `toolResultStatusMap`。
   */
  readonly inFoldCountOf?: (
    call: Readonly<{ readonly id: string; readonly name: string }>
  ) => boolean;
}

/**
 * assistant 活动的消息级顺序：文本段与连续 tool_use 集群按原始消息顺序
 * 返回。thinking / tool_result / user query 不占活动段；tool_result 不打断
 * 连续工具集群，因而一轮工具调用仍只画一个原位折叠。
 *
 * D3：entries 只聚合 `opts.inFoldCountOf` 判定为 true 的 tool_use（成功且
 * retract）；留 / 点名 / 失败件不进计数（它们由渲染层画独立标题行）。
 * resolver 缺省 = 全部计入。
 */
export function orderedTurnActivitySegments(
  messages: ReadonlyArray<AnthropicNativeMessage>,
  start: number,
  opts?: TurnActivityOptions
): ReadonlyArray<TurnActivitySegment> {
  if (!Number.isFinite(start) || start < 0 || start >= messages.length) {
    // EXIT: 无效或越界的 turn 起点不应把历史消息误当作当前活动。
    return [];
  }
  const inFoldCountOf = opts?.inFoldCountOf;

  try {
    const segments: TurnActivitySegment[] = [];
    const toolOrder: string[] = [];
    const toolCounts = new Map<string, number>();
    let toolMessageIndex: number | undefined;
    let toolContentBlockIndex: number | undefined;

    const flushTools = (): void => {
      if (toolMessageIndex === undefined) return;
      if (toolContentBlockIndex === undefined) return;
      segments.push({
        kind: "tools",
        messageIndex: toolMessageIndex,
        contentBlockIndex: toolContentBlockIndex,
        entries: toolOrder.map((name) => ({
          name,
          count: toolCounts.get(name) ?? 0,
        })),
      });
      toolOrder.length = 0;
      toolCounts.clear();
      toolMessageIndex = undefined;
      toolContentBlockIndex = undefined;
    };

    for (let i = Math.trunc(start); i < messages.length; i++) {
      const message = messages[i];
      if (message === undefined) continue;
      // D3 (tui-display-consistency):turn 边界 = user query (isTurnQuery);
      // 切到下一条 user query 时立即 flush 当前 tool 簇 —— 跨轮 tool_use
      // 不再合到同簇(每轮各自折叠),但同一 turn 内的多段 tool_use 仍合并。
      if (message.role === "user" && isTurnQuery(message)) {
        flushTools();
        continue;
      }
      if (message.role !== "assistant") continue;
      if (!Array.isArray(message.content)) {
        // EXIT: 非数组 content 无法安全参与有序活动投影。
        continue;
      }
      for (const [contentBlockIndex, block] of message.content.entries()) {
        if (block.type === "text" && block.text.trim().length > 0) {
          flushTools();
          segments.push({
            kind: "text",
            messageIndex: i,
            contentBlockIndex,
          });
        } else if (block.type === "tool_use") {
          if (toolMessageIndex === undefined) {
            toolMessageIndex = i;
            toolContentBlockIndex = contentBlockIndex;
          } else if (toolMessageIndex !== i) {
            // Keep the legacy cross-message cluster count and anchor the
            // fold to the first tool in the latest assistant message.
            toolMessageIndex = i;
            toolContentBlockIndex = contentBlockIndex;
          }
          if (inFoldCountOf !== undefined && !inFoldCountOf(block)) continue;
          if (!toolCounts.has(block.name)) toolOrder.push(block.name);
          toolCounts.set(block.name, (toolCounts.get(block.name) ?? 0) + 1);
        }
      }
    }
    flushTools();
    return segments;
  } catch {
    // EXIT: 异常消息形态没有可推导的稳定顺序，安全地不渲染折叠。
    return [];
  }
}

/** 最后一条 turn query 的下标；没有 query → -1。 */
export function lastTurnQueryIndex(
  messages: ReadonlyArray<AnthropicNativeMessage>
): number {
  let idx = -1;
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (message !== undefined && isTurnQuery(message)) idx = i;
  }
  return idx;
}

/** 从 `start`（含）切到末尾；start < 0 或越界 → 空数组（无 query 不当成全历史）。 */
export function sliceTurnFrom(
  messages: ReadonlyArray<AnthropicNativeMessage>,
  start: number
): ReadonlyArray<AnthropicNativeMessage> {
  if (start < 0 || start >= messages.length) return [];
  return messages.slice(start);
}

/**
 * assistant `tool_use` 按首次出现顺序计数。非 assistant / 非 tool_use 忽略。
 * count 钳到 ≥0（名字空串仍计一次，避免丢调用）。
 * D3：`opts.inFoldCountOf` 提供时只计数判定为 true 的件（成功且 retract），
 * 与 `orderedTurnActivitySegments` 同一 resolver 契约；缺省 = 全部计入。
 */
export function countToolUsesByName(
  messages: ReadonlyArray<AnthropicNativeMessage>,
  opts?: TurnActivityOptions
): ReadonlyArray<ToolUseCount> {
  const order: string[] = [];
  const map = new Map<string, number>();
  const inFoldCountOf = opts?.inFoldCountOf;
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const block of message.content) {
      if (block.type !== "tool_use") continue;
      if (inFoldCountOf !== undefined && !inFoldCountOf(block)) continue;
      const name = block.name;
      if (!map.has(name)) order.push(name);
      map.set(name, (map.get(name) ?? 0) + 1);
    }
  }
  return order.map((name) => ({
    name,
    count: Math.max(0, map.get(name) ?? 0),
  }));
}

/** 本切片里 assistant `tool_use` id 集合（live 计数去重用）。 */
export function toolUseIdsOf(
  messages: ReadonlyArray<AnthropicNativeMessage>
): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const block of message.content) {
      if (block.type === "tool_use") ids.add(block.id);
    }
  }
  return ids;
}

/**
 * 按 name 计数；`excludeIds` 命中则跳过（历史已计入的 live 条目不双计）。
 * 空 name 仍计一次。
 */
export function countNamedCalls(
  calls: ReadonlyArray<{ readonly id: string; readonly name: string }>,
  excludeIds: ReadonlySet<string>
): ReadonlyArray<ToolUseCount> {
  const order: string[] = [];
  const map = new Map<string, number>();
  for (const call of calls) {
    if (excludeIds.has(call.id)) continue;
    if (!map.has(call.name)) order.push(call.name);
    map.set(call.name, (map.get(call.name) ?? 0) + 1);
  }
  return order.map((name) => ({
    name,
    count: Math.max(0, map.get(name) ?? 0),
  }));
}

/** primary 名顺序优先，extra 新名接在后面；count 相加。 */
export function mergeToolUseCounts(
  primary: ReadonlyArray<ToolUseCount>,
  extra: ReadonlyArray<ToolUseCount>
): ReadonlyArray<ToolUseCount> {
  const order: string[] = [];
  const map = new Map<string, number>();
  for (const group of [primary, extra]) {
    for (const entry of group) {
      if (entry.count <= 0) continue;
      if (!map.has(entry.name)) order.push(entry.name);
      map.set(entry.name, (map.get(entry.name) ?? 0) + entry.count);
    }
  }
  return order.map((name) => ({
    name,
    count: map.get(name) ?? 0,
  }));
}

/** `bash × 2 · write_file × 1`；空列表 → 空串（无前导分隔符）。 */
export function formatToolUseCounts(
  entries: ReadonlyArray<ToolUseCount>
): string {
  if (entries.length === 0) return "";
  return entries
    .filter((e) => e.count > 0)
    .map((e) => `${e.name} × ${e.count}`)
    .join(" · ");
}

/**
 * idle 折叠行。seconds≤0 且无工具 → 空数组。
 * 有秒数 → 先一行 `思考了 N 秒`；有工具 → 下一行计数（不拼进同一行）。
 */
export function formatTurnActivityFold(
  seconds: number | undefined,
  entries: ReadonlyArray<ToolUseCount>
): ReadonlyArray<string> {
  const counts = formatToolUseCounts(entries);
  const think = formatThinkingFold(seconds);
  const lines: string[] = [];
  if (think.length > 0) lines.push(think);
  if (counts.length > 0) lines.push(counts);
  return lines;
}

/**
 * D3 (tui-display-consistency):折叠簇内 assistant 消息的 thinkingMs 求和（ms）。
 *
 * 输入：落盘的 thinkingMs 并行数组 + 折叠簇要计入的 messageIndex 列表
 * （有序、可重复 —— 与 `orderedTurnActivitySegments` 的 anchor messageIndex
 * 配套使用）。
 *
 * 边界形态（spec D2/D3 钉死）：
 *  - `null` 元素按 0 计入（非流式回合 / 该事件无 thinkingMs）；
 *  - `thinkingMs` undefined（整个 key 缺席 = 整链无 thinkingMs / 旧会话）→ 全 0；
 *  - 索引越界（数组长度 < max(indices)+1）→ 该位置按 0 计入；
 *  - 非有限数 / `<= 0`（理论上 appendEvents 已过滤，但 consumer 再做防御）→ 0。
 *
 * 输出：簇内 assistant 消息的 thinkingMs 累加值（毫秒）。调用方除以 1000 取秒。
 */
export function sumThinkingMsInRange(
  thinkingMs: ReadonlyArray<number | null> | undefined,
  messageIndices: ReadonlyArray<number>
): number {
  if (thinkingMs === undefined) return 0;
  if (messageIndices.length === 0) return 0;
  let total = 0;
  for (const index of messageIndices) {
    if (!Number.isInteger(index) || index < 0) continue;
    const value = thinkingMs[index];
    if (value === null || value === undefined) continue;
    if (!Number.isFinite(value) || value <= 0) continue;
    total += value;
  }
  return total;
}

/** ms → 秒（向上取整，确保 250ms 显示成 1 秒）。 */
export function thinkingMsToSeconds(ms: number): number {
  if (!Number.isFinite(ms) || ms <= 0) return 0;
  return Math.ceil(ms / 1000);
}

/**
 * 思考秒数折叠行（`思考了 N 秒`）显示判定 —— plans/tui-chrome-interaction.md T1：
 * running 态不阻止冻结的思考秒数渲染。fold by **completed unit**，不等整
 * turn idle：live thinking 一旦结束（final commit 写入落盘 thinkingMs），
 * 「思考了 N 秒」立刻可见，即便 tools 仍在 running。
 *
 * 不变式 = 决策只看 frozen thinkingMs（hasThinkingMs 派生自
 * session.thinkingMs[anchor] > 0），与 running 解耦 —— running 只用于
 * 渲染层决定是否同时显示 live thinking 面板，**不**用于压住已冻结行。
 */
export function shouldShowThinkingFold(opts: {
  readonly running: boolean;
  readonly hasThinkingMs: boolean;
}): boolean {
  return opts.hasThinkingMs;
}

/**
 * retract 计数行（`read_file × N` 等）显示判定 —— 同 T1：retract 一旦
 * 落定（live 已完成 或历史 tool_result 已配对），立刻进入折叠行，不等
 * 整 turn idle；turn 仍在 running 也不阻止渲染。
 */
export function shouldShowRetractFold(opts: {
  readonly running: boolean;
  readonly segmentRetractTotal: number;
}): boolean {
  return opts.segmentRetractTotal > 0;
}

/**
 * tail 折叠判定：折叠行在场 + 当前 turn 有 retract → 藏掉 tail 里已完成
 * retract 行（避免 double-render）。running 不再是「保持展开」的硬理由：
 * 一旦 retract 收成计数行,即便 turn 仍在 running,完成态 retract 不应
 * 同时出现在 tail 与折叠行。
 */
export function shouldCollapseTurnToolRows(
  running: boolean,
  foldLineCount: number,
  turnToolTotal: number
): boolean {
  // running 参数保留以备未来扩展；当前折叠条件与 running 解耦（T1）。
  void running;
  return foldLineCount > 0 && turnToolTotal > 0;
}

/**
 * 旧整-turn 闸门 —— plans/tui-chrome-interaction.md T1 删除：
 *  - 不再一刀切按 running 压制整轮折叠（隐藏历史 retract folds）；
 *  - 不再按 `turnToolTotal === 0` 一刀切（折叠按已完成单元判定）。
 *
 * 保留作为 helper：当前 turn 的 retract 行数 = 0 时整轮不渲染任何
 * 当前-turn 折叠行（既无思考行又无计数行）。多簇历史折叠仍按 per-segment
 * `shouldShowRetractFold` / `shouldShowThinkingFold` 各自判定，不受
 * 本函数结果影响。
 */
export function shouldShowTurnActivityFold(opts: {
  readonly running: boolean;
  readonly turnToolTotal: number;
}): boolean {
  // 与 running 解耦：只要当前 turn 有 retract,折叠行就参与判定（具体
  // 行渲染由 per-segment 闸门承担,本函数只决定「当前 turn 折叠行
  // 是否启用」,即 `foldDisplayLines` 是否参与 tail 折叠判定）。
  void opts.running;
  return opts.turnToolTotal > 0;
}
