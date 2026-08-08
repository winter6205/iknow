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

export type TraceRecordType =
  "llm_call" | "tool_call" | "turn" | "violation" | "session" | "sandbox_cmd";

export const TRACE_RECORD_TYPES: ReadonlyArray<TraceRecordType> = [
  "llm_call",
  "tool_call",
  "turn",
  "violation",
  "session",
  "sandbox_cmd",
];

/** Raw JSONL row, snake_case keys preserved. Read-only to discourage mutation. */
export type TraceRecordRow = Readonly<Record<string, unknown>>;

/** Query parameters for trace inspection. All fields optional; defaults applied in the reader. */
export interface TraceQuery {
  readonly conversationId?: string;
  readonly recordType?: TraceRecordType;
  readonly status?: "ok" | "error";
  readonly limit?: number;
  readonly offset?: number;
}

export interface TraceQueryResult {
  readonly records: ReadonlyArray<TraceRecordRow>;
  /** Filtered count before pagination — what the UI shows as "total". */
  readonly total: number;
  /** Lines that failed to parse or were not JSON objects. */
  readonly skippedLines: number;
  /** True when the file was truncated by the byte cap. */
  readonly truncated: boolean;
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
