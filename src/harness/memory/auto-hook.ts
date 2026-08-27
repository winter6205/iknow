/**
 * auto-memory T4: the host-side trigger gate.
 *
 * Spec: specs/auto-memory.md D1/D4; ADR-0031 Decision 1/5. Hosts (chat / tui /
 * serve) call `onTurnComplete` after every turn; everything that decides
 * whether an ingest actually happens lives here rather than in the loop
 * engine, which owns turn mechanics and not memory semantics.
 *
 * Three gates, in order: the feature is opted in, the turn stopped with
 * `completed`, and the conversation has accumulated `minCompletedTurns`
 * completed turns since the last pass.
 *
 * Two contracts the hosts depend on:
 *
 *   - `onTurnComplete` is synchronous, total, and returns nothing. It cannot
 *     throw and the ingest it starts cannot reject into the caller. A missed
 *     memory is never worth turning a successful user turn into a failed one.
 *   - passes are serialized. Two overlapping turns on one store would race
 *     each other's neighbor lookup and write duplicates.
 */
import { MemoryGcOptionInvalid } from "./errors.js";
import { ingestMemory } from "./ingest.js";
import type { MemoryExtractLlm, MemoryIngestResult } from "./ingest.js";

/** Completed turns to accumulate before a pass. ADR-0031 D1: never per-turn. */
export const DEFAULT_COMPLETED_TURN_GATE = 2;

export interface AutoMemoryTurn {
  /** The run's `StopReason`; anything but `completed` is ignored. */
  readonly stopReason: string;
  /** The conversation slice to mine. Blank input is ignored. */
  readonly transcript: string;
}

export interface AutoMemoryHook {
  /** Fire-and-forget. Never throws, never rejects, returns nothing. */
  readonly onTurnComplete: (turn: AutoMemoryTurn) => void;
  /** Resolve once in-flight passes settle. Test seam and shutdown hook. */
  readonly drain: () => Promise<void>;
}

export interface AutoMemoryHookOptions {
  readonly memoryDir: string;
  readonly llm: MemoryExtractLlm;
  /** Opt-in. Absent or non-true = off, byte-identical to no wiring at all. */
  readonly enabled?: boolean;
  /** Completed turns per pass; positive integer. Default DEFAULT_COMPLETED_TURN_GATE. */
  readonly minCompletedTurns?: number;
  /** ISO-8601 clock for written entries; defaults to the real clock. */
  readonly now?: () => string;
  /** Reference time for the post-write GC pass. */
  readonly nowMs?: number;
  /** Slug source; defaults to node:crypto randomBytes. */
  readonly randomBytes?: (n: number) => Buffer;
  /** TTL stamped on new auto entries; 0 (default) = never expires. */
  readonly ttlDays?: number;
  /** Active-entry ceiling handed to GC. */
  readonly cap?: number;
  /** Observer for swallowed failures. Absent = silent. */
  readonly onError?: (error: unknown) => void;
  /** Observer for completed passes. Absent = silent. */
  readonly onIngest?: (result: MemoryIngestResult) => void;
}

export function createAutoMemoryHook(
  opts: AutoMemoryHookOptions
): AutoMemoryHook {
  const gate = requireGate(opts.minCompletedTurns);
  const enabled = opts.enabled === true;

  let completedTurns = 0;
  // Single-slot chain: each pass waits for the previous one, so two turns
  // finishing back to back cannot interleave their reads and writes.
  let chain: Promise<void> = Promise.resolve();

  const onTurnComplete = (turn: AutoMemoryTurn): void => {
    if (!enabled) return;
    if (turn.stopReason !== "completed") return;
    if (turn.transcript.trim().length === 0) return;
    completedTurns++;
    if (completedTurns < gate) return;
    completedTurns = 0;

    const transcript = turn.transcript;
    chain = chain.then(async () => {
      try {
        const result = await ingestMemory({
          memoryDir: opts.memoryDir,
          transcript,
          llm: opts.llm,
          ...(opts.now ? { now: opts.now } : {}),
          ...(opts.nowMs !== undefined ? { nowMs: opts.nowMs } : {}),
          ...(opts.randomBytes ? { randomBytes: opts.randomBytes } : {}),
          ...(opts.ttlDays !== undefined ? { ttlDays: opts.ttlDays } : {}),
          ...(opts.cap !== undefined ? { cap: opts.cap } : {}),
        });
        opts.onIngest?.(result);
      } catch (error) {
        // EXIT: log-and-continue (ADR-0031 D5). The user's turn already
        // succeeded; a failed extraction is reported to the observer and
        // dropped. Re-throwing here would reject an unawaited promise and
        // take the host process down.
        safeReport(opts.onError, error);
      }
    });
  };

  return {
    onTurnComplete,
    drain: () => chain,
  };
}

function requireGate(value: number | undefined): number {
  if (value === undefined) return DEFAULT_COMPLETED_TURN_GATE;
  if (!Number.isInteger(value) || value < 1) {
    throw new MemoryGcOptionInvalid(
      `auto-memory: minCompletedTurns must be a positive integer, got ${String(value)}`
    );
  }
  return value;
}

/** A throwing observer must not become the failure it was reporting. */
function safeReport(
  onError: ((error: unknown) => void) | undefined,
  error: unknown
): void {
  if (!onError) return;
  try {
    onError(error);
  } catch {
    // EXIT: the observer is host UI, not a control path.
  }
}
