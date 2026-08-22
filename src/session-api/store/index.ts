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
  rewindFile,
  shouldPersistCheckpoint,
  splitTurns,
  toInterruptReason,
  turnSliceEnd,
  type TurnSlice,
} from "./checkpoint.js";
export {
  resolveProjectSessionDir,
  SessionStore,
  type SessionListEntry,
} from "./session-store.js";
