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
  /**
   * Optional input-specific reason override (SC3,
   * specs/mutate-write-contract.md): when present and it returns a string,
   * that string replaces the static `reason` in the deny outcome so the
   * message can carry the specific matched pattern id. Falls back to the
   * static `reason` when absent or undefined.
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

/** Project settings layer; the actual loader is T6 (#122 Q2b). */
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
    /** Caller cancellation must release the permission waiter. */
    readonly signal?: AbortSignal;
  }): Promise<boolean>;
}

/**
 * Pre 钩子的拦截语义（#126 D1 类型收窄）。
 *
 * 钩子只表达「拦」：返回 PreHookBlock = 拦下该调用（reason 被 executor 包装为
 * `[hook_blocked] <reason>` 回灌模型）；返回 undefined = 放行（进入 checkPermission）。
 * 特意不复用 PermissionOutcome —— 后者属于权限层（policy/checkPermission），
 * 钩子从未实现 ask/allow 语义，用专用类型让「deny-only」成为编译期事实。
 */
export interface PreHookBlock {
  readonly reason: string;
}

/**
 * PreToolUse hook (chain step 1)。
 * deny-only：返回 PreHookBlock = 拦截（executor 包装 `[hook_blocked] <reason>`）；
 * 返回 undefined = 放行。异常语义（#126 D3）由 executor 调用点承载（fail-closed）。
 *
 * #global-plugins T2 加性放宽：返回类型加 `Promise<PreHookBlock | undefined>`
 * —— 插件 hook 需异步 spawn 子进程。既有同步实现零改动（同步返回仍是该联合
 * 的成员，赋值兼容）；调用点必须 await（不 await 会拿到恒 truthy 的 Promise
 * 而不是 block —— gateOne 已 await）。
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
 * #global-plugins T2 加性放宽：返回类型加 `Promise<void>` —— 插件 hook 异步
 * 执行。异步拒绝由调用点收口（permission-executor `runAllowed` 的
 * `await post(...)` + try/catch；sandbox/violation-executor `observe` 同款），
 * 不让 rejected promise 逃逸成 unhandledRejection；「不改变工具结果」不变量不变。
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
    /** T4 #298:ok 变体的观测 side-channel；模型不可见。 */
    readonly meta?: ToolResultMeta;
  }): void | Promise<void>;
}
