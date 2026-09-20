/**
 * ACI capability layer: public entry.
 *
 * Re-exports all Layer 0 types and factories. The permission/ module is the
 * authoritative source for decisions / rules / policy; this entry keeps the
 * legacy-compatible API (createPermissionPolicy / isAllowedCommand /
 * isDangerousCommand / checkPermission / createAciExecutor).
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
  PreHookBlock,
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
