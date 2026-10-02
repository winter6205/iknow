/**
 * Load iknow runtime config from process.env + optional `.env` / `.env.local` (cwd)
 * + `.iknow/settings.json` (the single source of truth for loop config).
 *
 * LLM config converges on settings.json as its sole carrier:
 *   - `settings.llm.model` is the **only** source of the literal model route ID
 *     (no placeholders, no env fallback). Missing → fail-fast throw of
 *     "no LLM model configured in settings.llm.model" (see
 *     `LLM_MODEL_MISSING_MESSAGE`). The `IKNOW_LLM_MODEL` env path is retired
 *     (no longer read).
 *   - `settings.llm.apiKey` accepts a literal or a `${VAR}` placeholder,
 *     resolved by `expandPlaceholders` from `process.env[VAR]` first, with
 *     `.env.local` / `.env` as fallback; unresolved → undefined (consumer-side
 *     guards throw "LLM mode needs API key."). The `IKNOW_LLM_API_KEY_ENV` env
 *     path is retired (no longer read); apiKey no longer depends on env names.
 *   - `settings.llm.fallback` / `maxTurns` / `compress` are kept (user-configured).
 *   - `IKNOW_LLM_MAX_OUTPUT_TOKENS` is retired: any non-empty value (process
 *     environment or a loaded env file) throws the typed
 *     `LlmBudgetConfigError` (`legacy_max_output_tokens_env`) pointing the
 *     operator at `models[].maxTokens`. It is never read as a budget and never
 *     rewritten into a settings file. A request's output budget is now
 *     per-route: `llm.routeMaxTokens` / `ModelRouteEnv.maxTokens` carry the
 *     matched `models[].maxTokens`, and assembly falls back to 32,000 only for
 *     a route whose entry is silent.
 * Other fields keep the existing `process.env > .env.local > .env > hardcoded defaults`.
 *
 * Never logs secret values.
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  loadIknowSettings,
  type IknowSettings,
  type IknowSettingsLlmProvider,
  type IknowSettingsThinking,
  type IknowSettingsThinkingEffort,
  type LlmBudgetConfigError,
  DEFAULT_SUBAGENT_MAX_CONCURRENT_WORKERS,
} from "./settings.js";
import { LLM_MODEL_MISSING_MESSAGE } from "./messages.js";
import {
  PRODUCT_ROOT_ENV_KEY,
  WORKSPACE_ROOT_ENV_KEY,
} from "./workspace-root.js";

/**
 * Output-token fallback request assembly uses when the effective model entry
 * carries no `models[].maxTokens`. It is a request budget, not evidence of any
 * supplier's hard maximum.
 */
export const DEFAULT_MAX_OUTPUT_TOKENS = 32_000;

/**
 * Retired global output-token knob. The loader reads it for exactly one
 * purpose — rejecting a non-empty value with a migration error — and never uses
 * it as a budget.
 */
export const LEGACY_MAX_OUTPUT_TOKENS_ENV_KEY = "IKNOW_LLM_MAX_OUTPUT_TOKENS";

/**
 * Resolved transport triple for an optional provider route — the same
 * `providers[]` chain the main model uses (baseUrl/apiKey/headers) plus the
 * route literal. `apiKey` is always present on the success path
 * (`resolveLlmTransport` throws a typed error on a missing key and the caller
 * catches it and drops the whole key, so undefined never appears here). Used by
 * both the lite route and the sub-agent worker route; the field is **absent**
 * (never `null`) when the route is empty, wrong-typed, or unbuildable.
 */
export interface ModelRouteEnv {
  /** Route ID (trimmed settings literal, passed through verbatim to consumers). */
  model: string;
  baseUrl: string;
  apiKey: string;
  headers?: Readonly<Record<string, string>>;
  /**
   * Request output budget of the `models[]` entry this route's wire model
   * matched (`LlmEnv.routeMaxTokens` is the same value on the main route).
   * **Absent** — never a fallback number — when the route's model has no entry
   * or that entry omits `maxTokens`; request assembly then falls back to
   * `DEFAULT_MAX_OUTPUT_TOKENS`. Keeping absence visible means a consumer can
   * never read this route's silence as another route's cap.
   */
  maxTokens?: number;
}

/** Routing result of `settings.llm.liteModel`. */
export type LiteModelEnv = ModelRouteEnv;

/** Routing result of `settings.subagent.model` (the sub-agent worker route). */
export type SubagentModelEnv = ModelRouteEnv;

export interface LlmEnv {
  baseUrl: string;
  /**
   * Model route ID (literal of settings.llm.model, required after trim).
   * The env loader fail-fast guarantees a value (settings is the sole source,
   * no code defaults at all).
   */
  model: string;
  /**
   * Routing result of `settings.llm.liteModel` (same provider/model shape,
   * same `providers[]` lookup). Unset / invalid shape / provider unregistered
   * / provider key unset → **key absent** (same "absent = not produced"
   * discipline as headers), no fail-fast; main-model assembly is unaffected.
   */
  liteModel?: LiteModelEnv;
  /**
   * Extra request headers on a provider hit (settings.llm.providers[i].headers).
   * Only set when `provider/model` hits the registry and that provider has
   * non-empty headers; all other paths (no hit / no providers section) leave
   * the **key absent** — never an empty object — consumers use its presence
   * to decide whether to pass through `defaultHeaders`.
   */
  headers?: Readonly<Record<string, string>>;
  /**
   * Model fallback route ID list (from settings.llm.fallback, user-configured).
   * Unset → [] (no safety net; fallback consumers decide whether/how to use it).
   */
  fallback: string[];
  /**
   * LLM API key (settings.llm.apiKey resolved by `expandPlaceholders`).
   * Successful literal or `${VAR}` resolution → real key; failure → undefined.
   * Consumer guards: when !env.llm.apiKey, build-engine / tui-deps /
   * thinking-override throw "LLM mode needs API key." (no hardcoded fallback).
   */
  apiKey: string | undefined;
  /**
   * Output budget of the model entry matched by `settings.llm.model`
   * (`providers[].models[].maxTokens`, looked up by the route's wire model).
   * Request assembly reads this and **never** a global value; **absent** when
   * the matched entry omits `maxTokens`, in which case assembly uses
   * `DEFAULT_MAX_OUTPUT_TOKENS`. Re-resolved with the route, so selecting
   * another model (or a configured fallback entry) changes it.
   */
  routeMaxTokens?: number;
  /**
   * Retired global snapshot, kept only as a required type member until fixture
   * migration (follow-up ticket): always `DEFAULT_MAX_OUTPUT_TOKENS`, since a
   * budget belongs to one model entry. Nothing reads it anymore — live budget
   * resolution uses `routeMaxTokens`, and assembly sites fall back to
   * `DEFAULT_MAX_OUTPUT_TOKENS` for a route whose entry is silent. The retired
   * `IKNOW_LLM_MAX_OUTPUT_TOKENS` never feeds it — a non-empty value fails
   * loading with `LlmBudgetConfigError`.
   */
  maxOutputTokens: number;
  temperature: number;
  /**
   * Request-side thinking control arm:
   *   - "off"      → send no thinking / output_config (default)
   *   - "adaptive" → send thinking:{type:'adaptive'}; when effort is non-empty also append output_config:{effort:N}
   * Invalid value → fall back to "off".
   */
  thinking: "off" | "adaptive";
  /**
   * Effort tier: empty → send no output_config. Invalid value → treated as empty.
   */
  thinkingEffort: "" | "low" | "medium" | "high" | "xhigh" | "max";
  /**
   * Streaming arm switch:
   *   - "on"  → adapter uses `client.messages.stream(...)` (default)
   *   - "off" → non-streaming fallback arm (`messages.create`, existing behavior)
   * Invalid value → fall back to "on" without crashing (same fallback
   * discipline as the thinking flag, opposite direction).
   */
  stream: "on" | "off";
  /**
   * Max loop turns per session (optional positive integer).
   * `undefined` (default) = unlimited (loop-engine has no turn cap); when
   * explicitly set loop-engine stops at the cap (over-cap throw + reactive
   * compact branches belong to loop-engine).
   * Range validation: non-integer / < 1 is rejected by the CLI `--max-turns`
   * parsing layer (parse-args.ts); the env side uses envOptionalInt
   * (unset / empty / non-numeric → undefined, never throws).
   */
  maxTurns?: number;
  /**
   * Racing cap per single LLM call (per-call, milliseconds).
   * env chain: `envOptionalPositiveInt("IKNOW_LLM_TIMEOUT_MS") ?? mergedSettings.llm?.timeoutMs ?? 300_000`.
   * The third layer 300_000 (5 min) matches a single coding-agent call
   * (thinking + long tool_use), not the MCP connect timeout. Explicit env /
   * settings values still override.
   */
  timeoutMs: number;
  /**
   * "Model-call idle": on the streaming arm, the silent cap (ms) for the model
   * producing not a single delta. On expiry it falls through to the existing
   * `StopReason: timeout`; no new stop reason; with `stream=off` there are no
   * deltas to reset it and the harness treats it as absent.
   *
   * env chain: `envOptionalPositiveInt("IKNOW_LLM_IDLE_TIMEOUT_MS") ?? settings.llm.idleTimeoutMs ?? 300_000`.
   * Third layer is 5 minutes (raised from 2 minutes): while output flows,
   * provider deltas arrive at sub-second intervals, so minutes without a
   * single delta almost certainly mean a dead connection. But queueing and
   * upstream rate limiting before long thinking / 32k generations frequently
   * exceed 2 minutes, and the old value misjudged "still thinking" as a dead
   * stream. The idle clock runs from step start, so it must leave enough
   * slack for queueing before the first delta; the UI side only changes the
   * notice copy past its own silence threshold (60s default, host-injectable
   * — see DEFAULT_STREAMING_SILENCE_NOTICE_MS in tui/app.tsx), it never waits
   * or interrupts.
   *
   * Optional rather than required: `IknowEnv` literals are hand-written in
   * dozens of test / script spots; a required field would spread this change
   * into unrelated files (minimal-change). Production assembly always goes
   * through `loadIknowEnv`, which always fills this field.
   */
  idleTimeoutMs?: number;
  /**
   * "Model-call hard cap": on the streaming arm, a **finite** cap (ms) measured
   * from this `adapter.step`; on expiry it falls to `timeout` even while deltas
   * still flow (the hard cap must stay finite for acceptance).
   *
   * env chain: `envOptionalPositiveInt("IKNOW_LLM_HARD_CAP_MS") ?? settings.llm.hardCapMs ?? 900_000`.
   * Third layer is 15 minutes: must be strictly greater than the idle clock's
   * 300_000 default, otherwise the acceptance criterion "a call that keeps
   * producing deltas is not killed by a wall clock started at open" fails
   * under default config; take 3x the idle default to cover the longest
   * reasonable single step of extended thinking + 32k output while staying
   * finite.
   *
   * On the streaming arm it replaces `timeoutMs` as the wall clock
   * (`timeoutMs` remains the single clock for `stream=off`). Optional for the
   * same reason as `idleTimeoutMs`.
   */
  hardCapMs?: number;
}

