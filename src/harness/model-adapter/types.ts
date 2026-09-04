/**
 * Foundation 公共类型 (014 拥有;spec Code Style 区对齐)。
 *
 * 这些类型构成 016 Gate A 的核心接口形状,Loop Engine 和 Model Adapter
 * 都依赖此处的定义。注意:`AnthropicNativeMessage` 等 wire 协议类型
 * 仅由 Model Adapter 解释并产出,Loop Engine 不读取、不构造供应商原生字段。
 *
 * #176 T3：`ModelAdapter.step` 的 `request` 参数含可选 `onStream` 观察者
 * 回调（流式事件契约 SSOT `../stream.ts`，#147 D3）；仅流式臂消费,非流式
 * 臂忽略,缺省时行为与现状逐字节一致。
 */

import type { HarnessStreamEvent } from "../stream.js";

/** Anthropic 原生 content block(由 Model Adapter 解释)。 */
export type AnthropicContentBlock =
  | { type: "text"; text: string }
  | {
      type: "tool_use";
      id: string;
      name: string;
      input: unknown;
    }
  | {
      type: "tool_result";
      tool_use_id: string;
      content: unknown;
      is_error?: boolean;
    }
  | { type: "thinking"; thinking: string; signature: string }
  | { type: "redacted_thinking"; data: string };

/** Anthropic 原生消息角色。 */
export type AnthropicRole = "user" | "assistant" | "system";

/** Anthropic 原生消息(权威历史 append-only 单元)。 */
export interface AnthropicNativeMessage {
  readonly role: AnthropicRole;
  readonly content: ReadonlyArray<AnthropicContentBlock>;
}

/** Foundation 运行时权威状态(013 冻:唯一事实来源,不许第二份副本)。 */
export interface LoopState {
  /** Anthropic 原生 messages,append-only,immutable 追加。 */
  readonly messages: ReadonlyArray<AnthropicNativeMessage>;
  /** 每完成一个 assistant 回合(含纯文本完成)+1。 */
  readonly turnCount: number;
}

/** 016 Q3 五类停止原因 + 017 新增信号原因(append-only,不重排)。 */
export type StopReason =
  | "completed" // 成功停止 + 无 tool call + 至少一段非空文本
  | "maxTurns" // turnCount 到达上限
  | "nonSuccessStop" // 截断/拒绝等合法但未完成的供应商结果
  | "protocolError" // assistant 回合协议结构错误,整回合不进入历史
  | "emptyFinalResponse" // 供应商报告成功停止但无可展示文本,不进入权威历史
  | "cancelled" // 017: signal abort(type-only;runtime deferred to T5)
  | "timeout" // 017: timeoutMs hit(type-only;runtime deferred to T5)
  | "fused"; // #672 T3: 本 run 工具环停滞（只追加，不重排既有七值）

/** 016 Q1 状态机 Transition(判别联合,向后兼容扩展)。 */
export type Transition =
  | { kind: "continue"; nextState: LoopState }
  | { kind: "stop"; reason: StopReason; finalState: LoopState };

/** 一次 run 的对外结果。 */
export interface RunResult {
  /** 从最后成功 assistant 回合的 text blocks 派生(非权威)。 */
  readonly finalText: string | null;
  readonly messages: ReadonlyArray<AnthropicNativeMessage>;
  readonly turnCount: number;
  readonly stopReason: StopReason;
  /**
   * #160 / ADR-0008 Decision 5: 最后一次成功模型调用的 token usage(供显示面
   * 消费;TUI 经 hub-bridge 直读 RunResult)。必填字段:null = run 无成功模型
   * 调用(或所有成功调用的 usage 均缺席)。双源裁决(#160 Resolution Q4 +
   * ADR-0008 Decision 5),不复用 undefined 字段缺席语义——后者仅约束
   * LlmCallRecord 落盘面(Postel,ADR-0008 Decision 3)。
   */
  readonly lastUsage: TokenUsage | null;
}

/** assistant 回合投影:有序 text + 有序 tool call,保持原生顺序(014 投影)。 */
export interface AssistantProjection {
  /** 原生 assistant 回合原文,原样保留用于历史追加。 */
  readonly nativeMessage: AnthropicNativeMessage;
  /** 有序 text 投影(从原生 content blocks 按出现顺序筛出)。 */
  readonly texts: ReadonlyArray<string>;
  /** 有序 tool call 投影(身份 + 工具名 + 原始 input)。 */
  readonly toolCalls: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly input: unknown;
  }>;
}

