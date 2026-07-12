/**
 * Session HTTP API DTOs (host surface; not tool schema).
 * See docs/design/session-http-api-v0.md
 */
import type {
  CallerRole,
  IknowAnswer,
} from "../shared/schema.js";
import type { AgentModeCli } from "../interaction/slash.js";

/** Max user message length (code units). */
export const MAX_MESSAGE_CHARS = 8000;

export type SessionSummary = {
  conversation_id: string;
  caller_role: CallerRole;
  mode: AgentModeCli;
  json_mode: boolean;
  turn_count: number;
  prior_count: number;
  embeddings: boolean;
};

export type TurnDto = {
  query: string;
  answer: IknowAnswer;
  /** Host human projection when json_mode is false. */
  human_text?: string;
};

export type CreateSessionRequest = {
  role?: CallerRole;
  mode?: AgentModeCli;
  json_mode?: boolean;
  embeddings?: boolean;
};

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

export type PostCommandRequest = {
  command: string;
  args?: string[];
};

export type CommandEffectKind =
  | "help"
  | "info"
  | "error"
  | "mode_change"
  | "reset"
  | "quit";

export type PostCommandResponse = {
  session: SessionSummary;
  effect: CommandEffectKind;
  message: string;
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

export type ApiErrorBody = {
  error: string;
  message: string;
  details?: Record<string, unknown>;
};

/** Reserved routes (UI may probe; server may return 501). */
export const RESERVED_PATHS = {
  eventsSse: "/api/v1/sessions/:id/events",
} as const;
