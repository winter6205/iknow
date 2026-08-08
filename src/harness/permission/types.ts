/**
 * src/harness/permission/types.ts
 *
 * v0 permission three-layer graduation types (#115 / #122).
 *
 * Spec references:
 *  - PermissionDecision "allow" | "deny" | "ask" (replaces prototype "pass_through").
 *  - PermissionOutcome carries reason; deny reasons are prefixed at the call sites
 *    (hook_blocked / permission_denied / user_denied) so the loop / trace can
 *    attribute the source without losing the structured outcome.
 *  - ToolCategory is the surface the executor uses for category defaults; AciMeta.category
 *    maps 1:1 — see aci/types.ts AciCategory.
 *  - HardRuleSpec implements the un-overrideable security backstop (execute dangerous
 *    commands, sensitive paths).
 *  - Normal rules are layered: session > project > code; first hit from highest layer
 *    wins (per "上层覆盖下层"; see spec §plan T2).
 *  - Policy sources are pluggable; v0 ships three: CodeBuiltInPolicySource (always),
 *    ProjectSettingsPolicySource (loader in T6), SessionGrantsPolicySource (in-memory).
 *  - AskUser / Pre/Post hook interfaces: askUser is mandatory at construction time
 *    (ask_inlet_missing fail-loud per #162).
 */

import type { AciCategory } from "../aci/types.js";
import type { ToolResultMeta } from "../tools/types.js";

/** Decision triple (spec Q1). Replaces prototype "pass_through". */
export type PermissionDecision = "allow" | "deny" | "ask";

/** Surface returned from any check; consumers reason about decision + reason. */
export interface PermissionOutcome {
  readonly decision: PermissionDecision;
  /** Human/model-readable explanation; deny reasons carry a source prefix
   *  (hook_blocked / permission_denied / user_denied) at the call site. */
  readonly reason: string;
}

/** Tool category mirrors AciCategory but lives in permission/ to avoid an import cycle. */
export type ToolCategory = AciCategory;

/**
 * Un-overrideable security rule: matched rules short-circuit to deny; upper layers
 * (session / project) cannot relax a hard-wall. tier="hard-wall" stays the same in
 * outcome so tests can attribute.
 */
export interface HardRuleSpec {
  readonly id: string;
  /** Predicate against the raw call input; must be a pure function. */
  readonly match: (input: {
    readonly tool: string;
    readonly input: unknown;
  }) => boolean;
  readonly decision: "deny";
  readonly reason: string;
  readonly tier: "hard-wall";
}

/**
 * Layered rule (session > project > code). First matching rule from the highest
 * priority layer decides; lower layers are skipped for that one call.
 */
export interface NormalRuleSpec {
  readonly id: string;
  readonly match: (input: {
    readonly tool: string;
    readonly input: unknown;
  }) => boolean;
  readonly decision: PermissionDecision;
  readonly reason: string;
}

/** Built-in layer (always present; lowest priority normal layer). */
export interface CodeBuiltInPolicySource {
  readonly kind: "code";
  readonly rules: ReadonlyArray<NormalRuleSpec>;
}

/** Project settings layer; the actual loader is T6 (#122 Q2b). */
export interface ProjectSettingsPolicySource {
  readonly kind: "project";
  readonly filePath: string;
  readonly rules: ReadonlyArray<NormalRuleSpec>;
}

/** Session grants layer (in-memory, no persistence in v0). */
export interface SessionGrantsPolicySource {
  readonly kind: "session";
  readonly rules: () => ReadonlyArray<NormalRuleSpec>;
}

export type PermissionSource = "code" | "project" | "session";

/**
 * askUser inlet: true = approve, false = deny (fail-closed).
 * Mandatory at engine construction time (#162); missing at startup throws
 * with `ask_inlet_missing` substring so call sites can detect.
 */
export interface AskUser {
  (ctx: {
    readonly tool: string;
    readonly input: unknown;
    readonly summaryHint: string;
  }): Promise<boolean>;
}

/**
 * PreToolUse hook (chain step 1).
 * Return non-undefined to short-circuit (decision + reason).
 * reason will be wrapped at the executor as `[hook_blocked] <reason>`.
 */
export interface PreToolUseHook {
  (ctx: {
    readonly tool: string;
    readonly input: unknown;
  }): PermissionOutcome | undefined;
}

/** PostToolUse hook (chain step 5). Observability only; cannot influence outcome. */
export interface PostToolUseHook {
  (result: {
    readonly toolUseId: string;
    readonly name: string;
    readonly input: unknown;
    /** ok | validation_failed | tool_not_found | execution_failed */
    readonly kind:
      "ok" | "validation_failed" | "tool_not_found" | "execution_failed";
    readonly message?: string;
    readonly payload?: unknown;
    /** T4 #298:ok 变体的观测 side-channel；模型不可见。 */
    readonly meta?: ToolResultMeta;
  }): void | undefined;
}
