/**
 * JSONL trace file reader (read side of the trace inspection panel).
 *
 * Why synchronous reads: the writer uses appendFileSync (ADR-0003) and the
 * reader mirrors it; panel queries are "fetch one page per click", not a
 * continuous stream, so sync readFileSync latency within the 8 MiB cap is
 * negligible and async state management is avoided.
 *
 * Overflow guardrail: past maxBytes only the first maxBytes are read, cut
 * at a line boundary (last incomplete line dropped), truncated=true — no
 * throw. The cap is injectable via factory opts (tests use small values
 * instead of writing 8 MB). contains queries are the exception: they use
 * MAX_TRACE_BYTES_FOR_CONTAINS (256 MB), see readLinesFrom.
 *
 * Incremental reads: under `?poll=<ms>` polling the frontend passes the
 * previous response's `offset` back as `resumeOffset` — the reader only
 * reads lines appended after that byte offset, avoiding re-parsing
 * history. If the file was replaced (resumeOffset beyond the new size) ->
 * refetch everything from the head. Details in readLinesFrom.
 */
import { openSync, readSync, closeSync, statSync } from "node:fs";
import {
  TraceReadError,
  type TraceQuery,
  type TraceQueryResult,
  type TraceRecordRow,
} from "./types.js";
import { TRACE_FIELD_DEFS } from "./fields.js";
import { isEnoent, wrapIoError } from "./io.js";

/** Default byte cap for a single read (8 MiB). Overridable via factory opts. */
export const MAX_TRACE_BYTES = 8 * 1024 * 1024;

/**
 * Read-window cap for contains queries (256 MiB). When contains is given,
 * the 8 MiB status-quo cap is bypassed for a full scan — finding "which
 * records mention X" in a 39 MB trace is precisely why this knob exists;
 * the cap only guards against runaway input (a GB-scale file fed in by
 * mistake), and over the cap it **throws TraceReadError** rather than
 * silently truncating (a silent cut would turn contains into a blind
 * "scan only the first half" query on big traces — the same failure this
 * parameter exists to fix). Injectable via factory opts.containsMaxBytes
 * (for tests).
 */
export const MAX_TRACE_BYTES_FOR_CONTAINS = 256 * 1024 * 1024;

export interface JsonlTraceReaderOptions {
  readonly filePath: string;
  readonly maxBytes?: number;
  /** Read-window cap for contains queries; default MAX_TRACE_BYTES_FOR_CONTAINS (tests inject small values). */
  readonly containsMaxBytes?: number;
}

export interface JsonlTraceReader {
  query(q?: TraceQuery): TraceQueryResult;
  /**
   * Async contains query with a dereference arm (ADR-0116): the raw-line
   * substring stays the fast path, but a line that misses it is still kept
   * for parsing when `lineScope` claims it (e.g. llm_call rows), and each
   * parsed row is finally matched as `rawHit || rowMatches(row)`. The
   * `rowMatches` arm is where blob-stored bodies (system text, tool names)
   * become searchable. Same caps and pagination as the contains branch of
   * `query`.
   */
  queryContains(
    q: TraceQuery & { readonly contains: string },
    lineScope: (line: string) => boolean,
    rowMatches: (row: TraceRecordRow) => Promise<boolean>
  ): Promise<TraceQueryResult>;
}

// -- readLinesFrom ------------------------------------------------------------

interface RawLines {
  readonly lines: ReadonlyArray<string>;
  /** Byte offset at the **end** of the last complete line read in this segment (incl. newline), for the next poll to resume from. */
  readonly nextOffset: number;
  readonly truncated: boolean;
}

