/**
 * Session HTTP client — paths reserved per docs/design/session-http-api-v0.md
 * Base is same-origin (served by iknow serve).
 */

const API = "/api/v1";

/** Reserved for future streaming; probe may return 501. */
export const RESERVED = {
  sessionEvents: (id) => `${API}/sessions/${encodeURIComponent(id)}/events`,
};

/**
 * @typedef {object} ApiError
 * @property {string} error
 * @property {string} message
 * @property {Record<string, unknown>} [details]
 */

/**
 * @param {string} path
 * @param {RequestInit} [init]
 */
async function request(path, init = {}) {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const res = await fetch(path, { ...init, headers });
  const text = await res.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { error: "error", message: text.slice(0, 500) };
    }
  }
  if (!res.ok) {
    const err = new Error(
      (data && data.message) || `HTTP ${res.status}`,
    );
    err.status = res.status;
    err.body = data;
    err.code = (data && data.error) || "error";
    throw err;
  }
  return data;
}

export function health() {
  return request(`${API}/health`);
}

/**
 * @param {{ role?: string, mode?: string, json_mode?: boolean, embeddings?: boolean }} [body]
 */
export function createSession(body = {}) {
  return request(`${API}/sessions`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/**
 * @param {string} id
 */
export function getSession(id) {
  return request(`${API}/sessions/${encodeURIComponent(id)}`);
}

/**
 * @param {string} id
 * @param {string} text
 */
export function postMessage(id, text) {
  return request(`${API}/sessions/${encodeURIComponent(id)}/messages`, {
    method: "POST",
    body: JSON.stringify({ text }),
  });
}

/**
 * @param {string} id
 * @param {string} command
 * @param {string[]} [args]
 */
export function postCommand(id, command, args = []) {
  return request(`${API}/sessions/${encodeURIComponent(id)}/commands`, {
    method: "POST",
    body: JSON.stringify({ command, args }),
  });
}

/**
 * @param {string} id
 * @param {{ new_id?: boolean }} [opts]
 */
export function resetSession(id, opts = {}) {
  return request(`${API}/sessions/${encodeURIComponent(id)}/reset`, {
    method: "POST",
    body: JSON.stringify(opts),
  });
}

/**
 * Probe reserved SSE path (expect 501 on v0).
 * @param {string} id
 */
export async function probeEventsReserved(id) {
  const res = await fetch(RESERVED.sessionEvents(id));
  return { status: res.status, ok: res.ok };
}
