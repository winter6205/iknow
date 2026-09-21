/**
 * Preimage ledger — process-memory host accumulator (ADR-0036).
 *
 * Mirrors `LastReadLedgerHost`: keyed by conversationId, never persisted
 * (resume / restart → empty), so a lost entry just means the next commit finds
 * nothing to stamp for that `tool_use_id` — never a wrong stamp.
 *
 * Lifecycle spans a single turn's write → commit window: the injected
 * `PreimageCapture` records an entry the moment a workspace write is about to
 * land, and the commit closure pulls exactly the ids present in the batch it is
 * appending with `consume`. A wave that captures several writes before committing
 * them one-by-one still stamps each — `consume` removes only the ids in that
 * batch, not the whole bucket. Entries for writes that never reach a committed
 * `tool_result` (cancelled mid-tool) linger harmlessly until `clear` on reset;
 * `tool_use_id` is unique per call, so a lingering entry can never mis-stamp.
 */
import type { AnthropicNativeMessage } from "../../harness/index.js";
import type { PreimageRef } from "./jsonl.js";

export interface PreimageLedgerHost {
  /** Record one preimage under (conversationId, toolUseId). Same id → last
   *  write wins (a re-capture before commit replaces the prior ref). */
  readonly set: (
    conversationId: string,
    toolUseId: string,
    ref: PreimageRef
  ) => void;
  /** Pull and remove the refs for `toolUseIds` that are pending under this
   *  conversation. Returns only the found subset (empty when none match). */
  readonly consume: (
    conversationId: string,
    toolUseIds: Iterable<string>
  ) => Map<string, PreimageRef>;
  /** Drop every pending ref for a conversation (reset / teardown). */
  readonly clear: (conversationId: string) => void;
}

export function createPreimageLedger(): PreimageLedgerHost {
  const byConv = new Map<string, Map<string, PreimageRef>>();
  const host: PreimageLedgerHost = {
    set: (conversationId, toolUseId, ref) => {
      let bucket = byConv.get(conversationId);
      if (bucket === undefined) {
        bucket = new Map();
        byConv.set(conversationId, bucket);
      }
      bucket.set(toolUseId, ref);
    },
    consume: (conversationId, toolUseIds) => {
      const bucket = byConv.get(conversationId);
      const out = new Map<string, PreimageRef>();
      if (bucket === undefined) return out;
      for (const id of toolUseIds) {
        const ref = bucket.get(id);
        if (ref !== undefined) {
          out.set(id, ref);
          bucket.delete(id);
        }
      }
      if (bucket.size === 0) byConv.delete(conversationId);
      return out;
    },
    clear: (conversationId) => {
      byConv.delete(conversationId);
    },
  };
  return Object.freeze(host);
}

/**
 * Commit-side drain: pull exactly the refs whose `tool_use_id` appears in this
 * batch's `tool_result` blocks. Shared by every ledger owner (parent hub,
 * chat commit hook, worker transcript) so the three drains cannot drift apart.
 * Undefined when nothing is pending for the batch — the caller then appends
 * without the `preimages` key, byte-identical to the pre-capture shape.
 */
export function drainPreimageRefs(
  ledger: PreimageLedgerHost | undefined,
  key: string,
  events: ReadonlyArray<AnthropicNativeMessage>
): ReadonlyMap<string, PreimageRef> | undefined {
  if (ledger === undefined) return undefined;
  const toolUseIds: string[] = [];
  for (const message of events) {
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (block.type === "tool_result") toolUseIds.push(block.tool_use_id);
    }
  }
  if (toolUseIds.length === 0) return undefined;
  const consumed = ledger.consume(key, toolUseIds);
  return consumed.size > 0 ? consumed : undefined;
}
