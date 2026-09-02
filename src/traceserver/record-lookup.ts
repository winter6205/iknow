/**
 * `record_id` 查找 —— 读侧两条内容轴共用的**唯一**一份扫描实现。
 *
 * 为什么必须单一实现（plan `trace-mcp-read-side-split` T6 AC）：`query_trace`
 * 的下钻与 `get_record` 都要「在同一会话里按 10 个 id 字段找一个 id」。两处各写
 * 一遍，扫描上限、字段顺序、以及「扫到上限」与「扫完了没有」这两种失败就会各自漂
 * 移 —— 而它们是调用方据以决定下一步的事实，不是实现细节。T7 把行轴瘦成
 * 「行筛选 + 行分页」后，本文件是唯一的 `record_id` 入口。
 *
 * 归属边界：本文件只做「定位到哪一行 + 它的标量投影」。线形状（行轴的
 * envelope vs 内容轴的 `{record, matched_on}`）、错误类型选择（行轴现状的静默空
 * 列表 vs 内容轴的 `record_not_found`）都留在各自核里。
 */
import { TraceQueryRecordScanError } from "./query-trace-errors.js";
import type { JsonlTraceReader } from "./reader.js";
import type { TraceQuery, TraceRecordRow } from "./types.js";

/**
 * 一行可能携带 id 的 10 个字段（写侧 src/harness/trace/ 各 record 类型的 *_id
 * 键）。**顺序即优先级**：一行同时带 `llm_call_id` 与 `turn_id` 时 `matched_on`
 * 报前者，而 `get_record` 会把它回给调用方 —— 所以这份名单是答案的一部分，不是
 * 内部细节。
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
 * 一次 `record_id` 查找最多读多少条记录。10 000 是「一次调用可接受的解析量」，
 * 不是某个实测分布：到量即停止翻页，好把 `record_scan`（没扫完）与
 * `record_not_found`（扫完了，没有）分开 —— 合并这两者会让调用方以为一个存在的
 * id 不存在。
 */
export const TRACE_RECORD_ID_SCAN_LIMIT = 10_000;

/**
 * 扫描内部的 reader 分页大小。与 `QUERY_TRACE_MAX_LIMIT`（调用方可请求的页面上
 * 限）是两个概念，只是当前取同一个数字；本文件刻意不 import 那一侧，免得
 * query-trace-core ↔ record-lookup 互相依赖。
 */
const SCAN_PAGE_SIZE = 200;

export interface RecordMatch {
  readonly row: TraceRecordRow;
  /** 命中它的那个 id 字段名；调用方靠它回答「我给的 id 是哪条轴」。 */
  readonly matchedOn: string;
}

export interface RecordLookupResult {
  /** undefined = 扫完了整个会话仍无命中。 */
  readonly match?: RecordMatch;
  readonly skippedLines: number;
  readonly truncated: boolean;
  readonly offset: number;
}

/**
 * 按 `record_id` 找一行：分页读到命中、或读到文件末尾、或读到
 * `TRACE_RECORD_ID_SCAN_LIMIT`。
 *
 * `query` 让调用方带上既有筛选（行轴下钻沿用其筛选条件），本函数只覆写 `limit` /
 * `offset` 这两个自己管辖的分页坐标。
 *
 * 两种「没找到」在此分道：扫到上限仍未命中 → 抛 `TraceQueryRecordScanError`
 * （`record_scan`）；扫完了没有 → 返回无 `match`，由调用方决定那是静默空列表
 * （行轴现状）还是 `record_not_found`（内容轴，plan T6）。
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
 * 记录的标量投影：丢掉 `messages`（体积来源，交给行轴的预览或内容轴的窗）与
 * `raw`（reader 为未知字段另加的副本，正文已在行上）。两条轴都用它，所以
 * 「record 标量里有什么」只有一处定义。
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
