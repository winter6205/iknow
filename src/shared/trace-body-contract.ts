/**
 * SSOT for the trace-permitted body reference contract.
 *
 * Placement rationale: `src/shared/` is the neutral layer (same reason as
 * `session-tree-names.ts`) — `src/traceserver/` may not import `harness/`
 * (Assumption 5, pinned by `tests/traceserver/output-backstop.test.ts`), and
 * the write side is `harness/trace/trace-body.ts`. Pure declarations only: no
 * filesystem or crypto IO belongs in the contract.
 */

/** Representation tag stamped on every trace-permitted body. */
export const TRACE_BODY_REPRESENTATION = "masked-trace-v1";

/** sha256 hex alphabet — the only shape a body filename may take. */
const SHA_HEX_RE = /^[0-9a-f]{64}$/;

export interface TraceBodyRef {
  /** sha256 hex of the masked bytes. */
  readonly sha: string;
  /** UTF-8 byte length of the masked bytes. */
  readonly bytes: number;
  /** Consumer authority for the bytes behind `sha`. */
  readonly representation: typeof TRACE_BODY_REPRESENTATION;
}

/** True only for the exact recognized trace representation tag — a raw native
 *  state tag must never pass here. */
export function isTraceBodyRepresentation(
  value: unknown
): value is typeof TRACE_BODY_REPRESENTATION {
  return value === TRACE_BODY_REPRESENTATION;
}

/** True only for a lowercase 64-hex sha256 body address; rejects anything that
 *  could turn the body path into a traversal or a non-hex name. */
export function isTraceBodySha(value: unknown): value is string {
  return typeof value === "string" && SHA_HEX_RE.test(value);
}
