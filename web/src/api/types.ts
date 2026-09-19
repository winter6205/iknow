/** Mirror of Session HTTP API DTOs used by the product UI. */

/** Mirrors harness TokenUsage (src/harness/model-adapter/types.ts). */
export type TokenUsage = {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheCreationInputTokens: number | null;
  readonly cacheReadInputTokens: number | null;
};

/** Mirrors harness StopReason (8 values, including fused). */
export type StopReason =
  | "completed"
  | "maxTurns"
  | "nonSuccessStop"
  | "protocolError"
  | "emptyFinalResponse"
  | "cancelled"
  | "timeout"
  | "fused";

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

/** Ordered assistant content used by AgentCard to preserve text/tool order. */
export type ActivityItem =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "tool"; readonly tool: ToolCallView };

/** Mirrors TurnAnswerDto in src/session-api/contract.ts. */
export type TurnAnswerDto = {
  readonly finalText: string;
  readonly stopReason: StopReason;
  readonly turnCount: number;
  /** 可选：单回合 thinking 文本（后端 T1 投影；无 thinking 时省略）。 */
  readonly thinking?: ThinkingView;
  /** 可选：单回合工具调用视图（后端 T1 投影；无 tool_use 时省略）。 */
  readonly toolCalls?: readonly ToolCallView[];
  /** 可选：按 assistant 原生 content block 顺序排列的文本/工具活动。 */
  readonly activity?: readonly ActivityItem[];
  /** 可选：camelCase token usage；仅在后端值非 null 时存在。 */
  readonly lastUsage?: TokenUsage;
  /** D2 (tui-display-consistency) wire surface: 单回合 assistant 思考时长
   * (ms)。仅在 hub 算得 sum > 0 时存在;旧会话 / 非 assistant turn / sum = 0
   * → 字段缺席 (byte-stable, 与 thinking/toolCalls/lastUsage 同模式)。
   * UI 消费: AgentCard → ThinkingBlock 折叠块显示「思考了 N 秒」 (SC8)。 */
  readonly thinkingMs?: number;
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

/** Mirrors SessionListEntry in src/session-api/store/session-store.ts.
 *  `workspaceRoot` is Postel: absent on legacy files (and therefore on
 *  the list entry) means "unbound"; never serialized as null. */
export type SessionListItem = {
  readonly conversation_id: string;
  readonly updatedAt: string;
  readonly lastFinalText: string;
  /** UI title excerpt — sidebar 主行字段（spec session-list-title）。
   *  服务端 SessionListEntry 一直返回；空串 = 尚无标题，渲染走空态。 */
  readonly title: string;
  readonly workspaceRoot?: string;
  /** Additive binding health from the session store. */
  readonly bindingStatus?: "unbound" | "invalid" | "bound";
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

/** 手动压缩会话响应（镜像 src/session-api/contract.ts CompactSessionResponse）。 */
export type CompactSessionResponse = {
  session: SessionSummary;
  turns: TurnDto[];
  /** true 表示实际发生了裁剪；false 表示无可压缩上下文（幂等 no-op）。 */
  compacted: boolean;
  /** #548:signal abort → true,会话保持原样;其余时刻缺席 = false。 */
  cancelled?: boolean;
  beforeCount: number;
  afterCount: number;
};

export type RewindSessionResponse = {
  session: SessionSummary;
  turns: TurnDto[];
  head: string | null;
};

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
 * 可加载技能面条目（对齐服务端 `SkillSummaryDto`）。`description` 允许
 * 缺席：人侧技能可以没有 description（spec skill-index-increment SC5/SC9），
 * 缺席 ≠ 空串 —— 渲染走「无描述」形态而不是空串。
 */
export type SkillSummary = {
  readonly name: string;
  readonly description?: string;
};

export type SkillsResponse = {
  readonly skills: readonly SkillSummary[];
};

export type SkillBodyResponse = {
  readonly name: string;
  readonly body: string;
};

export type McpServerStatus = {
  readonly name: string;
  readonly state: string;
  readonly source: string;
  readonly error?: string;
};

export type McpStatusResponse = {
  readonly servers: readonly McpServerStatus[];
};

export type McpTool = {
  readonly server: string;
  readonly name: string;
  readonly description: string;
};

export type McpToolsResponse = {
  readonly tools: readonly McpTool[];
};

export type HealthResponse = {
  ok: true;
  service: string;
  version: string;
  readonly contextWindow: number;
  /** 模型路由 ID（settings.llm.model）；未配置时字段缺席。 */
  readonly model?: string;
};

/** Mirrors PermissionMode in src/harness/permission/modes.ts. */
export type PermissionMode = "default" | "plan" | "full_auto";

/** Mirrors PermissionModeResponse in src/session-api/contract.ts. */
export type PermissionModeResponse = {
  readonly mode: PermissionMode;
};

/**
 * Mirrors GraphModeResponse in src/session-api/contract.ts.
 * `message` is the SSOT line from applyGraphCommand / formatGraphStatus.
 */
export type GraphModeResponse = {
  readonly enabled: boolean;
  readonly message: string;
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

// -- Subagent runtime status (#358 T8) ---------------------------------------

/**
 * 子代理在场状态投影（镜像 `src/harness/subagent/manager.ts` SubagentInfo，
 * T7 端点响应 item）。字段语义与后端 SSOT 同源：
 * `state` ∈ "starting"|"running"|"completed"|"failed"；
 * Postel：endedAt/summary/reason 仅终态且有值时在场。
 */
export interface SubagentStatus {
  readonly taskId: string;
  readonly state: SubagentState;
  readonly taskPreview: string;
  readonly startedAt: string;
  readonly endedAt?: string;
  readonly summary?: string;
  readonly reason?: string;
}

/** 四态联合，对齐 SubagentState（manager TaskState 同构）。 */
export type SubagentState = "starting" | "running" | "completed" | "failed";

/** 镜像 T7 端点返回包 `{ subagents: [...] }`（镜像 `{ asks: [...] }` 先例）。 */
export interface SubagentsResponse {
  readonly subagents: ReadonlyArray<SubagentStatus>;
}

// -- Trace inspection panel (mirrors src/traceserver/) -----------------------

export type TraceRecord = Record<string, unknown>;

export interface TracesResponse {
  readonly records: ReadonlyArray<TraceRecord>;
  readonly total: number;
  readonly skipped_lines: number;
  readonly truncated: boolean;
}

/**
 * Trace 会话列表条目（读侧 `GET /api/v1/sessions`，spec v2 SC-R 10）。
 * Mirrors `SessionSummary` in src/traceserver/sessions.ts.
 */
export interface TraceSessionSummary {
  readonly conversation_id: string;
  readonly mtime: number;
  readonly size: number;
  readonly agent_version?: string;
}

export interface SessionsResponse {
  readonly sessions: ReadonlyArray<TraceSessionSummary>;
}

/**
 * Mirrors TraceRecordType in src/traceserver/types.ts (whitelist-derrived union).
 * 新 record 类型只在此追加, 对齐读侧白名单 (T5)。
 */
export type TraceRecordType =
  | "llm_call"
  | "tool_call"
  | "turn"
  | "violation"
  | "session"
  | "sandbox_cmd"
  | "subagent_spawn"
  | "subagent_stop"
  | "subagent_state_change"
  | "subagent_step";

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
  /** 前端轮询间隔（缺省 1000ms，0 关闭）。spec v2 SC-R 14 / SC-V 26. */
  readonly poll?: number;
  /**
   * T5/T6 (#358): 精确匹配 subagent task_id (snake_case wire, 镜像读侧
   * TraceQuery.taskId)。undefined = 不参与过滤。
   */
  readonly task_id?: string;
  /**
   * T5/T6 (#358): 精确匹配 parent_turn_id (snake_case wire)。undefined = 不参与过滤。
   */
  readonly parent_turn_id?: string;
}

// -- serve-workspace (#531, T5) -------------------------------------------------

/** serve-workspace T3: GET /api/v1/workspace 响应（picker 绑定状态）。 */
export interface WorkspaceState {
  readonly bound: boolean;
  readonly root?: string;
}

/** serve-workspace T3: PUT /api/v1/workspace 请求体。 */
export interface PutWorkspaceRequest {
  readonly path: string;
  readonly confirmTrust?: boolean;
}

/** serve-workspace T3: GET /api/v1/workspaces 响应（recents / trusted）。 */
export interface WorkspacesResponse {
  readonly workspaces: ReadonlyArray<{ readonly root: string }>;
}