/**
 * Thinking visibility control arm (env flag → env SSOT).
 *
 * `IKNOW_CHAT_SHOW_THINKING` value domain `"off" | "on"` (case-insensitive).
 * Invalid value → fall back to `false`. Default off (thinking never enters
 * the answer body).
 */
export interface ChatEnv {
  /**
   * Whether to show model thinking text in answers.
   * `false` (default) = hidden, existing chat projection behavior unchanged;
   * `true` = show thinking before the answer text in a distinct style.
   */
  showThinking: boolean;
}

/**
 * Env config arms for ACI web-family tools (web_search endpoint override +
 * egress proxy + pluggable backends).
 *
 * `IKNOW_WEB_SEARCH_URL`: optional HTML search endpoint override (private
 * backend / testing). Empty → undefined (web_search uses the default
 * DuckDuckGo html endpoint).
 *
 * `IKNOW_WEB_PROXY`: optional egress HTTP(S) proxy URL (trust_env=False
 * semantics — only explicit config takes effect; system HTTP(S)_PROXY is not
 * read). The assembly side builds a ProxyAgent dispatcher in network-guard;
 * when non-empty, web_fetch / web_search egress goes through the proxy
 * (remote resolution + egress, bypassing local DNS pollution / egress
 * blocking). The proxy URL still passes the same syntax validation as targets
 * (protocol / host / credentials).
 *
 * `IKNOW_WEB_SEARCH_BACKEND`: web_search backend selection (closed set
 * `"bing" | "tavily" | "exa" | "brave"`). Unset / empty string → default
 * `"bing"` (HTML parsing path unchanged, byte-identical to v0). Invalid value
 * → throw typed `WebEnvConfigError( "invalid_search_backend" )`, **never**
 * silently fall back to the default (unlike envThinkingModeOptional-style
 * "invalid → undefined" patterns — the default backend is sensitive to
 * misconfiguration, and a loud failure beats a fallback).
 *
 * `EXA_API_KEY` / `TAVILY_API_KEY` / `BRAVE_API_KEY` (vendor-named): keyed
 * backend API keys, literal or `${VAR}` placeholder; empty string / "yes" /
 * placeholder resolution failure → undefined (same expandPlaceholders chain
 * as settings.llm.apiKey).
 *
 * Reads go through this module's unified process.env > .env.local > .env
 * priority (env.ts SSOT, same loading chain as the LLM key); tools never read
 * process.env directly.
 *
 * Each vendor key additionally falls back to `settings.web.backendKey`
 * (the user-layer settings file), so a normal install configures the backend
 * and its key in one place without authoring an env file. That field is
 * vendor-neutral: it is routed into the slot of whichever backend
 * `web.searchBackend` resolved to. Env still wins: the settings value is the
 * last source before "no key", matching the `web.searchBackend` chain. A
 * settings value may itself be a `${VAR}` placeholder, which resolves through
 * the same process.env > .env.local > .env order.
 */

/** Project naming — env var name for web_search backend selection. */
export const SEARCH_BACKEND_ENV_KEY = "IKNOW_WEB_SEARCH_BACKEND";

/** Vendor naming — API key env var names for the three keyed backends. */
export const EXA_API_KEY_ENV_KEY = "EXA_API_KEY";
export const TAVILY_API_KEY_ENV_KEY = "TAVILY_API_KEY";
export const BRAVE_API_KEY_ENV_KEY = "BRAVE_API_KEY";

/**
 * Closed set of web_search backend ids.
 * Order kept stable (bing → tavily → exa → brave); the `envOptionalEnum` check
 * is order-insensitive (`Array.includes` linear scan), but the literal shape
 * is kept for error messages / test assertions. Loader assembly deserializes
 * via `(typeof VALUES)[number]`.
 */
export const SEARCH_BACKEND_VALUES = [
  "bing",
  "tavily",
  "exa",
  "brave",
] as const;

/** Backend id literal union (strong-typed alignment with envOptionalEnum helper defaults). */
export type SearchBackendId = (typeof SEARCH_BACKEND_VALUES)[number];

/**
 * WebEnv typed-error discriminated union.
 * Currently only the `invalid_search_backend` kind — `IKNOW_WEB_SEARCH_BACKEND`
 * outside the `SEARCH_BACKEND_VALUES` closed set. Mirrors `WorkspaceRootError`'s
 * plain-object `satisfies` shape (callers use the `isWebEnvConfigError` guard,
 * never `instanceof Error`: the latter stringifies a plain object to
 * `[object Object]`, hiding kind/varName entirely). Keeping `expected` (not
 * flattened into a string) lets the render side re-order the closed set as needed.
 */
export type WebEnvConfigError = {
  kind: "invalid_search_backend";
  varName: string;
  value: string;
  expected: readonly string[];
};

