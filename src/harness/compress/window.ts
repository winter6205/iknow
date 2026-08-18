// Q1/Q2/Q5 决议:纯丢弃 + 边界占位符,immutable 重建,tool 配对完整
import {
  COMPACTION_BOUNDARY_PLACEHOLDER,
  DEFAULT_KEEP_RECENT,
} from "./constant.js";
import type {
  AnthropicContentBlock,
  AnthropicNativeMessage,
} from "../model-adapter/types.js";

/**
 * 从末尾保留 keepRecent 条并向前修补边界,确保 tool_use↔tool_result 配对完整。
 *
 * #467 step 2:导出供 `full-compact.splitForCompaction` 复用同一 tool-pair
 * 守门(proactive / reactive / 手动 compress 共用同一份"丢弃前缀 + 配对补全"
 * 不变式)。新导出是 additive,既有 `compactMessages` 行为字节级稳定。
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
 * 滑动窗口压缩 messages:保留尾部 keepRecent 条 + 配对补全,
 * 前面丢弃,以边界占位符单消息替代。
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
