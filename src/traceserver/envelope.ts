/**
 * The read side's shared response envelope (wire shape, snake_case).
 *
 * panel face (`http.ts` → Web UI) 与 tool face (`query-trace-core.ts` → ACI /
 * MCP) 共用这一个类型和这一处构造。共用的**只有形状与构造**，序列化各归各：
 * 面板保留 `total` / `truncated` 给自己的分页，且没有字符帽
 * （ADR-0020 D1.1 面板语义不变）。
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
 * reader 结果 → 信封。`records` 用于替换成投影后的记录，省略则原样带上
 * reader 的原始行。键序固定为 records / total / skipped_lines / truncated /
 * offset：键序不影响序列化长度，但两张皮输出哪些字节由它决定。
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

/** 无数据可读时的信封：目录里还没有会话，或下钻没命中。 */
export function emptyResponseEnvelope(): ResponseEnvelope {
  return toResponseEnvelope({
    records: [],
    total: 0,
    skippedLines: 0,
    truncated: false,
    offset: 0,
  });
}