/**
 * WebEnv typed-error discriminated guard.
 * `kind` must hit the known closed set + `varName`/`value` are strings +
 * `expected` is an array. Same "kind + payload field" semantics as
 * `WorkspaceRootError`, avoiding kind collisions with `SessionStoreError`.
 */
export function isWebEnvConfigError(err: unknown): err is WebEnvConfigError {
  if (err === null || typeof err !== "object") return false;
  const maybe = err as Record<string, unknown>;
  return (
    maybe.kind === "invalid_search_backend" &&
    typeof maybe.varName === "string" &&
    typeof maybe.value === "string" &&
    Array.isArray(maybe.expected)
  );
}

/**
 * Typed-error discriminated union for when a provider is matched but the env
 * var named by `provider.apiKeyEnv` is unset (absent / empty in process.env).
 * Currently only the `provider_api_key_missing` kind.
 *
 * Plain-object `satisfies` shape (like `WebEnvConfigError` /
 * `WorkspaceRootError`): callers use the `isLlmProviderConfigError` guard,
 * **never** `err instanceof Error` — the latter stringifies a plain object to
 * `[object Object]`, hiding kind / providerId / apiKeyEnv (the typed-error
 * catch contract).
 *
 * Security contract: the payload carries only env var **names** (`apiKeyEnv`),
 * never key values; this module never prints or persists any secret.
 * **Never** fall back to the literal `settings.llm.apiKey` — a provider that
 * explicitly declares apiKeyEnv has opted into env resolution; silently
 * degrading would disguise "wrong env var name" as "working fine with a
 * different key".
 */
export type LlmProviderConfigError =
  | {
      kind: "provider_api_key_missing";
      providerId: string;
      apiKeyEnv: string;
    }
  | {
      kind: "provider_model_not_registered";
      model: string;
    };

/** Provider typed-error discriminated guard. */
export function isLlmProviderConfigError(
  err: unknown
): err is LlmProviderConfigError {
  if (err === null || typeof err !== "object") return false;
  const maybe = err as Record<string, unknown>;
  if (maybe.kind === "provider_api_key_missing") {
    return (
      typeof maybe.providerId === "string" &&
      typeof maybe.apiKeyEnv === "string"
    );
  }
  if (maybe.kind === "provider_model_not_registered") {
    return typeof maybe.model === "string";
  }
  return false;
}

/**
 * Wire-model SSOT parsing.
 *
 * The physical world = the `model` field of Anthropic SDK request bodies =
 * providers.models[].id (without the provider prefix). `settings.llm.model` is
 * a route ID (`provider/model` literal); the provider id is only used to look
 * up the registry for baseUrl/apiKey/headers and **never** goes on the wire —
 * only models[].id does.
 *
 * Behavior:
 *  - split on the first `/`: left = provider id (trimmed), right = model id
 *    (trimmed, may contain further `/`);
 *  - no `/`, or either side empty after trim → return the input unchanged
 *    (bare names pass through; `a/` / `/x` miss shapes are thrown as typed
 *    errors by today's loadIknowEnv before assembly; this function stays
 *    total and **never** throws, for unit-testability and future no-providers
 *    regression paths).
 *
 * The three assembly points (build-engine / thinking-override / subagent
 * worker) share this function; inlining duplicates is forbidden.
 */
export function wireModelFromRoute(route: string): string {
  const slash = route.indexOf("/");
  if (slash === -1) return route;
  const tail = route.slice(slash + 1).trim();
  if (tail === "") return route; // `a/` shape: miss path returns the input verbatim
  return tail;
}

/** Renders `LlmProviderConfigError` text; emits only provider / env names, never key values. */
export function formatLlmProviderConfigError(
  err: LlmProviderConfigError
): string {
  if (err.kind === "provider_model_not_registered") {
    return `provider_model_not_registered: ${err.model} (not in llm.providers)`;
  }
  return `provider_api_key_missing: ${err.providerId} (env ${err.apiKeyEnv} unset)`;
}

/**
 * Parse result of splitting the provider route ID out of `settings.llm.model`.
 *  - `providerId`: the first segment split on the **first** `/` (only counts
 *    as provider shape when non-empty after trim and the tail is also non-empty);
 *  - `provider`: the matched provider record; no hit / non-provider shape →
 *    undefined (`resolveLlmTransport` throws `provider_model_not_registered`).
 *
 * The tail (modelId) is used once for the shape check only: this function
 * trims and discards it — the consumer `resolveLlmTransport` only needs
 * providerId for the lookup; the model string itself (tail included) is
 * passed through verbatim into `IknowEnv.llm.model` by `loadIknowEnv`.
 */
interface ResolvedLlmProvider {
  readonly providerId: string;
  readonly provider: IknowSettingsLlmProvider | undefined;
}

/**
 * Key lookup on a provider hit — reads **only `process.env[apiKeyEnv]`**;
 * **no** fallback to the `.env` / `.env.local` fileMap (deliberately separate
 * from the apiKey placeholder chain: a provider-declared env var is a
 * deployment contract, not workspace config). A value counts only when
 * non-empty after trim; unset / empty / whitespace-only → undefined.
 *
 * `typeof raw === "string"` is the prototype-injection guard: if `apiKeyEnv`
 * happens to be an own key of Object.prototype (`constructor` / `__proto__` /
 * `toString` etc.), `process.env[key]` would hit the prototype and return a
 * function / object, and a direct `.trim()` would throw TypeError instead of a
 * typed error. Non-strings are treated as "unset" → typed
 * `provider_api_key_missing` (fail-safe: never use a non-env value as a key).
 */
function resolveProviderApiKey(apiKeyEnv: string): string | undefined {
  const raw = process.env[apiKeyEnv];
  if (typeof raw !== "string" || raw.trim() === "") return undefined;
  return raw.trim();
}

/**
 * `provider/model` split + registry lookup for `settings.llm.model`.
 * **No hit / providers absent → typed throw** (`provider_model_not_registered`);
 * no more fallback to the old `IKNOW_LLM_BASE_URL` + `settings.llm.apiKey` path.
 *
 *  - split on the first `/`; provider shape only when both segments are
 *    non-empty after trim (`/x` / `x/` / `a//b` → empty tail → treated as no
 *    match, no throw, no second split);
 *  - the tail keeps remaining `/`s (`a/b/c` → head `a`, tail `b/c`, used for
 *    the shape check then discarded);
 *  - `providers` absent / empty array → straight no-match (zero-cost short circuit);
 *  - lookup via `p.id === providerId` (the settings loading layer already
 *    trims provider ids); the registry is not deduplicated, **first match
 *    wins** (later same-id definitions do not override; see settings.ts).
 */
function resolveLlmProvider(
  providers: ReadonlyArray<IknowSettingsLlmProvider> | undefined,
  model: string
): ResolvedLlmProvider {
  const slash = model.indexOf("/");
  const providerId = slash === -1 ? "" : model.slice(0, slash).trim();
  const tail = slash === -1 ? "" : model.slice(slash + 1).trim();
  if (slash === -1 || providerId === "" || tail === "") {
    return { providerId, provider: undefined };
  }
  const provider = providers?.find((p) => p.id === providerId);
  return { providerId, provider };
}

/**
 * Triple assembly for `llm.baseUrl` / `llm.apiKey` / `llm.headers`.
 *
 * Hit → baseUrl = provider.baseUrl without trailing slash, apiKey =
 * `process.env[provider.apiKeyEnv]`, headers = provider.headers (absent →
 * not produced); missing / empty apiKeyEnv → throw typed
 * `LlmProviderConfigError`, **never** fall back to the literal
 * `settings.llm.apiKey`. providers absent / empty / no match →
 * `provider_model_not_registered`.
 */
interface ResolvedLlmTransport {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly headers: Readonly<Record<string, string>> | undefined;
  /**
   * `maxTokens` of the `models[]` entry whose id equals this route's wire model
   * (`wireModelFromRoute`, i.e. ADR-0094's raw tail); undefined when the
   * provider lists no such entry or that entry omits the field. Resolution
   * reports what the entry says and nothing else — no clamping, no fallback.
   */
  readonly maxTokens: number | undefined;
}

