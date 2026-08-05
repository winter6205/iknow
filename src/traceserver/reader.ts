/**
 * JSONL trace file reader (read side of the trace inspection panel).
 *
 * 同步读取的理由: 写侧用 appendFileSync (ADR-0003 D11)，读侧与之对称；
 * 面板查询量级是「单次点击拉一页」而非持续流式读取，8MB 上限内同步
 * readFileSync 的延迟可忽略，且避免引入异步状态管理。
 *
 * Overflow 护栏: 文件超过 maxBytes 时只读前 maxBytes 字节，按行边界截断
 * (丢弃最后一个不完整行)，并置 truncated=true — 不抛错。上限可经工厂
 * opts 注入覆盖 (测试用小值，避免写 8MB)。
 */
import { openSync, readSync, closeSync, statSync } from "node:fs";
import {
  TraceReadError,
  type TraceQuery,
  type TraceQueryResult,
  type TraceRecordRow,
} from "./types.js";

/** Default byte cap for a single read (8 MiB). Overridable via factory opts. */
export const MAX_TRACE_BYTES = 8 * 1024 * 1024;

export interface JsonlTraceReaderOptions {
  readonly filePath: string;
  readonly maxBytes?: number;
}

export interface JsonlTraceReader {
  query(q?: TraceQuery): TraceQueryResult;
}

// -- readAllLines -------------------------------------------------------------

interface RawLines {
  readonly lines: ReadonlyArray<string>;
  readonly truncated: boolean;
}

/**
 * Read the file up to maxBytes. ENOENT → empty (no throw). Size > maxBytes →
 * read the first maxBytes bytes and truncate at the last complete line.
 * Other IO errors (EISDIR etc.) → TraceReadError.
 */
function readAllLines(filePath: string, maxBytes: number): RawLines {
  let size: number;
  try {
    size = statSync(filePath).size;
  } catch (err) {
    if (isEnoent(err)) return { lines: [], truncated: false };
    throw wrapIoError(err);
  }
  const truncated = size > maxBytes;
  const bytesToRead = truncated ? maxBytes : size;
  const buf = Buffer.alloc(bytesToRead);
  try {
    const fd = openSync(filePath, "r");
    try {
      readSync(fd, buf, 0, bytesToRead, 0);
    } finally {
      closeSync(fd);
    }
  } catch (err) {
    if (isEnoent(err)) return { lines: [], truncated: false };
    throw wrapIoError(err);
  }
  return splitLines(buf.toString("utf8"), truncated);
}

function splitLines(content: string, truncated: boolean): RawLines {
  if (content.length === 0) return { lines: [], truncated };
  // Truncation cuts at byte level: drop the last incomplete line so every
  // parsed line is a complete JSONL record.
  const usable = truncated
    ? content.slice(0, content.lastIndexOf("\n") + 1)
    : content;
  if (usable.length === 0) return { lines: [], truncated };
  return {
    lines: usable.split("\n").filter((l) => l.trim().length > 0),
    truncated,
  };
}

function isEnoent(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === "ENOENT"
  );
}

function wrapIoError(err: unknown): TraceReadError {
  const code =
    typeof err === "object" &&
    err !== null &&
    typeof (err as { code?: unknown }).code === "string"
      ? (err as { code: string }).code
      : "IO";
  return new TraceReadError(`trace file read failed: ${code}`);
}

// -- parseLines ----------------------------------------------------------------

interface ParsedLines {
  readonly rows: TraceRecordRow[];
  readonly skippedLines: number;
}

/**
 * Parse each line as JSON. Failed parses and non-plain-object results
 * (numbers, strings, arrays, null) count as skipped lines.
 */
function parseLines(lines: ReadonlyArray<string>): ParsedLines {
  const rows: TraceRecordRow[] = [];
  let skippedLines = 0;
  for (const line of lines) {
    const row = parseOneLine(line);
    if (row === undefined) skippedLines += 1;
    else rows.push(row);
  }
  return { rows, skippedLines };
}

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
  return parsed as TraceRecordRow;
}

// -- applyFilter ---------------------------------------------------------------

/** Exact-match filter on conversation_id / record_type / status. */
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

/** Descending ISO8601 string compare; rows without a time keep stable order. */
function sortByTimeDesc(rows: ReadonlyArray<TraceRecordRow>): TraceRecordRow[] {
  return [...rows].sort((a, b) => {
    const ta = sortTimeOf(a);
    const tb = sortTimeOf(b);
    // "" sorts last: rows with a timestamp come first; among timestamped rows
    // ISO lexicographic order == chronological order.
    if (ta === tb) return 0;
    if (ta === "") return 1;
    if (tb === "") return -1;
    return ta < tb ? 1 : -1;
  });
}

// -- factory -------------------------------------------------------------------

export function createJsonlTraceReader(
  options: JsonlTraceReaderOptions
): JsonlTraceReader {
  const { filePath } = options;
  const maxBytes = options.maxBytes ?? MAX_TRACE_BYTES;

  return {
    query(query: TraceQuery = {}): TraceQueryResult {
      const raw = readAllLines(filePath, maxBytes);
      const { rows, skippedLines } = parseLines(raw.lines);
      const sorted = sortByTimeDesc(rows);
      const filtered = applyFilter(sorted, query);
      const records = applyPagination(filtered, query);
      return {
        records,
        total: filtered.length,
        skippedLines,
        truncated: raw.truncated,
      };
    },
  };
}
