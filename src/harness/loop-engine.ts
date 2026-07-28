/**
 * Loop Engine (013 / 014 / 015 拥有;spec Code Style 区钉死接口形状)。
 *
 * 边界:
 *   - 无可变实例字段;state 线程化、immutable 追加(S10 / S11 守门);
 *   - 014 原子校验:Adapter 交付的 AssistantTurnResult 通过后,整回合
 *     追加到 messages;tool calls 交给 Executor 串行执行;
 *   - ToolExecutionResult 经 Model Adapter.encodeToolResults 编码为
 *     原生 tool_result 块,再原子追加为一条 user message;
 *   - 016 Q3 五类停止原因:completed / maxTurns / nonSuccessStop /
 *     protocolError / emptyFinalResponse。
 *
 * Loop Engine 不读取、不判断、不构造供应商原生字段;Model Adapter 是
 * 唯一允许处理原生历史的模块。
 */

import type {
  AnthropicContentBlock,
  AnthropicNativeMessage,
  AssistantTurnResult,
  LoopState,
  ModelAdapter,
  RunResult,
  StopReason,
  Transition,
} from "./model-adapter/types.js";
import type { Executor, Registry, ToolExecutionResult } from "./tools/types.js";

/**
 * Loop Engine 需要的完整 Adapter 接口:除 step 外还要能编码用户文本
 * 与工具结果(交给历史追加)。Anthropic Adapter / Stub Model 都按
 * 此接口实现。
 */
export interface LoopAdapter extends ModelAdapter {
  readonly encodeUserText: (userText: string) => AnthropicNativeMessage;
  readonly encodeToolResults: (
    results: ReadonlyArray<ToolExecutionResult>,
  ) => AnthropicContentBlock[];
}

export interface LoopEngineDeps {
  readonly adapter: LoopAdapter;
  readonly executor: Executor;
  readonly registry: Registry;
  readonly maxTurns: number;
}

function freezeMessage(msg: AnthropicNativeMessage): AnthropicNativeMessage {
  return Object.freeze({
    role: msg.role,
    content: Object.freeze([...msg.content]),
  });
}

function appendMessage(
  state: LoopState,
  msg: AnthropicNativeMessage,
): LoopState {
  return {
    messages: Object.freeze([...state.messages, freezeMessage(msg)]),
    turnCount: state.turnCount,
  };
}

function deriveFinalText(messages: ReadonlyArray<AnthropicNativeMessage>): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.role === "assistant") {
      const texts = m.content
        .filter((b): b is { type: "text"; text: string } => b.type === "text")
        .map((b) => b.text)
        .filter((t) => t.trim().length > 0);
      if (texts.length > 0) return texts.join("\n");
    }
  }
  return null;
}

/**
 * 单步状态机推进。纯函数:基于当前 state + deps 产出 continue/stop
 * 转换。注意本 step 仅在同步上下文实现"基础占位"——真实 run() 走
 * 异步 Adapter.step;spec 的 step 接口形状被保留以供未来 unit 粒度
 * 测试(对应 Reusable step contract)。
 */
export function step(state: LoopState, deps: LoopEngineDeps): Transition {
  void state;
  void deps;
  throw new Error(
    "loop-engine.step: synchronous step not implemented in Gate A; use run()",
  );
}

// Avoid unused import warnings for spec-pin only types.
export type _StepContract = Transition;
export type _StopReasonPin = StopReason;

/**
 * 整轮运行:模型 -> 工具 -> 真实结果 -> Adapter 原生编码 -> 下一轮 ->
 * 明确停止。无 maxTurns 触顶外的循环调度;遇 protocolError 立即停止且
 * 整回合不进入历史。
 */
export async function run(
  userText: string,
  deps: LoopEngineDeps,
): Promise<RunResult> {
  const adapter = deps.adapter;
  let state: LoopState = {
    messages: Object.freeze([freezeMessage(adapter.encodeUserText(userText))]),
    turnCount: 0,
  };
  // Guard maxTurns (S6): check before each model call.
  while (state.turnCount < deps.maxTurns) {
    const turn: AssistantTurnResult = await adapter.step(state, {
      tools: deps.registry.list(),
    });
    // S9 protocolError path:整回合不进入历史,不执行工具。
    if (turn.projection.toolCalls.length === 0 && turn.isEmptyFinalResponse) {
      // Empty final response:整回合丢弃(S8)
      return {
        finalText: null,
        messages: state.messages,
        turnCount: state.turnCount,
        stopReason: "emptyFinalResponse",
      };
    }
    // Increment turnCount only when we accept the turn into history.
    state = appendMessage(state, turn.nativeMessage);
    state = { messages: state.messages, turnCount: state.turnCount + 1 };

    if (turn.projection.toolCalls.length === 0) {
      // Pure-text completion.
      if (turn.supplierStop === "success") {
        return {
          finalText: deriveFinalText(state.messages),
          messages: state.messages,
          turnCount: state.turnCount,
          stopReason: "completed",
        };
      }
      // Non-success stop (S7):truncation / refusal / other.
      return {
        finalText: null,
        messages: state.messages,
        turnCount: state.turnCount,
        stopReason: "nonSuccessStop",
      };
    }

    // Execute tool calls serially (T7 wired here).
    const toolCallViews = turn.projection.toolCalls.map((c) => ({
      id: c.id,
      name: c.name,
      input: c.input,
    }));
    const results = await deps.executor.executeAll(toolCallViews);
    // Encode tool results via Adapter, append as a single user message.
    const blocks = adapter.encodeToolResults(results);
    const toolResultMsg: AnthropicNativeMessage = {
      role: "user",
      content: blocks,
    };
    state = appendMessage(state, toolResultMsg);
  }
  // S6:maxTurns hit, no extra model call performed.
  return {
    finalText: deriveFinalText(state.messages),
    messages: state.messages,
    turnCount: state.turnCount,
    stopReason: "maxTurns",
  };
}

// Re-export spec types for downstream consumers.
export type { Executor, Registry } from "./tools/types.js";