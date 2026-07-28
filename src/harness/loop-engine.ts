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
 *     protocolError / emptyFinalResponse;
 *   - 017 新增两类:cancelled (signal abort) / timeout (超时强制);
 *   - 017 新增第二返回面:独立 LoopTrace,run 一次性返回
 *     `{ result: RunResult; trace: LoopTrace }`(A1 冻结形状)。
 *
 * Loop Engine 不读取、不判断、不构造供应商原生字段;Model Adapter 是
 * 唯一允许处理原生历史的模块。
 *
 * 016 H1 修复:`step(state, deps)` 真实实现为单步状态机推进;虽然 spec
 * 原文是 sync 签名,因 `adapter.step` 本身是异步,本 step 实际返回
 * `Promise<Transition>` 以保证协议契约诚实。`run` 直接复用本 step,避免
 * 双轨实现漂移。
 *
 * 017 T5:step 内部通过 stepWithTrace 同时产出 Transition 与 TurnTrace;
 * public step() 只返 Transition(冻结 016 契约);run() 累 trace + 一次
 * computeTotals 后返回 {result, trace}。
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
import type { LoopTrace, TurnTrace } from "./loop-trace.js";
import { computeTotals } from "./loop-trace.js";

/**
 * Loop Engine 需要的完整 Adapter 接口:除 step 外还要能编码用户文本
 * 与工具结果(交给历史追加)。Anthropic Adapter / Stub Model 都按
 * 此接口实现。
 */
export interface LoopAdapter {
  readonly step: (
    state: LoopState,
    request: { tools?: unknown },
    signal?: AbortSignal // 017 T1 决策:LoopAdapter 是 Loop Engine 直接消费接口,必须能接收 signal
  ) => Promise<AssistantTurnResult>;
  readonly encodeUserText: (userText: string) => AnthropicNativeMessage;
  readonly encodeToolResults: (
    results: ReadonlyArray<ToolExecutionResult>
  ) => AnthropicContentBlock[];
}

export interface LoopEngineDeps {
  readonly adapter: LoopAdapter;
  readonly executor: Executor;
  readonly registry: Registry;
  readonly maxTurns: number;
  /** 017: 主超时,运行时兜底 DEFAULT_TIMEOUT_MS(不在类型层写死) */
  readonly timeoutMs?: number;
  /** 017: 模型侧覆盖;生效 = modelTimeoutMs ?? timeoutMs ?? DEFAULT_TIMEOUT_MS */
  readonly modelTimeoutMs?: number;
  /** 017: 工具侧覆盖;生效 = toolTimeoutMs ?? timeoutMs ?? DEFAULT_TIMEOUT_MS */
  readonly toolTimeoutMs?: number;
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
  msg: AnthropicNativeMessage
): LoopState {
  return {
    messages: Object.freeze([...state.messages, freezeMessage(msg)]),
    turnCount: state.turnCount,
  };
}

function deriveFinalText(
  messages: ReadonlyArray<AnthropicNativeMessage>
): string | null {
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
 * 017 T5:模型侧超时哨兵。Symbol 保证不与业务错误混淆;Promise.race
 * reject 时由上层 catch 路由到 stop timeout。clearTimeout 在 settled
 * 后清理。
 */
/** 017 A3:超时运行时兜底。仅当 side-specific 与主超时字段都缺省时生效;按阶段解析,不存储。 */
const DEFAULT_TIMEOUT_MS = 60_000;
const MODEL_TIMEOUT = Symbol("loop-engine-model-timeout");

/**
 * 017 T5:把 adapter.step 与两个外部约束(setTimeout 超时、AbortSignal
 * 中断)同时 race。`settled` 闭包守卫保证:
 *   - 只有一个结果胜出后才会清理 timer / listener(无内存泄漏);
 *   - 同名 throw 不会被多次触发。
 *
 * 优先级:signal abort 与 timeout 各自 reject 一个不同的值,上层 catch
 * 按 signal.aborted 优先判定 cancelled,再判定 timeout。
 */
function raceModel(
  adapter: LoopAdapter,
  state: LoopState,
  deps: LoopEngineDeps,
  signal: AbortSignal | undefined,
  timeoutMs: number
): Promise<AssistantTurnResult> {
  return new Promise<AssistantTurnResult>((resolve, reject) => {
    let settled = false;
    const settle = (
      action: "resolve" | "reject",
      value: AssistantTurnResult | unknown
    ): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      if (signal && abortListener) {
        signal.removeEventListener("abort", abortListener);
      }
      if (action === "resolve") resolve(value as AssistantTurnResult);
      else reject(value);
    };

    let timer: ReturnType<typeof setTimeout> | undefined;
    let abortListener: (() => void) | undefined;

    if (timeoutMs > 0) {
      timer = setTimeout(() => settle("reject", MODEL_TIMEOUT), timeoutMs);
    }

    if (signal) {
      if (signal.aborted) {
        settle(
          "reject",
          new DOMException("This operation was aborted", "AbortError")
        );
        return;
      }
      abortListener = (): void =>
        settle(
          "reject",
          new DOMException("This operation was aborted", "AbortError")
        );
      signal.addEventListener("abort", abortListener, { once: true });
    }

    adapter.step(state, { tools: deps.registry.list() }, signal).then(
      (result) => settle("resolve", result),
      (err) => settle("reject", err)
    );
  });
}

