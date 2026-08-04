/**
 * src/harness/permission/prefixes.ts
 *
 * SSOT (Single Source of Truth) for violation message prefixes. Emitters
 * (permission-executor, fs-policy, network-policy, hard-walls) and the
 * categorizer (sandbox/violation-handling) all consume this table so a
 * future prefix change cannot silently desynchronize the emit side from
 * the recognize side.
 *
 * Location rationale: `permission/` does NOT import from `sandbox/`, but
 * `sandbox/` imports types from `permission/`. Putting the table here as a
 * leaf module (no inbound runtime imports) keeps both directions safe:
 *   - permission/policy.ts, permission-executor.ts → import from here
 *   - sandbox/fs-policy.ts, sandbox/network-policy.ts → import from here
 *   - sandbox/violation-handling.ts → import from here
 *
 * If you add a new violation category (e.g. `[rate_limited]`), update this
 * table AND the categorization regex in `categorizeResult`.
 */

export const VIOLATION_PREFIXES = Object.freeze({
  hardWall: "[hard_wall]",
  permissionDenied: "[permission_denied]",
  userDenied: "[user_denied]",
  networkDenied: "[network_denied]",
  fsDenied: "[fs_denied]",
  hookBlocked: "[hook_blocked]",
});

export type ViolationPrefixName = keyof typeof VIOLATION_PREFIXES;