/** 014 Adapter 公共回合结果(对应一次原生 assistant 回合)。 */
export interface AssistantTurnResult {
  /** 014 校验通过后的原生 assistant 消息,可被 Loop 原子追加。 */
  readonly nativeMessage: AnthropicNativeMessage;
  /** 014 投影(text + tool calls,保持原生顺序)。 */
  readonly projection: AssistantProjection;
  /** Adapter 解释后的供应商停止原因(成功 / 截断 / 拒绝 等)。 */
  readonly supplierStop: "success" | "truncation" | "refusal" | "other";
  /** 014 中是否需要工具(存在合法 tool call 即需要)。 */
  readonly needsTools: boolean;
  /** 是否为 `EmptyFinalResponse`(成功停止但无 text block)。 */
  readonly isEmptyFinalResponse: boolean;
  /**
   * #160 / ADR-0008 Decision 2+4: 一次成功 assistant 回合的 token 使用量投影
   * (sealed passthrough, 与 `supplierStop` 同构)。SDK usage 整体缺失 → 字段
   * 缺席(不写 null / 不写 {0,0,...});loop-engine 在 `recordLlmCall` 抄入
   * `LlmCallRecord`,`RunResult.lastUsage` 持有最后一次成功值。
   * stub 路径没有 usage,字段缺席是设计语义。
   */
  readonly usage?: TokenUsage;
  /**
   * D2 (tui-display-consistency):本 assistant 回合的思考时长(ms)。
   * 测量点 anthropic-adapter 流式臂 stepStreamArm —— 首条 thinking_delta 至
   * 首个非思考增量(text_delta / tool_call_start / tool_input_delta)的墙上
   * 时钟差。边界形态钉死:`thinkingMs <= 0` 或非有限数 → undefined
   * (store 落盘入口再过滤一次,绝不落 0 / NaN / Infinity)。非流式臂不产
   * 出(字段缺席 = 旧会话兼容 + 无思考回合)。Postel 纪律:`thinkingMs` 缺
   * 席 = 测不到,字段不存在(不写 null)。
   */
  readonly thinkingMs?: number;
}

/** 对齐 Anthropic SDK Usage 的 token 四字段(ADR-0008 Decision 2)。 */
export interface TokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheCreationInputTokens: number | null;
  readonly cacheReadInputTokens: number | null;
}

/**
 * B6 / ADR-0043 §3:countTokens 入参面 —— SDK 0.115 `client.messages.
 * countTokens` 投影到 harness 域。**只读 token 计数**(无流式臂、无 tool_call
 * 校验),装配层首轮溢出治理专用。
 *
 * 字段最小投影:
 *   - `tools` = 当前 visibleSchemas()(非 lazy + 已发现的 lazy;B4 §2 已有)
 *   - `system` = 当前 system 文本(可选;与 step request.system 同源)
 *   - `messages` = 当前消息历史(可选;首轮 = 空 messages,典型 0 消息)
 *
 * 真实 adapter 实现此方法;stub / 离线 adapter / 不可用端点 → 字段缺席
 * (undefined),装配层判定 → 跳过本会话(skip 语义,见 `tool-overflow.ts`)。
 */
export interface CountTokensInput {
  readonly tools?: ReadonlyArray<unknown>;
  readonly system?: string;
  readonly messages?: ReadonlyArray<AnthropicNativeMessage>;
}

/**
 * B6 / ADR-0043 §3:countTokens 响应最小投影 —— 实测 token 数。装配层
 * 与 `contextWindow * 0.1` 比较判定溢出。**不**返回 SDK 完整 Usage
 * (本接口面向溢出治理,不需要 cache_creation 等其他字段)。
 */
export interface CountTokensResult {
  /** SDK `MessageTokensCount.input_tokens`(countTokens 仅这一字段)。 */
  readonly inputTokens: number;
}

/** Model Adapter 接口(014 拥有)。 */
export interface ModelAdapter {
  /** 014 原子校验 + 投影:返回 AssistantTurnResult 或抛 ProtocolError。 */
  readonly step: (
    state: LoopState,
    // #176 T3:可选 onStream — 流式事件观察者(#147 D3),仅流式臂消费;
    // 离线 adapter / 非流式臂忽略此字段。
    request: {
      tools?: unknown;
      onStream?: (event: HarnessStreamEvent) => void;
    },
    signal?: AbortSignal // 017: run 第三参原样透传,离线实现可忽略(type-only;runtime deferred to T5)
  ) => Promise<AssistantTurnResult>;
  /**
   * B6 / ADR-0043 §3:**可选** countTokens 钩子(溢出治理专用)。
   *
   * 真实 Anthropic adapter (`createRealAnthropicAdapter`) 实现本方法 —
   * 透传 SDK `client.messages.countTokens({ messages, model, system?,
   * tools? })` 实测 token 数。**Stub / 离线 adapter 不实现**;字段缺席
   * (`undefined`) → 装配层跳过本会话(全部 deferrable 内建件保持常驻)+
   * `console.warn` 记录,首轮不抛错、不重试(ADR-0043 §3 钉死语义)。
   *
   * 契约:
   *   - `tools` 数组 = harness `ToolDef[]`(与 `step` request.tools 同源,
   *     离线/真实 adapter 各自翻译为 SDK `Tool[]` / `MessageCountTokensTool[]`)。
   *   - 返回 `inputTokens` 必须为有限正数;否则视为失败(与 catch 同语义)。
   *   - SDK 错误(APIError / 4xx/5xx)→ throw;装配层 catch 后 skip 本会话。
   */
  readonly countTokens?: (
    input: CountTokensInput
  ) => Promise<CountTokensResult>;
}