/**
 * 017 T5:构造一条 TurnTrace(A7 字段集,严格不含 payload)。
 *
 * freezeMessage 等同 messages 守门:S10 守门延伸到 trace,运行时不可
 * 原地修改任何字段。toolCalls 数组与条目各自 freeze。
 */
function mkTurn(input: {
  readonly turnIndex: number;
  readonly supplierStop: TurnTrace["supplierStop"];
  readonly toolCalls: TurnTrace["toolCalls"];
  readonly durationMs: number;
  readonly timeoutHit: boolean;
  readonly signalAborted: boolean;
}): TurnTrace {
  return Object.freeze({
    turnIndex: input.turnIndex,
    supplierStop: input.supplierStop,
    toolCalls: Object.freeze(
      input.toolCalls.map((c) => Object.freeze({ ...c }))
    ),
    durationMs: input.durationMs,
    timeoutHit: input.timeoutHit,
    signalAborted: input.signalAborted,
  });
}

/**
 * 017 T5:model 阶段封装。把 raceModel 调用 + 失败路由集中在此,避免
 * stepWithTrace 顶层出现 try/catch 与三路守卫分支。返回判别结果:
 *   - { kind: "ok"; result }:Adapter 成功,可继续后续阶段;
 *   - { kind: "stop"; transition; turn }:整回合失败已收敛为 stop,整回合
 *     不进入历史,但仍记一次占位 TurnTrace 供上层累积 trace。
 *
 * 守卫顺序(必须保持):
 *   signal.aborted > MODEL_TIMEOUT > ProtocolError > rethrow
 * 这是 017 S12 / S14 / 016 S9 路径的优先级契约,任何重排都会破坏测试。
 */
async function runModelPhase(
  state: LoopState,
  deps: LoopEngineDeps,
  signal: AbortSignal | undefined,
  started: number,
  modelTimeoutMs: number
): Promise<
  | { kind: "ok"; result: AssistantTurnResult }
  | { kind: "stop"; transition: Transition; turn: TurnTrace }
> {
  try {
    const result = await raceModel(
      deps.adapter,
      state,
      deps,
      signal,
      modelTimeoutMs
    );
    return { kind: "ok", result };
  } catch (err) {
    const durationMs = performance.now() - started;
    if (signal?.aborted) {
      // S12:signal 在模型在途触发,整回合不进历史。
      return {
        kind: "stop",
        transition: {
          kind: "stop",
          reason: "cancelled",
          finalState: state,
        },
        turn: mkTurn({
          turnIndex: state.turnCount,
          supplierStop: "other",
          toolCalls: [],
          durationMs,
          timeoutHit: false,
          signalAborted: true,
        }),
      };
    }
    if (err === MODEL_TIMEOUT) {
      // S14:模型超时,整回合不进历史。
      return {
        kind: "stop",
        transition: {
          kind: "stop",
          reason: "timeout",
          finalState: state,
        },
        turn: mkTurn({
          turnIndex: state.turnCount,
          supplierStop: "other",
          toolCalls: [],
          durationMs,
          timeoutHit: true,
          signalAborted: false,
        }),
      };
    }
    if (err instanceof ProtocolError) {
      // 016 S9 协议错误路径:整回合不进历史,不触发工具执行。
      return {
        kind: "stop",
        transition: {
          kind: "stop",
          reason: "protocolError",
          finalState: state,
        },
        turn: mkTurn({
          turnIndex: state.turnCount,
          supplierStop: "other",
          toolCalls: [],
          durationMs,
          timeoutHit: false,
          signalAborted: false,
        }),
      };
    }
    throw err;
  }
}

/**
 * 017 T5:纯函数 — 把 Executor 的 ToolExecutionResult 序列映射为 trace
 * 用的 toolCalls 数组。nameById 是按 toolUseId 索引的视图名表(由上层
 * 一次构造);tool_not_found 允许自报 toolName,其他 kind 兜底空串:
 * 该空串分支对良构结果不可达,但保留 total 以满足类型严格性。
 */
