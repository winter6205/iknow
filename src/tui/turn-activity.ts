/**
 * src/tui/turn-activity.ts
 *
 * 当前 turn 的工具折叠摘要（纯函数）。ChatView 在 idle 时把「本 turn 里
 * 每个工具调用了几次」收成一行，避免结束后仍铺开每一条 `[完成] bash · …`。
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
 */
export function countToolUsesByName(
  messages: ReadonlyArray<AnthropicNativeMessage>
): ReadonlyArray<ToolUseCount> {
  const order: string[] = [];
  const map = new Map<string, number>();
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const block of message.content) {
      if (block.type !== "tool_use") continue;
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
 * idle 折叠行。seconds≤0 且无工具 → 空串（不画「思考了 0 秒」、不换 `[思考]`）。
 * 有工具无秒数 → 只计数；有秒数 → `思考了 N 秒` + 计数。
 */
export function formatTurnActivityFold(
  seconds: number | undefined,
  entries: ReadonlyArray<ToolUseCount>
): string {
  const counts = formatToolUseCounts(entries);
  const think = formatThinkingFold(seconds);
  if (think.length === 0 && counts.length === 0) return "";
  if (think.length === 0) return counts;
  if (counts.length === 0) return think;
  return `${think} · ${counts}`;
}
