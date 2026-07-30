/**
 * Session HTTP API DTOs (host surface; not tool schema).
 * See docs/design/session-http-api-v0.md
 *
 * 022 T3 wire DTO rewrite: TurnDto.answer is now the harness RunResult
 * projection (TurnAnswerDto); SessionSummary drops caller_role; ApiErrorBody
 * is nested under { error: { kind, message, ... } }. http.ts / hub.ts still
 * reference the old shapes — they will be rewritten in T4/T5.
 */
import type { StopReason } from "../harness/index.js";
import type { AgentMode } from "../config/env.js";
import type { SessionStoreErrorKind } from "./store/errors.js";

/** Max user message length (code units). */
export const MAX_MESSAGE_CHARS = 8000;

/** 022 Q1: Session API 消息返回壳。harness RunResult 投影，wire 不外露 messages/trace。 */
export interface TurnAnswerDto {
  readonly finalText: string; // 映射 RunResult.finalText
  readonly stopReason: StopReason; // 复用 harness 7 类 StopReason 类型
  readonly turnCount: number; // 映射 RunResult.turnCount（每次 run() 从 0 起）
}

/** 022 Q1: 单次消息往返的 wire 形状。 */
export interface TurnDto {
  readonly query: string; // 用户输入文本
  readonly answer: TurnAnswerDto; // harness 投影，不含 messages/trace
  readonly human_text?: string; // host 投影（jsonMode=false 时填充）
}

/** 022 Q2-G4: 移除 caller_role 字段。caller_role 已在 harness 路径退役。 */
export interface SessionSummary {
  readonly conversation_id: string;
  readonly mode: AgentMode; // 020 决议保留
  readonly json_mode: boolean;
  readonly turn_count: number;
  readonly prior_count: number;
  readonly embeddings: boolean;
}

export interface CreateSessionRequest {
  // caller_role 已在 harness 路径退役（Q2-G4）；wire 不再接受
  mode?: AgentMode;
  json_mode?: boolean;
  embeddings?: boolean;
}

export type CreateSessionResponse = {
  session: SessionSummary;
  turns: TurnDto[];
};

export type GetSessionResponse = {
  session: SessionSummary;
  turns: TurnDto[];
};

export type PostMessageRequest = {
  text: string;
};

export type PostMessageResponse = {
  session: SessionSummary;
  turn: TurnDto;
};

export type ResetSessionRequest = {
  new_id?: boolean;
};

export type ResetSessionResponse = {
  session: SessionSummary;
  turns: TurnDto[];
};

export type HealthResponse = {
  ok: true;
  service: "iknow-session-api";
  version: string;
};

/**
 * 022 D1.1: wire 错误响应。嵌套形：`error.kind` 是 SessionStoreErrorKind 或
 * `validation` / `internal`；旧扁平形（`{ error: string; message; details? }`）退役。
 */
export interface ApiErrorBody {
  readonly error: {
    readonly kind: SessionStoreErrorKind | "validation" | "internal";
    readonly message: string;
    readonly conversation_id?: string;
    readonly field?: string;
  };
}

/** Reserved routes (UI may probe; server may return 501). */
export const RESERVED_PATHS = {
  eventsSse: "/api/v1/sessions/:id/events",
} as const;
