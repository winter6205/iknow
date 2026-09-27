export type { SessionStoreError, SessionStoreErrorKind } from "./errors.js";
export type {
  CheckpointRecord,
  GoalHistoryEntry,
  GoalSource,
  GoalState,
  GoalStatus,
  InterruptReason,
  SessionFileV1,
} from "./schema.js";
export { MAX_WORKSPACE_ROOT_CHARS } from "../../config/workspace-root.js";
export {
  CURRENT_SCHEMA_VERSION,
  extractGoal,
  extractTitle,
  isSessionFileV1,
  MAX_GOAL_CHARS,
  pinGoal,
  sanitizeSessionFile,
  validateGoalText,
  validateSessionFile,
} from "./schema.js";
export {
  appendCheckpoint,
  decideCheckpointPersist,
  resolveRewindAnchor,
  shouldPersistCheckpoint,
  splitTurns,
  toInterruptReason,
  turnSliceEnd,
  withCheckpointAnchors,
  type CheckpointPersistDecision,
  type TurnSlice,
} from "./checkpoint.js";
export { closeoutOrphanToolUses } from "./closeout-projection.js";
export {
  chainFromHead,
  headChainEvents,
  isStopReason,
  jsonDeepEqual,
  latestTitleText,
  messageEventId,
  parseSessionJsonl,
  projectSessionLog,
  resolveTurnOutcomes,
  serializeSessionLog,
  SESSION_JSONL_EXT,
  sessionFileToJsonl,
  type ParsedSessionLog,
  type SessionEventRecord,
  type SessionHeadRecord,
  type SessionHeaderRecord,
  type SessionJsonlError,
  type SessionJsonlRecord,
  type SessionOutcomeRecord,
  type SessionTitleRecord,
} from "./jsonl.js";
export {
  buildRewindTargetsFromLog,
  type LedgerRewindTarget,
} from "./rewind-targets.js";
export {
  applyCodeRestore,
  buildCodeRestorePlan,
  type ApplyCodeRestoreOpts,
  type CodeRestoreError,
  type CodeRestoreOp,
  type CodeRestorePlan,
  type CodeRestoreReport,
  type CodeRestoreSkip,
  type CodeRestoreTranscript,
} from "./code-preimage.js";
export {
  appendWorkerTranscript,
  isWorkerTranscriptPathSafe,
  loadWorkerPreimageEvents,
  loadWorkerTranscript,
  readWorkerSpawnToolUseId,
  type WorkerTranscriptLocation,
} from "./worker-transcript.js";
export { readWorkerInFlightToolName } from "./worker-activity.js";
export {
  resolveConversationDir,
  resolveConversationTraceFilePath,
  resolveProjectSessionDir,
  resolveSubagentTraceDir,
  SessionStore,
  SUBAGENT_TRACE_DIR_NAME,
  TRACE_FILE_NAME,
  type SessionListEntry,
  type SessionBindingStatus,
} from "./session-store.js";