function resolveLlmTransport(
  mergedSettings: IknowSettings,
  model: string
): ResolvedLlmTransport {
  const providers = mergedSettings.llm?.providers;
  if (providers === undefined || providers.length === 0) {
    throw {
      kind: "provider_model_not_registered",
      model,
    } satisfies LlmProviderConfigError;
  }
  const { providerId, provider } = resolveLlmProvider(providers, model);
  if (provider === undefined) {
    throw {
      kind: "provider_model_not_registered",
      model,
    } satisfies LlmProviderConfigError;
  }
  const apiKey = resolveProviderApiKey(provider.apiKeyEnv);
  if (apiKey === undefined) {
    throw {
      kind: "provider_api_key_missing",
      providerId,
      apiKeyEnv: provider.apiKeyEnv,
    } satisfies LlmProviderConfigError;
  }
  // Entry lookup on the wire model, not the route literal: the provider prefix
  // never appears in `models[].id`. Ids are unique within a provider, so the
  // first match resolves (same non-dedup discipline as the provider registry).
  const entry = provider.models.find(
    (m) => m.id === wireModelFromRoute(model).trim()
  );
  return {
    baseUrl: provider.baseUrl.replace(/\/$/, ""),
    apiKey,
    // headers absent (including empty object — the settings loading layer
    // folds empty maps into field absence) → keep undefined, never write `{}`.
    headers: provider.headers,
    maxTokens: entry?.maxTokens,
  };
}

/**
 * Resolve an optional provider route (lite or sub-agent) into a transport triple
 * through the same `resolveLlmTransport` chain the main model uses — budget of
 * the matched model entry included, so a separately routed request carries its
 * own route's value. An empty / wrong-typed route, or a route whose provider is
 * unregistered or whose api-key env is unset (`LlmProviderConfigError`,
 * recognized only by `isLlmProviderConfigError`), drops the whole key to
 * undefined so the caller falls back — an optional route must never fail-fast
 * anything. Any other throw propagates.
 */
function resolveOptionalRoute(
  mergedSettings: IknowSettings,
  rawRoute: string | undefined
): ModelRouteEnv | undefined {
  const route = rawRoute?.trim();
  if (!route) return undefined;
  let transport: ResolvedLlmTransport;
  try {
    transport = resolveLlmTransport(mergedSettings, route);
  } catch (err) {
    // EXIT: provider unregistered or api-key env unset → key absent, caller falls back.
    if (isLlmProviderConfigError(err)) return undefined;
    throw err;
  }
  return {
    model: route,
    baseUrl: transport.baseUrl,
    apiKey: transport.apiKey,
    // headers absent → key not produced (same discipline as LlmEnv.headers).
    ...(transport.headers === undefined ? {} : { headers: transport.headers }),
    // entry silent → key not produced: assembly falls back per route, so this
    // route can never inherit the budget of the route it fell out of.
    ...(transport.maxTokens === undefined
      ? {}
      : { maxTokens: transport.maxTokens }),
  };
}

/** `settings.llm.liteModel` → routing result; illegal states silently absent. */
function resolveLlmLite(
  mergedSettings: IknowSettings
): LiteModelEnv | undefined {
  return resolveOptionalRoute(mergedSettings, mergedSettings.llm?.liteModel);
}

/**
 * `settings.subagent.model` → sub-agent worker route; an unusable route is
 * silently absent so the worker starts on `settings.llm.model` and the parent
 * spawn is never failed.
 */
function resolveSubagentModel(
  mergedSettings: IknowSettings
): SubagentModelEnv | undefined {
  return resolveOptionalRoute(mergedSettings, mergedSettings.subagent?.model);
}

/**
 * Produce `{ liteModel }` only when the lite routing result exists; absent →
 * `{}` (no key). Moved verbatim from loadIknowEnv — the conditional spread is
 * folded into a single-purpose helper so loadIknowEnv's complexity doesn't
 * grow with optional arms.
 */
function spreadLiteModel(
  liteModel: LiteModelEnv | undefined
): Pick<LlmEnv, "liteModel"> {
  return liteModel === undefined ? {} : { liteModel };
}

/** Produce `{ model }` only when the sub-agent route resolved; absent → `{}` (no key, never `null`). */
function spreadSubagentModel(
  model: SubagentModelEnv | undefined
): Pick<IknowSubagentEnv, "model"> {
  return model === undefined ? {} : { model };
}

/**
 * Produce `{ routeMaxTokens }` only when the matched model entry declares a
 * budget; a silent entry → `{}` (no key), so the `DEFAULT_MAX_OUTPUT_TOKENS`
 * fallback stays in one place (assembly) and no other route's number can be
 * read as this one's cap. Moved verbatim from loadIknowEnv's return so the
 * conditional spread does not grow its complexity.
 */
function spreadRouteMaxTokens(
  maxTokens: number | undefined
): Pick<LlmEnv, "routeMaxTokens"> {
  return maxTokens === undefined ? {} : { routeMaxTokens: maxTokens };
}

export interface WebEnv {
  searchUrl: string | undefined;
  proxy: string | undefined;
  /**
   * Selected web_search backend id (closed set `"bing" | "tavily" | "exa" | "brave"`).
   * Fallback chain env > settings.web.searchBackend > default `"bing"`.
   * Invalid values throw typed `WebEnvConfigError` from the env loader, **never** silent fallback.
   */
  searchBackend?: "bing" | "tavily" | "exa" | "brave";
  /**
   * Exa API key (env `EXA_API_KEY`, vendor-named).
   * Literal key or `${VAR}` placeholder resolved by expandPlaceholders;
   * unset / empty / "yes" / placeholder resolution failure → undefined.
   */
  exaApiKey?: string;
  /**
   * Tavily API key (env `TAVILY_API_KEY`, vendor-named).
   * Same empty-state semantics as exaApiKey.
   */
  tavilyApiKey?: string;
  /**
   * Brave API key (env `BRAVE_API_KEY`, vendor-named).
   * Same empty-state semantics as exaApiKey.
   */
  braveApiKey?: string;
}

/**
 * Auto-compact config arm (env SSOT, passed through to harness/compress/).
 *
 * `IKNOW_MODEL_CONTEXT_WINDOW`: the **policy budget window** (integer) — the
 * same number shared by the usage-display denominator and the proactive
 * auto-compact gate; it is not the vendor model limit. Default 256000
 * (`DEFAULT_STRATEGY_CONTEXT_WINDOW`); non-numeric → fall back to the same
 * default (matches envInt's existing discipline, never throws).
 *
 * `IKNOW_AUTO_COMPACT_THRESHOLD_TOKENS`: proactive auto-compact threshold
 * (optional integer). Unset / empty / non-numeric → undefined (threshold.ts
 * derives `floor(0.95 × contextWindow)` by default at derive time, with the
 * hard check `threshold < window`). Early validation belongs to threshold.ts,
 * not the env loader. Whoever sets the denominator to the vendor's real cap
 * should lower this env themselves.
 */
export interface IknowCompressEnv {
  // Field access looks like `env.compress.contextWindow` / `env.compress.thresholdTokens`.
  contextWindow: number;
  thresholdTokens: number | undefined;
}

/**
 * Default **policy budget window**: shared by three spots — env-derived
 * default, TUI `ContextBar` denominator and health-projection denominator —
 * so drifting literals can never reintroduce "the bar says nearly full but
 * compaction hasn't happened".
 */
export const DEFAULT_STRATEGY_CONTEXT_WINDOW = 256_000;

/**
 * MCP connect-timeout config arm (env SSOT, passed to createMcpManager.timeoutMsOverride).
 *
 * `IKNOW_MCP_CONNECT_TIMEOUT_MS`: MCP server connect timeout in ms (positive integer).
 * Default 60_000 (30s was being busted by npx -y cold starts; raised to 60s to mitigate).
 * Invalid values (non-numeric / negative / 0) → fall back to 60_000 (unified
 * dual track; zero / negative timeouts are meaningless).
 */
