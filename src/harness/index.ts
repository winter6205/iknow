/**
 * src/harness/ 公共出口 (spec Project Structure 冻)。
 *
 * T1 阶段:仅导出 namespace(无运行时代码),shape 冻结由 types 提供。
 * T12 阶段:补全 `run` / `createLoopEngine` / `createAdapter`。
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

export { run, step } from "./loop-engine.js";
export type {
  LoopAdapter,
  LoopEngineDeps,
} from "./loop-engine.js";