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
 *
 * 016 H1 修复:`step(state, deps)` 真实实现为单步状态机推进;虽然 spec
 * 原文是 sync 签名,因 `adapter.step` 本身是异步,本 step 实际返回
 * `Promise<Transition>` 以保证协议契约诚实。`run` 直接复用本 step,避免
 * 双轨实现漂移。
 */

import { ProtocolError } from "./errors.js";
import type {
  AnthropicContentBlock,
  AnthropicNativeMessage,
  AssistantTurnResult,
  LoopState,
  RunResult,
  Transition,
} from "./model-adapter/types.js";
import type { Executor, Registry, ToolExecutionResult } from "./tools/types.js";

/**
 * Loop Engine 需要的完整 Adapter 接口:除 step 外还要能编码用户文本
 * 与工具结果(交给历史追加)。Anthropic Adapter / Stub Model 都按
 * 此接口实现。
 */
export interface LoopAdapter {
  readonly step: (
    state: LoopState,
    request: { system?: string; tools?: unknown },
  ) => Promise<AssistantTurnResult>;
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

/**
 * 把消息及其 content blocks 冻结(S10 守门).blocks 是平铺对象({type,
 * text}/{type,id,name,input}/...);`Object.freeze({ ...b })` 浅冻结块自身
 * 的可枚举属性已足够(input 由模型给出的不可变快照,不允许回路修改)。
 */
function freezeMessage(msg: AnthropicNativeMessage): AnthropicNativeMessage {
  return Object.freeze({
    role: msg.role,
    content: Object.freeze(msg.content.map((b) => Object.freeze({ ...b }))),
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
 * 单步状态机推进。基于当前 state + deps 调用一次 Adapter:
 *   1. turnCount 已达 maxTurns -> stop maxTurns,不调 Adapter;
 *   2. 调 Adapter;若抛 ProtocolError -> stop protocolError(整回合不进历史);
 *   3. emptyFinalResponse -> stop emptyFinalResponse(整回合不进历史);
 *   4. 纯文本完成 -> stop completed(进历史)或 nonSuccessStop;
 *   5. 有 tool call -> 执行工具,把 tool_result 编码后追加为一条 user
 *      message,产出 continue nextState(turnCount + 1)。
 *
 * 因 adapter.step 本身异步,本 step 返回 `Promise<Transition>`;spec 原文
 * 的 sync 签名在本版本诚实化为 async,以避免"双轨实现"漂移。
 */
export async function step(
  state: LoopState,
  deps: LoopEngineDeps,
): Promise<Transition> {
  // S6:maxTurns guard,先于 Adapter 调用。
  if (state.turnCount >= deps.maxTurns) {
    return {
      kind: "stop",
      reason: "maxTurns",
      finalState: state,
    };
  }
  const adapter = deps.adapter;
  let turn: AssistantTurnResult;
  try {
    turn = await adapter.step(state, { tools: deps.registry.list() });
  } catch (err) {
    if (err instanceof ProtocolError) {
      // S9:整回合不进入历史,不触发任何工具执行。
      return {
        kind: "stop",
        reason: "protocolError",
        finalState: state,
      };
    }
    throw err;
  }
  // S8:empty final response 整回合不进历史。
  if (
    turn.projection.toolCalls.length === 0 &&
    turn.isEmptyFinalResponse
  ) {
    return {
      kind: "stop",
      reason: "emptyFinalResponse",
      finalState: state,
    };
  }
  // Assistant 回合原子追加(S10 守门),并 turnCount +1。
  let nextState = appendMessage(state, turn.nativeMessage);
  nextState = { messages: nextState.messages, turnCount: state.turnCount + 1 };

  if (turn.projection.toolCalls.length === 0) {
    // 纯文本完成(S1 / S7)。
    const reason = turn.supplierStop === "success" ? "completed" : "nonSuccessStop";
    return {
      kind: "stop",
      reason,
      finalState: nextState,
    };
  }

  // 有 tool call:执行 -> 编码 -> 追加为一条 user message -> continue。
  const toolCallViews = turn.projection.toolCalls.map((c) => ({
    id: c.id,
    name: c.name,
    input: c.input,
  }));
  const results = await deps.executor.executeAll(toolCallViews);
  const blocks = adapter.encodeToolResults(results);
  const toolResultMsg: AnthropicNativeMessage = {
    role: "user",
    content: blocks,
  };
  nextState = appendMessage(nextState, toolResultMsg);
  return { kind: "continue", nextState };
}

/**
 * 整轮运行:init -> 反复 step -> stop 收尾。S6 / S9 / 全部错误路径
 * 由 step 一并负责,避免双轨实现漂移。
 */
export async function run(
  userText: string,
  deps: LoopEngineDeps,
): Promise<RunResult> {
  let state: LoopState = {
    messages: Object.freeze([
      freezeMessage(deps.adapter.encodeUserText(userText)),
    ]),
    turnCount: 0,
  };
  while (true) {
    const transition = await step(state, deps);
    if (transition.kind === "stop") {
      const { reason, finalState } = transition;
      const finalText =
        reason === "completed" ? deriveFinalText(finalState.messages) : null;
      return {
        finalText,
        messages: finalState.messages,
        turnCount: finalState.turnCount,
        stopReason: reason,
      };
    }
    state = transition.nextState;
  }
}

// Re-export spec types for downstream consumers.
export type { Executor, Registry } from "./tools/types.js";