export interface McpEnv {
  connectTimeoutMs: number;
}

/**
 * Subagent config arm (worker route and thinking settings, plus manager limits).
 *
 * `taskTimeoutMs` = whole-task lifetime cap per subagent (per-task wallclock, ms).
 * Semantics, naming and consumption point are kept fully separate from
 * `LlmEnv.timeoutMs` (per-call LLM racing).
 *
 * env chain: `envOptionalPositiveInt("IKNOW_SUBAGENT_TASK_TIMEOUT_MS") ?? mergedSettings.subagent?.taskTimeoutMs`.
 * No third-layer default at the env layer (the 7200s constant is declared at
 * the manager consumption point, to avoid declaring the default in two places;
 * single-carrier settings passes mirror validation).
 *
 * `maxConcurrentWorkers` = cap on workers simultaneously in starting/running.
 * Unset / empty / non-numeric / non-positive → default
 * `DEFAULT_SUBAGENT_MAX_CONCURRENT_WORKERS` (15).
 *
 * Value domain widened to `number | "unlimited"`; `"unlimited"` is only
 * produced from settings (env never accepts the unlimited literal), persisted
 * via the panel / persist reverse channel.
 */
export interface IknowSubagentEnv {
  /** Subagent whole-task lifetime cap (ms); env unset + settings unset → undefined. */
  taskTimeoutMs: number | undefined;
  /** Subagent concurrency cap; loadIknowEnv always fills a positive integer default or `"unlimited"`. */
  maxConcurrentWorkers?: number | "unlimited";
  /**
   * Resolved worker route from `settings.subagent.model`; the worker adapter
   * builds from this when present. **Absent (never `null`)** when the route is
   * empty / wrong-typed / unbuildable — the worker then uses `llm.model`.
   */
  model?: SubagentModelEnv;
  /** Optional worker thinking mode from user settings; no dedicated env override. */
  thinking?: IknowSettingsThinking;
  /** Optional worker thinking effort from user settings; no dedicated env override. */
  thinkingEffort?: IknowSettingsThinkingEffort;
}

export interface IknowEnv {
  llm: LlmEnv;
  /** Thinking visibility control arm. */
  chat: ChatEnv;
  /** ACI web-family tool config arm (web_search endpoint override). */
  web: WebEnv;
  /** Auto-compact config arm (passed through to harness/compress/). */
  compress: IknowCompressEnv;
  /** MCP connect-timeout config arm (passed to createMcpManager.timeoutMsOverride). */
  mcp: McpEnv;
  /** Subagent config arm (per-task wallclock; consumed by the manager SIGTERM timer). */
  subagent: IknowSubagentEnv;
  /**
   * Tool loop detection (on by default). env `IKNOW_TOOL_LOOP_DETECTION` and settings.loop.detectToolLoop.
   */
  loop?: { detectToolLoop: boolean };
  /**
   * ADR-0019 (T1): workspace-root per-root state anchor, read from
   * `IKNOW_WORKSPACE_ROOT` via envOptional (canonical reader; empty/unset
   * → undefined). Consumers pass this into `resolveWorkspaceRoot({env})`
   * (priority chain `[explicit, env, cwd]`); the resolver validates the
   * path is absolute and exists, throwing a typed `WorkspaceRootError`
   * for relative / missing paths.
   */
  workspaceRoot: string | undefined;
  /**
   * Project identity root, read from `IKNOW_PRODUCT_ROOT`. When a parent
   * session spawns subagents it injects this var so the worker's rules /
   * project `AGENTS.md` / project skills discovery land on the **main repo**
   * instead of its own cwd (after rebinding, that is a gitignored bare tree).
   * Unset → undefined, worker falls back to cwd (without rebinding both are
   * the same value, byte-for-byte unchanged).
   */
  productRoot: string | undefined;
}

/** Placeholder values treated as "no real secret set" (case-insensitive). */
const API_KEY_PLACEHOLDERS = new Set(["yes"]);

function parseEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const i = line.indexOf("=");
    const k = line.slice(0, i).trim();
    let v = line.slice(i + 1).trim();
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1);
    }
    if (v.startsWith("<") && v.endsWith(">")) continue; // unfilled placeholder
    out[k] = v;
  }
  return out;
}

interface EnvGetOpts {
  readonly file: Record<string, string>;
  readonly key: string;
  readonly fallback?: string;
}

function envGet(opts: EnvGetOpts): string {
  const { file, key } = opts;
  const fallback = opts.fallback ?? "";
  const fromProc = process.env[key];
  if (fromProc !== undefined && fromProc !== "") return fromProc;
  if (file[key] !== undefined && file[key] !== "") return file[key]!;
  return fallback;
}

/** Optional string env: unset / empty → undefined (unlike envGet's "" fallback). */
function envOptional(opts: EnvGetOpts): string | undefined {
  const raw = envGet({ file: opts.file, key: opts.key });
  return raw.length > 0 ? raw : undefined;
}

function envOptionalBool(opts: EnvGetOpts): boolean | undefined {
  const raw = envOptional(opts);
  if (raw === undefined) return undefined;
  const v = raw.trim().toLowerCase();
  if (v === "0" || v === "false" || v === "off" || v === "no") return false;
  if (v === "1" || v === "true" || v === "on" || v === "yes") return true;
  return undefined;
}

interface EnvIntOpts {
  readonly file: Record<string, string>;
  readonly key: string;
  readonly fallback: number;
}

/** Integer env values (tokens, timeouts). Non-finite → fallback. */
function envInt(opts: EnvIntOpts): number {
  const raw = envGet({ file: opts.file, key: opts.key });
  if (!raw) return opts.fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.trunc(n) : opts.fallback;
}

/**
 * Positive-integer env values (MCP connect timeout, etc.).
 * envInt only checks finiteness, but 0 / negative timeouts are meaningless;
 * tighten to pass through only when > 0, otherwise fall back (unset /
 * non-numeric / negative / 0 → fallback, never throws).
 */
function envPositiveInt(opts: EnvIntOpts): number {
  const n = envInt(opts);
  return n > 0 ? n : opts.fallback;
}

interface EnvOptionalIntOpts {
  readonly file: Record<string, string>;
  readonly key: string;
}

/**
 * Optional integer env values (e.g. auto-compact threshold).
 * Unset / empty → undefined; otherwise Number + isFinite + trunc;
 * non-numeric → undefined (fallback discipline matches envInt, never throws).
 */
function envOptionalInt(opts: EnvOptionalIntOpts): number | undefined {
  const raw = envGet({ file: opts.file, key: opts.key });
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.trunc(n) : undefined;
}

/** Optional positive integer env values (timeouts). Non-positive → undefined. */
function envOptionalPositiveInt(opts: EnvOptionalIntOpts): number | undefined {
  const n = envOptionalInt(opts);
  return n !== undefined && n > 0 ? n : undefined;
}

interface EnvNumberOpts {
  readonly file: Record<string, string>;
  readonly key: string;
  readonly fallback: number;
}

/** Float env values (e.g. temperature 0.0–2.0). Non-finite → fallback. */
function envNumber(opts: EnvNumberOpts): number {
  const raw = envGet({ file: opts.file, key: opts.key });
  if (!raw) return opts.fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : opts.fallback;
}

interface EnvFileKeyOpts {
  readonly file: Record<string, string>;
  readonly key: string;
}

/**
 * Parse IKNOW_LLM_THINKING value domain "off" | "adaptive" (case-insensitive).
 * Unset / empty / invalid → undefined (unlike the thinking-mode parser's
 * "invalid → fall back to off"): callers need the tri-state (off / adaptive /
 * unset) so that only a truly-unset env falls back to settings.llm.thinking.
 */
