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

/** Mirrors harness SupplierStopDetail — the adapter-normalized supplier stop
 *  behind a `nonSuccessStop` (never a StopReason of its own). */
export type SupplierStopDetail = "truncation" | "refusal" | "other";

/** Mirrors TurnOutcomeView in src/session-api/contract.ts: `known` carries the
 *  persisted terminal StopReason, `unknown` is the absence of terminal evidence
 *  (legacy history / a crash before the terminal record). */
export type TurnOutcomeView =
  | {
      readonly terminal: "known";
      readonly stopReason: StopReason;
      readonly supplierDetail?: SupplierStopDetail;
    }
  | { readonly terminal: "unknown" };

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
  /** Absent when the turn's terminal outcome has no record — that state is
   *  carried by `outcome: { terminal: "unknown" }`, so history never claims a
   *  completion it cannot prove. Read the terminal state from `outcome`, not
   *  from the presence of this key. */
  readonly stopReason?: StopReason;
  /** Terminal-outcome projection of the turn (ADR-0126). Present on every live
   *  answer and on a reopened turn read from the ledger; absent on a
   *  pre-ADR-0126 payload, which is likewise unknown. */
  readonly outcome?: TurnOutcomeView;
  /** The hub's deterministic English output-limit notice, present only when a
   *  known outcome records supplier detail `truncation`. Rendered verbatim:
   *  the copy is the server's, so the live turn and a reopened session cannot
   *  drift apart. Never message content — a projection of the outcome. */
  readonly outputLimitNotice?: string;
  readonly turnCount: number;
  /** Optional: per-turn thinking text (backend projection; omitted when absent). */
  readonly thinking?: ThinkingView;
  /** Optional: per-turn tool-call views (backend projection; omitted when no tool_use). */
  readonly toolCalls?: readonly ToolCallView[];
  /** Optional: text/tool activity ordered by the assistant's native content blocks. */
  readonly activity?: readonly ActivityItem[];
  /** Optional: camelCase token usage; present only when the backend value is non-null. */
  readonly lastUsage?: TokenUsage;
  /** Wire surface: per-turn assistant thinking
   * duration (ms). Present only when the hub computes sum > 0; legacy sessions /
   * non-assistant turns / sum = 0 → field absent (byte-stable, same pattern as
   * thinking/toolCalls/lastUsage). UI consumes it in AgentCard → ThinkingBlock's
   * collapsed 「思考了 N 秒」("thought for N seconds") label. */
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
  /** UI title excerpt — the sidebar's primary row field (spec session-list-title).
   *  The server-side SessionListEntry always returns it; empty string = no title
   *  yet, rendered via the empty-state form. */
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

/** Manual session-compact response (mirrors CompactSessionResponse in src/session-api/contract.ts). */
export type CompactSessionResponse = {
  session: SessionSummary;
  turns: TurnDto[];
  /** true = truncation actually happened; false = nothing to compact (idempotent no-op). */
  compacted: boolean;
  /** True when the signal aborted (session left untouched); absent otherwise = false. */
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
 * A loadable-skill row (aligned with the server-side `SkillSummaryDto`).
 * `description` may be absent: hand-authored skills need none (spec
 * skill-index-increment). Absent ≠ empty string — the UI renders a
 * dedicated "no description" form rather than an empty string.
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
  /** Model routing id (settings.llm.model); absent when unconfigured. */
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

// -- Subagent runtime status --------------------------------------------------

/**
 * Subagent presence projection (mirrors SubagentInfo in
 * `src/harness/subagent/manager.ts`, the endpoint response item).
 * Field semantics share the backend SSOT:
 * `state` ∈ "starting"|"running"|"completed"|"failed";
 * Postel: endedAt/summary/reason present only in a terminal state with a value.
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

/** Four-state union, aligned with SubagentState (isomorphic to the manager's TaskState). */
export type SubagentState = "starting" | "running" | "completed" | "failed";

/** Mirrors the endpoint envelope `{ subagents: [...] }` (following the `{ asks: [...] }` precedent). */
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
 * Trace session list row (read side `GET /api/v1/sessions`).
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
 * New record types are appended here only, matching the read-side whitelist.
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
  /** Front-end poll interval (default 1000ms; 0 disables polling). Spec v2. */
  readonly poll?: number;
  /**
   * Exact-match subagent task_id (snake_case wire, mirrors the
   * read-side TraceQuery.taskId). undefined = no filtering.
   */
  readonly task_id?: string;
  /**
   * Exact-match parent_turn_id (snake_case wire). undefined = no filtering.
   */
  readonly parent_turn_id?: string;
}

// -- Workspace picker ---------------------------------------------------------

/** GET /api/v1/workspace response (picker binding state). */
export interface WorkspaceState {
  readonly bound: boolean;
  readonly root?: string;
}

/** PUT /api/v1/workspace request body. */
export interface PutWorkspaceRequest {
  readonly path: string;
  readonly confirmTrust?: boolean;
}

/** GET /api/v1/workspaces response (recents / trusted). */
export interface WorkspacesResponse {
  readonly workspaces: ReadonlyArray<{ readonly root: string }>;
}
