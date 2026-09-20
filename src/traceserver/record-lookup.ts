/**
 * `record_id` lookup — the **single** scan implementation shared by both
 * read-side content axes.
 *
 * Why it must be single: `query_trace` drill-down and `get_record` both
 * need "find one id among 10 id fields in the same conversation". Written
 * twice, the scan limit, field order, and the distinction between "hit the
 * scan cap" vs "scanned everything, no match" would drift independently —
 * and those are facts the caller uses to decide its next step, not
 * implementation details. After the row axis slimmed to "row filtering +
 * row pagination", this file is the only `record_id` entry point.
 *
 * Scope boundary: this file only answers "which row + its scalar
 * projection". Wire shapes (row-axis envelope vs content-axis
 * `{record, matched_on}`) and error choices (the row axis's silent empty
 * list vs the content axis's `record_not_found`) stay in each core.
 */
import { TraceQueryRecordScanError } from "./query-trace-errors.js";
import type { JsonlTraceReader } from "./reader.js";
import type { TraceQuery, TraceRecordRow } from "./types.js";

/**
 * The 10 fields a row may carry an id in (the *_id keys of each record type
 * in the writer, src/harness/trace/). **Order is priority**: when a row has
 * both `llm_call_id` and `turn_id`, `matched_on` reports the former and
 * `get_record` echoes it back to the caller — this list is part of the
 * answer, not an internal detail.
 */
export const TRACE_RECORD_ID_KEYS = [
  "llm_call_id",
  "tool_call_id",
  "turn_id",
  "violation_id",
  "session_id",
  "sandbox_cmd_id",
  "verification_id",
  "goal_id",
  "subagent_id",
  "subagent_step_id",
] as const;

/**
 * Max records one `record_id` lookup will read. 10 000 is "an acceptable
 * parse volume per call", not a measured distribution: stop paging at the
 * cap so `record_scan` (did not finish) stays distinct from
 * `record_not_found` (finished, nothing there) — merging the two would make
 * callers believe an existing id does not exist.
 */
export const TRACE_RECORD_ID_SCAN_LIMIT = 10_000;

/**
 * Internal reader page size for the scan. A different concept from
 * `QUERY_TRACE_MAX_LIMIT` (the caller-requestable page cap) that merely
 * shares the same number today; this file deliberately does not import that
 * side to keep query-trace-core ↔ record-lookup acyclic.
 */
const SCAN_PAGE_SIZE = 200;

export interface RecordMatch {
  readonly row: TraceRecordRow;
  /** The id field name that matched; the caller answers "which axis my id belongs to" from it. */
  readonly matchedOn: string;
}

export interface RecordLookupResult {
  /** undefined = the whole conversation was scanned with no match. */
  readonly match?: RecordMatch;
  readonly skippedLines: number;
  readonly truncated: boolean;
  readonly offset: number;
}

/**
 * Find a row by `record_id`: page-read until a hit, the file end, or
 * `TRACE_RECORD_ID_SCAN_LIMIT`.
 *
 * `query` lets the caller keep its existing filters (the row-axis drill-down
 * reuses them); this function only overrides the two pagination coordinates
 * it owns, `limit` / `offset`.
 *
 * The two "not found" outcomes diverge here: cap reached without a hit ->
 * throw `TraceQueryRecordScanError` (`record_scan`); scanned everything with
 * no hit -> return no `match`, and the caller decides whether that is a
 * silent empty list (row axis) or `record_not_found` (content axis).
 */
export function lookupRecordById(
  reader: JsonlTraceReader,
  query: TraceQuery,
  recordId: string
): RecordLookupResult {
  const all: TraceRecordRow[] = [];
  let skippedLines = 0;
  let result = reader.query({ ...query, limit: SCAN_PAGE_SIZE, offset: 0 });
  all.push(...result.records);
  skippedLines += result.skippedLines;
  while (all.length < result.total && all.length < TRACE_RECORD_ID_SCAN_LIMIT) {
    const nextOffset = all.length;
    result = reader.query({
      ...query,
      limit: SCAN_PAGE_SIZE,
      offset: nextOffset,
    });
    if (result.records.length === 0) break;
    all.push(...result.records);
    skippedLines += result.skippedLines;
  }
  let match: RecordMatch | undefined;
  for (const row of all) {
    const matchedOn = TRACE_RECORD_ID_KEYS.find((key) => row[key] === recordId);
    if (matchedOn !== undefined) {
      match = { row, matchedOn };
      break;
    }
  }
  if (
    match === undefined &&
    all.length >= TRACE_RECORD_ID_SCAN_LIMIT &&
    (all.length < result.total || result.truncated)
  ) {
    throw new TraceQueryRecordScanError(recordId, TRACE_RECORD_ID_SCAN_LIMIT);
  }
  return {
    ...(match === undefined ? {} : { match }),
    skippedLines,
    truncated: result.truncated,
    offset: result.offset,
  };
}

/**
 * Scalar projection of a record: drops `messages` (the size source, handled
 * by the row axis's preview or the content axis's window) and `raw` (the
 * reader's copy for unknown fields, whose content already lives on the
 * row). Both axes use it, so "what a record's scalars contain" is defined
 * once.
 */
export function projectRecordBase(
  row: TraceRecordRow
): Record<string, unknown> {
  const projected: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (key !== "messages" && key !== "raw") projected[key] = value;
  }
  return projected;
}