function envThinkingModeOptional(
  opts: EnvFileKeyOpts
): "off" | "adaptive" | undefined {
  const raw = envGet({ file: opts.file, key: opts.key }).toLowerCase();
  if (raw === "off" || raw === "adaptive") return raw;
  return undefined;
}

/**
 * Parse IKNOW_LLM_THINKING_EFFORT value domain "low" | "medium" | "high" |
 * "xhigh" | "max". Unset / empty / invalid → undefined (unlike the effort
 * parser's "invalid treated as empty"): callers must distinguish "unset" to
 * fall back to settings.
 */
function envThinkingEffortOptional(
  opts: EnvFileKeyOpts
): "low" | "medium" | "high" | "xhigh" | "max" | undefined {
  const raw = envGet({ file: opts.file, key: opts.key }).toLowerCase();
  switch (raw) {
    case "low":
    case "medium":
    case "high":
    case "xhigh":
    case "max":
      return raw;
    default:
      return undefined;
  }
}

/**
 * Parse IKNOW_CHAT_SHOW_THINKING. Valid values "on" / "off" (case-insensitive);
 * invalid → fall back to false (thinking hidden by default).
 */
function envShowThinking(opts: EnvFileKeyOpts): boolean {
  const raw = envGet({ file: opts.file, key: opts.key }).toLowerCase();
  return raw === "on";
}

/**
 * Parse IKNOW_LLM_STREAM value domain "on" | "off" (case-insensitive).
 * Default on (streaming is the default arm); invalid → fall back to "on",
 * never throws. Structurally like the thinking-mode parser, only the fallback
 * direction is opposite (thinking defaults off, stream defaults on).
 */
function envStreamMode(opts: EnvFileKeyOpts): "on" | "off" {
  const raw = envGet({ file: opts.file, key: opts.key }).toLowerCase();
  if (raw === "off") return "off";
  return "on";
}

interface EnvOptionalEnumOpts<T extends string> {
  readonly file: Record<string, string>;
  readonly key: string;
  readonly values: readonly T[];
  /** Value used when the env var is unset; if absent, returns undefined (caller runs the settings / default fallback chain). */
  readonly default?: T;
}

/**
 * Closed-set enum parser (IKNOW_WEB_SEARCH_BACKEND, etc.).
 *  - unset / empty → `default` (when provided) else undefined — unset must
 *    stay distinguishable from an explicit value; callers run an
 *    env > settings > default fallback chain;
 *  - hit in the `values` closed set → returned verbatim (**case-sensitive**,
 *    aligned with the spec literal shapes);
 *  - non-empty but outside the closed set → throw typed
 *    `WebEnvConfigError( "invalid_search_backend", ... )`, **never** silently
 *    fall back to `default`.
 *
 * Opposite of the "invalid → undefined" pattern used by envThinkingModeOptional
 * and friends — the default backend is misconfiguration-sensitive, so a schema
 * reject is louder than a silent fallback.
 */
function envOptionalEnum<T extends string>(
  opts: EnvOptionalEnumOpts<T>
): T | undefined {
  const raw = envGet({ file: opts.file, key: opts.key });
  if (!raw) return opts.default;
  if ((opts.values as readonly string[]).includes(raw)) return raw as T;
  throw {
    kind: "invalid_search_backend",
    varName: opts.key,
    value: raw,
    expected: opts.values,
  } satisfies WebEnvConfigError;
}

/**
 * Placeholder shape: `${VAR}` or `$VAR`. `expandPlaceholders` and settings.ts
 * `isApiKeyOrPlaceholder` share the same VAR-name character set
 * (`[A-Za-z_][A-Za-z0-9_]*`).
 */
const PLACEHOLDER_PATTERN =
  /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g;

/**
 * Extract all `${VAR}` / `$VAR` placeholder variable names from a value
 * (deduplicated, order-preserving). Shares the same regex source with
 * settings.ts `analyzePlaceholderSyntax` (anti-drift). The env-isolation
 * masking list reuses this function too: multi-segment `${A}${B}` and legal
 * literal-plus-placeholder mixtures all extract correctly.
 */
export function extractPlaceholders(value: string): string[] {
  PLACEHOLDER_PATTERN.lastIndex = 0;
  const names = new Set<string>();
  value.replace(
    PLACEHOLDER_PATTERN,
    (_match, braced: string | undefined, bare: string | undefined) => {
      names.add(braced ?? (bare as string));
      return "";
    }
  );
  PLACEHOLDER_PATTERN.lastIndex = 0;
  return [...names];
}

/**
 * Prototype-injection guard — `isPrototypeOwnKey`:
 * Object.prototype own keys (`constructor` / `__proto__` / `toString` /
 * `hasOwnProperty` / `valueOf` etc.) are never legal env var names —
 * `process.env[name]` and `fileMap[name]` would hit Object.prototype and
 * return a function / object, causing a `raw.trim is not a function`
 * TypeError. Any path reaching these keys → reject.
 */
function isPrototypeOwnKey(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(Object.prototype, name);
}

/**
 * Prototype-injection guard — `isPlainEnvName`:
 *  - legal identifier shape (`[A-Za-z_][A-Za-z0-9_]*`);
 *  - not an Object.prototype own key (blocks prototype injection);
 *  - `Object.hasOwn(process.env, varName)` (only real process.env entries pass).
 */
function isPlainEnvName(varName: string): boolean {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(varName)) return false;
  if (isPrototypeOwnKey(varName)) return false;
  return Object.prototype.hasOwnProperty.call(process.env, varName);
}

/** Resolve one placeholder variable by priority: process.env[varName] (isPlainEnvName-guarded) → fileMap[varName]. */
function resolveValueFromFilename(
  varName: string,
  fileMap: Record<string, string>
): string | undefined {
  // Hard reject: any Object.prototype own key (incl. an explicit same-name `constructor` in fileMap) is never resolved.
  if (isPrototypeOwnKey(varName)) return undefined;
  if (isPlainEnvName(varName)) {
    const fromProc = process.env[varName];
    if (fromProc !== undefined && fromProc !== "") return fromProc;
  }
  // fileMap fallback: read only when varName is a legal identifier and
  // fileMap owns the key itself (guards against hitting Object.prototype;
  // same hasOwn discipline as process.env).
  if (
    /^[A-Za-z_][A-Za-z0-9_]*$/.test(varName) &&
    Object.prototype.hasOwnProperty.call(fileMap, varName)
  ) {
    const fromFile = fileMap[varName];
    if (fromFile !== undefined && fromFile !== "") return fromFile;
  }
  return undefined;
}

/**
 * Resolve the settings.llm.apiKey literal / `${VAR}` placeholder.
 *
 *  - undefined → undefined (unconfigured; consumer guards throw "no API key configured");
 *  - literal (no `$VAR` / `${VAR}` shape) → trimmed verbatim (a literal key in
 *    the settings file is the real key; anything containing `$IDENT` is parsed
 *    as a placeholder, no `$$` escaping);
 *  - `${VAR}` / `$VAR` → resolved from `process.env[VAR]` first, falling back
 *    to `fileMap[VAR]` (merged .env.local / .env); any variable that fails to
 *    resolve (unset / empty / "yes" placeholder / non-plain env name) →
 *    undefined (triggers the consumer guards);
 *  - `"yes"` (dotenv-style placeholder, case-insensitive) → treated as unset → undefined.
 *
 * Multi-segment placeholders (e.g. `${A}${B}`) resolve per segment and are
 * concatenated; any missing segment makes the whole string undefined. Invalid
 * placeholder shapes (e.g. `${}` / `${1VAR}` / unterminated `${VAR`) →
 * undefined (aligned with settings.ts `isApiKeyOrPlaceholder` drop semantics —
 * a string containing `${` that doesn't match `${VAR}` is neither a valid
 * placeholder nor a literal key). This function never prints or persists key values.
 */
