/**
 * Central export surface for the identity module.
 *
 * Workspace init / assembly pipeline / cognitive layer / persona / first-run
 * guidance / user template are exposed from this one file. `assemble.ts` owns
 * the assembly pipeline (`assembleIdentityContext` / `IKNOW_ASSEMBLY_ORDER` /
 * `shouldIncludeBootstrap`); `workspace.ts` owns `~/.iknow/` initialization
 * and the state.json state machine. Different responsibilities, separate files.
 *
 * USER_TEMPLATE is deliberately not re-exported here:
 * `initializeIknowWorkspace` imports it directly inside `workspace.ts`,
 * keeping a single source.
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
  IKNOW_GIT_WORK_TEXT,
  gitWorkSegment,
} from "./assemble.js";
export type {
  IdentitySegmentKind,
  AssemblyContext,
  SkillSummary,
  McpServiceSummary,
  McpToolSummary,
  DeferredInternalToolSummary,
} from "./assemble.js";
export {
  MCP_TOOL_SHORT_DESCRIPTION_MAX,
  DIRECT_CALL_GUIDANCE,
} from "./assemble.js";
export { runIndexDemotion, renderIndexText } from "./index-demotion.js";
export type {
  IndexDemotionInput,
  IndexDemotionResult,
  IndexDemotionReason,
  CountIndexTokensFn,
} from "./index-demotion.js";
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
