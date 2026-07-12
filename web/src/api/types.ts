/** Mirror of session-http-api-v0 DTOs used by the product UI. */

export type CallerRole = "employee" | "manager" | "admin";
export type AgentMode = "deterministic" | "llm";

export type SourceSpan = {
  chunk_id: string;
  quote?: string;
  offset?: [number, number];
};

export type ToolCallLog = {
  tool: string;
  args: Record<string, unknown>;
  ordinal: number;
};

export type IknowAnswer = {
  text: string;
  source_spans: SourceSpan[];
  snapshot_id: string;
  governance_status: string;
  tool_trace: string[];
  tool_calls: ToolCallLog[];
  hops_used: number;
  notes?: string[];
};

export type SessionSummary = {
  conversation_id: string;
  caller_role: CallerRole;
  mode: AgentMode;
  json_mode: boolean;
  turn_count: number;
  prior_count: number;
  embeddings: boolean;
};

export type TurnDto = {
  query: string;
  answer: IknowAnswer;
  human_text?: string;
};

export type CreateSessionResponse = {
  session: SessionSummary;
  turns: TurnDto[];
};

export type PostMessageResponse = {
  session: SessionSummary;
  turn: TurnDto;
};

export type PostCommandResponse = {
  session: SessionSummary;
  effect: string;
  message: string;
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

export type ApiErrorBody = {
  error: string;
  message: string;
  details?: Record<string, unknown>;
};

export class SessionApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly body: ApiErrorBody | null;

  constructor(
    message: string,
    status: number,
    code: string,
    body: ApiErrorBody | null,
  ) {
    super(message);
    this.name = "SessionApiError";
    this.status = status;
    this.code = code;
    this.body = body;
  }
}
