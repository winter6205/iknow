/**
 * Trace inspection types (read side).
 *
 * The write side lives in src/harness/trace/ and is unchanged: it appends
 * snake_case JSONL rows to a flat file. This module defines the read-side
 * vocabulary so the inspection HTTP surface and the web panel can both
 * speak a typed contract.
 *
 * Architecture note: TraceRecordRow is intentionally a `Record<string, unknown>`
 * — the inspection panel renders raw JSONL as-is. Type narrowing happens at
 * the per-field level via TRACE_FIELD_DEFS in fields.ts.
 */

/**
 * Whitelist-derived union — new record types are only appended here;
 * reader/http/fields all follow this whitelist (no hardcoded record-name
 * lists). Declaration order is relied on by existing consumers; new members
 * must be APPENDed at the end.
 */
export type TraceRecordType =
  | "llm_call"
  | "tool_call"
  | "turn"
  | "violation"
  | "session"
  | "sandbox_cmd"
  | "subagent_spawn"
  | "subagent_stop"
  | "subagent_state_change"
  | "subagent_step"
  | "verification"
  | "goal";

export const TRACE_RECORD_TYPES: ReadonlyArray<TraceRecordType> = [
  "llm_call",
  "tool_call",
  "turn",
  "violation",
  "session",
  "sandbox_cmd",
  "subagent_spawn",
  "subagent_stop",
  "subagent_state_change",
  "subagent_step",
  "verification",
  "goal",
];

/** Raw JSONL row, snake_case keys preserved. Read-only to discourage mutation. */
export type TraceRecordRow = Readonly<Record<string, unknown>>;

/** Query parameters for trace inspection. All fields optional; defaults applied in the reader. */
export interface TraceQuery {
  readonly conversationId?: string;
  readonly recordType?: TraceRecordType;
  readonly status?: "ok" | "error";
  /** Row-based pagination offset (limit 1..200, offset >= 0). */
  readonly limit?: number;
  readonly offset?: number;
  /**
   * Exact match on task_id (top-level snake_case JSONL key).
   * undefined = not part of the filter. Exact-match only; time-window
   * queries are out of scope.
   */
  readonly taskId?: string;
  /**
   * Exact match on parent_turn_id. undefined = not part of the filter.
   * The v1 writer's SubagentDefinition has no parentTurnId source yet, so
   * the field is currently not persisted; the reader is in place first and
   * can query as soon as the writer starts emitting it.
   */
  readonly parentTurnId?: string;
  /** Exact-match turn association filter. */
  readonly turnId?: string;
  /**
   * Incremental-polling resume byte offset: reads only lines appended after
   * resumeOffset. Orthogonal to the row pagination `offset` — row pagination
   * means "start from row N", this means "read new data after byte N".
   * Default 0 = read everything from the file head. The frontend passes
   * back the previous response's `offset` verbatim.
   */
  readonly resumeOffset?: number;
  /**
   * Case-sensitive raw-line substring match: hits full JSONL line text —
   * for llm_call its serialized messages field, for tool_call its
   * arguments (once the writer persists tool_call arguments). AND-combined
   * with exact filters like record_type/status; orthogonal to limit/offset
   * pagination.
   *
   * When contains is provided, the 8 MiB status-quo query byte cap is
   * bypassed in favor of the `MAX_TRACE_BYTES_FOR_CONTAINS` bound, to avoid
   * a "scan only the first 8 MB" blind spot on ~39 MB traces.
   * `undefined` / absent = behavior completely unchanged (status-quo queries
   * keep the 8 MiB cap and no raw-line filtering).
   */
  readonly contains?: string;
}

export interface TraceQueryResult {
  readonly records: ReadonlyArray<TraceRecordRow>;
  /** Filtered count before pagination — what the UI shows as "total". */
  readonly total: number;
  /** Lines that failed to parse or were not JSON objects. */
  readonly skippedLines: number;
  /** True when the file was truncated by the byte cap. */
  readonly truncated: boolean;
  /**
   * Byte offset where this read ended (aligned to line boundaries). The
   * frontend passes it back as `resume_offset` next poll to fetch only new
   * lines. 0 = this read hit an empty file / file head.
   */
  readonly offset: number;
}

/**
 * Typed error for read-side IO failures (ENOENT is handled silently, not thrown).
 * Bubbles up to http.ts which maps it to 500 internal without leaking the
 * underlying fs message onto the wire.
 */
export class TraceReadError extends Error {
  readonly kind = "io_error";

  constructor(message: string) {
    super(message);
    this.name = "TraceReadError";
  }
}
