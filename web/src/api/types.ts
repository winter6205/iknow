/** Mirror of session-http-api-v0 DTOs used by the product UI. */

/** Mirrors harness StopReason (7 values). */
export type StopReason =
  | "completed"
  | "maxTurns"
  | "nonSuccessStop"
  | "protocolError"
  | "emptyFinalResponse"
  | "cancelled"
  | "timeout";

/** Mirrors ThinkingEntryView in src/session-api/contract.ts. */
export type ThinkingEntryView = {
  readonly text: string;
};

/** Mirrors ThinkingView in src/session-api/contract.ts. */
export type ThinkingView = {
  readonly entries: readonly ThinkingEntryView[];
  readonly redactedCount: number;
};

/** Mirrors ToolCallView in src/session-api/contract.ts. */
export type ToolCallView = {
  readonly id: string;
  readonly name: string;
  readonly inputPreview: string;
  readonly outputPreview: string;
  readonly isError: boolean;
  readonly truncated: boolean;
};

/** Mirrors TurnAnswerDto in src/session-api/contract.ts. */
export type TurnAnswerDto = {
  readonly finalText: string;
  readonly stopReason: StopReason;
  readonly turnCount: number;
  /** 可选：单回合 thinking 文本视图（后端 T1 投影；无 thinking 时省略）。 */
  readonly thinking?: ThinkingView;
  /** 可选：单回合工具调用视图（后端 T1 投影；无 tool_use 时省略）。 */
  readonly toolCalls?: readonly ToolCallView[];
};

/** Mirrors ThinkingOverride in PostMessageRequest (src/session-api/contract.ts). */
export type ThinkingOverride = {
  readonly mode: "off" | "adaptive";
  readonly effort?: "" | "low" | "medium" | "high" | "xhigh" | "max";
};

/** Mirrors PostMessageRequest in src/session-api/contract.ts. */
export type PostMessageRequest = {
  readonly text: string;
  readonly thinking?: ThinkingOverride;
};

/** Mirrors SessionListEntry in src/session-api/store/session-store.ts. */
export type SessionListItem = {
  readonly conversation_id: string;
  readonly updatedAt: string;
  readonly lastFinalText: string;
};

export type SessionSummary = {
  conversation_id: string;
  json_mode: boolean;
  turn_count: number;
  prior_count: number;
};

export type TurnDto = {
  query: string;
  answer: TurnAnswerDto;
  human_text?: string;
};

export type CreateSessionResponse = {
  session: SessionSummary;
  turns: TurnDto[];
};

export type GetSessionResponse = {
  session: SessionSummary;
  turns: TurnDto[];
};

export type PostMessageResponse = {
  session: SessionSummary;
  turn: TurnDto;
};

export type ResetSessionResponse = {
  session: SessionSummary;
  turns: TurnDto[];
};

export type HealthResponse = {
  ok: true;
  service: string;
  version: string;
};

/**
 * Wire error body (nested). Mirrors ApiErrorBody in src/session-api/contract.ts.
 * kind is SessionStoreErrorKind | "validation" | "internal"; kept as string
 * on the web side to avoid coupling to backend enum evolution.
 */
export type ApiErrorBody = {
  error: {
    kind: string;
    message: string;
    conversation_id?: string;
    field?: string;
  };
};

export class SessionApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly body: ApiErrorBody | null;

  constructor(
    message: string,
    status: number,
    code: string,
    body: ApiErrorBody | null
  ) {
    super(message);
    this.name = "SessionApiError";
    this.status = status;
    this.code = code;
    this.body = body;
  }
}
