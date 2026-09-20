/**
 * Checkpoint data layer — turn boundary projection, persistence predicate,
 * checkpoint appender, and rewind anchor resolution.
 *
 * Pure functions, no IO. Shared by:
 *   - checkpoint (interrupt persist): hub.conditionalSave asks
 *     `decideCheckpointPersist(result, priorMessages)` for one of three
 *     outcomes (none / full / partial_user_only) and appends a
 *     CheckpointRecord when a cancelled/interrupt turn made progress.
 *   - TUI rewind (rollback): the former `rewindFile` disk truncation is
 *     retired — rewind now MOVES the persisted head pointer to an earlier
 *     user-message anchor and the skipped chain stays in the same JSONL.
 *     `resolveRewindAnchor` computes that anchor (head-chain index +
 *     recomputed turnCount); `withCheckpointAnchors` re-anchors checkpoint
 *     records by event id.
 *
 * Turn-boundary rule (SSOT: turn-projection.ts `isTurnQuery`, shared with
 * hub.ts projectMessagesToTurns): a turn starts at a user message that has NO
 * tool_result block and is NOT a subagent drain summary; user messages that
 * carry only tool_result blocks are continuation, not queries.
 */
import type { AnthropicNativeMessage, RunResult } from "../../harness/index.js";
import { isTurnQuery } from "../turn-projection.js";
import type {
  CheckpointRecord,
  InterruptReason,
  SessionFileV1,
} from "./schema.js";

/**
 * Exclusive end index (within `messages`) of the turn at 0-based ordinal
 * `turnIndex`. Clamped to [0, messages.length] when `turnIndex` is out of
 * range (negative or beyond the available turns). Returns 0 for empty input.
 */
export function turnSliceEnd(
  messages: ReadonlyArray<AnthropicNativeMessage>,
  turnIndex: number
): number {
  if (messages.length === 0) return 0;
  if (turnIndex < 0) return 0;
  const slices = splitTurns(messages);
  if (turnIndex >= slices.length) return messages.length;
  return slices[turnIndex]!.end;
}

/** A turn slice: [start, end) inside the message array. */
export interface TurnSlice {
  readonly start: number;
  readonly end: number;
}

/** Project turn boundaries: one slice per turn-starting user message per the
 *  shared `isTurnQuery` rule (no tool_result block, not a subagent drain
 *  summary — SSOT in turn-projection.ts, same as hub.ts
 *  projectMessagesToTurns). Returns [] when no query message exists (e.g. a
 *  session that starts mid tool-result, which is malformed). */
export function splitTurns(
  messages: ReadonlyArray<AnthropicNativeMessage>
): ReadonlyArray<TurnSlice> {
  const slices: TurnSlice[] = [];
  let nextStart = -1;
  for (let i = 0; i < messages.length; i++) {
    if (!isTurnQuery(messages[i]!)) continue;
    if (nextStart >= 0) {
      slices.push({ start: nextStart, end: i });
    }
    nextStart = i;
  }
  if (nextStart >= 0) {
    slices.push({ start: nextStart, end: messages.length });
  }
  return slices;
}

/**
 * Tri-state persistence decision returned by `decideCheckpointPersist`
 * (protocolError/emptyFinalResponse persist the user message from this
 * turn, not the failed assistant):
 *
 *   - `kind: "none"` — skip save entirely. Covers zero-delta cancels and
 *     protocolError/emptyFinalResponse with no user message this turn
 *     (e.g. /continue mode).
 *   - `kind: "full"` — save the full result.messages (current behavior for
 *     completed / maxTurns / timeout / nonSuccessStop / cancelled-with-delta).
 *   - `kind: "partial_user_only"` — splice ONLY the genuine user queries from
 *     this run's delta onto disk (SSOT `isTurnQuery`: tool_result-only and
 *     subagent-drain user messages are continuation, not queries). The failed
 *     assistant turn is dropped. Used when protocolError/emptyFinalResponse
 *     lands after the engine encoded the user message (postMessage path) but
 *     before / without an assistant reply.
 *
 * Replaces the boolean `shouldPersistCheckpoint` — the user message is now
 * kept on protocolError/emptyFinalResponse.
 */
export type CheckpointPersistDecision =
  | { readonly kind: "none" }
  | { readonly kind: "full" }
  | { readonly kind: "partial_user_only" };

/**
 * Compute the persistence decision for a finished run. `delta` is
 * (result.messages.length - priorMessages.length): only messages THIS run
 * appended count as progress (run() starts from priorMessages and always
 * returns a history that begins with them).
 *
 * Rules:
 *   - cancelled + delta>0 → full persist (progress was made; record a
 *     checkpoint so the interrupted turn is recoverable).
 *   - cancelled + delta==0 → none (no new authoritative messages).
 *   - protocolError / emptyFinalResponse:
 *       * zero user delta (continue-mode or other zero-input path) → none.
 *       * non-zero user delta (postMessage) → partial_user_only; the
 *         assistant turn never enters history; the user message does.
 *   - every other stopReason (completed / maxTurns / timeout / nonSuccessStop)
 *     → full.
 */
