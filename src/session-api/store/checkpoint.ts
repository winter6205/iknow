/**
 * T1 checkpoint data layer — turn boundary projection, persistence predicate,
 * checkpoint appender, and the rewindFile truncation (T6 rewind reuses the
 * pure truncation; this module only wires T1 tests, no T6 production callers).
 *
 * Pure functions, no IO. Shared by:
 *   - checkpoint (interrupt persist): hub.conditionalSave asks
 *     `shouldPersistCheckpoint(result, priorMessages)` and appends a
 *     CheckpointRecord when a cancelled/interrupt turn made progress.
 *   - TUI rewind (rollback): `rewindFile` truncates to a turn boundary with
 *     tool pairs complete, recomputes turnCount, and prunes checkpoints that
 *     describe truncated turns.
 *
 * Turn-boundary rule (mirrors hub.ts projectMessagesToTurns): a turn starts at
 * a user message that has NO tool_result block; user messages that carry only
 * tool_result blocks are continuation, not queries.
 */
import type { AnthropicNativeMessage, RunResult } from "../../harness/index.js";
import type {
  CheckpointRecord,
  InterruptReason,
  SessionFileV1,
} from "./schema.js";
import { extractTitle } from "./schema.js";

/** A turn starts at a user message that carries no tool_result block — matches
 *  hub.ts projectMessagesToTurns and rewind's "skip tool_result user msg"
 *  rule verbatim. */
function isQuery(msg: AnthropicNativeMessage): boolean {
  return (
    msg.role === "user" && !msg.content.some((b) => b.type === "tool_result")
  );
}

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

/** Project turn boundaries: one slice per non-tool_result user message
 *  (matching hub.ts projectMessagesToTurns). Returns [] when no query message
 *  exists (e.g. a session that starts mid tool-result, which is malformed). */
export function splitTurns(
  messages: ReadonlyArray<AnthropicNativeMessage>
): ReadonlyArray<TurnSlice> {
  const slices: TurnSlice[] = [];
  let nextStart = -1;
  for (let i = 0; i < messages.length; i++) {
    if (!isQuery(messages[i]!)) continue;
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
 * Rewind a session file to `keepTurns` turn boundaries (T6 rewind reuses this).
 * Pure. Truncation always lands on a turn START (the next message is either a
 * non-tool_result user query or the end), so a mid-turn tool pair can never be
 * split: the slice end index comes from turnSliceEnd and a truncated turn's
 * tool_result block (if any) stays inside its slice. Also:
 *   - recomputes turnCount (number of kept turns);
 *   - recomputes title from the truncated prefix (#467 renamed from `summary`);
 *   - prunes checkpoints whose turnIndex >= keepTurns (records that describe
 *     turns that no longer exist after the truncation).
 *
 * `keepTurns` is clamped to [0, availableTurns]. Empty messages stay empty.
 */
export function rewindFile(
  session: SessionFileV1,
  keepTurns: number
): SessionFileV1 {
  const slices = splitTurns(session.messages);
  const available = slices.length;
  const target = Math.max(0, Math.min(keepTurns, available));
  if (target === available) {
    return {
      ...session,
      checkpoints: session.checkpoints ?? [],
    };
  }
  const end = target === 0 ? 0 : slices[target - 1]!.end;
  const messages = session.messages.slice(0, end);
  const checkpoints = (session.checkpoints ?? []).filter(
    (c) => c.turnIndex < target
  );
  return {
    ...session,
    messages,
    turnCount: target,
    title: extractTitle(messages),
    checkpoints,
  };
}
