export { READ_ONLY_SYSTEM_PATHS, createFsPolicy } from "./fs-policy.js";
export type { FsPolicy, FsPolicyOptions } from "./fs-policy.js";

// ADR-0092 Amendment 2026-09-13 / SC11/SC12:工作区档 fs-isolation overlay
// —— 可变 holder + 值域守卫(详见 fs-mode.ts 文件头 SSOT)。`resolveFsIsolationMode`
// 由 T8 在 `config/settings.ts` 落地,本文件只 re-export 类型与工厂。
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
  defaultProbeSocat,
  createEgressViolationSink,
  renderEgressViolations,
  renderEgressFailureMessage,
  SocatUnavailableError,
  createEgressApprovalGate,
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
