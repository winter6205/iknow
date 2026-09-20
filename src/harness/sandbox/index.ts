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
export type { BwrapFence, BwrapFenceOptions, SeccompProfile } from "./bwrap.js";

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
