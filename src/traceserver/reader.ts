/**
 * JSONL trace file reader (read side of the trace inspection panel).
 *
 * 同步读取的理由: 写侧用 appendFileSync (ADR-0003 D11)，读侧与之对称；
 * 面板查询量级是「单次点击拉一页」而非持续流式读取，8MB 上限内同步
 * readFileSync 的延迟可忽略，且避免引入异步状态管理。
 *
 * Overflow 护栏: 文件超过 maxBytes 时只读前 maxBytes 字节，按行边界截断
 * (丢弃最后一个不完整行)，并置 truncated=true — 不抛错。上限可经工厂
 * opts 注入覆盖 (测试用小值，避免写 8MB)。contains 查询例外：改走
 * MAX_TRACE_BYTES_FOR_CONTAINS (256MB) 上限，见 readLinesFrom。
 *
 * 增量读取 (SC-R 14): `?poll=<ms>` 轮询场景下前端把上一轮响应里的 `offset`
 * 作为 `resumeOffset` 传回 — reader 只读该字节偏移之后的追加行，避免重复
 * 解析历史。若文件被替换 (resumeOffset 落在新文件大小之外) → 从文件头召回
 * 全量。语义详见 readLinesFrom。
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
 * contains 查询的读窗上限 (256 MiB)。contains 提供时绕过 8 MiB 现状帽全文件
 * 扫描 — 39 MB 级 trace 找「哪条记录提到 X」正是本参数的存在理由；帽只防
 * 失控 (误把 GB 级文件喂进来)，超限时**抛 TraceReadError** 而不是静默截断
 * (静默截断会让 contains 在大 trace 上悄悄变成「只扫前半段」的盲查询 —
 * 与本参数要解决的问题同形)。可经工厂 opts.containsMaxBytes 注入覆盖 (测试用)。
 */
export const MAX_TRACE_BYTES_FOR_CONTAINS = 256 * 1024 * 1024;

export interface JsonlTraceReaderOptions {
  readonly filePath: string;
  readonly maxBytes?: number;
  /** contains 查询的读窗上限; 缺省 MAX_TRACE_BYTES_FOR_CONTAINS (测试注入小值)。 */
  readonly containsMaxBytes?: number;
}

export interface JsonlTraceReader {
  query(q?: TraceQuery): TraceQueryResult;
}

// -- readLinesFrom ------------------------------------------------------------

interface RawLines {
  readonly lines: ReadonlyArray<string>;
  /** 本段读到的最后一个完整行**结尾**的字节偏移 (含换行符)，供下轮轮询续读。 */
  readonly nextOffset: number;
  readonly truncated: boolean;
}

/**
 * Read the file from byte `startOffset` up to maxBytes.
 *
 * 增量语义: 从 startOffset 处定位 (pread)，只读 startOffset 之后的字节。
 * 文件被替换 (startOffset > stat.size 且 startOffset > 0) → 从文件头召回
 * 全量 (写侧 appendFileSync 只增长，startOffset 越过 size 只可能是文件被
 * 整个替换/重建)。ENOENT → 空段 (文件被删/未创建，轮询静默)。
 * Size - startOffset > maxBytes → 只读该窗口的前 maxBytes 字节，按行边界
 * 截断 (truncated=true)。其它 IO 错误 (EISDIR 等) → TraceReadError。
 *
 * nextOffset 计算: 当前段若以完整换行结尾 → 直接取绝对结尾；否则去掉末尾
 * 未终结行 (半行，可能是截断或写入进行中) — 下轮续读时重新读该行，保证
 * 每条 JSONL 只被消费一次。
 *
 * contains (trace-mcp-args-search task): 提供时对**原始行文本**做大小写敏感
 * 子串预过滤 — raw 不命中的行直接丢弃，不进 parseLines (省 JSON.parse CPU)。
 * 过滤发生在行边界切分之后、解析之前，所以 nextOffset / truncated 等字节级
 * 语义不受影响。
 */
