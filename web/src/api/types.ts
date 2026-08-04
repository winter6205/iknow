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

/** Mirrors TurnAnswerDto in src/session-api/contract.ts. */
export type TurnAnswerDto = {
  readonly finalText: string;
  readonly stopReason: StopReason;
  readonly turnCount: number;
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

// -- Trace inspection panel (mirrors src/traceserver/) -----------------------

export type TraceRecord = Record<string, unknown>;

export interface TracesResponse {
  readonly records: ReadonlyArray<TraceRecord>;
  readonly total: number;
  readonly skipped_lines: number;
  readonly truncated: boolean;
}

export type TraceRecordType = "llm_call" | "tool_call" | "turn" | "violation";

export type TraceFieldType =
  "string" | "number" | "boolean" | "enum" | "datetime";

export interface TraceFieldDef {
  readonly key: string;
  readonly jsonlKey: string;
  readonly type: TraceFieldType;
  readonly label: string;
  readonly recordTypes: ReadonlyArray<TraceRecordType>;
  readonly options?: ReadonlyArray<string>;
  /** Declarative render-tone hint; "status" colours the cell by ok/error value. */
  readonly tone?: "status";
}

export interface TraceQueryParams {
  readonly conversation_id?: string;
  readonly record_type?: TraceRecordType;
  readonly status?: "ok" | "error";
  readonly limit?: number;
  readonly offset?: number;
}
