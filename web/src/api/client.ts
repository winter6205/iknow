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

const API = "/api/v1";

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const res = await fetch(path, { ...init, headers });
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

export function health(): Promise<HealthResponse> {
  return request(`${API}/health`);
}

export function createSession(body: {
  role?: CallerRole;
  mode?: AgentMode;
  json_mode?: boolean;
  embeddings?: boolean;
}): Promise<CreateSessionResponse> {
  return request(`${API}/sessions`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function postMessage(
  id: string,
  text: string,
): Promise<PostMessageResponse> {
  return request(
    `${API}/sessions/${encodeURIComponent(id)}/messages`,
    {
      method: "POST",
      body: JSON.stringify({ text }),
    },
  );
}

export function postCommand(
  id: string,
  command: string,
  args: string[] = [],
): Promise<PostCommandResponse> {
  return request(
    `${API}/sessions/${encodeURIComponent(id)}/commands`,
    {
      method: "POST",
      body: JSON.stringify({ command, args }),
    },
  );
}

export function resetSession(
  id: string,
  opts: { new_id?: boolean } = {},
): Promise<ResetSessionResponse> {
  return request(`${API}/sessions/${encodeURIComponent(id)}/reset`, {
    method: "POST",
    body: JSON.stringify(opts),
  });
}
