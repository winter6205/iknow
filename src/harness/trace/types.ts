/**
 * Trace Service bounded context — interface contract (GH #64, T2).
 *
 * 决策: conversationId 不进 record 参数。
 *   - 原因: loop-engine 016/017 不持 conversation 概念;逐条传会逼 LoopEngineDeps 加字段,
 *     违反 spec 判据 17 (LoopEngineDeps 只能加 `trace?` 可选字段)。
 *   - 实例绑定: T3 的 JsonlTraceService 构造参数收 conversationId,每条 JSONL 记录写入它。
 *     满足 ADR-0003 Decision 4 (conversation_id 永远存在于 JSONL)。
 *
 * 字段集决策 (Postel's Law, 2026-07-31 grilling):
 *   - TraceErrorType 复用 StopReason + ToolExecutionResult.kind + unknown 兜底;
 *     不含 api_error / rate_limit / context_length_exceeded / content_filter / internal
 *     (源码无现成 union, ADR Decision 6 文本与 repo 不符时以 repo 实际值为 SSOT)。
 *   - supplierStop 值域同 LoopTrace TurnTrace (4 值 camelCase union)。
 *   - toolKind 值域同 LoopTrace TurnTrace (4 值 camelCase union)。
 *   - decision 值域 = StopReason 去掉 maxTurns (6 值 camelCase union)。
 *     maxTurns 被移除原因 (Postel's Law): maxTurns 早停分支在 stepWithTrace
 *     入口即返回 turn: null, 从不 recordTurn, 该值永远不会写入 decision;
 *     留在 union 里只是死值, 故删。
 *
 * 不依赖 model-adapter / tools 的类型,通过重定义字面量联合 + JSDoc 标注源文件保持
 * trace bounded context 的独立松耦合 (follow loop-trace.ts:17 注释 + loop-trace.ts:22-23 注释先例)。
 */

export type TraceStatus = "ok" | "error";

export type TraceErrorType =
  | "cancelled"
  | "timeout"
  | "protocolError"
  | "emptyFinalResponse"
  | "validation_failed"
  | "tool_not_found"
  | "execution_failed"
  | "unknown";

export interface TraceError {
  type: TraceErrorType;
  message: string;
}

export interface LlmCallRecord {
  startedAt: string;
  endedAt: string;
  durationMs: number;
  supplierStop?: "success" | "truncation" | "refusal" | "other";
  stream: boolean;
  messagesCaptured: boolean;
  messages?: ReadonlyArray<unknown>;
  status: TraceStatus;
  error?: TraceError;
  /**
   * #160 / ADR-0008 Decision 2: 顶层平铺的 token 四字段。
   * 形状对齐 SDK `Usage` 与 model-adapter 域类型 `TokenUsage`,
   * 但 trace bounded context 遵循先例(文件头注释 + loop-trace.ts:17/22-23)
   * **不 import** model-adapter 类型 —— 通过字面量联合 + JSDoc 标注源
   * 文件保持独立松耦合;loop-engine 在 `recordLlmCall` 抄入时做结构赋值。
   *
   * Postel 语义(ADR-0003 Decision 9 + ADR-0008 Decision 3):
   *   - success 分支填全四字段(SDK 保证存在);
   *   - error 分支(整条缺席)不写任何 *_tokens 键,JSON.stringify
   *     自然丢弃 undefined,字段缺席 = 调用未产生 token 计数(不可猜测)。
   */
  inputTokens?: number;
  outputTokens?: number;
  cacheCreationInputTokens?: number | null;
  cacheReadInputTokens?: number | null;
}

export interface ToolCallRecord {
  parentLlmCallId: string | undefined;
  toolName: string;
  toolKind: "ok" | "validation_failed" | "tool_not_found" | "execution_failed";
  startedAt: string;
  endedAt: string;
  durationMs: number;
  argumentsCaptured: boolean;
  arguments?: unknown;
  resultCaptured: boolean;
  result?: unknown;
  status: TraceStatus;
  error?: TraceError;
}

export interface TurnRecord {
  turnIndex: number;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  llmCallIds: ReadonlyArray<string>;
  toolCallIds: ReadonlyArray<string>;
  decision:
    | "completed"
    | "nonSuccessStop"
    | "protocolError"
    | "emptyFinalResponse"
    | "cancelled"
    | "timeout";
  status: TraceStatus;
  error?: TraceError;
}

export interface TraceService {
  /**
   * 记录一次 LLM 调用; 由实现生成 llmCallId。
   * @throws never — 实现必须捕获 IO 错误并返回 undefined (spec 判据 4/13)。
   */
  recordLlmCall(record: LlmCallRecord): Promise<string | undefined>;
  /**
   * 记录一次工具调用; parentLlmCallId 为必填槽 (undefined → 孤儿记录)。
   * @throws never.
   */
  recordToolCall(record: ToolCallRecord): Promise<string | undefined>;
  /**
   * 记录一次 turn; 由实现生成 turnId。
   * @throws never.
   */
  recordTurn(record: TurnRecord): Promise<string | undefined>;
}
