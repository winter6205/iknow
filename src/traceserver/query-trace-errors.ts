/**
 * Domain errors raised by the shared read-side cores (`query_trace`,
 * `list_sessions`, `get_record`).
 *
 * Messages carry no tool name: this core backs several tools on each thin face,
 * so naming one would misreport the others. Prefixing belongs to the faces.
 *
 * spec SC20 counts the kinds: `validation` / `record_scan` / `record_not_found`
 * / `window_overflow` / `session_not_found` — five, plus the pre-existing
 * `io_error` on `TraceReadError` (types.ts). Out-of-range coordinates answer
 * `validation` with the real number of addressable items rather than growing a
 * sixth kind.
 */

/**
 * Validation error shared by all three read axes (`query_trace` limit /
 * detail, `list_sessions` limit / offset, `get_record` window coordinates
 * and out-of-range `message_index` / `part_index`): the ACI thin-shell catch
 * arm identifies it by `instanceof` and the contract counts by `kind`, so
 * both faces share one class instead of two same-shape ones.
 * `QueryTrace` in the class name is historical; renaming needs its own
 * change — the discriminator string literals stay untouched mid-flight.
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

/**
 * `record_id` found no match after scanning the whole conversation. This is
 * distinct from `record_scan`: that says "scan did not finish", this says
 * "scan finished, nothing there". `get_record` throws it instead of the
 * row axis's silent `records: []`.
 */
export class TraceRecordNotFoundError extends Error {
  override readonly name = "TraceRecordNotFoundError";
  readonly kind = "record_not_found" as const;
  readonly recordId: string;

  constructor(recordId: string) {
    super(`no record matched record_id '${recordId}'`);
    this.recordId = recordId;
  }
}

/**
 * The required `conversation_id` has no matching file under this traceDir.
 * It is **not** the same as `record_not_found`: the record may exist and
 * this face simply never looked at it (raised ahead of envelope work because
 * `get_record` is the first face where `conversation_id` is required).
 */
export class TraceSessionNotFoundError extends Error {
  override readonly name = "TraceSessionNotFoundError";
  readonly kind = "session_not_found" as const;
  readonly conversationId: string;

  constructor(conversationId: string) {
    super(`no trace session file for conversation_id '${conversationId}'`);
    this.conversationId = conversationId;
  }
}

/**
 * The caller's window passes the end of the part (`from_char + count >
 * part_chars`).
 *
 * The message carries `part_chars` and the remaining length, and returns
 * **no part bytes**: the rule is "the window must lie entirely inside the
 * part", so the right answer is "adjust your coordinates and read fully",
 * not "here, a clipped page for you" — the latter would contradict the very
 * reason this kind exists. `remaining` lets the caller compute the last
 * page's `count` in one step.
 */
export class TraceWindowOverflowError extends Error {
  override readonly name = "TraceWindowOverflowError";
  readonly kind = "window_overflow" as const;
  readonly fromChar: number;
  readonly count: number;
  readonly partChars: number;
  readonly remaining: number;

  constructor(coords: { fromChar: number; count: number; partChars: number }) {
    const remaining = Math.max(0, coords.partChars - coords.fromChar);
    super(
      `window of ${coords.count} characters at from_char=${coords.fromChar} ` +
        `exceeds the part: part_chars=${coords.partChars}, remaining=${remaining}`
    );
    this.fromChar = coords.fromChar;
    this.count = coords.count;
    this.partChars = coords.partChars;
    this.remaining = remaining;
  }
}
