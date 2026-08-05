import type {
  ApiErrorBody,
  CreateSessionResponse,
  GetSessionResponse,
  HealthResponse,
  PostMessageRequest,
  PostMessageResponse,
  ResetSessionResponse,
  SessionListItem,
} from "./types";
import { SessionApiError } from "./types";

/**
 * Session HTTP API base path (session-http-api-v0).
 * @see docs/design/session-http-api-v0.md
 */
const API = "/api/v1";

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