export function expandPlaceholders(
  value: string | undefined,
  fileMap: Record<string, string>
): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (API_KEY_PLACEHOLDERS.has(trimmed.toLowerCase())) return undefined;
  // When the value contains `${`, run braced-debris detection first: every
  // `${...}` substring must be a legal `${VAR}`; leftover `${` is illegal
  // (`${}` / `${1VAR}` / unterminated `${VAR`) → undefined. Must check before
  // the literal short-circuit, otherwise `${}` etc. would return as literals.
  if (trimmed.includes("${")) {
    const bracedOnly = /\$\{[A-Za-z_][A-Za-z0-9_]*\}/g;
    const stripped = trimmed.replace(bracedOnly, "");
    if (stripped.includes("${")) return undefined;
  }
  const names = extractPlaceholders(trimmed);
  if (names.length === 0) return trimmed; // Literal key returned verbatim.
  let resolved = true;
  const out = trimmed.replace(
    PLACEHOLDER_PATTERN,
    (match: string, braced: string | undefined, bare: string | undefined) => {
      const varName = braced ?? (bare as string);
      const raw = resolveValueFromFilename(varName, fileMap);
      if (raw === undefined) {
        resolved = false;
        return match;
      }
      const val = raw.trim();
      if (!val || API_KEY_PLACEHOLDERS.has(val.toLowerCase())) {
        resolved = false;
        return match;
      }
      return val;
    }
  );
  return resolved ? out : undefined;
}

/**
 * Migration gate for the retired global output-token setting. A non-empty value
 * anywhere the loader reads env (`process.env` first, then `.env.local` / `.env`)
 * fails config loading outright: keeping it would silently override every
 * model entry, and quietly ignoring it would hide a cap the operator believes
 * is in force. Empty / whitespace-only / unset means "not configured" (the same
 * trim discipline as `resolveProviderApiKey`). This never writes or rewrites any
 * settings file — the operator moves the value to `models[].maxTokens` themselves.
 */
function assertNoLegacyMaxOutputTokensEnv(file: Record<string, string>): void {
  const fromProcess = process.env[LEGACY_MAX_OUTPUT_TOKENS_ENV_KEY];
  const raw =
    fromProcess !== undefined && fromProcess !== ""
      ? fromProcess
      : file[LEGACY_MAX_OUTPUT_TOKENS_ENV_KEY];
  const value = raw?.trim();
  if (value === undefined || value === "") return;
  throw {
    kind: "legacy_max_output_tokens_env",
    varName: LEGACY_MAX_OUTPUT_TOKENS_ENV_KEY,
    value,
  } satisfies LlmBudgetConfigError;
}

