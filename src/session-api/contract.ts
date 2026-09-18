/**
 * Session HTTP API DTOs (host surface; not tool schema).
 *
 * TurnDto.answer is the harness RunResult projection (TurnAnswerDto);
 * ApiErrorBody
 * is nested under { error: { kind, message, ... } }. http.ts / hub.ts still
 * reference the old shapes — they will be rewritten in T4/T5.
 */
import type { StopReason, TokenUsage } from "../harness/index.js";
import type { FsIsolationMode } from "../harness/sandbox/fs-mode.js";
import type { HarnessStreamEvent } from "../harness/stream.js";
import type { CompactReason } from "../harness/compress/index.js";
import type { SessionStoreErrorKind } from "./store/errors.js";

/** Max user message length (code units). */
export const MAX_MESSAGE_CHARS = 8000;

/** 022 Q1: Session API 消息返回壳。harness RunResult 投影，wire 不外露 messages/trace。 */
export interface TurnAnswerDto {
  readonly finalText: string; // 映射 RunResult.finalText
  readonly stopReason: StopReason; // 复用 harness 8 类 StopReason 类型（含 fused）
  readonly turnCount: number; // 映射 RunResult.turnCount（每次 run() 从 0 起）
  /** T1: 单回合内所有非空 assistant thinking 文本（按块序）。空 thinking 跳过；无任何 thinking 时整字段省略。 */
  readonly thinking?: ThinkingView;
  /** T1: 单回合内所有 tool_use，按 tool_use_id 配对 tool_result。无 tool_use 时整字段省略。 */
  readonly toolCalls?: readonly ToolCallView[];
  /** Ordered assistant content used by clients that need text/tool placement. */
  readonly activity?: readonly ActivityItem[];
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
   * #128 失败自动修正闭环（M3 surface）：verify 配置且最终判定为
   * 真失败 / 不稳定 / 升级后仍失败 / 通过时存在。disabled / aborted → 字段缺席
   * （byte-stable，与 stopSummary / interrupted 同模式）。
   */
  readonly verify?: VerifyAnswerView;
  /**
   * D2 (tui-display-consistency) wire surface: 单回合 assistant 思考时长
   * (ms)。hub `projectMessagesToTurns` / `toTurnDto` 求和本 turn slice 内
   * 所有 assistant 消息对应的落盘 thinkingMs (per-message index → 并行数组);
   * sum > 0 时挂上本字段 (byte-stable, 与 thinking/toolCalls/lastUsage 同模式)。
   * 旧会话无 thinkingMs / 非 assistant turn / sum = 0 → 字段缺席。
   * UI 消费: web AgentCard thinking 块显示「思考了 N 秒」(spec SC8 / D6)。
   */
  readonly thinkingMs?: number;
  /**
   * ADR-0094 SC4-SC5 (viewport API error): transport 失败时的网关侧摘要
   * (HTTP status + 消息文本)。hub 在 `result.apiError` 存在时透传
   * (TransportRetryExhaustedError catch 路径);非 transport 失败 / 无 cause
   * → 字段缺席(byte-stable,与 thinking/toolCalls/lastUsage/thinkingMs 同模式)。
   *
   * UI 消费: chat-flow viewport surface(TUI notice / web AgentCard 错误态)
   * 落"API error (status): message"提示;不带 status 时落"API error: message"。
   */
  readonly apiError?: {
    readonly status?: number;
    readonly message: string;
  };
}

/** #128：验证闭环最终判定的 wire 视图（rounds + outcome，供 UI surface）。
 * T2 (#458)：outcome 增加 "passed" 成功态；abort / disabled 仍不进 wire。 */
export interface VerifyAnswerView {
  readonly outcome: "failed" | "unstable" | "escalated" | "passed";
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

/** Ordered assistant content used by clients that need text/tool placement. */
export type ActivityItem =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "tool"; readonly tool: ToolCallView };

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
 * `compacted`：true 表示实际发生了裁剪（消息数减少）；false 表示无可压缩
 * 上下文（空会话幂等或压缩整体失败；manual-compact-trigger T1 后手动路径
 * 不再有 token 门 no-op）。
 * `cancelled`：#548 — 仅在 opts.signal 中途 abort、压缩未完成时为 true；
 * 会话保持原样（messages/turnCount/updatedAt 均不动），与
 * compacted=false 的”未达阈值”语义区分(web/TUI 渲染区分)。
 * `reason`：plan compress-trigger-gate T2 — 触发判据分类标识,SSOT 见
 * `src/harness/compress/index.ts:evaluateCompactTrigger`。客户端据此区分
 * 文案(`below_token_threshold` / `messages_too_few` / `windowed` /
 * `full_summary`)。
 */
export type CompactSessionResponse = {
  session: SessionSummary;
  turns: TurnDto[];
  compacted: boolean;
  /** #548:signal abort → true,会话保持原样;其余时刻缺席 = false。 */
  cancelled?: boolean;
  /** plan T2:触发判据分类标识(4 选 1);T4 据此分文案分支。 */
  readonly reason: CompactReason;
  /** 压缩前的消息条数（DEFAULT_KEEP_RECENT 尾窗保留判定用）。 */
  beforeCount: number;
  /** 压缩后的消息条数（no-op 时 === beforeCount）。 */
  afterCount: number;
};

