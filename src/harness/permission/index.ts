/**
 * src/harness/permission/ barrel export (plan T2).
 */

export type {
  AskUser,
  PreHookBlock,
  PreToolUseHook,
  PostToolUseHook,
  PermissionDecision,
  PermissionOutcome,
  PermissionSource,
  ToolCategory,
  HardRuleSpec,
  NormalRuleSpec,
  CodeBuiltInPolicySource,
  ProjectSettingsPolicySource,
  SessionGrantsPolicySource,
} from "./types.js";

export {
  createPermissionPolicy,
  checkPermission,
  DEFAULT_BY_CATEGORY,
  HARD_WALL_DENY_PREFIX,
} from "./policy.js";
export type { PermissionPolicy, CategoryDefault } from "./policy.js";

export { createNoOpHooks, createHooksPair } from "./hooks.js";
export type { HooksPair, HooksCustom } from "./hooks.js";

export {
  createTtyAskUser,
  createFailClosedAskUser,
  createNoAskUser,
  createServeAskUser,
} from "./ask-user.js";
export type { TtyAskUserOpts, ServeAskUserHandle } from "./ask-user.js";

export { createSessionGrants } from "./session-grants.js";
export type { SessionGrants } from "./session-grants.js";

export {
  PERMISSION_MODES,
  DEFAULT_PERMISSION_MODE,
  parsePermissionMode,
  createPermissionModeContext,
  asModeContext,
  modeLabel,
  nextShiftTabMode,
  applyShiftTabModeFlip,
} from "./modes.js";
export type {
  PermissionMode,
  PermissionModeContext,
  ShiftTabKeyShape,
} from "./modes.js";

export {
  createPermissionExecutor,
  createAciCatalog,
} from "./permission-executor.js";
export type {
  PermissionExecutorOptions,
  HookErrorEvent,
} from "./permission-executor.js";

export {
  createSecretsGuardHook,
  DEFAULT_SECRET_PATTERNS,
  MAX_SCAN_LENGTH,
} from "./secrets-guard.js";
export type { SecretsGuardHookOpts } from "./secrets-guard.js";