/**
 * Read the file from byte `startOffset` up to maxBytes.
 *
 * Incremental semantics: seek to startOffset (pread), read only bytes after
 * it. File replaced (startOffset > stat.size and startOffset > 0) -> refetch
 * everything from the head (the writer's appendFileSync only grows, so
 * startOffset beyond size can only mean the file was wholly replaced /
 * rebuilt). ENOENT -> empty segment (file deleted / not yet created;
 * polling stays silent). size - startOffset > maxBytes -> read only the
 * first maxBytes of that window, cut at a line boundary (truncated=true).
 * Other IO errors (EISDIR etc.) -> TraceReadError.
 *
 * nextOffset: if the segment ends with a complete newline -> take the
 * absolute end directly; otherwise drop the unterminated trailing partial
 * line (half line — either a cut or an in-flight write) so the next round
 * re-reads it, guaranteeing each JSONL line is consumed exactly once.
 *
 * contains: when given, a case-sensitive substring prefilter runs on the
 * **raw line text** — lines that miss are dropped before parsing (saves
 * JSON.parse CPU). The filter sits after line splitting and before parsing,
 * so byte-level semantics (nextOffset / truncated) are unaffected.
 * `keepLine` (ADR-0116) widens the prefilter for the dereference arm: a
 * missing-line-scope predicate keeps the historical drop-everything behavior.
 */
function readLinesFrom(
  filePath: string,
  maxBytes: number,
  startOffset: number,
  contains?: string,
  keepLine?: (line: string) => boolean
): RawLines {
  // ENOENT handling converges in statSize: a missing file -> size=0, falling
  // into the empty-segment branch below (silent polling, consistent with this
  // function's existing degradation semantics).
  const size = statSize(filePath);
  if (startOffset > size) {
    // File replaced (resumeOffset beyond the new file) -> refetch from head.
    // Only startOffset > 0 and > size proves replacement; startOffset === 0
    // is already at the head, no replacement semantics.
    if (startOffset > 0)
      return readLinesFrom(filePath, maxBytes, 0, contains, keepLine);
    return { lines: [], nextOffset: 0, truncated: false };
  }

  const truncated = size - startOffset > maxBytes;
  const bytesToRead = truncated ? maxBytes : size - startOffset;
  const buf = Buffer.alloc(bytesToRead);
  try {
    const fd = openSync(filePath, "r");
    try {
      readSync(fd, buf, 0, bytesToRead, startOffset);
    } finally {
      closeSync(fd);
    }
  } catch (err) {
    if (isEnoent(err))
      return { lines: [], nextOffset: startOffset, truncated: false };
    throw wrapIoError(err);
  }
  const raw = splitLines(buf.toString("utf8"), startOffset, truncated);
  // An empty-string contains is treated as absent (includes("") is always
  // true = no filter, but would wrongly bypass the status-quo cap) —
  // "empty string = absent" means the same here and in query-trace-core's
  // validation layer.
  if (!contains) return raw;
  return {
    ...raw,
    lines: raw.lines.filter(
      (line) => line.includes(contains) || keepLine?.(line) === true
    ),
  };
}

function splitLines(
  content: string,
  startOffset: number,
  truncated: boolean
): RawLines {
  if (content.length === 0) {
    // Empty segment: file is empty, or no new bytes (size === startOffset).
    // nextOffset stays at the start point so the next poll continues from
    // the same offset without re-reading.
    return { lines: [], nextOffset: startOffset, truncated };
  }
  let usable: string;
  if (content.endsWith("\n")) {
    // Fully terminated segment: every character belongs to complete lines.
    // In-segment line separators \n are single bytes and UTF-8 multibyte
    // sequences never span lines, so Buffer.byteLength(content) is the
    // absolute offset.
    usable = content;
  } else {
    // Segment does not end with a newline: the last line is incomplete (an
    // in-flight write or a maxBytes cut). Keep only the complete lines
    // before it; the tail is re-read in full next round.
    const nl = content.lastIndexOf("\n");
    if (nl === -1) {
      // Not a single complete line in this segment → nothing parseable,
      // nextOffset stays at the start point.
      return { lines: [], nextOffset: startOffset, truncated };
    }
    usable = content.slice(0, nl + 1);
  }
  const nextOffset = startOffset + Buffer.byteLength(usable);
  return {
    lines: usable.split("\n").filter((l) => l.trim().length > 0),
    nextOffset,
    truncated,
  };
}

// -- parseLines ----------------------------------------------------------------

/**
 * Parse a single line into a TraceRecordRow.
 *
 * Unknown-field fallback: top-level keys in the row not declared by
 * TRACE_FIELD_DEFS (jsonlKey) are collected into a `raw.unmapped` array
 * (the panel renders them under "other fields"). The `raw` key is added
 * only when unknown fields exist, keeping every other row clean; keys of
 * known fields are untouched.
 */