export function loadIknowEnv(
  cwd: string = process.cwd(),
  settings?: IknowSettings,
  home?: string
): IknowEnv {
  // process.env still wins via envGet; among files, .env.local overrides .env.
  // The settings parameter is a test injection seam; when omitted the real
  // settings files are read. Under the project allowlist, project files
  // contribute only verify / secrets / permissions; the `llm` consumed here is
  // a user-layer key (sole source = `~/.iknow/settings.json`).
  // The home parameter is passed through to loadIknowSettings: for isolating
  // user-level settings in tests. Explicit injection pins this layer instead
  // of relying on ambient process.env.HOME; on POSIX os.homedir() does follow
  // $HOME, so it would work, but implicitly and breakably.
  const mergedSettings = settings ?? loadIknowSettings({ cwd, home });

  const file = {
    ...parseEnvFile(join(cwd, ".env")),
    ...parseEnvFile(join(cwd, ".env.local")),
  };

  // Retired global knob: fail fast before any value could be used (reads
  // process.env + the fileMap above; settings files stay untouched).
  assertNoLegacyMaxOutputTokensEnv(file);

  // Model sole source = settings.llm.model literal (no placeholders, no env
  // fallback). Missing → fail-fast throw (no hardcoded fallback).
  // IKNOW_LLM_MODEL is retired.
  const modelRaw = mergedSettings.llm?.model?.trim();
  if (!modelRaw) {
    throw new Error(LLM_MODEL_MISSING_MESSAGE);
  }

  // The model string must hit the providers registry → baseUrl/apiKey/headers
  // come from the provider triple; no hit / providers absent → typed throw.
  // Missing apiKeyEnv → typed error.
  const transport = resolveLlmTransport(mergedSettings, modelRaw);

  // Lite routing result (optional key) — illegal states silently absent, never affecting the main-model fail-fast above.
  const liteModel = resolveLlmLite(mergedSettings);

  // Sub-agent worker route (optional key) — same providers[] chain; an
  // unbuildable route is silently absent so the worker falls back to modelRaw.
  const subagentModel = resolveSubagentModel(mergedSettings);

  // web_search backend selection, fallback chain
  // env > settings.web.searchBackend > default bing (mirrors the maxTurns
  // precedent). env unset returns undefined (not folded with explicit
  // "bing"); illegal settings-side values were already dropped in
  // parseWeb; illegal env-side values still throw a typed error (a louder
  // misconfiguration surface).
  // Explicit T=SearchBackendId: the helper's T extends string would
  // otherwise be inferred by TS to the wide string type, losing the
  // literal union.
  // Note: `?? "bing"` makes IknowEnv.searchBackend never undefined — the
  // tri-state "unset != explicit bing" survives only at the helper return
  // layer and is folded by the time it reaches WebSearchToolDeps.backend
  // (so the backend_unset_with_key fail-closed defense is test-path-only;
  // restoring it needs undefined carried in the IknowEnv layer, a separate task).
  const webSearchBackend: SearchBackendId =
    envOptionalEnum<SearchBackendId>({
      file,
      key: SEARCH_BACKEND_ENV_KEY,
      values: SEARCH_BACKEND_VALUES,
    }) ??
    mergedSettings.web?.searchBackend ??
    "bing";
  // The settings-side key belongs to the backend that was actually selected, so the
  // field name stays vendor-neutral: a config written for exa keeps working if the
  // selection changes to a backend that later becomes real. Keyed by the same closed
  // set as searchBackend; "bing" has no key and therefore no settings slot.
  const settingsWebKey = expandPlaceholders(mergedSettings.web?.backendKey, file);
  const settingsKeyFor = (id: SearchBackendId): string | undefined =>
    id === webSearchBackend ? settingsWebKey : undefined;

  return {
    llm: {
      baseUrl: transport.baseUrl,
      model: modelRaw,
      // headers produced only when the provider hit has non-empty headers configured (never an empty object).
      ...(transport.headers === undefined
        ? {}
        : { headers: transport.headers }),
      ...spreadLiteModel(liteModel),
      fallback: mergedSettings.llm?.fallback ?? [],
      // apiKey source = settings.llm.apiKey (literal or ${VAR} placeholder)
      // resolved by expandPlaceholders; unset / unresolvable → undefined
      // (consumer guards). On a provider hit transport.apiKey takes over (a
      // provider that declares apiKeyEnv opts into env; never falls back to
      // the literal here).
      apiKey: transport.apiKey,
      // Retired global snapshot: kept only as a required type member pending
      // fixture migration; no reader. The live budget is `routeMaxTokens` below.
      maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
      // Budget of the entry `modelRaw` matched on this route; a silent entry
      // keeps the key absent, so the 32,000 fallback stays one place (assembly)
      // and no other route's number can be read as this one's cap.
      ...spreadRouteMaxTokens(transport.maxTokens),
      // Per-call LLM racing cap (env > settings > 300_000 fallback). Mirrors
      // the maxTurns pattern (envOptionalPositiveInt ?? settings); third layer
      // 5 min: thinking + 32k generations commonly exceed 60s. MCP
      // connectTimeoutMs stays 60s.
      timeoutMs:
        envOptionalPositiveInt({
          file,
          key: "IKNOW_LLM_TIMEOUT_MS",
        }) ??
        mergedSettings.llm?.timeoutMs ??
        300_000,
      // Streaming-arm dual clocks (env > settings > default). Rationale in the
      // LlmEnv field docs; the idle < hard-cap and finite-hard-cap invariants
      // are pinned by tests/harness/model-idle-hardcap-config.test.ts.
      // Default idle is minute-scale 300s (~5 min) — long thinking / 32k
      // generations commonly exceed 60s, so smaller values mis-kill. env /
      // settings override priority unchanged; hardCapMs default stays 900s,
      // the idle < hardCap invariant still pinned by tests (300_000 < 900_000).
      idleTimeoutMs:
        envOptionalPositiveInt({
          file,
          key: "IKNOW_LLM_IDLE_TIMEOUT_MS",
        }) ??
        mergedSettings.llm?.idleTimeoutMs ??
        300_000,
      hardCapMs:
        envOptionalPositiveInt({
          file,
          key: "IKNOW_LLM_HARD_CAP_MS",
        }) ??
        mergedSettings.llm?.hardCapMs ??
        900_000,
      temperature: envNumber({
        file,
        key: "IKNOW_LLM_TEMPERATURE",
        fallback: 0,
      }),
      // settings.llm.thinking / thinkingEffort fallback (env > settings > default).
      // Optional parsing keeps the tri-state: explicit env off/adaptive or a
      // legal effort wins outright; unset / empty / invalid → undefined →
      // falls to settings; both missing → off / "".
      thinking:
        envThinkingModeOptional({
          file,
          key: "IKNOW_LLM_THINKING",
        }) ??
        mergedSettings.llm?.thinking ??
        "off",
      thinkingEffort:
        envThinkingEffortOptional({
          file,
          key: "IKNOW_LLM_THINKING_EFFORT",
        }) ??
        mergedSettings.llm?.thinkingEffort ??
        "",
      // Streaming on by default; invalid values fall back to on.
      stream: envStreamMode({
        file,
        key: "IKNOW_LLM_STREAM",
      }),
      // Optional positive integer; unset / empty / non-numeric → undefined (= unlimited).
      // settings.llm.maxTurns fallback (env > settings).
      maxTurns:
        envOptionalInt({
          file,
          key: "IKNOW_LLM_MAX_TURNS",
        }) ?? mergedSettings.llm?.maxTurns,
    },
    chat: {
      // Default off (thinking hidden, status quo kept).
      showThinking: envShowThinking({
        file,
        key: "IKNOW_CHAT_SHOW_THINKING",
      }),
    },
    web: {
      // Optional endpoint override: empty → undefined (web_search uses the default DuckDuckGo html endpoint).
      searchUrl: envOptional({ file, key: "IKNOW_WEB_SEARCH_URL" }),
      // Optional egress proxy: empty → undefined (network-guard direct connect). Only explicit config takes effect.
      proxy: envOptional({ file, key: "IKNOW_WEB_PROXY" }),
      searchBackend: webSearchBackend,
      // Vendor-keyed backend API keys — literal or `${VAR}` placeholder resolved by the
      // shared `expandPlaceholders` primitive (the same value grammar and placeholder
      // guard that `settings.llm.apiKey` uses, via `isApiKeyOrPlaceholder` on the
      // settings side); empty / "yes" / placeholder resolution failure → undefined
      // (never a silent empty string, never a raw "${VAR}").
      //
      // Fallback chain per key, mirroring web.searchBackend above:
      //   process.env > .env.local / .env (both inside envGet) > settings.web.backendKey > undefined
      //
      // The env rung is **resolved before** the `??`, deliberately: envOptional only maps
      // length-0 → undefined, so an env file holding a dotenv stub (`EXA_API_KEY=yes`) or an
      // unresolvable `${VAR}` is "present" and would short-circuit the settings fallback —
      // discarding a usable settings key and silently downgrading to the default backend.
      // Expanding first makes the chain first-USABLE-wins, matching the empty/whitespace
      // fall-through envOptional already provides.
      //
      // `settings.web.backendKey` is vendor-neutral, so it is routed into the slot of the
      // backend that was actually selected (`settingsKeyFor`) — a config written today
      // keeps working if another backend becomes selectable, and no vendor is baked into
      // the field name. Tavily / Brave remain reachable the same way their env vars
      // always were, which is what `assertBackendConfig`'s `backend_unset_with_key` guard
      // names.
      exaApiKey:
        expandPlaceholders(envOptional({ file, key: EXA_API_KEY_ENV_KEY }), file) ??
        settingsKeyFor("exa"),
      tavilyApiKey: expandPlaceholders(
        envOptional({ file, key: TAVILY_API_KEY_ENV_KEY }),
        file
      ) ?? settingsKeyFor("tavily"),
      braveApiKey: expandPlaceholders(
        envOptional({ file, key: BRAVE_API_KEY_ENV_KEY }),
        file
      ) ?? settingsKeyFor("brave"),
    },
    // Auto-compact config arm (passed through to harness/compress/ via LoopEngineDeps.compress).
    // Threshold sanity validation (threshold >= window rejected) belongs to
    // threshold.ts; this loader only carries raw env parsing and never throws.
    compress: {
      // settings.llm.compress.contextWindow fallback (env > settings > default policy budget window).
      contextWindow: envInt({
        file,
        key: "IKNOW_MODEL_CONTEXT_WINDOW",
        fallback:
          mergedSettings.llm?.compress?.contextWindow ??
          DEFAULT_STRATEGY_CONTEXT_WINDOW,
      }),
      // settings.llm.compress.thresholdTokens fallback (env > settings).
      thresholdTokens:
        envOptionalInt({
          file,
          key: "IKNOW_AUTO_COMPACT_THRESHOLD_TOKENS",
        }) ?? mergedSettings.llm?.compress?.thresholdTokens,
    },
    // MCP connect timeout (default 60_000; mitigates npx -y cold starts busting through 30s).
    mcp: {
      connectTimeoutMs: envPositiveInt({
        file,
        key: "IKNOW_MCP_CONNECT_TIMEOUT_MS",
        fallback: 60_000,
      }),
    },
    // Subagent per-task wallclock (env > settings, no third-layer default; the 7200s constant lives in the manager).
    subagent: {
      taskTimeoutMs:
        envOptionalPositiveInt({
          file,
          key: "IKNOW_SUBAGENT_TASK_TIMEOUT_MS",
        }) ?? mergedSettings.subagent?.taskTimeoutMs,
      // Concurrency cap (env > settings > manager default 15). settings may
      // come from test injection that skipped parse, so re-validate fail-safe
      // here. Value domain widened to `number | "unlimited"` — env still
      // accepts only positive integers (no unlimited literal); settings accepts
      // positive integers or the literal `"unlimited"`; after both chains
      // converge the type is `number | "unlimited"`, which the manager passes
      // through unchanged (see harness/subagent/manager.ts).
      maxConcurrentWorkers:
        envOptionalPositiveInt({
          file,
          key: "IKNOW_SUBAGENT_MAX_CONCURRENT_WORKERS",
        }) ??
        mergedSettings.subagent?.maxConcurrentWorkers ??
        DEFAULT_SUBAGENT_MAX_CONCURRENT_WORKERS,
      ...spreadSubagentModel(subagentModel),
      ...(mergedSettings.subagent?.thinking !== undefined
        ? { thinking: mergedSettings.subagent.thinking }
        : {}),
      ...(mergedSettings.subagent?.thinkingEffort !== undefined
        ? { thinkingEffort: mergedSettings.subagent.thinkingEffort }
        : {}),
    },
    // Workspace-root per-root state anchor (registered at env SSOT;
    // `envOptional` canonical reader — empty/unset → undefined; the consumer
    // resolver type-validates relative paths / missing directories).
    workspaceRoot: envOptional({
      file,
      key: WORKSPACE_ROOT_ENV_KEY,
    }),
    // Project identity root. Same envOptional discipline as workspaceRoot
    // (empty/unset → undefined); consumed by subagent worker identity discovery.
    productRoot: envOptional({
      file,
      key: PRODUCT_ROOT_ENV_KEY,
    }),
    loop: {
      detectToolLoop:
        envOptionalBool({
          file,
          key: "IKNOW_TOOL_LOOP_DETECTION",
        }) ??
        mergedSettings.loop?.detectToolLoop ??
        true,
    },
  };
}
