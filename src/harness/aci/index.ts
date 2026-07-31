/**
 * PROTOTYPE（throwaway）— ACI 原型工具层：公共出口。
 *
 * 独立于 src/harness/index.ts（冻结出口不动）。
 * 重导出 Layer 0 全部类型与工厂；Layer 1/2 由各自文件直接 import。
 */

export type {
  AciCategory,
  AciMeta,
  AciToolDef,
  PermissionDecision,
  PermissionOutcome,
  PermissionRule,
  AciPermissionPolicy,
  AciCatalog,
} from "./types.js";

export {
  createPermissionPolicy,
  isAllowedCommand,
  isDangerousCommand,
  checkPermission,
} from "./permission.js";

export { createAciExecutor } from "./aci-executor.js";
export type { AciExecutorOptions } from "./aci-executor.js";

export { createAciRegistry } from "./aci-registry.js";
export type { AciRegistry } from "./aci-registry.js";
