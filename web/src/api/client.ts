import type {
  ApiErrorBody,
  CreateSessionResponse,
  GetSessionResponse,
  HealthResponse,
  PostMessageRequest,
  PostMessageResponse,
  ResetSessionResponse,
  SessionListItem,
  TraceFieldDef,
  TraceQueryParams,
  TracesResponse,
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

// -- Trace inspection endpoints -----------------------------------------------

function traceQueryString(params: TraceQueryParams): string {
  const sp = new URLSearchParams();
  if (params.conversation_id) sp.set("conversation_id", params.conversation_id);
  if (params.record_type) sp.set("record_type", params.record_type);
  if (params.status) sp.set("status", params.status);
  if (params.limit !== undefined) sp.set("limit", String(params.limit));
  if (params.offset !== undefined) sp.set("offset", String(params.offset));
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