function parseOneLine(line: string): TraceRecordRow | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }
  const row = parsed as Record<string, unknown>;
  const knownKeys = new Set<string>();
  for (const def of TRACE_FIELD_DEFS) knownKeys.add(def.jsonlKey);
  const unmapped: Array<{ key: string; value: unknown }> = [];
  for (const key of Object.keys(row)) {
    if (!knownKeys.has(key)) unmapped.push({ key, value: row[key] });
  }
  if (unmapped.length === 0) return row as TraceRecordRow;
  return { ...row, raw: { unmapped } } as TraceRecordRow;
}

/** Line + parsed row kept paired for the dereference arm of contains (ADR-0116): the final match test needs the raw text for the fast path and the row for the deref arm. */
interface LinePair {
  readonly line: string;
  readonly row: TraceRecordRow;
}

function parseLinePairs(
  lines: ReadonlyArray<string>
): { pairs: LinePair[]; skippedLines: number } {
  const pairs: LinePair[] = [];
  let skippedLines = 0;
  for (const line of lines) {
    const row = parseOneLine(line);
    if (row === undefined) skippedLines += 1;
    else pairs.push({ line, row });
  }
  return { pairs, skippedLines };
}

/**
 * The shared sort + filter stage of the query pipeline: both arms (plain
 * `query` and the deref-arm `queryContains`) run the identical
 * sort-by-time-desc then field-filter sequence over parsed pairs, so their
 * ordering / scoping semantics cannot drift apart.
 */
function sortedScopedPairs(
  pairs: ReadonlyArray<LinePair>,
  query: TraceQuery
): LinePair[] {
  const sorted = [...pairs].sort((a, b) =>
    compareTimeDesc(sortTimeOf(a.row), sortTimeOf(b.row))
  );
  return sorted.filter((pair) => applyFilter([pair.row], query)[0] !== undefined);
}

/** The shared pagination / result-assembly stage for both query arms. */
function assemblePage(
  matched: ReadonlyArray<TraceRecordRow>,
  skippedLines: number,
  raw: RawLines,
  query: TraceQuery
): TraceQueryResult {
  return {
    records: applyPagination(matched, query),
    total: matched.length,
    skippedLines,
    truncated: raw.truncated,
    offset: raw.nextOffset,
  };
}

// -- applyFilter ---------------------------------------------------------------

/**
 * Exact-match filter on conversation_id / record_type / status +
 * task_id / parent_turn_id / turn_id. All AND-combined; conditions left
 * undefined do not take effect.
 */
function applyFilter(
  rows: ReadonlyArray<TraceRecordRow>,
  query: TraceQuery
): TraceRecordRow[] {
  const conversationId = query.conversationId;
  const recordType = query.recordType;
  const status = query.status;
  return rows.filter((row) => {
    if (
      conversationId !== undefined &&
      row["conversation_id"] !== conversationId
    )
      return false;
    if (recordType !== undefined && row["record_type"] !== recordType)
      return false;
    if (status !== undefined && row["status"] !== status) return false;
    // Exact match on task_id / parent_turn_id. When undefined, skipped (a
    // row missing the key counts as non-matching, never as success). Empty
    // string values were already rejected upstream with 400 in http.ts
    // parseStringParam and never reach the filter.
    if (query.taskId !== undefined && row["task_id"] !== query.taskId)
      return false;
    if (
      query.parentTurnId !== undefined &&
      row["parent_turn_id"] !== query.parentTurnId
    )
      return false;
    if (query.turnId !== undefined && row["turn_id"] !== query.turnId)
      return false;
    return true;
  });
}

// -- applyPagination -----------------------------------------------------------

/** Slice the filtered rows by offset + limit (default limit 100). */
function applyPagination(
  rows: ReadonlyArray<TraceRecordRow>,
  query: TraceQuery
): TraceRecordRow[] {
  const offset = query.offset ?? 0;
  const limit = query.limit ?? 100;
  return rows.slice(offset, offset + limit);
}

// -- sorting -------------------------------------------------------------------

/** Sort key: started_at (turn/llm/tool) then ts (violation); absent → "" (stable). */
function sortTimeOf(row: TraceRecordRow): string {
  const startedAt = row["started_at"];
  if (typeof startedAt === "string" && startedAt.length > 0) return startedAt;
  const ts = row["ts"];
  if (typeof ts === "string" && ts.length > 0) return ts;
  return "";
}

