/**
 * `TRACE_OUTPUT_BACKSTOP` — the MCP transport's output floor for the read side.
 *
 * The value mirrors `OUTPUT_HARD_CAP` in `src/harness/tools/executor.ts`
 * (that const is not exported). **This module must not import `harness/`** —
 * the read-side core stays free of harness dependencies — so we follow the
 * existing repo convention of "same value + a comment naming the source +
 * one lock-value assertion" (as `FETCH_OUTPUT_BUDGET` in
 * `src/harness/aci/tools/web-fetch.ts` does). The assertion lives in
 * `tests/traceserver/output-backstop.test.ts`: tests may cross the boundary
 * to run executor; src may not cross it to import.
 *
 * Why the same value: truncating below the executor and silently again here
 * means two authorities each take a cut — the double truncation ADR-0006
 * explicitly warns against. The ACI surface is backstopped by executor; this
 * constant serves only the MCP surface (no executor behind that shell).
 */
export const TRACE_OUTPUT_BACKSTOP = 20_000;

/**
 * Same shape as the preview marker in `project-tool-results.ts`: two
 * truncation markers on one read side should look alike so callers
 * immediately recognize "the tail was cut". Length counts against the
 * budget above.
 */
export const TRACE_BACKSTOP_MARKER = "...[truncated]";

/**
 * Cut only when over budget, and the **marker counts against the budget**:
 * the result length is strictly ≤ `TRACE_OUTPUT_BACKSTOP`.
 *
 * Deliberately not the executor's 8-round convergence loop: that loop keeps
 * a long marker with variable-width `{original}` / `{kept}` numbers under
 * the cap. This marker is fixed-width, so a single `slice` already
 * satisfies the invariant and extra looping is pure cost (ADR-0006 demands
 * the same invariant, not the same implementation).
 */
export function applyTraceOutputBackstop(text: string): string {
  if (text.length <= TRACE_OUTPUT_BACKSTOP) return text;
  return (
    text.slice(0, TRACE_OUTPUT_BACKSTOP - TRACE_BACKSTOP_MARKER.length) +
    TRACE_BACKSTOP_MARKER
  );
}
