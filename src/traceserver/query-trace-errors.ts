/** Domain errors raised by the shared query_trace read-side core. */

export class TraceQueryValidationError extends Error {
  override readonly name = "TraceQueryValidationError";
  readonly kind = "validation" as const;
  readonly field: string;

  constructor(field: string, message: string) {
    super(`query_trace: ${message}`);
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
      `query_trace: record_id scan exhausted after ${scanned} records before finding '${recordId}'`
    );
    this.recordId = recordId;
    this.scanned = scanned;
  }
}