/** Descending ISO8601 string compare; "" (no timestamp) sorts last, equal times keep stable order. */
function compareTimeDesc(ta: string, tb: string): number {
  if (ta === tb) return 0;
  if (ta === "") return 1;
  if (tb === "") return -1;
  return ta < tb ? 1 : -1;
}

// -- factory -------------------------------------------------------------------

export function createJsonlTraceReader(
  options: JsonlTraceReaderOptions
): JsonlTraceReader {
  const { filePath } = options;
  const maxBytes = options.maxBytes ?? MAX_TRACE_BYTES;
  const containsMaxBytes =
    options.containsMaxBytes ?? MAX_TRACE_BYTES_FOR_CONTAINS;

  return {
    query(query: TraceQuery = {}): TraceQueryResult {
      const startOffset = Math.max(0, query.resumeOffset ?? 0);
      if (query.contains !== undefined) {
        const raw = readContainsWindow(
          { ...query, contains: query.contains },
          startOffset
        );
        return finishQuery(raw, query);
      }
      const raw = readLinesFrom(filePath, maxBytes, startOffset);
      return finishQuery(raw, query);
    },

    async queryContains(
      query: TraceQuery & { readonly contains: string },
      lineScope: (line: string) => boolean,
      rowMatches: (row: TraceRecordRow) => Promise<boolean>
    ): Promise<TraceQueryResult> {
      const startOffset = Math.max(0, query.resumeOffset ?? 0);
      const raw = readContainsWindow(query, startOffset, lineScope);
      const { pairs, skippedLines } = parseLinePairs(raw.lines);
      const matched: TraceRecordRow[] = [];
      for (const pair of sortedScopedPairs(pairs, query)) {
        // Fast path first: an inline raw hit never pays for a deref.
        if (pair.line.includes(query.contains) || (await rowMatches(pair.row))) {
          matched.push(pair.row);
        }
      }
      return assemblePage(matched, skippedLines, raw, query);
    },
  };

  /**
   * The one contains-window opener for both arms: with contains, the 8 MiB
   * status-quo cap is bypassed for containsMaxBytes (default 256 MiB) —
   * finding "which records mention X" on a 39 MB trace needs this tier: an
   * 8 MiB cap would shut out the whole second half of the trace. Over-cap
   * files throw TraceReadError instead of silent truncation, because a
   * truncated contains is a dishonest search result (the same failure this
   * knob exists to fix). The precheck and the read window use the same cap:
   * letting the window take max(contains, max) would create two
   * contradictory caps — with containsMaxBytes < maxBytes the window would
   * be larger yet the query still refused at containsMaxBytes. `keepLine`
   * widens the raw-line prefilter for the deref arm (ADR-0116); the plain
   * contains branch keeps the historical drop-everything-on-miss behavior.
   */
  function readContainsWindow(
    query: TraceQuery & { readonly contains: string },
    startOffset: number,
    keepLine?: (line: string) => boolean
  ): RawLines {
    const size = statSize(filePath);
    if (size > containsMaxBytes) {
      throw new TraceReadError(
        `contains query refused: trace file exceeds the ${containsMaxBytes}-byte ` +
          `scan cap (size=${size}); narrow the query or raise containsMaxBytes`
      );
    }
    return readLinesFrom(
      filePath,
      containsMaxBytes,
      startOffset,
      query.contains,
      keepLine
    );
  }

  function finishQuery(raw: RawLines, query: TraceQuery): TraceQueryResult {
    const { pairs, skippedLines } = parseLinePairs(raw.lines);
    const rows = sortedScopedPairs(pairs, query).map((pair) => pair.row);
    return assemblePage(rows, skippedLines, raw, query);
  }
}

/**
 * stat size helper for the contains cap check. ENOENT -> 0 (a missing file
 * is handled by readLinesFrom's existing silent degradation; no throw here).
 */
function statSize(filePath: string): number {
  try {
    return statSync(filePath).size;
  } catch (err) {
    if (isEnoent(err)) return 0;
    throw wrapIoError(err);
  }
}
