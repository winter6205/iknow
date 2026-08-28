/**
 * auto-memory T4: the host-side trigger gate.
 *
 * Spec: specs/auto-memory.md D1/D4; ADR-0031 Decision 1/5. Hosts (chat / tui /
 * serve) call `onTurnComplete` after every turn; everything that decides
 * whether an ingest actually happens lives here rather than in the loop
 * engine, which owns turn mechanics and not memory semantics.
 *
 * Extract gates, in order: the feature is opted in, the turn stopped with
 * `completed`, and the conversation has accumulated `minCompletedTurns`
 * completed turns since the last extract pass. Dream uses a separate dual
 * gate (24h since last success-or-skip ∧ 5 distinct sessions) persisted
 * under the memory root.
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
import {
  dreamGatesMet,
  loadDreamCursor,
  recordDreamSession,
  resetDreamCursor,
  saveDreamCursor,
  type DreamCursor,
} from "./dream-cursor.js";
import { runMemoryDream } from "./dream.js";
import { ingestMemory } from "./ingest.js";
import type { MemoryExtractLlm, MemoryIngestResult } from "./ingest.js";
import { runMemoryGc } from "./gc.js";

/** Completed turns to accumulate before a pass. ADR-0031 D1: never per-turn. */
export const DEFAULT_COMPLETED_TURN_GATE = 2;

export interface AutoMemoryTurn {
  /** The run's `StopReason`; anything but `completed` is ignored. */
  readonly stopReason: string;
  /** The conversation slice to mine. Blank input is ignored. */
  readonly transcript: string;
  /**
   * Host session identity for the dream 5-session gate. Chat/TUI: one
   * in-process conversation. Serve: conversation_id. Absent = no session increment.
   */
  readonly sessionKey?: string;
  /**
   * Host-computed: this completed turn already persisted a successful
   * `memory_save`. When true, extract is skipped even if the N-turn gate is due.
   */
  readonly memorySaveSucceeded?: boolean;
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
  /** Independent opt-in for the offline merge pass; absent or non-true = off. */
  readonly dream?: boolean;
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
  /**
   * Live TUI flags. When present, `onTurnComplete` reads them each call
   * instead of snapshotting `enabled` / `dream` at construction.
   */
  readonly flags?: MemoryLiveFlags;
  /**
   * Host-wired static layer (user + project AGENTS.md / rules).
   * Resolved only on an extract pass. Thrown faults are swallowed.
   */
  readonly staticLayer?: () => Promise<string>;
}

/** Mutable box the TUI mutates on /memory Esc without rebuilding the hook. */
export interface MemoryLiveFlags {
  autoExtract: boolean;
  dream: boolean;
}

function liveFlags(opts: AutoMemoryHookOptions): {
  enabled: boolean;
  dream: boolean;
} {
  if (opts.flags !== undefined) {
    return {
      enabled: opts.flags.autoExtract === true,
      dream: opts.flags.dream === true,
    };
  }
  return {
    enabled: opts.enabled === true,
    dream: opts.dream === true,
  };
}

export function createAutoMemoryHook(
  opts: AutoMemoryHookOptions
): AutoMemoryHook {
  const gate = requireGate(opts.minCompletedTurns);

  let completedTurns = 0;
  // Single-slot chain: each pass waits for the previous one, so two turns
  // finishing back to back cannot interleave their reads and writes.
  let chain: Promise<void> = Promise.resolve();

  const onTurnComplete = (turn: AutoMemoryTurn): void => {
    const { enabled, dream } = liveFlags(opts);
    if (!enabled && !dream) return;
    if (turn.stopReason !== "completed") return;
    const extractEligible = enabled && turn.transcript.trim().length > 0;
    if (!extractEligible && !dream) return;

    let extractDue = false;
    if (extractEligible) {
      completedTurns++;
      if (completedTurns >= gate) {
        completedTurns = 0;
        extractDue = true;
      }
    }
    if (!extractDue && !dream) return;

    const transcript = turn.transcript;
    const sessionKey = turn.sessionKey;
    const skipExtract = turn.memorySaveSucceeded === true;
    chain = chain.then(async () => {
      const live = liveFlags(opts);
      const dreamDue = live.dream
        ? await persistAndEvaluateDreamGate(opts, sessionKey, opts.onError)
        : false;

      if (extractDue && live.enabled && !skipExtract) {
        await runExtractPass(opts, transcript, dreamDue);
      }
      if (dreamDue) {
        await runDreamPass(opts);
      }
    });
  };

  return {
    onTurnComplete,
    drain: () => chain,
  };
}

