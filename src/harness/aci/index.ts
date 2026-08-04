/**
 * ACI 能力层：公共出口。
 *
 * 重新出口 Layer 0 全部类型与工厂。新模块（permission/）作为决策 / 规则 /
 * 策略的权威源；本入口继续提供 prototype 兼容 API（createPermissionPolicy /
 * isAllowedCommand / isDangerousCommand / checkPermission / createAciExecutor）。
 */

export type { AciCategory, AciMeta, AciToolDef, AciCatalog } from "./types.js";

// Re-export the permission type aliases (compatibility surface; canonical
// definitions live in ../permission/). The aci/types.ts module already
// re-exports PermissionDecision / PermissionOutcome / PermissionRule /
// AciPermissionPolicy, so consumers can import either from "./types.js" or
// from ".. / permission/types.js" — both yield the same type identity.
export type {
  PermissionDecision,
  PermissionOutcome,
  PermissionRule,
  AciPermissionPolicy,
  AskUser,
  PreToolUseHook,
  PostToolUseHook,
} from "./types.js";

export {
  createPermissionPolicy,
  isAllowedCommand,
  isDangerousCommand,
  checkPermission,
  findDangerousPattern,
} from "./permission.js";

export { createAciExecutor } from "./aci-executor.js";
export type { AciExecutorOptions } from "./aci-executor.js";

export { createAciRegistry } from "./aci-registry.js";
export type { AciRegistry } from "./aci-registry.js";
