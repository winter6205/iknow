/**
 * src/harness/trace 公共出口 (T2 + T3, GH #64)。
 *
 * T4 才决定是否挂到 src/harness/index.ts (本模块内部出口独立维护)。
 */
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
} from "./types.js";

export { createNoopTraceService } from "./noop.js";
export { createJsonlTraceService } from "./jsonl.js";
export type { JsonlTraceOptions } from "./jsonl.js";
export { safeTrace } from "./safe-trace.js";
export { translateToObservability } from "./observability-bridge.js";
