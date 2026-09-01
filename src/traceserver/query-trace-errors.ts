/**
 * Domain errors raised by the shared query_trace read-side core.
 *
 * Messages carry no tool name: this core backs several tools on each thin face,
 * so naming one would misreport the others. Prefixing belongs to the faces.
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
