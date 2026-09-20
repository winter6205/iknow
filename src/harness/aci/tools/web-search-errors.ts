/**
 * Typed discriminated union for `web_search` backend failures.
 *
 * Shape: **plain object** (not a class), mirroring the existing
 * `WebEnvConfigError` (`src/config/env.ts`) / `WorkspaceRootError` forms.
 * Callers must branch on `kind` via the `isSearchBackendError` guard and never
 * `err instanceof Error` — that would stringify a plain object as
 * `[object Object]`, hiding `kind` / `endpoint`.
 *
 * Closed set of six kinds (extending it requires revisiting the spec):
 *   - `missing_key`            keyed backend selected but its key is absent / placeholder resolution failed
 *   - `backend_unset_with_key` backend unset while some keyed key is set (guards against silent fallback to Bing)
 *   - `http_non_2xx`           upstream non-2xx (401 / 429 / 5xx)
 *   - `parse`                  upstream response unparseable (**no** silent-empty downgrade)
 *   - `timeout`                cancelled / timed out
 *   - `not_shipped`            a backend not implemented in v1 was selected (Tavily / Brave)
 *
 * Security contract: `message` / `endpoint` must never carry a key literal,
 * an `Authorization` header, or an upstream request body. `endpoint` keeps
 * only the domain (`createSearchBackendError` enforces the narrowing and
 * drops the query string); `message` passes through `redactAuthSecrets` as a
 * backstop. The raw failure stays in `cause` (debug chain only, never the
 * model-visible `ToolExecutionError.message`).
 */

import { ToolExecutionError } from "../../errors.js";

/**
 * The closed set of six kinds, ordered config → transport → unimplemented.
 * Tests deepEqual-pin this order so the set can't be silently extended.
 */
export const SEARCH_BACKEND_ERROR_KINDS = [
  "missing_key",
  "backend_unset_with_key",
  "http_non_2xx",
  "parse",
  "timeout",
  "not_shipped",
] as const;

export type SearchBackendErrorKind =
  (typeof SEARCH_BACKEND_ERROR_KINDS)[number];

/**
 * Typed web_search backend failure. `endpoint` is a bare **domain** (no
 * scheme / path / query / credentials) and may be absent (config-stage
 * failures never reach an endpoint).
 */
export type SearchBackendError = {
  readonly kind: SearchBackendErrorKind;
  readonly message: string;
  readonly endpoint?: string;
  readonly cause?: unknown;
};

/**
 * Typed-discriminant guard (mirrors `isWebEnvConfigError` in
 * `src/config/env.ts`). Requires `kind` in the closed set, `message` a
 * string, and `endpoint` absent or a string. `Error` instances are explicitly
 * excluded so existing error classes (e.g. `ToolExecutionError`) are never
 * misread as this type.
 */
export function isSearchBackendError(err: unknown): err is SearchBackendError {
  if (err === null || typeof err !== "object") return false;
  if (err instanceof Error) return false;
  const maybe = err as Record<string, unknown>;
  return (
    SEARCH_BACKEND_ERROR_KINDS.includes(maybe.kind as SearchBackendErrorKind) &&
    typeof maybe.message === "string" &&
    (maybe.endpoint === undefined || typeof maybe.endpoint === "string")
  );
}

/**
 * URL / bare domain → bare domain. On parse failure (already bare, or not a
 * URL at all), fall back to the input but still cut everything after
 * `?`/`#` — losing information is fine; leaking a key from the query string
 * is not.
 */
function toEndpointDomain(endpoint: string): string {
  try {
    return new URL(endpoint).hostname;
  } catch {
    // EXIT: not a parseable URL; keep the host-ish prefix only.
    return endpoint.split(/[?#]/, 1)[0]?.trim() ?? "";
  }
}

/**
 * Backstop redaction: wipes `Authorization: ...` / `Bearer <token>` /
 * `api_key=<v>` shapes. Construction sites must never insert a key in the
 * first place (first line of defense); this function is the second, catching
 * upstream error text copied verbatim into message. Same family as
 * `sanitizeMcpLifecycleDetail` in `errors.ts`, narrowed to the three shapes
 * web_search can hit.
 */
function redactAuthSecrets(message: string): string {
  return (
    message
      // `bearer` before `authorization`: in `Authorization: Bearer <key>`,
      // running the authorization rule first lets `\S+` consume only
      // "Bearer", leaking the key.
      .replace(/\bbearer\s+\S+/gi, "[redacted]")
      .replace(/\bauthorization\b\s*[:=]?\s*\S+/gi, "[redacted]")
      .replace(
        /\b(?:api[-_]?key|apikey|token|x-subscription-token)\b\s*[:=]\s*\S+/gi,
        "[redacted]"
      )
      .trim()
  );
}

/**
 * Sole construction point for `SearchBackendError`, enforcing the two
 * security invariants in one place: `endpoint` narrowed to a domain,
 * `message` run through redaction.
 */
export function createSearchBackendError(args: {
  readonly kind: SearchBackendErrorKind;
  readonly message: string;
  readonly endpoint?: string;
  readonly cause?: unknown;
}): SearchBackendError {
  const endpoint =
    args.endpoint === undefined ? undefined : toEndpointDomain(args.endpoint);
  return {
    kind: args.kind,
    message: redactAuthSecrets(args.message),
    ...(endpoint ? { endpoint } : {}),
    ...(args.cause === undefined ? {} : { cause: args.cause }),
  };
}

/**
 * Exit translation — typed `SearchBackendError` → `ToolExecutionError`
 * (the existing failure family the executor feeds back to the model verbatim;
 * **no** new error class).
 *
 * Message shape `web_search failed: <kind>: <message>[ (endpoint: <domain>)]`:
 *   - the `web_search failed:` prefix aligns with existing network-guard failures;
 *   - `<kind>` keeps the six kinds distinguishable in the model's view
 *     (`${kind}: ...` rendering, per the typed-error catch contract);
 *   - `endpoint` exposes only the domain, never a key.
 * The original typed error rides along in `cause` for upstream debugging,
 * out of the message.
 */
export function toToolExecutionError(
  err: SearchBackendError
): ToolExecutionError {
  const suffix = err.endpoint ? ` (endpoint: ${err.endpoint})` : "";
  return new ToolExecutionError(
    `web_search failed: ${err.kind}: ${err.message}${suffix}`,
    { cause: err }
  );
}
