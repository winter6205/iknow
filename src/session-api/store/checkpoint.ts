/**
 * T1 checkpoint data layer — turn boundary projection, persistence predicate,
 * checkpoint appender, and the T5 rewind anchor resolution.
 *
 * Pure functions, no IO. Shared by:
 *   - checkpoint (interrupt persist): hub.conditionalSave asks
 *     `shouldPersistCheckpoint(result, priorMessages)` and appends a
 *     CheckpointRecord when a cancelled/interrupt turn made progress.
 *   - TUI rewind (rollback): T5 (#622 / spec session-jsonl-resume) retired
 *     `rewindFile`'s disk truncation — rewind now MOVES the persisted head
 *     pointer to an earlier user-message anchor and the skipped chain stays
 *     in the same JSONL. `resolveRewindAnchor` computes that anchor (the
 *     head-chain index + recomputed turnCount); `withCheckpointAnchors`
 *     re-anchors checkpoint records by event id (spec D3).
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
 * Persistence predicate (replaces the DROP_REASONS set in hub.ts 裁决#8):
 *
 *   - `cancelled` with delta>0 → persist (progress was made before abort;
 *     write a checkpoint so the interrupted turn is recoverable).
 *   - `cancelled` with delta==0 → no-op (no new authoritative messages).
 *   - `protocolError` / `emptyFinalResponse` → false (维持 #120 裁决: these
 *     turns never persist, they are dropped-context stops).
 *   - every other stopReason (completed / maxTurns / timeout / nonSuccessStop)
 *     → true (现状全量落盘).
 *
 * `delta` is (result.messages.length - priorMessages.length): only messages
 * THIS run appended count as progress (run() starts from priorMessages and
 * always returns a history that begins with them).
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
 * a process-level closeout and has no StopReason source; it is part of the
 * InterruptReason union for T2+ wiring. Returns null for stopReasons that do
 * not produce a checkpoint (completed / emptyFinalResponse / nonSuccessStop).
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
 * `record.turnIndex` (mirror of hub.ts:739 `session.turnCount +
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
 * T5 (#622): resolve the rewind target for `keepTurns` — the head-chain
 * index of the last kept message plus the recomputed turnCount. Pure.
 * Replaces rewindFile's truncation: the store moves the persisted head
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
 * T5 (spec D3): re-anchor checkpoint records by event id. The event id is
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