export function decideCheckpointPersist(
  result: RunResult,
  priorMessages: ReadonlyArray<AnthropicNativeMessage>
): CheckpointPersistDecision {
  if (result.stopReason === "cancelled") {
    return result.messages.length - priorMessages.length > 0
      ? { kind: "full" }
      : { kind: "none" };
  }
  if (
    result.stopReason === "protocolError" ||
    result.stopReason === "emptyFinalResponse"
  ) {
    const newMessages = result.messages.slice(priorMessages.length);
    // `isTurnQuery` (SSOT, shared with hub projectMessagesToTurns) keeps only
    // genuine user queries: a tool_result-only user message is a continuation,
    // and persisting it alone (its assistant tool_use is dropped) would leave
    // a malformed orphan pair on disk.
    const userDelta = newMessages.filter((m) => isTurnQuery(m));
    return userDelta.length > 0
      ? { kind: "partial_user_only" }
      : { kind: "none" };
  }
  return { kind: "full" };
}

/**
 * Boolean persistence predicate. Still authoritative for two consumers that
 * only need a yes/no verdict and do NOT want the user-kept rule:
 *
 *   - `toTurnDto`'s `interrupted` flag (cancelled-only — the DTO field is
 *     defined against this boolean, so widening it to the tri-state would
 *     change the wire contract for no benefit).
 *   - the `cancelled`-only notice sites in `src/cli/chat-session.ts`, where
 *     this boolean and the tri-state agree by construction.
 *
 * New callers deciding what to write should use `decideCheckpointPersist`
 * (tri-state), which is what both hub.conditionalSave and the chat REPL save
 * path consume.
 *
 *   cancelled + delta>0 → true (unchanged)
 *   protocolError / emptyFinalResponse → false (this predicate does NOT
 *     encode the user-kept rule; callers that need it must use
 *     decideCheckpointPersist).
 *   every other stopReason → true (unchanged)
 */
export function shouldPersistCheckpoint(
  result: RunResult,
  priorMessages: ReadonlyArray<AnthropicNativeMessage>
): boolean {
  if (result.stopReason === "cancelled") {
    return result.messages.length - priorMessages.length > 0;
  }
  if (
    result.stopReason === "protocolError" ||
    result.stopReason === "emptyFinalResponse"
  ) {
    return false;
  }
  return true;
}

/**
 * Map a harness StopReason to the checkpoint label. `process` is reserved for
 * a process-level closeout and has no StopReason source. Returns null for
 * stopReasons that do not produce a checkpoint (completed /
 * emptyFinalResponse / nonSuccessStop).
 */
export function toInterruptReason(
  stopReason: RunResult["stopReason"]
): InterruptReason | null {
  switch (stopReason) {
    case "cancelled":
    case "maxTurns":
    case "protocolError":
    case "timeout":
      return stopReason;
    default:
      return null;
  }
}

/**
 * Append a checkpoint record to a session's `checkpoints` list. Pure — the
 * input session is not mutated. No-op when `record.messagesCount <=
 * session.messages.length` (delta=0 or negative: the record would describe a
 * history prefix already superseded, e.g. after a compactSession shrank
 * messages).
 *
 * Cumulative turnCount is computed by the CALLER and baked into
 * `record.turnIndex` (mirror of hub.ts `session.turnCount +
 * result.turnCount`); this function only appends.
 */
export function appendCheckpoint(
  session: SessionFileV1,
  record: CheckpointRecord
): SessionFileV1 {
  if (record.messagesCount <= session.messages.length) {
    return session;
  }
  const existing = session.checkpoints ?? [];
  return {
    ...session,
    checkpoints: [...existing, record],
  };
}

/**
 * Resolve the rewind target for `keepTurns` — the head-chain index of the
 * last kept message plus the recomputed turnCount. Pure.
 * Replaces the retired disk truncation: the store moves the persisted head
 * pointer to `chain[headIndex]` (null when -1) instead of slicing messages
 * off disk, so the skipped chain stays in the same JSONL.
 *
 * The anchor always lands on a turn END (the next message is either a
 * non-tool_result user query or the end of the chain), so a mid-turn tool
 * pair can never be split — same boundary rule as the retired truncation.
 *
 * `keepTurns` is clamped to [0, availableTurns]. `headIndex` -1 = empty
 * transcript (head record id null). keepTurns >= availableTurns resolves to
 * the current chain tip (a no-op head move).
 */
export function resolveRewindAnchor(
  messages: ReadonlyArray<AnthropicNativeMessage>,
  keepTurns: number
): { readonly headIndex: number; readonly turnCount: number } {
  const slices = splitTurns(messages);
  const available = slices.length;
  const target = Math.max(0, Math.min(keepTurns, available));
  if (target === 0) {
    return { headIndex: -1, turnCount: 0 };
  }
  return { headIndex: slices[target - 1]!.end - 1, turnCount: target };
}

/**
 * Re-anchor checkpoint records by event id. The event id is
 * authoritative; `messagesCount` is the derived view the picker joins on.
 * For each record, the anchor resolves to `eventIds[messagesCount - 1]` —
 * the last message of the checkpointed turn on the current head chain.
 * Resolvable anchors are (re-)derived even when one is already present
 * (self-healing after a fork re-roots the chain and event ids change);
 * unresolvable records (messagesCount beyond the chain) pass through
 * untouched. Pure; inputs are not mutated.
 */
export function withCheckpointAnchors(
  checkpoints: ReadonlyArray<CheckpointRecord>,
  eventIds: ReadonlyArray<string>
): CheckpointRecord[] {
  return checkpoints.map((c) => {
    const index = c.messagesCount - 1;
    const anchor =
      index >= 0 && index < eventIds.length ? eventIds[index] : undefined;
    if (anchor === undefined) return c;
    if (c.anchorEventId === anchor) return c;
    return { ...c, anchorEventId: anchor };
  });
}
