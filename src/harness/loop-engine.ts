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
import type { CancelKind, LoopTrace, TurnTrace } from "./loop-trace.js";
import { computeTotals } from "./loop-trace.js";
import type { TraceErrorType, TraceService } from "./trace/index.js";
import { safeTrace } from "./trace/index.js";

/**
 * 把任意 reason 字符串安全映射为 TraceErrorType (消除 as 强转)。
 * 已知值直接透传; 未知值 (含 nonSuccessStop / maxTurns / completed) 兜底 "unknown"。
 */
function toTraceErrorType(reason: string): TraceErrorType {
  switch (reason) {
    case "cancelled":
    case "timeout":
    case "protocolError":
    case "emptyFinalResponse":
    case "validation_failed":
    case "tool_not_found":
    case "execution_failed":
      return reason;
    default:
      return "unknown";
  }
}

/**
 * 把 StopReason 安全映射为 TurnRecord.decision (消除 as 强转)。
 * maxTurns 早停不记录 turn, 该分支不可达; 兜底 "nonSuccessStop" 保持 total。
 */
function toDecision(
  reason: string
): import("./trace/types.js").TurnRecord["decision"] {
  switch (reason) {
    case "completed":
    case "nonSuccessStop":
    case "protocolError":
    case "emptyFinalResponse":
    case "cancelled":
    case "timeout":
      return reason;
    default:
      return "nonSuccessStop";
  }
}

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
  /** 064 T4: optional TraceService injection; byte-identical when absent (criterion 5/17) */
  readonly trace?: TraceService;
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

function appendMessage(opts: {
  readonly state: LoopState;
  readonly msg: AnthropicNativeMessage;
}): LoopState {
  return {
    messages: Object.freeze([...opts.state.messages, freezeMessage(opts.msg)]),
    turnCount: opts.state.turnCount,
  };
}

/**
 * 从权威历史派生 `result.finalText`(仅 `reason === "completed"` 时调用)。
 *
 * 算法:倒序扫 messages,找到**第一条带非空 text 的 assistant** 回合,
 * 返回其 text 块拼接;越过空 text 的 assistant(如纯 tool_use 回合)继续
 * 回扫;无则返回 null。
 *
 * 与 `src/cli/format.ts` 的 `renderAssistantAnswer({showThinking:false})`
 * 在边界上存在细微差异:后者停在最后一条 assistant(不回扫空 text)。
 * 生产路径 `formatRunHuman` 走 `result.finalText`(本函数),分歧仅在
 * `renderAssistantAnswer(false)` 的直接测试调用暴露;由
 * `tests/cli/format.test.ts` 的不变量回归测试钉住一致性。
 *
 * 导出供测试引用同一真源(`result.finalText` 契约),非通用工具。
 */
export function deriveFinalText(
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

/** 017 A3:超时运行时兜底。仅当 side-specific 与主超时字段都缺省时生效;按阶段解析,不存储。 */
const DEFAULT_TIMEOUT_MS = 60_000;

/** 023: raceModel 的结构化胜出来源，避免 SDK abort 错误覆盖原始意图。 */
export type RaceOutcomeSource =
  "adapter" | "timerTimeout" | "hostCancel" | "callerAbort";

export interface RaceModelOutcome {
  readonly result: AssistantTurnResult | undefined;
  readonly source: RaceOutcomeSource;
}

export interface RaceModelHandle {
  readonly outcome: Promise<RaceModelOutcome>;
  readonly childSignal: AbortSignal;
  readonly childAbort: () => void;
}

export interface RaceModelOpts {
  readonly adapter: LoopAdapter;
  readonly state: LoopState;
  readonly deps: LoopEngineDeps;
  readonly signal: AbortSignal | undefined;
  readonly timeoutMs: number;
}

/** 023: settle 共址于 helper，统一 single-wins 与 cleanup。 */
function createRaceOutcome(opts: {
  readonly raceOpts: RaceModelOpts;
  readonly child: AbortController;
  readonly compositeSignal: AbortSignal;
  readonly setChildAbort: (abort: () => void) => void;
}): Promise<RaceModelOutcome> {
  return new Promise<RaceModelOutcome>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abortListener: (() => void) | undefined;
    const settle = (
      source: RaceOutcomeSource,
      result?: AssistantTurnResult,
      err?: unknown
    ): void => {
      if (settled) return; // post-settle SDK error / abort 均丢弃。
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      if (opts.raceOpts.signal && abortListener)
        opts.raceOpts.signal.removeEventListener("abort", abortListener);
      opts.child.abort();
      if (err !== undefined) reject(err);
      else resolve(Object.freeze({ result, source }));
    };
    opts.setChildAbort(() => settle("hostCancel"));
    if (opts.raceOpts.timeoutMs > 0)
      timer = setTimeout(() => {
        opts.child.abort(); // L1': 必须先取消 HTTP，再记录 timer 胜出。
        settle("timerTimeout");
      }, opts.raceOpts.timeoutMs);
    abortListener = (): void => settle("callerAbort");
    if (opts.raceOpts.signal?.aborted) abortListener();
    else
      opts.raceOpts.signal?.addEventListener("abort", abortListener, {
        once: true,
      });
    opts.raceOpts.adapter
      .step(
        opts.raceOpts.state,
        { tools: opts.raceOpts.deps.registry.list() },
        opts.compositeSignal
      )
      .then(
        (result) => settle("adapter", result),
        (err) => settle("adapter", undefined, err)
      );
  });
}

