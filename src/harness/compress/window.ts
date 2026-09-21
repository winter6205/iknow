// Pure drop + boundary placeholder, immutable rebuild, tool pairing kept intact.
import {
  COMPACTION_BOUNDARY_PLACEHOLDER,
  DEFAULT_KEEP_RECENT,
} from "./constant.js";
import type {
  AnthropicContentBlock,
  AnthropicNativeMessage,
} from "../model-adapter/types.js";

/**
 * Keep the last keepRecent messages, repairing the boundary forward so every
 * tool_use↔tool_result pair stays complete.
 *
 * Exported so `full-compact.splitForCompaction` can reuse the same tool-pair
 * guard (proactive / reactive / manual compaction share one "drop prefix +
 * complete pairs" invariant). The new export is additive; existing
 * `compactMessages` behavior is byte-stable.
 */
export function preserveToolPairs(
  messages: ReadonlyArray<AnthropicNativeMessage>,
  keepRecent: number
): { kept: ReadonlyArray<AnthropicNativeMessage>; slicedFrom: number } {
  if (messages.length === 0 || messages.length <= keepRecent) {
    return { kept: messages, slicedFrom: 0 };
  }

  let earliestIndex = messages.length - keepRecent;
  const requiredToolUses = new Set<string>();
  for (let i = earliestIndex; i < messages.length; i++) {
    const message = messages[i];
    if (!message) continue;
    for (const block of message.content) {
      if (block.type === "tool_result") requiredToolUses.add(block.tool_use_id);
    }
  }
  for (let i = earliestIndex - 1; i >= 0 && requiredToolUses.size > 0; i--) {
    const message = messages[i];
    if (!message) continue;
    for (const block of message.content) {
      const candidate: AnthropicContentBlock = block;
      if (
        candidate.type === "tool_use" &&
        requiredToolUses.delete(candidate.id)
      ) {
        earliestIndex = i;
      }
    }
  }

  const kept = messages.slice(earliestIndex);
  const toolResultIds = new Set<string>();
  for (const message of kept) {
    for (const block of message.content) {
      if (block.type === "tool_result") toolResultIds.add(block.tool_use_id);
    }
  }
  for (const message of kept) {
    for (const block of message.content) {
      if (block.type === "tool_use" && !toolResultIds.has(block.id)) {
        throw new Error(
          `tool_use ${block.id} missing tool_result after compaction`
        );
      }
    }
  }
  return { kept, slicedFrom: earliestIndex };
}

/**
 * Sliding-window compaction of messages: keep the tail of keepRecent
 * messages + pair repair, drop the head, replaced by a single boundary
 * placeholder message.
 */
export function compactMessages(
  messages: ReadonlyArray<AnthropicNativeMessage>,
  keepRecent: number = DEFAULT_KEEP_RECENT
): ReadonlyArray<AnthropicNativeMessage> {
  const safe = preserveToolPairs(messages, keepRecent);
  if (safe.slicedFrom === 0) return messages;
  return [
    {
      role: "user",
      content: [{ type: "text", text: COMPACTION_BOUNDARY_PLACEHOLDER }],
    },
    ...safe.kept,
  ];
}
