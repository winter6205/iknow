import type {
  ApiErrorBody,
  CompactSessionResponse,
  CreateSessionResponse,
  GetSessionResponse,
  HealthResponse,
  McpStatusResponse,
  McpToolsResponse,
  PermissionModeResponse,
  PostMessageRequest,
  PostMessageResponse,
  ResetSessionResponse,
  RewindSessionResponse,
  RewindTargetsResponse,
  SessionListItem,
  SessionsResponse,
  SkillBodyResponse,
  SkillsResponse,
  SubagentsResponse,
  TraceFieldDef,
  TraceQueryParams,
  TracesResponse,
  WorkspaceState,
  WorkspacesResponse,
  PutWorkspaceRequest,
} from "./types";
import { SessionApiError } from "./types";

/**
 * Session HTTP API base path.
 * @see src/session-api/contract.ts
 */
const API = "/api/v1";

/**
 * Trace inspection API base path (spec #183).
 *
 * Defaults to `/api/v1/traces` so the existing `iknow serve` reverse-proxy
 * path works without env wiring. Override with VITE_TRACE_API_BASE when the
 * standalone `iknow trace` process lives on a different origin (e.g.
 * `http://127.0.0.1:24881`). Exported pure for unit tests.
 */
export function resolveTraceApiBase(envValue: string | undefined): string {
  if (typeof envValue === "string" && envValue.trim().length > 0) {
    return envValue;
  }
  return "/api/v1/traces";
}

const TRACE_API = resolveTraceApiBase(
  (import.meta.env.VITE_TRACE_API_BASE ?? undefined) as string | undefined
);

const DEFAULT_TIMEOUT_MS = 120_000;

function defaultSignal(external?: AbortSignal): AbortSignal | undefined {
  if (external) return external;
  // AbortSignal.timeout is available in modern browsers / Node 18+
  if (typeof AbortSignal !== "undefined" && "timeout" in AbortSignal) {
    return AbortSignal.timeout(DEFAULT_TIMEOUT_MS);
  }
  return undefined;
}

async function request<T>(
  path: string,
  init: RequestInit = {},
  signal?: AbortSignal
): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const res = await fetch(path, {
    ...init,
    headers,
    signal: signal ?? init.signal ?? defaultSignal(),
  });
  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text) as unknown;
    } catch {
      // Non-JSON error body: wrap in nested ApiErrorBody shape so the caller
      // sees the same `{ error: { kind, message } }` contract as JSON failures.
      data = { error: { kind: "internal", message: text.slice(0, 500) } };
    }
  }
  if (!res.ok) {
    const body = (data ?? null) as ApiErrorBody | null;
    throw new SessionApiError(
      body?.error?.message || `HTTP ${res.status}`,
      res.status,
      body?.error?.kind || "error",
      body
    );
  }
  return data as T;
}

export function health(signal?: AbortSignal): Promise<HealthResponse> {
  return request(`${API}/health`, {}, signal);
}

/**
 * permission mode 端点（TUI Shift+Tab 的 web 镜像）。GET 读当前值；POST
 * 走后端 SSOT 循环（nextShiftTabMode）切换并返回新值 —— 前端不复制
 * 循环语义。holder 缺席的装配返回 404（调用方静默降级：徽标不渲染）。
 */
export function getPermissionMode(
  signal?: AbortSignal
): Promise<PermissionModeResponse["mode"]> {
  return request<PermissionModeResponse>(
    `${API}/permission-mode`,
    {},
    signal
  ).then((res) => res.mode);
}

export function cyclePermissionMode(
  signal?: AbortSignal
): Promise<PermissionModeResponse["mode"]> {
  return request<PermissionModeResponse>(
    `${API}/permission-mode`,
    { method: "POST" },
    signal
  ).then((res) => res.mode);
}

export function createSession(
  body: {
    json_mode?: boolean;
  },
  signal?: AbortSignal
): Promise<CreateSessionResponse> {
  return request(
    `${API}/sessions`,
    {
      method: "POST",
      body: JSON.stringify(body),
    },
    signal
  );
}

export function listSessions(
  signal?: AbortSignal
): Promise<{ sessions: SessionListItem[] }> {
  return request<{ sessions: SessionListItem[] }>(
    `${API}/sessions`,
    {},
    signal
  ).then((res) => ({
    // Drop empty sessions: ones whose last assistant text is empty AND
    // the front-end can't determine otherwise. These are records created
    // by a partial bootstrap (no user query ever recorded) and clutter the
    // sidebar. Sessions with any recorded activity are preserved.
    sessions: res.sessions.filter(
      (s) => s.lastFinalText && s.lastFinalText.trim().length > 0
    ),
  }));
}

export function getSessionHistory(
  id: string,
  signal?: AbortSignal
): Promise<GetSessionResponse> {
  return request(`${API}/sessions/${encodeURIComponent(id)}`, {}, signal);
}