function toTraceToolCalls(
  results: ReadonlyArray<ToolExecutionResult>,
  nameById: ReadonlyMap<string, string>
): TurnTrace["toolCalls"] {
  return results.map((r) => {
    const toolName =
      nameById.get(r.toolUseId) ??
      (r.kind === "tool_not_found" ? r.toolName : "");
    const message =
      r.kind === "validation_failed" || r.kind === "execution_failed"
        ? r.message
        : undefined;
    return {
      toolUseId: r.toolUseId,
      toolName,
      kind: r.kind,
      ...(message !== undefined ? { message } : {}),
    };
  });
}

/**
 * 017 T5:扫描 Executor 结果 + signal,判定本次 tool 阶段是否触发
 * cancelled / timeout。cancelled 优先级高于 timeout(与 stepWithTrace
 * 主路径上的判定顺序一致),signal 已 abort 即视为整体取消,即便
 * results 中同时存在 timeout 标签。
 */
function computeToolStopFlags(
  results: ReadonlyArray<ToolExecutionResult>,
  signal: AbortSignal | undefined
): { timedOut: boolean; cancelled: boolean } {
  const timedOut = results.some(
    (r) => r.kind === "execution_failed" && r.message === "timeout"
  );
  const cancelled =
    signal?.aborted === true ||
    results.some(
      (r) => r.kind === "execution_failed" && r.message === "cancelled"
    );
  return { timedOut, cancelled };
}

/** 017 T5:工具阶段独立收敛,保持整回合追加与停止优先级不变。 */
async function runToolPhase(
  afterAssistantState: LoopState,
  entryTurnCount: number,
  turnResult: AssistantTurnResult,
  deps: LoopEngineDeps,
  signal: AbortSignal | undefined,
  started: number
): Promise<{ transition: Transition; turn: TurnTrace }> {
  const toolCallViews = turnResult.projection.toolCalls.map((c) => ({
    id: c.id,
    name: c.name,
    input: c.input,
  }));
  const toolTimeout =
    deps.toolTimeoutMs ?? deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const results = await deps.executor.executeAll(
    toolCallViews,
    signal,
    toolTimeout
  );
  const blocks = deps.adapter.encodeToolResults(results);
  const toolResultMsg: AnthropicNativeMessage = {
    role: "user",
    content: blocks,
  };
  const finalState = appendMessage(afterAssistantState, toolResultMsg);
  const durationMs = performance.now() - started;
  const nameById = new Map(toolCallViews.map((c) => [c.id, c.name]));
  const toolCalls = toTraceToolCalls(results, nameById);
  const { timedOut, cancelled } = computeToolStopFlags(results, signal);
  const turn = mkTurn({
    turnIndex: entryTurnCount,
    supplierStop: turnResult.supplierStop,
    toolCalls,
    durationMs,
    timeoutHit: timedOut,
    signalAborted: cancelled,
  });
  if (cancelled) {
    return {
      transition: { kind: "stop", reason: "cancelled", finalState },
      turn,
    };
  }
  if (timedOut) {
    return {
      transition: { kind: "stop", reason: "timeout", finalState },
      turn,
    };
  }
  return { transition: { kind: "continue", nextState: finalState }, turn };
}

/**
 * 017 T5:stepWithTrace 在原 step 逻辑上叠加:
 *   - step 入口记 started = performance.now(),出口算 durationMs;
 *   - 调用 runModelPhase 包 adapter.step + 超时 + abort + 协议错误;
 *   - 整回合取消/超时/协议错误时仍跑出 stop(reason),但 turn 也用占位
 *     TurnTrace 记入 trace(S12/S14 路径不进入历史,trace 仍记一次失败
 *     尝试,S13/S15 路径 tool_call 失败已填入 toolCalls 数组);
 *   - turn 仅在 maxTurns 早停分支返回 null(no adapter call → no trace entry)。
 *
 * 内部 Transition 形状与 016 冻结契约一致(judgement union,reason 字段
 * 类型随 StopReason 自动扩展)。
 */
