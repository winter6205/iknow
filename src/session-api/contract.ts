/**
 * Session HTTP API DTOs (host surface; not tool schema).
 *
 * TurnDto.answer is the harness RunResult projection (TurnAnswerDto);
 * ApiErrorBody
 * is nested under { error: { kind, message, ... } }. http.ts / hub.ts still
 * reference the old shapes — they will be rewritten in T4/T5.
 */
import type { StopReason, TokenUsage } from "../harness/index.js";
import type { SessionStoreErrorKind } from "./store/errors.js";

/** Max user message length (code units). */
export const MAX_MESSAGE_CHARS = 8000;

/** 022 Q1: Session API 消息返回壳。harness RunResult 投影，wire 不外露 messages/trace。 */
export interface TurnAnswerDto {
  readonly finalText: string; // 映射 RunResult.finalText
  readonly stopReason: StopReason; // 复用 harness 7 类 StopReason 类型
  readonly turnCount: number; // 映射 RunResult.turnCount（每次 run() 从 0 起）
  /** T1: 单回合内所有非空 assistant thinking 文本（按块序）。空 thinking 跳过；无任何 thinking 时整字段省略。 */
  readonly thinking?: ThinkingView;
  /** T1: 单回合内所有 tool_use，按 tool_use_id 配对 tool_result。无 tool_use 时整字段省略。 */
  readonly toolCalls?: readonly ToolCallView[];
  /** 上下文用量显示：该回合最后一次成功模型调用的 token usage。
   *  映射 RunResult.lastUsage（ADR-0008 D5）；null → 字段缺席（byte-stable，
   *  与 thinking/toolCalls 同模式）。contextWindow 经 HealthResponse 下发。 */
  readonly lastUsage?: TokenUsage;
  /**
   * plan T6 / ADR-0011：异常停（maxTurns 等）后的 best-effort 收尾摘要文本。
   * 仅 hub 捕获 MaxTurnsExceeded 时填充；无摘要 / 正常停 → 字段缺席
   * （byte-stable，与 thinking/toolCalls/lastUsage 同模式）。
   */
  readonly stopSummary?: string;
  /**
   * B1：Ctrl+C 打断反馈 —— 仅 stopReason === "cancelled" 时存在：
   * true = checkpoint 已保存（cancelled + delta>0）；false = 无新内容未落盘
   * （cancelled + delta=0）。其它 stopReason → 字段缺席（byte-stable）。
   */
  readonly interrupted?: boolean;
  /**
   * #128 失败自动修正闭环（M3 surface）：仅 verify 配置且最终判定为
   * 真失败 / 不稳定 / 升级后仍失败时存在。passed / disabled / aborted → 字段缺席
   * （byte-stable，与 stopSummary / interrupted 同模式）。
   */
  readonly verify?: VerifyAnswerView;
}

/** #128：验证闭环最终判定的 wire 视图（rounds + outcome，供 UI surface）。 */
export interface VerifyAnswerView {
  readonly outcome: "failed" | "unstable" | "escalated";
  readonly rounds: number;
}

/** T1: 单条 thinking 文本视图（redacted_thinking 仅计数，data 永不上 wire）。 */
export interface ThinkingEntryView {
  readonly text: string;
}

export interface ThinkingView {
  readonly entries: readonly ThinkingEntryView[]; // 按块序，空 thinking 文本跳过
  readonly redactedCount: number; // redacted_thinking block 计数
}

/** T1: 工具调用视图（input/output 走 preview + 截断，data 永不暴露原始 input）。 */
export interface ToolCallView {
  readonly id: string; // tool_use.id
  readonly name: string;
  readonly inputPreview: string; // JSON.stringify(input)，截断 MAX_TOOL_INPUT_PREVIEW_CHARS
  readonly outputPreview: string; // tool_result text 拼接，截断 MAX_TOOL_OUTPUT_PREVIEW_CHARS
  readonly isError: boolean; // tool_result.is_error === true
  readonly truncated: boolean; // output 是否被截断
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
  readonly json_mode: boolean;
  readonly turn_count: number;
  readonly prior_count: number;
}

export interface CreateSessionRequest {
  // caller_role 已在 harness 路径退役（Q2-G4）；wire 不再接受
  json_mode?: boolean;
}

export type CreateSessionResponse = {
  session: SessionSummary;
  turns: TurnDto[];
};

export type GetSessionResponse = {
  session: SessionSummary;
  turns: TurnDto[];
};

/** T2: per-request thinking effort value range (SSOT). */
export const THINKING_EFFORT_VALUES = [
  "",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
export type ThinkingEffortWire = (typeof THINKING_EFFORT_VALUES)[number];

/** T2: per-request thinking override (mode + optional effort). */
export interface WireThinkingOverride {
  readonly mode: "off" | "adaptive";
  readonly effort?: ThinkingEffortWire;
}

export type PostMessageRequest = {
  text: string;
  /** T2: 该回合覆盖 harness 的 thinking 控制臂。缺省 → 沿用 ensureDeps 的缓存配置（行为不变）。 */
  readonly thinking?: WireThinkingOverride;
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

/**
 * 手动压缩会话响应（web 按钮 / TUI /compact 共用 wire 形状）。
 * 压缩后 session 保持同一 conversation_id；turns 为压缩后消息投影。
 * `compacted`：true 表示实际发生了裁剪（消息数减少）；false 表示消息已
 * 低于压缩阈值、无变化（幂等 no-op，客户端据此提示“无需压缩”）。
 */
export type CompactSessionResponse = {
  session: SessionSummary;
  turns: TurnDto[];
  compacted: boolean;
  /** 压缩前的消息条数（DEFAULT_KEEP_RECENT 尾窗保留判定用）。 */
  beforeCount: number;
  /** 压缩后的消息条数（no-op 时 === beforeCount）。 */
  afterCount: number;
};

export type HealthResponse = {
  ok: true;
  service: "iknow-session-api";
  version: string;
  /** 上下文窗口大小（token）。来源 env.compress.contextWindow（IKNOW_MODEL_CONTEXT_WINDOW），
   *  默认 200000。上下文用量显示的百分比分母。 */
  contextWindow: number;
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