export type PostMessageOptions = {
  /** 每请求 thinking 覆盖（T5）；未提供则 body 不带 thinking 字段（后端走缓存配置）。 */
  thinking?: PostMessageRequest["thinking"];
};

export function postMessage(
  id: string,
  text: string,
  opts: PostMessageOptions = {},
  signal?: AbortSignal
): Promise<PostMessageResponse> {
  const body: PostMessageRequest = {
    text,
    // Explicit undefined 省略：JSON.stringify 会丢掉 undefined 字段。
    ...(opts.thinking !== undefined ? { thinking: opts.thinking } : {}),
  };
  return request(
    `${API}/sessions/${encodeURIComponent(id)}/messages`,
    {
      method: "POST",
      body: JSON.stringify(body),
    },
    signal
  );
}

export function resetSession(
  id: string,
  opts: { new_id?: boolean } = {},
  signal?: AbortSignal
): Promise<ResetSessionResponse> {
  return request(
    `${API}/sessions/${encodeURIComponent(id)}/reset`,
    {
      method: "POST",
      body: JSON.stringify(opts),
    },
    signal
  );
}

export function compactSession(
  id: string,
  signal?: AbortSignal
): Promise<CompactSessionResponse> {
  return request(
    `${API}/sessions/${encodeURIComponent(id)}/compact`,
    {
      method: "POST",
      body: JSON.stringify({}),
    },
    signal
  );
}

export function rewindSession(
  id: string,
  head: string | null,
  signal?: AbortSignal
): Promise<RewindSessionResponse> {
  return request(
    `${API}/sessions/${encodeURIComponent(id)}/rewind`,
    {
      method: "POST",
      body: JSON.stringify({ head }),
    },
    signal
  );
}

export function listRewindTargets(
  id: string,
  signal?: AbortSignal
): Promise<RewindTargetsResponse> {
  return request(
    `${API}/sessions/${encodeURIComponent(id)}/rewind-targets`,
    {},
    signal
  );
}

export function listSkills(signal?: AbortSignal): Promise<SkillsResponse> {
  return request(`${API}/skills`, {}, signal);
}

export function getSkillBody(
  name: string,
  signal?: AbortSignal
): Promise<SkillBodyResponse> {
  return request(`${API}/skills/${encodeURIComponent(name)}`, {}, signal);
}

export function listMcp(signal?: AbortSignal): Promise<McpStatusResponse> {
  return request(`${API}/mcp`, {}, signal);
}

export function reloadMcp(signal?: AbortSignal): Promise<McpStatusResponse> {
  return request(
    `${API}/mcp/reload`,
    { method: "POST", body: JSON.stringify({}) },
    signal
  );
}

export function listMcpTools(signal?: AbortSignal): Promise<McpToolsResponse> {
  return request(`${API}/mcp/tools`, {}, signal);
}

export interface PendingAsk {
  readonly id: string;
  readonly tool: string;
  readonly summaryHint: string;
  /** #503 T10 / ADR-0022:bash network:true 时由 executor 透传；缺省时该
   *  key 不存在。SPA PermissionDialog 可据此渲染宿主网络标记。 */
  readonly network?: boolean;
}

export type AskDecision = "allow-once" | "always-allow" | "deny";

export function listPendingAsks(
  id: string,
  signal?: AbortSignal
): Promise<{ readonly asks: ReadonlyArray<PendingAsk> }> {
  return request(
    `${API}/sessions/${encodeURIComponent(id)}/asks`,
    { method: "GET" },
    signal
  );
}

export function resolveAsk(
  id: string,
  askId: string,
  decision: AskDecision,
  signal?: AbortSignal
): Promise<{ readonly resolved: boolean }> {
  return request(
    `${API}/sessions/${encodeURIComponent(id)}/asks/${encodeURIComponent(askId)}/resolve`,
    {
      method: "POST",
      body: JSON.stringify({ decision }),
    },
    signal
  );
}

// -- Subagent runtime status (#358 T8) ---------------------------------------

/**
 * #358 T8: subagent 状态端点路径（纯函数，单独导出供单测——镜像
 * `resolveTraceSessionsBase` 形态；与 `listPendingAsks` 同样的
 * `{API}/sessions/{id}/...` URI 形态）。`encodeURIComponent` 处理
 * sessionId 中的特殊字符（避免裸 `?` `/` 触发路由解析）。
 */
export function resolveSubagentsPath(sessionId: string): string {
  return `${API}/sessions/${encodeURIComponent(sessionId)}/subagents`;
}

/**
 * GET /sessions/:id/subagents — 只读子代理状态投影（spec #358 T8）。
 * 与 `listPendingAsks` 同形：轮询端点，解析 `{ subagents: SubagentStatus[] }`。
 * 不建 SSE/websocket（spec Boundaries Never）。
 */
