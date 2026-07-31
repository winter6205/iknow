/**
 * Machine-consumable TypeScript contracts for iknow CLI session.
 *
 * Source of truth: caller_role enum + SessionContext (harness-injected).
 *
 * 023 retired: kb_* 4-tool contracts (kb_retrieve / kb_verify_citation /
 * kb_compile / kb_governance) moved to docs/archive/023-retire-kb-tools/.
 * ACL is now expressed via harness ACI decor layer's AciMeta + permission
 * policy, not protocol types.
 */

// ---------------------------------------------------------------------------
// Shared enums / primitives
// ---------------------------------------------------------------------------

/** Allowed session caller roles (schema truth; CLI / harness must match). */
export const CALLER_ROLES = ["employee", "manager", "admin"] as const;
export type CallerRole = (typeof CALLER_ROLES)[number];

export function isCallerRole(value: unknown): value is CallerRole {
  return (
    typeof value === "string" &&
    (CALLER_ROLES as readonly string[]).includes(value)
  );
}

/**
 * Parse a role string to CallerRole.
 * Throws Error when value is not in CALLER_ROLES (CLI / harness entry).
 */
export function parseCallerRole(value: unknown): CallerRole {
  if (isCallerRole(value)) {
    return value;
  }
  throw new Error(
    `Invalid caller role: ${JSON.stringify(value)}; expected one of: ${CALLER_ROLES.join("|")}`,
  );
}

// ---------------------------------------------------------------------------
// Session (harness-injected; not a tool input)
// ---------------------------------------------------------------------------

export interface SessionContext {
  caller_role: CallerRole;
  /**
   * Orphaned since 023 (kb_retrieve / kb_governance retired). Flag kept
   * for CLI surface compatibility; no production consumer reads it.
   * Follow-up: remove --governance-timeout flag + degrade param + this
   * field in a dedicated cleanup commit.
   */
  simulate_governance_timeout?: boolean;
}
