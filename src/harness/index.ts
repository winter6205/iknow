/**
 * src/harness/ 公共出口 (spec Project Structure 冻)。
 *
 * T12 阶段补全:`run` / `createLoopEngine` / `createAnthropicAdapter` /
 * `createRegistry` / `createExecutor` / `createStubModel` / `createStubTool`
 * 等 Foundation 自治运行时入口。spec Success Criteria 16 条全部 yes。
 */

export {
  RegistryConstructionError,
  ProtocolError,
  ToolExecutionError,
} from "./errors.js";

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

export { createAnthropicAdapter } from "./model-adapter/anthropic-adapter.js";
export { createRealAnthropicAdapter } from "./model-adapter/anthropic-adapter.js";
export type {
  AnthropicAdapter,
  AnthropicAdapterOptions,
  RealAnthropicAdapterOptions,
} from "./model-adapter/anthropic-adapter.js";

export { createStubModel } from "./stubs/stub-model.js";
export type { StubModelFull } from "./stubs/stub-model.js";

export { createStubTool } from "./stubs/stub-tool.js";

export { createEchoTool } from "./stubs/demo-tools.js";
export { createGetTimeTool } from "./stubs/demo-tools.js";

// 017 A7 LoopTrace:纯类型 + 一次性 reduce 函数,字段名 SSOT。
export { computeTotals } from "./loop-trace.js";
export type { LoopTrace, TurnTrace, Totals } from "./loop-trace.js";
