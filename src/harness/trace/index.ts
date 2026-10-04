/** src/harness/trace public entry point (module-internal barrel). */
export type {
  TraceService,
  TraceStatus,
  TraceError,
  TraceErrorType,
  LlmCallRecord,
  DispatchEvidenceEntry,
  DispatchEvidenceInput,
  ToolCallRecord,
  TurnRecord,
  SessionRecord,
  SandboxCmdRecord,
  VerificationRecord,
  VerificationVerdict,
  VerificationAction,
  SubagentState,
  SubagentSpawnRecord,
  SubagentStopRecord,
  SubagentStateChangeRecord,
  ToolCallCause,
  CleanupTraceEvidence,
  ViolationRecord,
  ViolationCleanupItem,
} from "./types.js";

export { createNoopTraceService } from "./noop.js";
// The payload itself is read by `parseViolationEvent` in
// `sandbox/violation-handling.ts` — one function shared with the serve hub's
// durable projection and the CLI operator line. This module re-exports it
// only so a trace-layer consumer can reach the shared reader without knowing
// which bounded context owns it.
export { parseViolationEvent } from "../sandbox/violation-handling.js";
export { violationRecordFromReason } from "./violation-record.js";
export { createJsonlTraceService } from "./jsonl.js";
export type { JsonlTraceOptions, TraceServiceWithHealth } from "./jsonl.js";
export {
  TRACE_BODY_REPRESENTATION,
  isTraceBodyRepresentation,
  isTraceBodySha,
  writeTraceBody,
} from "./trace-body.js";
export type { TraceBodyRef } from "./trace-body.js";
export { safeTrace } from "./safe-trace.js";
export { translateToObservability } from "./observability-bridge.js";
