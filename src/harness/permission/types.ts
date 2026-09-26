/**
 * src/harness/permission/types.ts
 *
 * Permission model types: three decision values, layered rules, hooks.
 *
 * - PermissionDecision is "allow" | "deny" | "ask".
 * - PermissionOutcome carries reason; deny reasons are prefixed at the call
 *   sites (hook_blocked / permission_denied / user_denied) so the loop / trace
 *   can attribute the source without losing the structured outcome.
 * - ToolCategory is the surface the executor uses for category defaults;
 *   AciMeta.category maps 1:1 — see aci/types.ts AciCategory.
 * - HardRuleSpec implements the un-overrideable security backstop (dangerous
 *   commands, sensitive paths).
 * - Normal rules are layered: session > project > code; first hit from the
 *   highest layer wins (higher layer overrides lower).
 * - Policy sources are pluggable; three ship here: CodeBuiltInPolicySource
 *   (always), ProjectSettingsPolicySource, SessionGrantsPolicySource (in-memory).
 * - askUser is mandatory at construction time (ask_inlet_missing fail-loud).
 */

import type { AciCategory } from "../aci/types.js";
import type { ToolResultMeta } from "../tools/types.js";

/** Decision triple: "allow" | "deny" | "ask". */
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
  /**
   * Optional input-specific reason override (ADR-0125, SC3 of
   * specs/substitution-hard-walls.md):
   * when present and it returns a string, that string replaces the static
   * `reason` in the deny outcome so the message can carry the specific
   * matched pattern id. Falls back to the static `reason` otherwise.
   */
  readonly reasonFor?: (input: {
    readonly tool: string;
    readonly input: unknown;
  }) => string | undefined;
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

/** Project settings layer. */
export interface ProjectSettingsPolicySource {
  readonly kind: "project";
  readonly filePath: string;
  readonly rules: ReadonlyArray<NormalRuleSpec>;
  /**
   * Optional startup `PermissionMode` seed (ADR-0090). Only `default` /
   * `plan` are legal here — `full_auto` is rejected at load time as a
   * shared-repo self-grant. Absent = no seed; CLI / `IKNOW_PERMISSION_MODE`
   * / `/permissions` / Shift+Tab all still override.
   */
  readonly defaultMode?: "default" | "plan";
}

/** Session grants layer (in-memory). */
export interface SessionGrantsPolicySource {
  readonly kind: "session";
  readonly rules: () => ReadonlyArray<NormalRuleSpec>;
}

export type PermissionSource = "code" | "project" | "session";

/**
 * askUser inlet: true = approve, false = deny (fail-closed).
 * Mandatory at engine construction time; missing at startup throws with the
 * `ask_inlet_missing` substring so call sites can detect.
 */
export interface AskUser {
  (ctx: {
    readonly tool: string;
    readonly input: unknown;
    readonly summaryHint: string;
    /** Caller cancellation must release the permission waiter. */
    readonly signal?: AbortSignal;
  }): Promise<boolean>;
}

/**
 * Pre-hook blocking semantics.
 *
 * The hook expresses only "block": returning PreHookBlock stops the call
 * (the executor wraps reason as `[hook_blocked] <reason>` back to the
 * model); returning undefined lets it through to checkPermission.
 * PermissionOutcome is deliberately not reused — it belongs to the
 * permission layer; the hook never implements ask/allow, so a dedicated
 * type makes "deny-only" a compile-time fact.
 */
export interface PreHookBlock {
  readonly reason: string;
}

/**
 * PreToolUse hook (chain step 1). Deny-only: returning PreHookBlock blocks
 * (executor wraps `[hook_blocked] <reason>`); undefined passes through.
 * Throwing is handled fail-closed at the executor call site.
 *
 * May be async (returns `Promise<PreHookBlock | undefined>`) because plugin
 * hooks spawn subprocesses. Existing sync implementations stay compatible;
 * call sites must await — an un-awaited Promise is always truthy and would
 * be mistaken for a block.
 */
export interface PreToolUseHook {
  (ctx: {
    readonly tool: string;
    readonly input: unknown;
  }): PreHookBlock | undefined | Promise<PreHookBlock | undefined>;
}

/**
 * PostToolUse hook (chain step 5). Observability only; cannot influence outcome.
 *
 * May be async (`Promise<void>`) for the same reason. Async rejections are
 * collected at the call sites (permission-executor `runAllowed` awaits
 * `post(...)` in try/catch; sandbox/violation-executor `observe` does the
 * same) so no rejected promise escapes as unhandledRejection; the "never
 * changes the tool result" invariant is unchanged.
 */
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
    /** Observation side-channel of the ok variant; invisible to the model. */
    readonly meta?: ToolResultMeta;
  }): void | Promise<void>;
}
