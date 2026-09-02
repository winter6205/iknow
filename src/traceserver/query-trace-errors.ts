/**
 * Domain errors raised by the shared query_trace read-side core.
 *
 * Messages carry no tool name: this core backs several tools on each thin face,
 * so naming one would misreport the others. Prefixing belongs to the faces.
 */

/**
 * 读侧共用的校验错误，两条轴都抛它（`query_trace` 的 limit / detail，
 * `list_sessions` 的 limit / offset）：ACI 薄皮的 catch arm 按 `instanceof` 认它，
 * spec SC20 按 `kind` 计数，所以两张皮共用一份、不各立一个同形类。
 * 类名里的 `QueryTrace` 是历史名，重命名另开票（plan `trace-mcp-read-side-split`
 * §待写入），不在本轮中途改判别名的字符串面。
 */
export class TraceQueryValidationError extends Error {
  override readonly name = "TraceQueryValidationError";
  readonly kind = "validation" as const;
  readonly field: string;

  constructor(field: string, message: string) {
    super(message);
    this.field = field;
  }
}

export class TraceQueryRecordScanError extends Error {
  override readonly name = "TraceQueryRecordScanError";
  readonly kind = "record_scan" as const;
  readonly recordId: string;
  readonly scanned: number;

  constructor(recordId: string, scanned: number) {
    super(
      `record_id scan exhausted after ${scanned} records before finding '${recordId}'`
    );
    this.recordId = recordId;
    this.scanned = scanned;
  }
}
