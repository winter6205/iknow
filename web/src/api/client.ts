import type {
  ApiErrorBody,
  CompactSessionResponse,
  CreateSessionResponse,
  GetSessionResponse,
  HealthResponse,
  McpStatusResponse,
  McpToolsResponse,
  GraphModeResponse,
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
 * Trace inspection API base path.
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
 * Permission-mode endpoints (web mirror of the TUI's Shift+Tab). GET reads the
 * current value; POST cycles via the backend SSOT (nextShiftTabMode) and
 * returns the new value — the front-end never duplicates the cycle logic.
 * Assemblies without a permission holder return 404 (callers degrade silently:
 * no badge rendered).
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

/** POST /api/v1/graph-mode: sends slash `/graph` args verbatim; the response text is rendered server-side. */
export function applyGraphMode(
  args: ReadonlyArray<string>,
  signal?: AbortSignal
): Promise<GraphModeResponse> {
  return request<GraphModeResponse>(
    `${API}/graph-mode`,
    { method: "POST", body: JSON.stringify({ args }) },
    signal
  );
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
  /** Per-request thinking override; omitted means no `thinking` field in the body (backend uses cached config). */
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
    // Omit explicit undefined: JSON.stringify would drop undefined fields anyway.
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

/** HITL skip-append continue. Empty body; wire is PostMessageResponse. */
export function continueSession(
  id: string,
  signal?: AbortSignal
): Promise<PostMessageResponse> {
  return request(
    `${API}/sessions/${encodeURIComponent(id)}/continue`,
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

// -- Subagent runtime status --------------------------------------------------

/**
 * Subagent-status endpoint path. Exported as a pure function for
 * unit tests — mirrors `resolveTraceSessionsBase` and shares the
 * `{API}/sessions/{id}/...` URI shape used by `listPendingAsks`.
 * `encodeURIComponent` keeps special characters in sessionId (a bare `?` or
 * `/`) from breaking route resolution.
 */
export function resolveSubagentsPath(sessionId: string): string {
  return `${API}/sessions/${encodeURIComponent(sessionId)}/subagents`;
}

/**
 * GET /sessions/:id/subagents — read-only subagent state projection.
 * Same shape as `listPendingAsks`: a polling endpoint returning
 * `{ subagents: SubagentStatus[] }`. No SSE/websocket (spec Boundaries Never).
 */
export function getSubagents(
  id: string,
  signal?: AbortSignal
): Promise<SubagentsResponse> {
  return request(resolveSubagentsPath(id), { method: "GET" }, signal);
}

// -- Workspace picker ---------------------------------------------------------

/**
 * GET /api/v1/workspace — current picker binding state (bound + root).
 * Unbound → `{ bound: false }`, `root` absent.
 */
export function getWorkspace(signal?: AbortSignal): Promise<WorkspaceState> {
  return request(`${API}/workspace`, {}, signal);
}

/**
 * GET /api/v1/workspaces — recents/trust list (picker candidates). When
 * recentsHome is absent the backend returns 404 not_found; callers degrade
 * silently to an empty list.
 */
export function listTrustedWorkspaces(
  signal?: AbortSignal
): Promise<WorkspacesResponse> {
  return request(`${API}/workspaces`, {}, signal);
}

/**
 * GET /api/v1/workspaces/browse?root=<abs> probes one
 * directory level. Returns `{ entries: ReadonlyArray<{ name, path }> }` with
 * path = join(root, name). Missing / non-absolute / unreadable / empty root →
 * backend 422 typed validation, surfaced here as `SessionApiError` through the
 * existing `request<T>` channel; callers fall back to `onNotice`.
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
 * PUT /api/v1/workspace — switch the bound root. `confirmTrust=true` is
 * required when first binding a not-yet-trusted absolute path.
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

// -- Trace session list (session list → drill-down) --------------------------

/**
 * Trace session list (read side `GET /api/v1/traces/sessions`, ADR-0020 D1.6).
 * Distinct from session-api's `listSessions` (chat sessions at
 * `GET /api/v1/sessions`): this is the trace panel's own session directory
 * (conversation_id / mtime / size / agent_version).
 *
 * ADR-0020 D1.1: the endpoint moved from the standalone `/api/v1/sessions`
 * under the traces prefix to avoid colliding with chat sessions. Both mounted
 * and `--separate` modes serve it there (standalone keeps the old alias for
 * one version). TRACE_API defaults to `/api/v1/traces`, so sessions =
 * `${TRACE_API}/sessions`; a VITE_TRACE_API_BASE override derives from the
 * overridden value the same way (exported pure for unit tests).
 */
export function resolveTraceSessionsBase(traceApi: string): string {
  return `${traceApi}/sessions`;
}

export function getTraceSessions(
  signal?: AbortSignal
): Promise<SessionsResponse> {
  return request(resolveTraceSessionsBase(TRACE_API), {}, signal);
}
