import type {
  AgentMode,
  ApiErrorBody,
  CallerRole,
  CreateSessionResponse,
  HealthResponse,
  PostCommandResponse,
  PostMessageResponse,
  ResetSessionResponse,
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
  signal?: AbortSignal,
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
      data = { error: "error", message: text.slice(0, 500) };
    }
  }
  if (!res.ok) {
    const body = (data ?? null) as ApiErrorBody | null;
    throw new SessionApiError(
      body?.message || `HTTP ${res.status}`,
      res.status,
      body?.error || "error",
      body,
    );
  }
  return data as T;
}

export function health(signal?: AbortSignal): Promise<HealthResponse> {
  return request(`${API}/health`, {}, signal);
}

export function createSession(
  body: {
    role?: CallerRole;
    mode?: AgentMode;
    json_mode?: boolean;
    embeddings?: boolean;
  },
  signal?: AbortSignal,
): Promise<CreateSessionResponse> {
  return request(
    `${API}/sessions`,
    {
      method: "POST",
      body: JSON.stringify(body),
    },
    signal,
  );
}

export function postMessage(
  id: string,
  text: string,
  signal?: AbortSignal,
): Promise<PostMessageResponse> {
  return request(
    `${API}/sessions/${encodeURIComponent(id)}/messages`,
    {
      method: "POST",
      body: JSON.stringify({ text }),
    },
    signal,
  );
}

export function postCommand(
  id: string,
  command: string,
  args: string[] = [],
  signal?: AbortSignal,
): Promise<PostCommandResponse> {
  return request(
    `${API}/sessions/${encodeURIComponent(id)}/commands`,
    {
      method: "POST",
      body: JSON.stringify({ command, args }),
    },
    signal,
  );
}

export function resetSession(
  id: string,
  opts: { new_id?: boolean } = {},
  signal?: AbortSignal,
): Promise<ResetSessionResponse> {
  return request(
    `${API}/sessions/${encodeURIComponent(id)}/reset`,
    {
      method: "POST",
      body: JSON.stringify(opts),
    },
    signal,
  );
}