/**
 * 手动压缩调用方 opts (#548) — hub.compactSession 与 TuiBridge.compactSession
 * 共享同一 shape(本文件导出避免 3 处独立声明 drift,Standards review
 * Low#1 数据团)。
 */
export type CompactCallerOpts = {
  readonly signal?: AbortSignal;
  readonly onStream?: (event: HarnessStreamEvent) => void;
};

/** POST /api/v1/sessions/:id/rewind — 对齐 TUI rewindSession（#624: head）。 */
export type RewindSessionResponse = {
  session: SessionSummary;
  turns: TurnDto[];
  head: string | null;
};

/** GET /api/v1/sessions/:id/rewind-targets — 当前 head 链上的用户消息锚点。
 *  `head` = 该句 parent（回退到发送这句之前）。`fillInput` 对列出的行恒为 true。
 *  跳过分支不进默认 picker。 */
export type RewindTargetDto = {
  readonly head: string | null;
  readonly userMessageText: string;
  readonly fullText: string;
  readonly anchoredAt: string;
  readonly fillInput: boolean;
  readonly anchorTurnIndex: number;
};

export type RewindTargetsResponse = {
  readonly targets: ReadonlyArray<RewindTargetDto>;
};

/**
 * GET /api/v1/skills — TUI `skillCatalog.loadable()` 投影（可加载技能面）。
 * `description` 允许缺席：人侧技能可以没有 description（spec
 * skill-index-increment SC5/SC9），强转 `""` 会把「无描述」与「空描述」
 * 混为一谈，宿主也就无法把它渲染成「无描述」形态。
 */
export type SkillSummaryDto = {
  readonly name: string;
  readonly description?: string;
};

export type SkillsResponse = {
  readonly skills: readonly SkillSummaryDto[];
};

export type SkillBodyResponse = {
  readonly name: string;
  readonly body: string;
};

/** GET /api/v1/mcp — TUI mcp.status() 投影。 */
export type McpServerStatusDto = {
  readonly name: string;
  readonly state: string;
  readonly source: string;
  readonly error?: string;
};

export type McpStatusResponse = {
  readonly servers: readonly McpServerStatusDto[];
};

export type McpToolDto = {
  readonly server: string;
  readonly name: string;
  readonly description: string;
};

export type McpToolsResponse = {
  readonly tools: readonly McpToolDto[];
};

export type HealthResponse = {
  ok: true;
  service: "iknow-session-api";
  version: string;
  /** **策略预算窗口**大小（token）。来源 env.compress.contextWindow（IKNOW_MODEL_CONTEXT_WINDOW），
   *  默认 256000（ADR-0100）。上下文用量显示的百分比分母，与 auto-compact 闸同一数字。 */
  contextWindow: number;
  /** 模型路由 ID（settings.llm.model）。未配置 → 字段缺席（byte-stable，
   *  与 lastUsage 同模式）。web 输入框下方状态条显示用。 */
  model?: string;
  /** Trace 写盘失败次数；由 HTTP 层读取写侧实例的当前计数。 */
  traceWriteFailures: number;
};

/** GET/POST /api/v1/permission-mode 响应（web Shift+Tab 模式切换）。 */
export type PermissionModeResponse = {
  mode: "default" | "plan" | "full_auto";
};

/**
 * D-α V1 / ADR-0030：GET/POST /api/v1/graph-mode 响应（serve 侧的 `/graph`
 * 对等物）。`message` 是三入口共用的那一行状态文案（chat 打到 stdout、TUI
 * 落 notice、web 直接渲染这段）。
 */
export type GraphModeResponse = {
  enabled: boolean;
  message: string;
};

/** POST /api/v1/graph-mode 请求体：`/graph` 的 args（已切词）。缺省 = 查询。 */
export interface GraphModeRequest {
  readonly args?: ReadonlyArray<string>;
}

/**
 * ADR-0092 / SC13：GET/POST /api/v1/fs-mode 响应（serve 侧的 `/config`
 * 对等物）。`message` 是三入口共用的那一行状态文案（chat 打到 stdout、TUI
 * 落 notice、web 直接渲染这段）。
 *
 * `mode` 复用 `harness/sandbox/fs-mode.ts` 的 `FsIsolationMode`（SSOT）——
 * 本文件不再自带一份字面量拷贝，避免闭集扩档时两处漂移。
 */
export type FsModeResponse = {
  mode: FsIsolationMode;
  message: string;
};

/** POST /api/v1/fs-mode 请求体：`/config` 的 args（已切词）。缺省 = 查询。 */
export interface FsModeRequest {
  readonly args?: ReadonlyArray<string>;
}

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

/** serve-workspace T3: GET /api/v1/workspace response. */
export type WorkspaceResponse = {
  readonly bound: boolean;
  readonly root?: string;
};

/** serve-workspace T3: PUT /api/v1/workspace request body. */
export interface PutWorkspaceRequest {
  readonly path: string;
  readonly confirmTrust?: boolean;
}

/** serve-workspace T3: PUT /api/v1/workspace response body. */
export type PutWorkspaceResponse = WorkspaceResponse;

/** serve-workspace T3: GET /api/v1/workspaces response (recents / trusted). */
export type WorkspacesResponse = {
  readonly workspaces: readonly { readonly root: string }[];
};

/** Reserved routes (UI may probe; server may return 501). */
export const RESERVED_PATHS = {
  eventsSse: "/api/v1/sessions/:id/events",
} as const;
