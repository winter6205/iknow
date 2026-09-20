/**
 * Public surface of src/harness/ (frozen by the project structure spec).
 *
 * Foundation autonomous-runtime entries: `run` / `createLoopEngine` /
 * `createAnthropicAdapter` / `createRegistry` / `createExecutor` /
 * `createStubModel` / `createStubTool` and friends.
 */

export {
  RegistryConstructionError,
  ProtocolError,
  PromptTooLongError,
  TransportRetryExhaustedError,
  MaxTurnsExceeded,
  ToolExecutionError,
  McpLifecycleError,
  MessageCommitError,
} from "./errors.js";
export type { McpLifecycleErrorKind } from "./errors.js";

export type {
  AnthropicContentBlock,
  AnthropicRole,
  AnthropicNativeMessage,
  LoopState,
  StopReason,
  Transition,
  RunResult,
  AssistantProjection,
  AssistantTurnResult,
  TokenUsage,
  ModelAdapter,
} from "./model-adapter/types.js";

export type {
  ToolHandler,
  ToolDef,
  Registry,
  ToolCall,
  ToolExecutionContext,
  ToolExecutionResult,
  Executor,
} from "./tools/types.js";

export { run, step, createLoopEngine } from "./loop-engine.js";
export type { LoopAdapter, LoopEngineDeps } from "./loop-engine.js";

export { createRegistry } from "./tools/registry.js";
export { createExecutor } from "./tools/executor.js";
export { toAnthropicToolResults } from "./tools/tool-result.js";

export { classifyFault } from "./fault-class.js";
export type { FaultClass, FaultEvent } from "./fault-class.js";

export { createAnthropicAdapter } from "./model-adapter/anthropic-adapter.js";
export { createRealAnthropicAdapter } from "./model-adapter/anthropic-adapter.js";
export { buildThinkingParams } from "./model-adapter/anthropic-adapter.js";
export { translateAnthropicTransportFault } from "./model-adapter/anthropic-adapter.js";
export { withTransportRetry } from "./model-adapter/with-transport-retry.js";
export type {
  AnthropicAdapter,
  AnthropicAdapterOptions,
  RealAnthropicAdapterOptions,
  ThinkingParams,
} from "./model-adapter/anthropic-adapter.js";

export { createStubModel } from "./stubs/stub-model.js";
export type { StubModelFull } from "./stubs/stub-model.js";

export { createStubTool } from "./stubs/stub-tool.js";

export { createEchoTool } from "./stubs/demo-tools.js";
export { createGetTimeTool } from "./stubs/demo-tools.js";

// LoopTrace: pure types + one-shot reduce; field names are the SSOT.
export { computeTotals } from "./loop-trace.js";
export type { LoopTrace, TurnTrace, Totals, CancelKind } from "./loop-trace.js";

// Harness streaming-event contract SSOT (minimal set).
export type { HarnessStreamEvent } from "./stream.js";

// TraceService bounded context public exports.
export type {
  TraceService,
  LlmCallRecord,
  ToolCallRecord,
  TurnRecord,
  TraceStatus,
  TraceError,
  TraceErrorType,
} from "./trace/index.js";
export {
  createNoopTraceService,
  createJsonlTraceService,
  safeTrace,
  translateToObservability,
} from "./trace/index.js";

// Compaction: the shared pure-function seam for the proactive / reactive
// double-safety net plus the manual entry (TUI /compact, web button).
// loop-engine triggers automatically; hosts (session-api/hub) trigger
// manually via compactSession, and both share the same `compactMessages`,
// so thresholds / compaction logic never fork.
// The LLM structured-summary (full compact) path is exposed alongside the
// plain truncation placeholder path — the loop-engine automatic path and the
// hub manual path share the same best-effort contract.
export {
  compactMessages,
  buildCompactPrompt,
  extractCompactSummary,
  splitForCompaction,
  buildCompactedMessages,
  runFullCompact,
} from "./compress/index.js";
export type { FullCompactOutcome, CompactAdapter } from "./compress/index.js";