async function stepWithTrace(
  state: LoopState,
  deps: LoopEngineDeps,
  signal?: AbortSignal
): Promise<{ transition: Transition; turn: TurnTrace | null }> {
  // S6:maxTurns guard,先于 Adapter 调用;不产生 trace entry。
  if (state.turnCount >= deps.maxTurns) {
    return {
      transition: {
        kind: "stop",
        reason: "maxTurns",
        finalState: state,
      },
      turn: null,
    };
  }

  const started = performance.now();
  // 017 T5 兜底链:侧覆盖 > 主超时 > DEFAULT_TIMEOUT_MS(最后一次兜底,只在两侧均
  // 未配置时才落到此值;数值按 phase 每次解析,不在 state 中存储)。
  const modelTimeout =
    deps.modelTimeoutMs ?? deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const modelPhase = await runModelPhase(
    state,
    deps,
    signal,
    started,
    modelTimeout
  );
  if (modelPhase.kind === "stop") {
    return { transition: modelPhase.transition, turn: modelPhase.turn };
  }
  const turnResult = modelPhase.result;

  // S8:empty final response 整回合不进历史。
  if (
    turnResult.projection.toolCalls.length === 0 &&
    turnResult.isEmptyFinalResponse
  ) {
    const durationMs = performance.now() - started;
    return {
      transition: {
        kind: "stop",
        reason: "emptyFinalResponse",
        finalState: state,
      },
      turn: mkTurn({
        turnIndex: state.turnCount,
        supplierStop: turnResult.supplierStop,
        toolCalls: [],
        durationMs,
        timeoutHit: false,
        signalAborted: false,
      }),
    };
  }

  // Assistant 回合原子追加(S10 守门),并 turnCount +1。
  const nextState = appendMessage(state, turnResult.nativeMessage);
  const afterAssistantState = {
    messages: nextState.messages,
    turnCount: state.turnCount + 1,
  };

  if (turnResult.projection.toolCalls.length === 0) {
    // 纯文本完成(S1 / S7)。
    const durationMs = performance.now() - started;
    const reason =
      turnResult.supplierStop === "success" ? "completed" : "nonSuccessStop";
    return {
      transition: {
        kind: "stop",
        reason,
        finalState: afterAssistantState,
      },
      turn: mkTurn({
        turnIndex: state.turnCount,
        supplierStop: turnResult.supplierStop,
        toolCalls: [],
        durationMs,
        timeoutHit: false,
        signalAborted: false,
      }),
    };
  }

  return runToolPhase(
    afterAssistantState,
    state.turnCount,
    turnResult,
    deps,
    signal,
    started
  );
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
 * 017:signal 透传给 adapter.step;Adapter 抛 DOMException AbortError
 * 与 Promise.race 超时都被收敛为 cancelled / timeout。stepWithTrace 是
 * 唯一持有 trace 的内部入口,public step() 只返 Transition(016 契约冻结)。
 *
 * 因 adapter.step 本身异步,本 step 返回 `Promise<Transition>`;spec 原文
 * 的 sync 签名在本版本诚实化为 async,以避免"双轨实现"漂移。
 */
export async function step(
  state: LoopState,
  deps: LoopEngineDeps,
  signal?: AbortSignal
): Promise<Transition> {
  const { transition } = await stepWithTrace(state, deps, signal);
  return transition;
}

/**
 * 整轮运行:init -> 反复 step -> stop 收尾。S6 / S9 / 全部错误路径
 * 由 step 一并负责,避免双轨实现漂移。
 *
 * 017 A1 返回形状变更:`Promise<{ result: RunResult; trace: LoopTrace }>`。
 * RunResult 形状零变更;trace 仅在 run 内部 immutable 累积([...prev, t]),
 * run 收尾一次性 computeTotals(A7)。
 */
export async function run(
  userText: string,
  deps: LoopEngineDeps,
  signal?: AbortSignal
): Promise<{ result: RunResult; trace: LoopTrace }> {
  let state: LoopState = {
    messages: Object.freeze([
      freezeMessage(deps.adapter.encodeUserText(userText)),
    ]),
    turnCount: 0,
  };
  let turns: ReadonlyArray<TurnTrace> = [];
  while (true) {
    const { transition, turn } = await stepWithTrace(state, deps, signal);
    if (turn !== null) {
      // immutable append;禁止 push / 原地修改。
      turns = [...turns, turn];
    }
    if (transition.kind === "stop") {
      const { reason, finalState } = transition;
      const finalText =
        reason === "completed" ? deriveFinalText(finalState.messages) : null;
      const result: RunResult = {
        finalText,
        messages: finalState.messages,
        turnCount: finalState.turnCount,
        stopReason: reason,
      };
      return {
        result,
        trace: { turns, totals: computeTotals(turns) },
      };
    }
    state = transition.nextState;
  }
}

// Re-export spec types for downstream consumers.
export type { Executor, Registry } from "./tools/types.js";
export type { LoopTrace, TurnTrace, Totals } from "./loop-trace.js";

/**
 * 工厂:把 dep 闭包成 runner / stepper 对象(016 T12 spec 出口)。
 * 返回的 `step` 是闭包版(只需传 state),`run` 接收 userText。
 *
 * 017:闭包层 run / step 透传可选的 signal 第三参;返回形状随 run /
 * step 扩展,闭包类型签名同步更新。
 */
export function createLoopEngine(deps: LoopEngineDeps): {
  readonly run: (
    userText: string,
    signal?: AbortSignal
  ) => Promise<{ result: RunResult; trace: LoopTrace }>;
  readonly step: (
    state: LoopState,
    signal?: AbortSignal
  ) => Promise<Transition>;
} {
  return Object.freeze({
    run: (userText: string, signal?: AbortSignal) =>
      run(userText, deps, signal),
    step: (state: LoopState, signal?: AbortSignal) => step(state, deps, signal),
  });
}
