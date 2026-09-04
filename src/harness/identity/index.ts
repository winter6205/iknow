/**
 * IKNOW-196 identity 模块集中导出。
 *
 * 模块职责:把 workspace / 装配层 / 认知 / 人格 / 首启引导 / 用户模板
 * 集中从 `./index.ts` 一处对外。`assemble.ts` 负责 9 段装配流水线
 * (`assembleIdentityContext` / `IKNOW_ASSEMBLY_ORDER` /
 * `shouldIncludeBootstrap`),`workspace.ts` 负责 `~/.iknow/` 初始化与
 * state.json 状态机。两者职责不同,故分文件。
 *
 * USER_TEMPLATE 不在此重导出:`initializeIknowWorkspace` 在
 * `workspace.ts` 内部直接 `import { USER_TEMPLATE } from "./user-template.js"`,
 * 保持单一来源。
 */

export {
  iknowWorkspaceRoot,
  initializeIknowWorkspace,
  initIknowWorkspaceSafe,
  readIknowState,
  writeIknowState,
  bootstrapFilePath,
} from "./workspace.js";
export type { IknowStateV1, IknowIdentityError } from "./workspace.js";

export { runHostInitScript, runHostInitScriptSafe } from "./host-init.js";
export type {
  HostInitScriptResult,
  RunHostInitScriptOpts,
} from "./host-init.js";

export { IKNOW_IDENTITY_DEFAULT } from "./identity.js";
export { IKNOW_SOUL_DEFAULT } from "./soul.js";
export { BOOTSTRAP_TEMPLATE } from "./bootstrap.js";

export {
  IKNOW_ASSEMBLY_ORDER,
  shouldIncludeBootstrap,
  createIknowSystemResolver,
  assembleIdentityContext,
} from "./assemble.js";
export type {
  IdentitySegmentKind,
  AssemblyContext,
  SkillSummary,
  McpServiceSummary,
} from "./assemble.js";
export {
  createGitSnapshotProvider,
  gitSnapshotSegment,
  GIT_SEGMENT_TITLE,
  GIT_SEGMENT_DISCLAIMER,
  GIT_STATUS_MAX_CHARS,
} from "./git-snapshot.js";
export type {
  GitSnapshot,
  CreateGitSnapshotProviderOpts,
} from "./git-snapshot.js";
