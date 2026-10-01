/**
 * ACI capability layer: permission-check compatibility entry (graduation
 * transition).
 *
 * Decisions and decision objects moved to `src/harness/permission/`; this
 * file keeps the allowlist / dangerous-command detectors (`isAllowedCommand`
 * / `isDangerousCommand` / `firstToken` / `SHELL_METACHARS`) as defense in
 * depth (the hard walls reference only dangerous patterns + sensitive paths;
 * non-whitelisted commands fall into ask, with runtime boundaries owned by
 * bwrap).
 *
 * `checkPermission` now lives in `permission/checkPermission` (the 5-step
 * middleware chain is in `permission/permission-executor.ts`). To avoid
 * breaking existing tests / tool code, this file re-exports the pure
 * `createPermissionPolicy` / `checkPermission` shapes, staying compatible
 * with the earlier prototype API.
 *
 * Also keeps the prototype's `createPermissionPolicy({defaultRule, byName})`
 * input shape as a thin wrapper (mapped internally to the new
 * `createPermissionPolicy`).
 */

import type {
  AskUser,
  PreHookBlock,
  PreToolUseHook,
  PostToolUseHook,
  PermissionOutcome,
  NormalRuleSpec,
} from "../permission/types.js";
import {
  createPermissionPolicy as createPolicyV2,
  checkPermission as checkPermissionV2,
  type PermissionPolicy as PolicyV2,
} from "../permission/policy.js";

/* -----------------------------------------------------------------------------
 * Prototype-shape thin wrapper for createPermissionPolicy
 * -------------------------------------------------------------------------- */

/** Projection of the prototype AciPermissionPolicy (defaultRule/byName). */
export interface ProtoPermissionPolicy {
  readonly defaultRule?: "allow" | "ask";
  readonly byName?: Readonly<Record<string, "allow" | "deny" | "ask">>;
}

/**
 * Back-compat: prototype callers passing `{ defaultRule, byName }` keep
 * working. Internally we map byName into normal session-style rules at
 * codeBuiltInRules slot (highest-precedence normal layer in v0 = code; the
 * wrapper injects into session so they override built-ins consistently).
 */
export function createPermissionPolicy(opts?: ProtoPermissionPolicy): PolicyV2 {
  const sessionRules: NormalRuleSpec[] = [];
  if (opts?.byName) {
    for (const [name, decision] of Object.entries(opts.byName)) {
      if (decision === "allow" || decision === "deny" || decision === "ask") {
        sessionRules.push({
          id: `proto-byname-${name}`,
          match: ({ tool }) => tool === name,
          decision,
          reason: `prototype byName: ${name} → ${decision}`,
        });
      }
    }
  }
  // defaultRule overrides category behavior; v0 simplified — see policy.ts
  const overrides = opts?.defaultRule
    ? {
        "read-only":
          opts.defaultRule === "allow" ? ("allow" as const) : ("ask" as const),
        write:
          opts.defaultRule === "allow" ? ("allow" as const) : ("ask" as const),
        execute:
          opts.defaultRule === "allow" ? ("allow" as const) : ("ask" as const),
        collaborate:
          opts.defaultRule === "allow" ? ("allow" as const) : ("ask" as const),
      }
    : undefined;
  return createPolicyV2({
    ...(sessionRules.length
      ? {
          session: {
            kind: "session" as const,
            rules: () => Object.freeze(sessionRules),
          },
        }
      : {}),
    ...(overrides ? { defaultByCategory: overrides } : {}),
  });
}

/**
 * Back-compat: pass to permission-executor / policy layer. v0 prototype callers
 * receive a wrapped shape; the prototype AciPermissionPolicy interface is no
 * longer exported as a fresh type (see types.ts re-export to PermissionPolicy).
 */
export type AciPermissionPolicyShape = PolicyV2;

/* -----------------------------------------------------------------------------
 * Bash allowlist surface (retained for bash.ts)
 * -------------------------------------------------------------------------- */

export {
  isAllowedCommand,
  isDangerousCommand,
  findDangerousPattern,
  firstToken,
  commandContainsSensitivePath,
} from "../permission/hard-walls.js";

/* -----------------------------------------------------------------------------
 * checkPermission (thin compat wrapper)
 * -------------------------------------------------------------------------- */

/** Legacy entry: takes {def, input, policy} with prototype policy shape. */
export function checkPermission(opts: {
  def: import("./types.js").AciToolDef;
  input: unknown;
  policy: PolicyV2;
}): PermissionOutcome {
  return checkPermissionV2({
    def: opts.def,
    input: opts.input,
    sources: opts.policy.sources,
    hardWalls: opts.policy.hardWalls,
    defaultByCategory: opts.policy.defaultByCategory,
    // ADR-0132/ADR-0133: forwarded from the policy so this legacy entry
    // answers with the same cleanup scope as the runtime's own gate.
    ...(opts.policy.hostRoots !== undefined
      ? { hostRoots: opts.policy.hostRoots }
      : {}),
  });
}

/* -----------------------------------------------------------------------------
 * Re-export from permission/ so the prototype import surface stays stable.
 * -------------------------------------------------------------------------- */

export type { AskUser, PreHookBlock, PreToolUseHook, PostToolUseHook };
