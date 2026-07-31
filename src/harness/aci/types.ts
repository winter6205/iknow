/**
 * PROTOTYPE（throwaway）— ACI 原型工具层：类型契约。
 *
 * 验证问题：ch04 ACI 能力（权限 / 安全标记 / 延迟加载）能否以加法式装饰层
 * 嫁接到已冻结的 4-tool 协议上，而不破坏协议、不碰产品流量。
 * 本文件只定义扩展类型（extends ToolDef），不修改协议文件（只 import，不改）。
 * 原型验证通过后，被验证的决策可折入真代码；本体留档后删除。
 */

import type { ToolDef } from "../tools/types.js";

/** ch04 四类安全级别。 */
export type AciCategory = "read-only" | "write" | "execute" | "collaborate";

/** ACI 安全/调度元数据：加在冻结 ToolDef 之外的扩展字段。 */
export interface AciMeta {
  readonly category: AciCategory;
  readonly isReadOnly: boolean;
  readonly isDestructive: boolean;
  readonly isConcurrencySafe: boolean;
  readonly interruptBehavior: "cancel" | "block";
  /** true = 延迟加载：默认不进 prompt schema，需 discover() 检索注入。默认 false（核心常驻）。 */
  readonly lazy?: boolean;
}

/** ACI 工具定义 = 冻结 ToolDef + aci 元数据（扩展，不改协议）。 */
export interface AciToolDef extends ToolDef {
  readonly aci: AciMeta;
}

/** 权限三值决策（ch04 阶段④）。 */
export type PermissionDecision = "allow" | "deny" | "pass_through";

export interface PermissionOutcome {
  readonly decision: PermissionDecision;
  /** 人/模型可读的决策理由（会进 execution_failed message）。 */
  readonly reason: string;
}

/** 规则层：always_allow / always_deny / ask（原型里 ask 收敛为 allow + 标记，无人工回路）。 */
export type PermissionRule = "always_allow" | "always_deny" | "ask";

export interface AciPermissionPolicy {
  readonly defaultRule: PermissionRule;
  readonly byName?: Readonly<Record<string, PermissionRule>>;
  /** execute 类是否拦截危险命令；默认 true。 */
  readonly denyDangerousExecute?: boolean;
}

/** ACI 目录：按名定位 AciToolDef（权限层与延迟加载共用）。 */
export interface AciCatalog {
  readonly get: (name: string) => AciToolDef | undefined;
  readonly all: () => ReadonlyArray<AciToolDef>;
}
