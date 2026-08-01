/**
 * Machine-consumable TypeScript contracts for iknow CLI session.
 *
 * Source of truth: SessionContext — the harness-injected session marker.
 * Authorization lives entirely in the harness ACI decor layer
 * (src/harness/aci/); no caller-role classification is expressed here.
 *
 * 023 retired: kb_* 4-tool contracts (kb_retrieve / kb_verify_citation /
 * kb_compile / kb_governance) moved to docs/archive/023-retire-kb-tools/.
 * ACL is now expressed via harness ACI decor layer's AciMeta + permission
 * policy, not protocol types.
 */

// ---------------------------------------------------------------------------
// Session (harness-injected; not a tool input)
// ---------------------------------------------------------------------------

/**
 * Harness-injected session marker. Intentionally empty: the retired agent-loop
 * caller-role / governance fields were removed once their enforcement points
 * were archived (docs/archive/022 + 023). Kept as a named type so the harness
 * has a stable injection seam to grow into.
 */
export interface SessionContext {}
