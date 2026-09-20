/**
 * Shared integer-argument validation for the read side (traceserver bounded
 * context).
 *
 * Extracted from the private `parseInteger` in `query-trace-core.ts` (same
 * move as io.ts extracting duplicated reader/sessions helpers): the
 * `limit` / `offset` of `list_sessions` and the `limit` / `resume_offset` of
 * `query_trace` follow one bound rule, and the error text must stay
 * byte-identical — otherwise the same overflow prints two different
 * messages on the two shells.
 *
 * The thin shells (ACI ajv / MCP zod) already declare and enforce the same
 * bounds on their side; this helper is the core's re-check, keeping the
 * "read unit" concept single-sourced so the core still reports honestly when
 * a shell slips.
 */
import { TraceQueryValidationError } from "./query-trace-errors.js";

/**
 * Parse an optional integer argument: `undefined` returns as-is (the caller
 * supplies its own default); otherwise it must be an integer within
 * `[minimum, maximum]`, out of bounds throws `validation`.
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
