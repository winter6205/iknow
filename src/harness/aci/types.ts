/**
 * ACI 能力层：类型契约。
 *
 * 权限三层毕业（#122 Q5）后：删 pass_through（决策改 allow/deny/ask），
 * 删 AciMeta.isReadOnly / isDestructive（category 已是真值单一权威）；
 * 保留 category / isConcurrencySafe / interruptBehavior（#124 中断/超时）。
 *
 * 决策 / 规则 / 策略对象均移至 `src/harness/permission/` 模块，
 * 见 permission/index.ts 公共出口。
 */

import type { ToolDef } from "../tools/types.js";

/** ch04 四类安全级别（category 是 read-only / write / execute / collaborate 真值）。 */
export type AciCategory = "read-only" | "write" | "execute" | "collaborate";

/** ACI 安全/调度元数据（延迟加载 / 并发安全 / 中断行为）。 */
export interface AciMeta {
  readonly category: AciCategory;
  readonly isConcurrencySafe: boolean;
  readonly interruptBehavior: "cancel" | "block";
  /** true = 延迟加载：默认不进 prompt schema，需 discover() 检索注入。默认 false（核心常驻）。 */
  readonly lazy?: boolean;
}

/** ACI 工具定义 = 冻结 ToolDef + aci 元数据（扩展，不改协议）。 */
export interface AciToolDef extends ToolDef {
  readonly aci: AciMeta;
}

/** ACI 目录：按名定位 AciToolDef（权限层与延迟加载共用）。 */
export interface AciCatalog {
  readonly get: (name: string) => AciToolDef | undefined;
  readonly all: () => ReadonlyArray<AciToolDef>;
}

/**
 * ⚠️ Compatibility re-exports — the prototype layer used PermissionDecision,
 * PermissionOutcome, PermissionRule, AciPermissionPolicy. Those shapes live in
 * `src/harness/permission/` now (graduated as part of #122). Re-exporting them
 * here avoids breaking any prototype-importing tests while the new module
 * (the new home of these symbols) is the canonical source.
 */
export type {
  PermissionDecision,
  PermissionOutcome,
  AskUser,
  PreToolUseHook,
  PostToolUseHook,
} from "../permission/types.js";
export type { NormalRuleSpec as PermissionRule } from "../permission/types.js";
export type { PermissionPolicy as AciPermissionPolicy } from "../permission/policy.js";