function readLinesFrom(
  filePath: string,
  maxBytes: number,
  startOffset: number,
  contains?: string
): RawLines {
  // ENOENT 判定收敛在 statSize: 不存在的文件 → size=0，走下方空段分支
  // (轮询静默，与本函数既有的静默降级语义一致)。
  const size = statSize(filePath);
  if (startOffset > size) {
    // 文件被替换 (resumeOffset 落在新文件之外) → 召回，从文件头重读。
    // startOffset > 0 且 > size 才能判定替换；若 startOffset === 0 则本就在
    // 文件头，没有替换语义。
    if (startOffset > 0) return readLinesFrom(filePath, maxBytes, 0, contains);
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
  // 空串 contains 视为未提供 (includes("") 恒真等于无过滤，却会错误绕过
  // 现状帽) — 「空串 = 未提供」在此层与 query-trace-core 的校验层同义。
  if (!contains) return raw;
  return { ...raw, lines: raw.lines.filter((line) => line.includes(contains)) };
}

function splitLines(
  content: string,
  startOffset: number,
  truncated: boolean
): RawLines {
  if (content.length === 0) {
    // 空段: 空文件，或无新增 (size === startOffset)。nextOffset 保持起点，
    // 下轮轮询从同一偏移继续，不回头重读。
    return { lines: [], nextOffset: startOffset, truncated };
  }
  let usable: string;
  if (content.endsWith("\n")) {
    // 完整终结段: 每个字符都是完整行。段内行分隔 \n 为单字节，非 \n 的
    // UTF-8 多字节序列不会跨行，故 Buffer.byteLength(content) 即绝对偏移。
    usable = content;
  } else {
    // 段未以换行结尾: 最后一行不完整 (写入进行中或被 maxBytes 截断)。
    // 只保留此前完整行；末行留到下轮从头重读。
    const nl = content.lastIndexOf("\n");
    if (nl === -1) {
      // 一段内连一个完整行都没有 → 无可解析行，nextOffset 保持起点。
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

/**
 * Parse a single line into a TraceRecordRow.
 *
 * 未知字段兜底 (SC-R 15): 行内不在 TRACE_FIELD_DEFS 声明 (jsonlKey) 的顶层
 * 键收进 `raw.unmapped` 数组 (面板「其他字段」渲染)。只有存在未知字段时才
 * 添加 `raw` 键，避免污染每一行；已知字段的 key 不受影响。
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

// -- applyFilter ---------------------------------------------------------------

/**
 * Exact-match filter on conversation_id / record_type / status +
 * task_id / parent_turn_id / turn_id. 全部 AND 组合, 缺省 undefined 的被滤条件不生效。
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
    // T5 (#358): task_id / parent_turn_id 精确匹配。缺省 undefined 时跳过
    // (缺失 key 的行视为不匹配, 不参与成功判定)。空字符串值已在上游
    // http.ts parseStringParam 拒绝 400, 不会到达 filter。
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
  const containsMaxBytes =
    options.containsMaxBytes ?? MAX_TRACE_BYTES_FOR_CONTAINS;

  return {
    query(query: TraceQuery = {}): TraceQueryResult {
      const startOffset = Math.max(0, query.resumeOffset ?? 0);
      // contains 提供时绕过 8 MiB 现状帽, 改走 containsMaxBytes (缺省 256 MiB)
      // 上限 — 这就是为什么 39 MB 级 trace 上找「哪条记录提到 X」需要这一档
      // 帽: 8 MiB 帽会把整个 trace 的后半段挡在门外。文件超过该上限 → 抛
      // TraceReadError 而不是静默截断, 因为截断后的 contains 是一个不诚实的
      // 搜索结果 (与本参数要解决的问题同形)。未提供时行为完全不变 (走
      // `maxBytes`, 即 8 MiB 默认)。
      if (query.contains !== undefined) {
        // 预检与读窗用同一上限 (containsMaxBytes): 读窗若取 max(contains, max)
        // 反而制造两个上限互相矛盾 — containsMaxBytes < maxBytes 时读窗更大
        // 却仍按 containsMaxBytes 拒查。
        const size = statSize(filePath);
        if (size > containsMaxBytes) {
          throw new TraceReadError(
            `contains query refused: trace file exceeds the ${containsMaxBytes}-byte ` +
              `scan cap (size=${size}); narrow the query or raise containsMaxBytes`
          );
        }
        const raw = readLinesFrom(
          filePath,
          containsMaxBytes,
          startOffset,
          query.contains
        );
        return finishQuery(raw, query);
      }
      const raw = readLinesFrom(filePath, maxBytes, startOffset);
      return finishQuery(raw, query);
    },
  };

  function finishQuery(raw: RawLines, query: TraceQuery): TraceQueryResult {
    const { rows, skippedLines } = parseLines(raw.lines);
    const sorted = sortByTimeDesc(rows);
    const filtered = applyFilter(sorted, query);
    const records = applyPagination(filtered, query);
    return {
      records,
      total: filtered.length,
      skippedLines,
      truncated: raw.truncated,
      offset: raw.nextOffset,
    };
  }
}

/**
 * stat size helper for the contains cap check. ENOENT → 0 (不存在的文件由
 * readLinesFrom 的既有静默降级处理, 不在这里抛)。
 */
function statSize(filePath: string): number {
  try {
    return statSync(filePath).size;
  } catch (err) {
    if (isEnoent(err)) return 0;
    throw wrapIoError(err);
  }
}
