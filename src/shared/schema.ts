/**
 * Machine-consumable TypeScript contracts for iknow CLI session.
 *
 * Source of truth: SessionContext — the harness-injected session marker.
 * Authorization lives entirely in the harness ACI decor layer
 * (src/harness/aci/); no caller-role classification is expressed here.
 */

// ---------------------------------------------------------------------------
// Session (harness-injected; not a tool input)
// ---------------------------------------------------------------------------

/**
 * Harness-injected session marker. Intentionally empty; kept as a named type
 * so the harness has a stable injection seam to grow into.
 */
export interface SessionContext {}