export function getSubagents(
  id: string,
  signal?: AbortSignal
): Promise<SubagentsResponse> {
  return request(resolveSubagentsPath(id), { method: "GET" }, signal);
}

// -- Workspace picker (serve-workspace #531, T5) --------------------------------

/**
 * GET /api/v1/workspace — 当前 picker 绑定状态（bound + root）。
 * 未绑定 → `{ bound: false }`，root 缺席。
 */
export function getWorkspace(signal?: AbortSignal): Promise<WorkspaceState> {
  return request(`${API}/workspace`, {}, signal);
}

/**
 * GET /api/v1/workspaces — recents/trust 名单（picker 候选）。recentsHome
 * 缺席 → 后端 404 not_found（调用方自行静默降级为空列表）。
 */
export function listTrustedWorkspaces(
  signal?: AbortSignal
): Promise<WorkspacesResponse> {
  return request(`${API}/workspaces`, {}, signal);
}

/**
 * serve-workspace T3: GET /api/v1/workspaces/browse?root=<abs> 单层子目录
 * 探测。返回 `{ entries: ReadonlyArray<{ name, path }> }`, path = join(root, name)。
 * 不存在 / 非绝对 / 无权限 / 空串 → 后端 422 typed validation, 此处按
 * 既有 `request<T>` 通道抛 `SessionApiError`, 调用方走 `onNotice` 兜底。
 */
export interface WorkspaceSubdirEntry {
  readonly name: string;
  readonly path: string;
}

export interface WorkspaceSubdirsResponse {
  readonly entries: ReadonlyArray<WorkspaceSubdirEntry>;
}

export function listWorkspaceSubdirs(
  root: string,
  signal?: AbortSignal
): Promise<WorkspaceSubdirsResponse> {
  return request(
    `${API}/workspaces/browse?root=${encodeURIComponent(root)}`,
    {},
    signal
  );
}

/**
 * PUT /api/v1/workspace — 切换绑定根。`confirmTrust=true` 用于未信任路径
 * （首次绑定新绝对路径需显式确认信任）。
 */
export function putWorkspace(
  body: PutWorkspaceRequest,
  signal?: AbortSignal
): Promise<WorkspaceState> {
  return request(
    `${API}/workspace`,
    {
      method: "PUT",
      body: JSON.stringify(body),
    },
    signal
  );
}

// -- Trace inspection endpoints -----------------------------------------------

function traceQueryString(params: TraceQueryParams): string {
  const sp = new URLSearchParams();
  if (params.conversation_id) sp.set("conversation_id", params.conversation_id);
  if (params.record_type) sp.set("record_type", params.record_type);
  if (params.status) sp.set("status", params.status);
  if (params.limit !== undefined) sp.set("limit", String(params.limit));
  if (params.offset !== undefined) sp.set("offset", String(params.offset));
  if (params.poll !== undefined) sp.set("poll", String(params.poll));
  if (params.task_id !== undefined && params.task_id !== "") {
    sp.set("task_id", params.task_id);
  }
  if (params.parent_turn_id !== undefined && params.parent_turn_id !== "") {
    sp.set("parent_turn_id", params.parent_turn_id);
  }
  return sp.toString();
}

export function getTraces(
  params: TraceQueryParams = {},
  signal?: AbortSignal
): Promise<TracesResponse> {
  const qs = traceQueryString(params);
  return request(`${TRACE_API}${qs ? `?${qs}` : ""}`, {}, signal);
}

export function getTraceFields(
  signal?: AbortSignal
): Promise<{ fields: ReadonlyArray<TraceFieldDef> }> {
  return request(`${TRACE_API}/fields`, {}, signal);
}

// -- Trace session list (spec v2: 会话列表 → 下钻) ----------------------------

/**
 * Trace 会话列表（读侧 `GET /api/v1/traces/sessions`，ADR-0020 D1.6）。
 * 与 session-api 的 `listSessions`（chat 会话 `GET /api/v1/sessions`）不同——
 * 这是 trace 面板自己的会话目录列表（conversation_id / mtime / size /
 * agent_version）。
 *
 * ADR-0020 D1.1: 端点从 standalone 的 `/api/v1/sessions` 迁入 traces 前缀
 * 下（`/api/v1/traces/sessions`），避免与 chat sessions 撞名。mounted mode
 * 与 `--separate` mode 都在该前缀下提供（standalone 另保留旧别名一个版本）。
 * TRACE_API 默认 `/api/v1/traces`，故 sessions = `${TRACE_API}/sessions`；
 * VITE_TRACE_API_BASE 覆盖时同样从覆盖值推导（exported 供单测）。
 */
export function resolveTraceSessionsBase(traceApi: string): string {
  return `${traceApi}/sessions`;
}

export function getTraceSessions(
  signal?: AbortSignal
): Promise<SessionsResponse> {
  return request(resolveTraceSessionsBase(TRACE_API), {}, signal);
}
