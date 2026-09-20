/** src/harness/trace public entry point (module-internal barrel). */
export type {
  TraceService,
  TraceStatus,
  TraceError,
  TraceErrorType,
  LlmCallRecord,
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
} from "./types.js";

export { createNoopTraceService } from "./noop.js";
export { createJsonlTraceService } from "./jsonl.js";
export type { JsonlTraceOptions, TraceServiceWithHealth } from "./jsonl.js";
export { safeTrace } from "./safe-trace.js";
export { translateToObservability } from "./observability-bridge.js";
