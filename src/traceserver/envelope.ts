/**
 * The read side's shared response envelope (wire shape, snake_case).
 *
 * panel face (`http.ts` → Web UI) 与 tool face (`query-trace-core.ts` → ACI /
 * MCP) **不再共用**信封构造：从 plan `trace-mcp-read-side-split` T7 起，
 * `total` / `truncated` 是面板分页语义（ADR-0020 D1.1），不再出现在工具面
 * （契约 X / ADR-0004:23 / spec SC7）。本文件仍留下 `ResponseEnvelope` /
 * `toResponseEnvelope` 给面板沿用；工具面改用 `QueryTracePage` /
 * `toQueryTracePage`（plan §序列化 对 T7 的硬约束：另立一个构造，**不得**
 * 给 `toResponseEnvelope` 加「哪张皮」的开关）。
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
 * reader 结果 → 面板信封。`records` 用于替换成投影后的记录，省略则原样带上
 * reader 的原始行。键序固定为 records / total / skipped_lines / truncated /
 * offset：键序不影响序列化长度，但面板输出哪些字节由它决定。
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

/** 无数据可读时的面板信封：目录里还没有会话。 */
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
 * tool face 的 `query_trace` 信封形状：行筛选 + 行分页的一页，
 * **不含** `total` / `truncated`。
 *
 * - `records`：投影后的记录数组（list 路径）。
 * - `limit` / `offset`：生效坐标（即「调用方实际用到的值」—— 缺省也物化），续
 *   取 = `offset + records.length`，`records.length < limit` 即「到底」信号。
 * - 不带 `skipped_lines`：JSONL 解析失败条数对工具面无意义（行轴的续取是 row
 *   级而非字节级，且工具面删除了字节轮询 `resume_offset`），把它混进 envelope
 *   会把面板读侧的诊断字段错认作工具契约的一部分。
 *
 * 同形判据：plan §序列化 + 第 12 条的 `ListSessionsPage` 同款语义，「records 数
 * 组 + 回显生效坐标」是三轴工具面的统一形状。
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
