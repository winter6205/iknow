/**
 * src/tui/turn-activity.ts
 *
 * Derives the activity segments of the current turn (pure functions), feeding
 * segment / count shapes to `deriveActivityBlocks` and MessageRow. The
 * `unit fold` line (`Thought for … · name × N`) is no longer derived here —
 * activity-block.ts owns it, and the activity-block list is the single source
 * for folding / previewing.
 *
 * The turn boundary shares its rule with `isTurnQuery`: from the last user
 * query without a tool_result to the end of the session (tool_result user
 * messages in between included).
 */
import type { AnthropicNativeMessage } from "../harness/model-adapter/types.js";
import { isTurnQuery } from "../session-api/turn-projection.js";

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
   * The fold-count line aggregates only tool_use calls for which this
   * predicate returns true (success and retract). An absent resolver counts
   * everything (the pure-function fallback matches the count helpers);
   * production callers pass a decision derived from
   * `deriveSlot(name, {running, failed})`, with failures sourced from
   * `toolResultStatusMap`.
   */
  readonly inFoldCountOf?: (
    call: Readonly<{ readonly id: string; readonly name: string }>
  ) => boolean;
}

/**
 * Message-level order of assistant activity: text segments and runs of
 * consecutive tool_use clusters are returned in original message order.
 * thinking / tool_result / user query occupy no activity segment; tool_result
 * does not break a run of tool clusters, so one round of tool calls still
 * renders exactly one in-place fold.
 *
 * Entries aggregate only tool_use calls for which `opts.inFoldCountOf`
 * returns true (success and retract); kept / accent / failed calls are not
 * counted (the renderer draws their own title lines). An absent resolver
 * counts everything.
 */
export function orderedTurnActivitySegments(
  messages: ReadonlyArray<AnthropicNativeMessage>,
  start: number,
  opts?: TurnActivityOptions
): ReadonlyArray<TurnActivitySegment> {
  if (!Number.isFinite(start) || start < 0 || start >= messages.length) {
    // EXIT: An invalid or out-of-range turn start must not treat history as current activity.
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
      // Turn boundary = user query (isTurnQuery): flush the current tool
      // cluster as soon as the next user query appears — tool_use across
      // turns never merges into one cluster (each turn folds separately),
      // while multiple tool_use runs within the same turn still merge.
      if (message.role === "user" && isTurnQuery(message)) {
        flushTools();
        continue;
      }
      if (message.role !== "assistant") continue;
      if (!Array.isArray(message.content)) {
        // EXIT: Non-array content cannot safely participate in the ordered activity projection.
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
    // EXIT: Malformed messages have no derivable stable order; render no fold, safely.
    return [];
  }
}

/** Index of the last turn query; no query → -1. */
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

/** Slice from `start` (inclusive) to the end; start < 0 or out of range → empty array (a missing query must not mean the whole history). */
export function sliceTurnFrom(
  messages: ReadonlyArray<AnthropicNativeMessage>,
  start: number
): ReadonlyArray<AnthropicNativeMessage> {
  if (start < 0 || start >= messages.length) return [];
  return messages.slice(start);
}

/**
 * Count assistant `tool_use` by first-appearance order. Non-assistant /
 * non-tool_use blocks are ignored. Counts clamp to ≥0 (an empty name still
 * counts once so no call is lost). When `opts.inFoldCountOf` is provided only
 * calls it accepts are counted (success and retract) — the same resolver
 * contract as `orderedTurnActivitySegments`; absent = count everything.
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

/** Set of assistant `tool_use` ids in this slice (for deduping live counts). */
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
 * Count by name; skip calls whose id is in `excludeIds` (live entries already
 * counted in history must not double-count). An empty name still counts once.
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

/** Formats as `bash × 2 · write_file × 1`; empty list → empty string (no leading separator). */
export function formatToolUseCounts(
  entries: ReadonlyArray<ToolUseCount>
): string {
  if (entries.length === 0) return "";
  return entries
    .filter((e) => e.count > 0)
    .map((e) => `${e.name} × ${e.count}`)
    .join(" · ");
}

/** ms → seconds (rounded up so 250ms still shows as 1s). */
export function thinkingMsToSeconds(ms: number): number {
  if (!Number.isFinite(ms) || ms <= 0) return 0;
  return Math.ceil(ms / 1000);
}
