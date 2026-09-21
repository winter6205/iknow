/**
 * src/tui/tool-result-index.ts
 *
 * Incremental tool_use_id → status/text index. ChatView previously rebuilt
 * `toolResultStatusMap` / `toolResultTextMap` over the whole transcript
 * every time the messages array reference changed (turn end, echo, compact,
 * rewind). The transcript is append-mostly and every message object is
 * immutable, so the derivation can be maintained incrementally: reuse the
 * longest reference-identical prefix and scan only the appended tail.
 *
 * Contracts:
 *  - the maps must stay byte-equivalent to the full-build oracle functions in
 *    tool-summary.ts (same pairing, same last-wins for duplicate ids, same
 *    empty-content skip); the text extraction itself is the *same function*
 *    (`toolResultTextOf`), so the equivalence is structural;
 *  - `toolUseIds` matches `toolUseIdsOf` exactly: assistant-role tool_use
 *    only (same role guard);
 *  - when an append adds no tool-relevant block, the returned index reuses
 *    the previous map/set references — MessageBlocks' memo shallow-compare
 *    depends on that stability;
 *  - any non-append divergence (mid-list change, truncation, head
 *    replacement — compact / rewind shapes) falls back to a full rebuild:
 *    correctness first, incremental is an optimization only for appends;
 *  - authoritative messages are never spliced or rewritten here — this
 *    module is a read-side index.
 */
import type { AnthropicNativeMessage } from "../harness/model-adapter/types.js";
import { toolResultTextOf } from "./tool-summary.js";

export interface TranscriptToolIndex {
  /** The exact messages array this index was synced against (identity anchor). */
  readonly source: ReadonlyArray<AnthropicNativeMessage>;
  readonly statusMap: ReadonlyMap<string, boolean>;
  readonly resultTextMap: ReadonlyMap<string, string>;
  /** All assistant tool_use ids in the transcript (tail-run dedup source). */
  readonly toolUseIds: ReadonlySet<string>;
}

interface MutableIndex {
  readonly status: Map<string, boolean>;
  readonly text: Map<string, string>;
  readonly ids: Set<string>;
}

function scanInto(
  index: MutableIndex,
  messages: ReadonlyArray<AnthropicNativeMessage>,
  from: number
): void {
  for (let i = from; i < messages.length; i++) {
    const message = messages[i];
    if (message === undefined || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (block.type === "tool_result") {
        index.status.set(block.tool_use_id, block.is_error === true);
        const text = toolResultTextOf(block.content);
        if (text !== null) index.text.set(block.tool_use_id, text);
      } else if (block.type === "tool_use" && message.role === "assistant") {
        // Same role guard as `toolUseIdsOf`: a tool_use block outside an
        // assistant message is malformed and must not enter the id set.
        index.ids.add(block.id);
      }
    }
  }
}

function hasToolBlocksFrom(
  messages: ReadonlyArray<AnthropicNativeMessage>,
  from: number
): boolean {
  for (let i = from; i < messages.length; i++) {
    const message = messages[i];
    if (message === undefined || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (block.type === "tool_result" || block.type === "tool_use") {
        return true;
      }
    }
  }
  return false;
}

function referencePrefixLength(
  prev: ReadonlyArray<AnthropicNativeMessage>,
  next: ReadonlyArray<AnthropicNativeMessage>
): number {
  const limit = Math.min(prev.length, next.length);
  let i = 0;
  while (i < limit && prev[i] === next[i]) i++;
  return i;
}

function buildFresh(
  messages: ReadonlyArray<AnthropicNativeMessage>,
  from: number
): MutableIndex {
  const index: MutableIndex = {
    status: new Map(),
    text: new Map(),
    ids: new Set(),
  };
  scanInto(index, messages, from);
  return index;
}

/**
 * Sync the index against a (possibly new) messages array. `prev === null`
 * (or a non-append divergence) rebuilds from scratch; a pure append scans
 * only the tail and may even keep the previous map references when the tail
 * carries no tool blocks.
 */
export function syncToolIndex(
  prev: TranscriptToolIndex | null,
  messages: ReadonlyArray<AnthropicNativeMessage>
): TranscriptToolIndex {
  if (prev !== null && prev.source === messages) return prev; // EXIT: unchanged reference
  if (prev !== null) {
    const k = referencePrefixLength(prev.source, messages);
    if (k === prev.source.length) {
      // pure append: old prefix entries are already indexed
      if (!hasToolBlocksFrom(messages, k)) {
        return {
          source: messages,
          statusMap: prev.statusMap,
          resultTextMap: prev.resultTextMap,
          toolUseIds: prev.toolUseIds,
        };
      }
      const index: MutableIndex = {
        status: new Map(prev.statusMap),
        text: new Map(prev.resultTextMap),
        ids: new Set(prev.toolUseIds),
      };
      scanInto(index, messages, k);
      return {
        source: messages,
        statusMap: index.status,
        resultTextMap: index.text,
        toolUseIds: index.ids,
      };
    }
  }
  const index = buildFresh(messages, 0);
  return {
    source: messages,
    statusMap: index.status,
    resultTextMap: index.text,
    toolUseIds: index.ids,
  };
}
