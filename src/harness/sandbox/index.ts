export { READ_ONLY_SYSTEM_PATHS, createFsPolicy } from "./fs-policy.js";
export type { FsPolicy, FsPolicyOptions } from "./fs-policy.js";

// Workspace-tier fs-isolation overlay per ADR-0092 — mutable holder + value
// guard (SSOT: file header of fs-mode.ts). `resolveFsIsolationMode` lives in
// `config/settings.ts`; this file only re-exports the types and factories.
export {
  FS_ISOLATION_MODE_DEFAULT,
  createFsModeContext,
  parseFsModeFlag,
} from "./fs-mode.js";
export type { FsIsolationMode, FsModeContext } from "./fs-mode.js";

// ADR-0119 / specs/yolo-mode.md: yolo no-sandbox mode — independent boolean-axis
// holder + enter/exit actions + the typed refusal for non-TUI entries
// (SSOT: file header of yolo.ts).
export {
  YOLO_DEFAULT,
  YOLO_TUI_ONLY_REJECTED_COMMANDS,
  createYoloContext,
  createYoloController,
  isYoloRejectedCommand,
  parseYoloFlag,
  rejectYoloForCommand,
} from "./yolo.js";
export type {
  YoloActionOptions,
  YoloActionResult,
  YoloContext,
  YoloController,
  YoloNonTuiEntryError,
} from "./yolo.js";

export {
  CPU_SEC,
  MEM_BYTES,
  TMP_BYTES,
  MAX_PROCS,
  MAX_FD,
  createResourceLimits,
} from "./resource-limits.js";
export type {
  ResourceLimits,
  ResourceLimitOptions,
} from "./resource-limits.js";

export {
  BASE_ENV_WHITELIST,
  SECRET_ENV_NAMES,
  applyCwdReadonlyFenceEnv,
  clearActiveExtraSecrets,
  createEnvIsolation,
  currentSecretEnvNames,
  currentSecretValues,
  setActiveExtraSecrets,
} from "./env-isolation.js";
export type { EnvIsolation, EnvIsolationOptions } from "./env-isolation.js";

export { createOutputMask } from "./output-mask.js";
export type { OutputMask } from "./output-mask.js";

export {
  buildProxyEnv,
  createEgressSession,
  resolveEgressRelay,
  createEgressViolationSink,
  renderEgressViolations,
  renderEgressFailureMessage,
  sshHostKeyFailureGuidance,
  EgressRelayUnavailableError,
  createEgressApprovalGate,
  wrapCommandWithInnerBridge,
  type AskApproval,
  type CreateEgressApprovalGateOptions,
  type EgressAllowlistSource,
  type EgressApprovalGate,
  type EgressFenceSpec,
  type EgressPolicyInput,
  type EgressSession,
  type EgressSessionOptions,
  type EgressViolation,
  type EgressViolationReason,
  type EgressViolationSink,
} from "./egress/index.js";

export { createBwrapFence, OPTIONAL_HOST_RO_PREFIXES } from "./bwrap.js";
export type {
  BwrapFence,
  BwrapFenceOptions,
  ProtectedTargetSkippedWarning,
  SeccompProfile,
} from "./bwrap.js";

export {
  createProtectedTargetInventory,
  protectedTargetBindPaths,
  protectedTargetRoBindArgs,
} from "./protected-targets.js";
// The single wiring point for the protected-fence option pair (inventory +
// credential read mask) shared by every production route.
export {
  fenceScanScope,
  protectedFenceWiring,
} from "./protected-fence-wiring.js";
export {
  describeProtectedTargetClass,
  protectedTargetErofsGuidance,
  protectedTargetFenceGuidance,
} from "./protected-target-feedback.js";
export type {
  ProtectedTargetArm,
  ProtectedTargetBindPath,
  ProtectedTargetClassId,
  ProtectedTargetEntry,
  ProtectedTargetExtra,
  ProtectedTargetInventory,
  ProtectedTargetInventoryOptions,
  ProtectedNamePattern,
  ProtectedTargetRule,
} from "./protected-targets.js";

export {
  DEFAULT_MAX_OUTPUT_CODE_POINTS,
  SIGNAL_EXIT_CODES,
  killProcessGroup,
  requireBwrap,
  runInSandbox,
  signalExitCode,
  spawnWithStopSignal,
  truncateByCodePoint,
} from "./runner.js";
export type {
  SandboxRunOptions,
  SandboxRunResult,
  SpawnResult,
  SpawnWithStopSignalOptions,
  SpawnWithStopSignalResult,
} from "./runner.js";

export {
  createSandboxServer,
  renderSandboxServerError,
} from "./server/index.js";
export type {
  CreateSandboxServerOptions,
  SandboxServer,
} from "./server/index.js";
export type {
  ExecRequest,
  ExecResponse,
  SpawnRequest,
  SandboxTaskEvent,
  SandboxTaskHandle,
  SandboxServerError,
  QueuedTaskEvent,
} from "./server/types.js";
