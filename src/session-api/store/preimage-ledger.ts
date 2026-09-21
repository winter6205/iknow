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
