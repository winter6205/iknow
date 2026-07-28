/**
 * Foundation 公共类型 (014 拥有;spec Code Style 区对齐)。
 *
 * 这些类型构成 016 Gate A 的核心接口形状,Loop Engine 和 Model Adapter
 * 都依赖此处的定义。注意:`AnthropicNativeMessage` 等 wire 协议类型
 * 仅由 Model Adapter 解释并产出,Loop Engine 不读取、不构造供应商原生字段。
 */

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
    };

/** Anthropic 原生消息角色。 */
export type AnthropicRole = "user" | "assistant";

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

/** 016 Q3 五类停止原因。 */
export type StopReason =
  | "completed" // 成功停止 + 无 tool call + 至少一段非空文本
  | "maxTurns" // turnCount 到达上限
  | "nonSuccessStop" // 截断/拒绝等合法但未完成的供应商结果
  | "protocolError" // assistant 回合协议结构错误,整回合不进入历史
  | "emptyFinalResponse"; // 供应商报告成功停止但无可展示文本,不进入权威历史

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
}

/** Model Adapter 接口(014 拥有)。 */
export interface ModelAdapter {
  /** 014 原子校验 + 投影:返回 AssistantTurnResult 或抛 ProtocolError。 */
  readonly step: (
    state: LoopState,
    request: { system?: string; tools?: unknown }
  ) => Promise<AssistantTurnResult>;
}