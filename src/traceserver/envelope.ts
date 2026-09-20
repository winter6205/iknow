/**
 * The read side's shared response envelope (wire shape, snake_case).
 *
 * The panel face (`http.ts` → Web UI) and the tool face
 * (`query-trace-core.ts` → ACI / MCP) **no longer share** envelope
 * construction: `total` / `truncated` are panel pagination semantics
 * (ADR-0020) and no longer appear on the tool face (contract X / ADR-0004).
 * This file keeps `ResponseEnvelope` / `toResponseEnvelope` for the panel;
 * the tool face uses `QueryTracePage` / `toQueryTracePage` — a separate
 * construction, deliberately **not** a "which face" switch added to
 * `toResponseEnvelope`.
 */
import type { TraceRecordRow, TraceQueryResult } from "./types.js";

export interface ResponseEnvelope {
  readonly records: ReadonlyArray<Record<string, unknown> | TraceRecordRow>;
  readonly total: number;
  readonly skipped_lines: number;
  readonly truncated: boolean;
  readonly offset: number;
}

/**
 * reader result → panel envelope. `records` replaces the rows with
 * projected records; when omitted the reader's raw rows pass through. Key
 * order is fixed as records / total / skipped_lines / truncated / offset:
 * key order does not affect serialized length, but it decides which bytes
 * the panel emits.
 */
export function toResponseEnvelope(
  result: TraceQueryResult,
  records: ResponseEnvelope["records"] = result.records
): ResponseEnvelope {
  return {
    records,
    total: result.total,
    skipped_lines: result.skippedLines,
    truncated: result.truncated,
    offset: result.offset,
  };
}

/** Panel envelope when there is nothing to read: the directory has no sessions yet. */
export function emptyResponseEnvelope(): ResponseEnvelope {
  return toResponseEnvelope({
    records: [],
    total: 0,
    skippedLines: 0,
    truncated: false,
    offset: 0,
  });
}

/**
 * The tool face's `query_trace` envelope shape: one page of row filtering +
 * row pagination, **without** `total` / `truncated`.
 *
 * - `records`: projected record array (list path).
 * - `limit` / `offset`: effective coordinates (the values the caller
 *   actually used — defaults are materialized too); resume =
 *   `offset + records.length`, and `records.length < limit` is the
 *   "reached the end" signal.
 * - No `skipped_lines`: the count of JSONL parse failures is meaningless on
 *   the tool face (row-axis resume is row-level, not byte-level, and the
 *   byte polling `resume_offset` was removed from the tool face); mixing it
 *   into the envelope would mistake panel read-side diagnostics for part of
 *   the tool contract.
 *
 * Same-shape rationale: mirrors `ListSessionsPage` — "records array +
 * echoed effective coordinates" is the unified shape of the tool face.
 */
export interface QueryTracePage {
  readonly records: ReadonlyArray<Record<string, unknown> | TraceRecordRow>;
  readonly limit: number;
  readonly offset: number;
}

export function toQueryTracePage(
  records: QueryTracePage["records"],
  effective: { readonly limit: number; readonly offset: number }
): QueryTracePage {
  return {
    records,
    limit: effective.limit,
    offset: effective.offset,
  };
}
