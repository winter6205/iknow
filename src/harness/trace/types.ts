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
  /**
   * #361 / ADR-0014 Decision 6:loop-engine 在 model 阶段成功 / 错误 / 摘要
   * 三处(recordLlmCall @ 427 / 948 / 970)首次填充 messages 字段 —— 语义
   * 即"模型本步实际看到的 messages"(effectiveState.messages, 含 reactive
   * 压缩后形态;摘要轮为 outcome.inputMessages = truncateTailForSummary
   * 截尾 + 收尾 user prompt)。
   *
   * **无 size cap**(review-fix S6):全量 messages 进 trace 会膨胀 jsonl
   * 行体积 —— 长会话持续累积,行字节数随 turn 线性增长。决策:不在写入
   * 侧裁剪(避免与 messages_captured 验收 6 矛盾 —— 验收 6 要求 messages
   * 数组含 coordinator 段 proactive 关键词等完整 system 文本,截断会破坏
   * "模型实际所见"不变量);如未来需控容,由 trace 消费端(IDE 调试器 /
   * 上层观测工具)按 IKNOW_TRACE_MAX_CONTENT_BYTES 类策略裁剪,loop-engine
   * 保持"所见即所填"的真值纪律。Postel(ADR-0003 D9):messagesCaptured
   * 独立布尔开关,字段填充由 loop-engine 决定;trace 服务不裁剪。
   */
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
  /**
   * #286 补字段（spec 欠账）。
   * 模型调用经适配器路由到实际供应商模型时记录：
   *   - modelRequested — 请求侧申报的模型（resolve 到实际路由模型）；
   *   - modelActual — 响应侧实际模型（request.model ≠ response.model 双字段）；
   *   - provider — 供应商名（= gen_ai.provider.name 类比）。
   * Postel（ADR-0003 D9 + ADR-0008 D3）:成功分支填，错误分支缺席。
   */
  modelRequested?: string;
  modelActual?: string;
  provider?: string;
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

/**
 * #285/#286 会话级 L1 根记录（v2）。
 * loop-engine 入口埋点，表示一次完整运行的根；所有 turn/llm/tool 记录
 * 通过 conversation_id 关联到它。
 */
export interface SessionRecord {
  startedAt: string;
  endedAt: string;
  durationMs: number;
  /**
   * 由 writer/CLI 侧在构造时注入（C2 决议：注入而非 harness 层 import
   * cli/usage.ts，避免写侧←cli 反向依赖，遵循 ADR-0003 文件头先例）。
   */
  agentVersion: string;
  status: TraceStatus;
  error?: TraceError;
}

/**
 * #285/#286 沙箱命令执行记录（v2）。
 * schema 就位、埋点留 pendingRuntime（sandbox 只有 violation，无独立命令
 * 执行记录能力；Postel 例外论证见 spec）。当前不产生任何 JSONL 行。
 */
export interface SandboxCmdRecord {
  /** 单值 parent（#286 决议：新 record 统一 parent_*_id 单值）。 */
  parentTurnId: string;
  command: string;
  exitCode: number;
  /** Postel：布尔开关，内容仅 true 时落盘。 */
  stdoutCaptured: boolean;
  /** 限长（C 方案：IKNOW_TRACE_MAX_CONTENT_BYTES）。 */
  stdout?: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  status: TraceStatus;
  error?: TraceError;
}

/**
 * 分类器 (子代理 LLM 判官, #128) 单条证据: 判官跑了什么 + 跑出了什么。
 * 语义同 verify 域 `ClassifierCheck` (spec A4); trace bounded context 遵循文件头
 * 先例 (loop-trace.ts:17/22-23 注释) **不 import** verify 域类型 —— 通过形状重定义
 * + JSDoc 标注源文件保持独立松耦合; verify-loop 抄入时做结构赋值。
 * 无 command 的 check 算 skip 不算 pass (spec A4)。
 */
export interface VerificationCheck {
  readonly command: string;
  readonly output?: string;
  readonly result: "pass" | "fail";
}

/**
 * 验证判定记录（#128 自动修正闭环观测落点）。
 * 与既有 record 的关键差异: id/sessionId/ts 由调用方提供 (plan §Decisions 定稿),
 * 不依赖 turn 树 —— 以自有 id 关联整条验证轨迹。
 * sessionId 关联会话根; round 为闭环轮次; verdict 三态判定; action 为策略动作。
 * Postel: failedCount / signature / finalOutcome 可选, 仅存在时落盘。
 */