async function persistAndEvaluateDreamGate(
  opts: AutoMemoryHookOptions,
  sessionKey: string | undefined,
  onError: ((error: unknown) => void) | undefined
): Promise<boolean> {
  const nowMs = opts.nowMs ?? Date.now();
  let cursor: DreamCursor;
  try {
    cursor = recordDreamSession(
      await loadDreamCursor(opts.memoryDir),
      sessionKey
    );
    await saveDreamCursor(opts.memoryDir, cursor);
  } catch (error) {
    // EXIT: log-and-continue — a cursor fault must not fail the user turn.
    safeReport(onError, error);
    return false;
  }
  return dreamGatesMet(cursor, nowMs);
}

async function runExtractPass(
  opts: AutoMemoryHookOptions,
  transcript: string,
  deferGcForDream: boolean
): Promise<void> {
  let staticLayer = "";
  try {
    staticLayer = (await opts.staticLayer?.()) ?? "";
  } catch (error) {
    // EXIT: log-and-continue — a static-layer fault must not fail the user turn.
    safeReport(opts.onError, error);
  }
  try {
    const ingestResult = await ingestMemory({
      memoryDir: opts.memoryDir,
      transcript,
      llm: opts.llm,
      ...(staticLayer.length > 0 ? { staticLayer } : {}),
      ...(opts.now ? { now: opts.now } : {}),
      ...(opts.nowMs !== undefined ? { nowMs: opts.nowMs } : {}),
      ...(opts.randomBytes ? { randomBytes: opts.randomBytes } : {}),
      ...(opts.ttlDays !== undefined ? { ttlDays: opts.ttlDays } : {}),
      ...(deferGcForDream ? { gc: false } : {}),
      ...(opts.cap !== undefined ? { cap: opts.cap } : {}),
    });
    opts.onIngest?.(ingestResult);
  } catch (error) {
    // EXIT: log-and-continue (ADR-0031 D5). Extract failure must not
    // skip the later dream/GC stages or fail the user turn.
    safeReport(opts.onError, error);
  }
}

async function runDreamPass(opts: AutoMemoryHookOptions): Promise<void> {
  const nowMs = opts.nowMs ?? Date.now();
  let mergeFailed = false;
  try {
    await runMemoryDream({
      memoryDir: opts.memoryDir,
      llm: opts.llm,
      ...(opts.now ? { now: opts.now } : {}),
      ...(opts.randomBytes ? { randomBytes: opts.randomBytes } : {}),
      ...(opts.ttlDays !== undefined ? { ttlDays: opts.ttlDays } : {}),
    });
  } catch (error) {
    mergeFailed = true;
    // EXIT: log-and-continue — merge failure still yields mechanical GC
    // so extract SUPERSEDE targets and TTL evictions are not stranded.
    safeReport(opts.onError, error);
  }
  try {
    await runMemoryGc(opts.memoryDir, {
      ...(opts.nowMs !== undefined ? { nowMs: opts.nowMs } : {}),
      ...(opts.cap !== undefined ? { cap: opts.cap } : {}),
    });
  } catch (error) {
    // EXIT: log-and-continue — GC is subtractive and must not fail the turn.
    safeReport(opts.onError, error);
  }
  if (mergeFailed) return;
  try {
    await saveDreamCursor(opts.memoryDir, resetDreamCursor(nowMs));
  } catch (error) {
    // EXIT: log-and-continue — losing a reset retries the next turn, which is safe.
    safeReport(opts.onError, error);
  }
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
