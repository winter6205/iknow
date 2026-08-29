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
  resolveRewindAnchor,
  shouldPersistCheckpoint,
  splitTurns,
  toInterruptReason,
  turnSliceEnd,
  withCheckpointAnchors,
  type TurnSlice,
} from "./checkpoint.js";
export { closeoutOrphanToolUses } from "./closeout-projection.js";
export {
  chainFromHead,
  headChainEvents,
  jsonDeepEqual,
  messageEventId,
  parseSessionJsonl,
  projectSessionLog,
  serializeSessionLog,
  SESSION_JSONL_EXT,
  sessionFileToJsonl,
  type ParsedSessionLog,
  type SessionEventRecord,
  type SessionHeadRecord,
  type SessionHeaderRecord,
  type SessionJsonlError,
  type SessionJsonlRecord,
} from "./jsonl.js";
export {
  buildRewindTargetsFromLog,
  type LedgerRewindTarget,
} from "./rewind-targets.js";
export {
  resolveProjectSessionDir,
  SessionStore,
  type SessionListEntry,
  type SessionBindingStatus,
} from "./session-store.js";
