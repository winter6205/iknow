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
 * A ref that the commit side consumed but cannot stamp is reported through
 * `drainPreimageRefs`' `onUnstampable` — never a silent loss (see that
 * function for the exact coupling).
 */
import type { AnthropicNativeMessage } from "../../harness/index.js";
import { matchCodePreimageId, type PreimageRef } from "./jsonl.js";

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
 * Commit-side drain: consume exactly the refs whose `tool_use_id` appears in
 * this batch's `tool_result` blocks, but return only what the per-event stamp
 * can actually land — the FIRST captured, non-`is_error` match of each event,
 * selected with `matchCodePreimageId`, the same rule the append side stamps
 * with. A consumed ref that cannot land (a parallel write's second ref in one
 * event, a ref whose tool then errored) is handed to `onUnstampable` — never
 * dropped silently, because it will never be stampable again: ids are unique
 * per call. Shared by every ledger owner (parent hub, worker transcript) so
 * the drains cannot drift apart. Undefined when nothing stampable is pending
 * for the batch — the caller then appends without the `preimages` key,
 * byte-identical to the pre-capture shape.
 */
export function drainPreimageRefs(
  ledger: PreimageLedgerHost | undefined,
  key: string,
  events: ReadonlyArray<AnthropicNativeMessage>,
  onUnstampable?: (unstamped: ReadonlyMap<string, PreimageRef>) => void
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
  if (consumed.size === 0) return undefined;
  const stampable = new Map<string, PreimageRef>();
  for (const message of events) {
    if (!Array.isArray(message.content)) continue;
    const id = matchCodePreimageId(message, consumed);
    if (id !== undefined && !stampable.has(id)) {
      stampable.set(id, consumed.get(id)!);
    }
  }
  if (stampable.size < consumed.size) {
    const unstamped = new Map(
      [...consumed].filter(([id]) => !stampable.has(id))
    );
    onUnstampable?.(unstamped);
  }
  return stampable.size > 0 ? stampable : undefined;
}

/** Production `onUnstampable` outlet shared by both commit hosts: one
 *  console.warn line per stranded ref (the codebase's non-blocking
 *  degradation channel) — enough for an operator to see that a captured write
 *  will not be restorable, without a throw inside the commit path. */
export function warnUnstampablePreimages(
  key: string,
  unstamped: ReadonlyMap<string, PreimageRef>
): void {
  for (const [toolUseId, ref] of unstamped) {
    console.warn(
      `[preimage] ${key}: captured ref for ${toolUseId} (${ref.relPath}) ` +
        "cannot land on this batch's events — its write is not restorable"
    );
  }
}