/** 023: child 与 caller signal 合并，timer/host 都可取消真实 HTTP。 */
export function raceModel(opts: RaceModelOpts): RaceModelHandle {
  const child = new AbortController();
  const childSignal = AbortSignal.any(
    opts.signal ? [opts.signal, child.signal] : [child.signal]
  );
  let childAbort = (): void => undefined;
  const outcome = createRaceOutcome({
    raceOpts: opts,
    child,
    compositeSignal: childSignal,
    setChildAbort: (abort) => (childAbort = abort),
  });
  return Object.freeze({
    outcome,
    childSignal,
    childAbort: () => childAbort(),
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
  readonly cancelKind: CancelKind;
}): TurnTrace {
  return Object.freeze({
    turnIndex: input.turnIndex,
    supplierStop: input.supplierStop,
    toolCalls: Object.freeze(
      input.toolCalls.map((c) => Object.freeze({ ...c }))
    ),
    durationMs: input.durationMs,
    cancelKind: input.cancelKind,
  });
}

/**
 * 025 #98:reason 驱动 transition(冻结 StopReason 不变),cancelKind 独立
 * 驱动 trace 元数据;两者解耦,hostCancel 得以保留 stopReason "timeout"
 * 的控制流,同时在 trace 记录真实来源。
 */
function modelStop(opts: {
  readonly state: LoopState;
  readonly started: number;
  readonly reason: "cancelled" | "timeout" | "protocolError";
  readonly cancelKind: CancelKind;
}): { kind: "stop"; transition: Transition; turn: TurnTrace } {
  return {
    kind: "stop",
    transition: { kind: "stop", reason: opts.reason, finalState: opts.state },
    turn: mkTurn({
      turnIndex: opts.state.turnCount,
      supplierStop: "other",
      toolCalls: [],
      durationMs: performance.now() - opts.started,
      cancelKind: opts.cancelKind,
    }),
  };
}

/** 023: await 结构化 race outcome，并保持 SDK-first 错误 catch 契约。 */
async function runModelPhase(opts: {
  readonly state: LoopState;
  readonly deps: LoopEngineDeps;
  readonly signal: AbortSignal | undefined;
  readonly started: number;
  readonly modelTimeoutMs: number;
}): Promise<
  | { kind: "ok"; result: AssistantTurnResult }
  | { kind: "stop"; transition: Transition; turn: TurnTrace }
> {
  try {
    const handle = raceModel({
      adapter: opts.deps.adapter,
      state: opts.state,
      deps: opts.deps,
      signal: opts.signal,
      timeoutMs: opts.modelTimeoutMs,
    });
    const outcome = await handle.outcome;
    if (outcome.source === "adapter") {
      return { kind: "ok", result: outcome.result! };
    }
    if (outcome.source === "callerAbort") {
      return modelStop({
        state: opts.state,
        started: opts.started,
        reason: "cancelled",
        cancelKind: "callerAbort",
      });
    }
    if (outcome.source === "hostCancel") {
      // hostCancel 保留 stopReason "timeout" 以维持控制流;trace 由 cancelKind
      // 独立记录真实来源。
      // 覆盖说明:hostCancel 无公共触发点 — RaceModelHandle 封装于
      // runModelPhase 内部,run/step/createLoopEngine 均不暴露 childAbort。
      // 覆盖天花板为 raceModel 层 T2-new-5(直接调 handle.childAbort());
      // 本映射由 (a) TypeScript 对 4 值 source union 的穷尽性检查 与
      // (b) callerAbort/timerTimeout 集成测试 S12/S14(走同一 modelStop
      // 路径)共同钉死。
      return modelStop({
        state: opts.state,
        started: opts.started,
        reason: "timeout",
        cancelKind: "hostCancel",
      });
    }
    return modelStop({
      state: opts.state,
      started: opts.started,
      reason: "timeout",
      cancelKind: "timerTimeout",
    });
  } catch (err) {
    if (err instanceof ProtocolError)
      return modelStop({
        state: opts.state,
        started: opts.started,
        reason: "protocolError",
        cancelKind: "none",
      });
    throw err;
  }
}

/**
 * 017 T5:纯函数 — 把 Executor 的 ToolExecutionResult 序列映射为 trace
 * 用的 toolCalls 数组。nameById 是按 toolUseId 索引的视图名表(由上层
 * 一次构造);tool_not_found 允许自报 toolName,其他 kind 兜底空串:
 * 该空串分支对良构结果不可达,但保留 total 以满足类型严格性。
 */
function toTraceToolCalls(opts: {
  readonly results: ReadonlyArray<ToolExecutionResult>;
  readonly nameById: ReadonlyMap<string, string>;
}): TurnTrace["toolCalls"] {
  return opts.results.map((r) => {
    const toolName =
      opts.nameById.get(r.toolUseId) ??
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
 *
 * 124/T5:导出供 interrupt-routing 验收套件断言严格 strict-equal
 * 契约(无前缀/后缀宽容,严禁任何 substring / prefix 优化)。
 */
export function computeToolStopFlags(opts: {
  readonly results: ReadonlyArray<ToolExecutionResult>;
  readonly signal: AbortSignal | undefined;
}): { timedOut: boolean; cancelled: boolean } {
  const timedOut = opts.results.some(
    (r) => r.kind === "execution_failed" && r.message === "timeout"
  );
  const cancelled =
    opts.signal?.aborted === true ||
    opts.results.some(
      (r) => r.kind === "execution_failed" && r.message === "cancelled"
    );
  return { timedOut, cancelled };
}

/** 017 T5:工具阶段独立收敛,保持整回合追加与停止优先级不变。 */
async function runToolPhase(opts: {
  readonly afterAssistantState: LoopState;
  readonly entryTurnCount: number;
  readonly turnResult: AssistantTurnResult;
  readonly deps: LoopEngineDeps;
  readonly signal: AbortSignal | undefined;
  readonly started: number;
}): Promise<{
  transition: Transition;
  turn: TurnTrace;
  toolResults: ReadonlyArray<ToolExecutionResult>;
  toolCallViews: ReadonlyArray<{ id: string; name: string; input: unknown }>;
}> {
  const toolCallViews = opts.turnResult.projection.toolCalls.map((c) => ({
    id: c.id,
    name: c.name,
    input: c.input,
  }));
  const toolTimeout =
    opts.deps.toolTimeoutMs ?? opts.deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const results = await opts.deps.executor.executeAll(
    toolCallViews,
    opts.signal,
    toolTimeout
  );
  const blocks = opts.deps.adapter.encodeToolResults(results);
  const toolResultMsg: AnthropicNativeMessage = {
    role: "user",
    content: blocks,
  };
  const finalState = appendMessage({
    state: opts.afterAssistantState,
    msg: toolResultMsg,
  });
  const durationMs = performance.now() - opts.started;
  const nameById = new Map(toolCallViews.map((c) => [c.id, c.name]));
  const toolCalls = toTraceToolCalls({ results, nameById });
  const { timedOut, cancelled } = computeToolStopFlags({
    results,
    signal: opts.signal,
  });
  const turn = mkTurn({
    turnIndex: opts.entryTurnCount,
    supplierStop: opts.turnResult.supplierStop,
    toolCalls,
    durationMs,
    // 025 #98:cancelled 优先级高于 timeout(与 computeToolStopFlags 注释一致)。
    cancelKind: cancelled ? "callerAbort" : timedOut ? "timerTimeout" : "none",
  });
  if (cancelled) {
    return {
      transition: { kind: "stop", reason: "cancelled", finalState },
      turn,
      toolResults: results,
      toolCallViews,
    };
  }
  if (timedOut) {
    return {
      transition: { kind: "stop", reason: "timeout", finalState },
      turn,
      toolResults: results,
      toolCallViews,
    };
  }
  return {
    transition: { kind: "continue", nextState: finalState },
    turn,
    toolResults: results,
    toolCallViews,
  };
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
async function stepWithTrace(opts: {
  readonly state: LoopState;
  readonly deps: LoopEngineDeps;
  readonly signal?: AbortSignal;
}): Promise<{ transition: Transition; turn: TurnTrace | null }> {
  if (opts.state.turnCount >= opts.deps.maxTurns) {
    return {
      transition: {
        kind: "stop",
        reason: "maxTurns",
        finalState: opts.state,
      },
      turn: null,
    };
  }

  const started = performance.now();
  const turnStartedAt = new Date().toISOString();
  const modelTimeout =
    opts.deps.modelTimeoutMs ?? opts.deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const llmStartedAt = new Date().toISOString();
  const llmStartMono = performance.now();

  const modelPhase = await runModelPhase({
    state: opts.state,
    deps: opts.deps,
    signal: opts.signal,
    started,
    modelTimeoutMs: modelTimeout,
  });

  const llmEndedAt = new Date().toISOString();
  const llmDurationMs = performance.now() - llmStartMono;
  let llmCallId: string | undefined;
  if (opts.deps.trace) {
    if (modelPhase.kind === "stop") {
      const t = modelPhase.transition;
      const reason = t.kind === "stop" ? t.reason : "unknown";
      llmCallId = await safeTrace(() =>
        opts.deps.trace!.recordLlmCall({
          startedAt: llmStartedAt,
          endedAt: llmEndedAt,
          durationMs: llmDurationMs,
          stream: false,
          messagesCaptured: false,
          status: "error",
          error: { type: toTraceErrorType(reason), message: reason },
        })
      );
    } else {
      llmCallId = await safeTrace(() =>
        opts.deps.trace!.recordLlmCall({
          startedAt: llmStartedAt,
          endedAt: llmEndedAt,
          durationMs: llmDurationMs,
          supplierStop: modelPhase.result.supplierStop,
          stream: false,
          messagesCaptured: false,
          status: "ok",
        })
      );
    }
  }

  if (modelPhase.kind === "stop") {
    if (opts.deps.trace) {
      const t2 = modelPhase.transition;
      const reason = t2.kind === "stop" ? t2.reason : "unknown";
      await safeTrace(() =>
        opts.deps.trace!.recordTurn({
          turnIndex: opts.state.turnCount,
          startedAt: turnStartedAt,
          endedAt: new Date().toISOString(),
          durationMs: performance.now() - started,
          llmCallIds: llmCallId ? [llmCallId] : [],
          toolCallIds: [],
          decision: toDecision(reason),
          status: "error",
          error: { type: toTraceErrorType(reason), message: reason },
        })
      );
    }
    return { transition: modelPhase.transition, turn: modelPhase.turn };
  }
  const turnResult = modelPhase.result;

  if (
    turnResult.projection.toolCalls.length === 0 &&
    turnResult.isEmptyFinalResponse
  ) {
    const durationMs = performance.now() - started;
    if (opts.deps.trace) {
      await safeTrace(() =>
        opts.deps.trace!.recordTurn({
          turnIndex: opts.state.turnCount,
          startedAt: turnStartedAt,
          endedAt: new Date().toISOString(),
          durationMs,
          llmCallIds: llmCallId ? [llmCallId] : [],
          toolCallIds: [],
          decision: "emptyFinalResponse",
          status: "error",
          error: {
            type: "emptyFinalResponse",
            message: "emptyFinalResponse",
          },
        })
      );
    }
    return {
      transition: {
        kind: "stop",
        reason: "emptyFinalResponse",
        finalState: opts.state,
      },
      turn: mkTurn({
        turnIndex: opts.state.turnCount,
        supplierStop: turnResult.supplierStop,
        toolCalls: [],
        durationMs,
        cancelKind: "none",
      }),
    };
  }

  const nextState = appendMessage({
    state: opts.state,
    msg: turnResult.nativeMessage,
  });
  const afterAssistantState = {
    messages: nextState.messages,
    turnCount: opts.state.turnCount + 1,
  };

  if (turnResult.projection.toolCalls.length === 0) {
    const durationMs = performance.now() - started;
    const reason =
      turnResult.supplierStop === "success" ? "completed" : "nonSuccessStop";
    if (opts.deps.trace) {
      await safeTrace(() =>
        opts.deps.trace!.recordTurn({
          turnIndex: opts.state.turnCount,
          startedAt: turnStartedAt,
          endedAt: new Date().toISOString(),
          durationMs,
          llmCallIds: llmCallId ? [llmCallId] : [],
          toolCallIds: [],
          decision: reason,
          status: reason === "completed" ? "ok" : "error",
          error:
            reason === "completed"
              ? undefined
              : { type: toTraceErrorType("nonSuccessStop"), message: reason },
        })
      );
    }
    return {
      transition: { kind: "stop", reason, finalState: afterAssistantState },
      turn: mkTurn({
        turnIndex: opts.state.turnCount,
        supplierStop: turnResult.supplierStop,
        toolCalls: [],
        durationMs,
        cancelKind: "none",
      }),
    };
  }

  const toolStartedAt = new Date().toISOString();
  const toolStartMono = performance.now();

  const toolPhase = await runToolPhase({
    afterAssistantState,
    entryTurnCount: opts.state.turnCount,
    turnResult,
    deps: opts.deps,
    signal: opts.signal,
    started,
  });

  const toolEndedAt = new Date().toISOString();
  const toolDurationMs = performance.now() - toolStartMono;
  const toolCallIds: string[] = [];
  if (opts.deps.trace) {
    const nameById = new Map(
      toolPhase.toolCallViews.map((c) => [c.id, c.name])
    );
    for (const result of toolPhase.toolResults) {
      const toolName =
        nameById.get(result.toolUseId) ??
        (result.kind === "tool_not_found" ? result.toolName : "");
      const toolCallId = await safeTrace(() =>
        opts.deps.trace!.recordToolCall({
          parentLlmCallId: llmCallId,
          toolName,
          toolKind: result.kind,
          startedAt: toolStartedAt,
          endedAt: toolEndedAt,
          durationMs: toolDurationMs,
          argumentsCaptured: false,
          resultCaptured: false,
          status: result.kind === "ok" ? "ok" : "error",
          error:
            result.kind === "ok"
              ? undefined
              : {
                  type: result.kind,
                  message:
                    result.kind === "execution_failed" ||
                    result.kind === "validation_failed"
                      ? result.message
                      : result.kind,
                },
        })
      );
      if (toolCallId) toolCallIds.push(toolCallId);
    }
  }

  if (opts.deps.trace) {
    const toolTransition = toolPhase.transition;
    const isStop = toolTransition.kind === "stop";
    const decision = toDecision(isStop ? toolTransition.reason : "completed");
    await safeTrace(() =>
      opts.deps.trace!.recordTurn({
        turnIndex: opts.state.turnCount,
        startedAt: turnStartedAt,
        endedAt: new Date().toISOString(),
        durationMs: performance.now() - started,
        llmCallIds: llmCallId ? [llmCallId] : [],
        toolCallIds,
        decision,
        status: isStop ? "error" : "ok",
        error: isStop
          ? {
              type: toTraceErrorType(
                toolTransition.kind === "stop"
                  ? toolTransition.reason
                  : "unknown"
              ),
              message:
                toolTransition.kind === "stop" ? toolTransition.reason : "",
            }
          : undefined,
      })
    );
  }

  return { transition: toolPhase.transition, turn: toolPhase.turn };
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
  const { transition } = await stepWithTrace({ state, deps, signal });
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
  signal?: AbortSignal,
  opts?: { priorMessages?: ReadonlyArray<AnthropicNativeMessage> }
): Promise<{ result: RunResult; trace: LoopTrace }> {
  // 020 Q2 priorMessages 续传接缝:历史前缀逐条冻结,单次运行 turnCount 仍从 0 起。
  let state: LoopState = {
    messages: Object.freeze([
      ...(opts?.priorMessages ?? []).map(freezeMessage),
      freezeMessage(deps.adapter.encodeUserText(userText)),
    ]),
    turnCount: 0,
  };
  let turns: ReadonlyArray<TurnTrace> = [];
  while (true) {
    const { transition, turn } = await stepWithTrace({ state, deps, signal });
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
export type { LoopTrace, TurnTrace, Totals, CancelKind } from "./loop-trace.js";

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
