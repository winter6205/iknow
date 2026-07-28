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
  ToolExecutionResult,
  Executor,
} from "./tools/types.js";

export { run, step, createLoopEngine } from "./loop-engine.js";
export type {
  LoopAdapter,
  LoopEngineDeps,
} from "./loop-engine.js";

export { createRegistry } from "./tools/registry.js";
export { createExecutor } from "./tools/executor.js";
export { toAnthropicToolResults } from "./tools/tool-result.js";

export {
  createAnthropicAdapter,
} from "./model-adapter/anthropic-adapter.js";
export type {
  AnthropicAdapter,
  AnthropicAdapterOptions,
} from "./model-adapter/anthropic-adapter.js";

export { createStubModel } from "./stubs/stub-model.js";
export type { StubModelFull } from "./stubs/stub-model.js";

export { createStubTool } from "./stubs/stub-tool.js";