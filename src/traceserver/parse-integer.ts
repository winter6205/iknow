/**
 * Shared integer-argument validation for the read side (traceserver bounded
 * context).
 *
 * 从 `query-trace-core.ts` 的私有 `parseInteger` 抽出（与 `io.ts` 抽取
 * reader/sessions 重复 helper 同法）：`list_sessions` 的 `limit` / `offset` 与
 * `query_trace` 的 `limit` / `resume_offset` 是同一条界规则，错误文案也必须逐字
 * 一致，否则两张皮上的同一个越界会打出两种消息。
 *
 * 各薄皮（ACI ajv / MCP zod）已经在自己那侧声明并执行同样的界；本 helper 是核的
 * 复查，保证「读单元」这个概念只有一个权威，薄皮漏守时核仍诚实报错。
 */
import { TraceQueryValidationError } from "./query-trace-errors.js";

/**
 * 解析一个可选的整数参数：`undefined` 直返（调用方自己给缺省），否则必须落在
 * `[minimum, maximum]` 内的整数，越界抛 `validation`。
 */
export function parseInteger(
  value: unknown,
  field: string,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER
): number | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new TraceQueryValidationError(
      field,
      `${field} must be an integer in ${minimum}..${maximum}`
    );
  }
  return value;
}