export interface VerificationRecord {
  /** 自有 id (#286 决议：新 record 统一 parent_*_id 单值；VerificationRecord 以自有 id 关联整条验证轨迹，不依赖 turn 树）。 */
  readonly id: string;
  readonly sessionId: string;
  readonly round: number;
  readonly verdict: VerificationVerdict;
  readonly exitCode: number;
  /** Postel：布尔开关，内容仅存在时落盘。 */
  readonly failedCount?: number;
  readonly signature?: string;
  readonly action: VerificationAction;
  readonly finalOutcome?: string;
  readonly ts: string;
  /** 分类器分支字段: 语义同 verify 域 VerificationRecord (spec A4 / SC10)。 */
  readonly reason?: string;
  readonly evidence?: ReadonlyArray<VerificationCheck>;
  readonly missing?: ReadonlyArray<string>;
  /**
   * 证据优先前级字段 (#449b B3, 镜像 verify 域 VerificationRecord.evidenceVerdict / .gamingSignals)。
   * trace bounded context 遵循文件头注释 (types.ts:21-23) **不 import** verify 域类型;
   * 通过同名字面字符串联合保持独立松耦合, verify-loop 在 buildRecord 处做结构赋值。
   * evidenceVerdict 三值: EVIDENCE_SUFFICIENT / EVIDENCE_CONTRADICTED / EVIDENCE_INSUFFICIENT
   * (与 src/harness/verify/types.ts `EvidenceVerdict` 同值域)。
   * Postel: 可选字段仅存在时落盘。
   */
  readonly evidenceVerdict?:
    "EVIDENCE_SUFFICIENT" | "EVIDENCE_CONTRADICTED" | "EVIDENCE_INSUFFICIENT";
  readonly gamingSignals?: ReadonlyArray<string>;
}

export type VerificationVerdict = "pass" | "true-failure" | "unstable";
export type VerificationAction = "continue" | "stop" | "escalate";

/**
 * Goal 生命周期 trace action (T4, #458).
 *
 * 自包含字面量联合 —— trace bounded context 遵循文件头注释 (types.ts:21-23)
 * 与 VerificationRecord 同模式, **不 import** session-api 的 GoalAction 类型;
 * 通过重定义字面量 + JSDoc 标注源文件保持 trace 域独立松耦合.
 * 源文件对照: plans/458-goal-lifecycle-taskfocus.md T4 Acceptance.
 */
export type GoalAction = "seed" | "pin" | "clear" | "writeback";

/**
 * Goal 生命周期 trace status (T4, #458).
 *
 * 刻意 **不含** 已删的模型提议槽位 (SC1 防回归, ACR #2 协同: T6 模型提议/确认通道
 * 零落地, 删除该字面值避免死值). 包含 `cleared` 是 /goal clear 命令的终态,
 * 与 applyTransition 五态 (active/achieved/aborted/superseded) 区分 —— 清除态
 * 不走状态机转移, 仅 trace 留痕.
 *
 * 自包含字面量联合 —— 不 import session-api 类型.
 */
export type GoalTraceStatus =
  "active" | "achieved" | "aborted" | "superseded" | "cleared";

/**
 * Goal 生命周期 trace record (T4, #458 — T12 数据契约落定).
 *
 * 与 VerificationRecord 同形态: id/sessionId/ts/conversationId 由调用方提供;
 * 实现不做 ID 生成 —— 成功返回 record.id, 失败返回 undefined.
 * sessionId 关联会话根; action 区分生命周期节点 (seed/pin/clear/writeback);
 * status 可选 (clear 与 seed 不一定带 status); text 与 textLen 二选一 (seed
 * 路径只带 textLen 不带 text 明文, 减少日志膨胀 — 与 hub.ts:1061 seed 发射点对齐).
 *
 * Postel: status / text / textLen 可选, 仅存在时落盘 (JSON.stringify 自动丢弃 undefined).
 */
export interface GoalRecord {
  /** 自有 id (调用方提供, 实现不做 ID 生成). */
  readonly id: string;
  readonly sessionId: string;
  readonly action: GoalAction;
  /** Postel: 可选 (clear/seed 不一定带). */
  readonly status?: GoalTraceStatus;
  /** Postel: 可选 (seed 路径只带 textLen). */
  readonly text?: string;
  /** Postel: 可选 (Pin/writeback 路径通常不带). */
  readonly textLen?: number;
  readonly ts: string;
  readonly conversationId: string;
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
  /**
   * 记录一次会话根 (L1, v2); 由实现生成 sessionId。
   * @throws never.
   */
  recordSession(record: SessionRecord): Promise<string | undefined>;
  /**
   * 记录一次沙箱命令执行 (v2, schema 就位埋点留 pendingRuntime)。
   * @throws never.
   */
  recordSandboxCmd(record: SandboxCmdRecord): Promise<string | undefined>;
  /**
   * 记录一次验证判定（#128 闭环）。
   * 注意: 与既有 record 不同, VerificationRecord 的 id/sessionId/ts 由调用方提供,
   * 实现不做 ID 生成 —— 成功返回 record.id, 失败返回 undefined。
   * @throws never — 实现必须捕获 IO 错误并返回 undefined。
   */
  recordVerification(record: VerificationRecord): Promise<string | undefined>;
  /**
   * 记录一次 goal 生命周期事件 (#458 T12 数据契约).
   * 注意: 与 VerificationRecord 同形态 —— id/sessionId/ts 由调用方提供,
   * 实现不做 ID 生成 —— 成功返回 record.id, 失败返回 undefined.
   * record.conversationId 是冗余字段 (工厂构造时已实例绑定), 实现从 snake
   * 副本剔除以保证工厂 binding 胜出 (对齐 recordVerification 语义).
   * @throws never — 实现必须捕获 IO 错误并返回 undefined。
   */
  recordGoal(record: GoalRecord): Promise<string | undefined>;
}
