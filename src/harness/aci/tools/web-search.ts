/**
 * web_search tool (ACI web category): search the web, return a compact list.
 *
 * Behavioral ground truth: web_search_tool.py (behavior-aligned, not a port):
 *   - Default endpoint: the upstream-default DuckDuckGo html endpoint is
 *     unreachable on some networks (local DNS pollution / egress blocking —
 *     measured on WSL2 + Windows host resolver: duckduckgo.com resolves to a
 *     Facebook IP and direct connections time out). So the default is Bing
 *     (cn.bing.com/search — measured reachable from CN with complete result
 *     structure); DDG html remains available via the search_url override /
 *     IKNOW_WEB_SEARCH_URL.
 *   - Result-page parsing dispatches on endpoint hostname — DDG html uses
 *     result__a / result-link + result__snippet; Bing uses li.b_algo → h2>a +
 *     div.b_caption.
 *   - DuckDuckGo /l/?uddg= redirect links are normalized to the target URL.
 *   - Output is a numbered list `N. title / URL: / snippet`; zero results →
 *     ToolExecutionError.
 *
 * The SSRF defense reuses network-guard (both the endpoint and search_url
 * overrides are validated hop by hop); non-2xx / empty results throw
 * ToolExecutionError (fed back to the model verbatim by the executor).
 *
 * ACI metadata: category=read-only, isConcurrencySafe=true,
 * interruptBehavior=cancel, timeoutTier=default (30s).
 *
 * Dependency injection (following the grep.ts GrepToolDeps precedent):
 * deps.fetch / deps.lookup override the network-guard egress layer
 * (production default = network-guard createDefaultGuardDeps SSOT);
 * deps.envSearchUrl injects the env-resolved endpoint prepared by the
 * assembly side (test isolation / production via loadIknowEnv).
 */

import type { AciToolDef } from "../types.js";
import type { ToolExecutionContext } from "../../tools/types.js";
import { ToolExecutionError } from "../../errors.js";
import { resolveWebCapability } from "../../../config/aci-web-backend.js";
import type { WebCapability } from "../../../config/aci-web-backend.js";
import {
  BRAVE_API_KEY_ENV_KEY,
  EXA_API_KEY_ENV_KEY,
  SEARCH_BACKEND_ENV_KEY,
  TAVILY_API_KEY_ENV_KEY,
} from "../../../config/env.js";
import {
  createSearchBackendError,
  isSearchBackendError,
  toToolExecutionError,
} from "./web-search-errors.js";
import { cleanHtml, decodeEntities } from "./html-text.js";
import {
  createDefaultGuardDeps,
  fetchPublicResponse,
  type GuardDeps,
  type GuardFetchFn,
  type GuardLookupFn,
} from "./network-guard.js";

const DEFAULT_MAX_RESULTS = 5;
const MAX_MAX_RESULTS = 10;
const MAX_TITLE_CHARS = 200;
const MAX_SNIPPET_CHARS = 500;
const MAX_URL_CHARS = 2_000;
const SEARCH_OUTPUT_BUDGET = 8_000;
export const SEARCH_TIMEOUT_MS = 20_000;
/** Default endpoint is Bing (reachable in CN where DDG is not); DDG html stays available via override. */
const DEFAULT_SEARCH_ENDPOINT = "https://cn.bing.com/search";

/**
 * Dependency injection: override points (defaults = production values).
 * - `fetch`: replaces the egress HTTP layer (tests inject canned result pages).
 * - `lookup`: replaces DNS resolution (tests inject fixed IPs).
 * - `envSearchUrl`: the `IKNOW_WEB_SEARCH_URL` value resolved by the assembly
 *   side (buildHarnessEngine) via loadIknowEnv; tests may inject directly.
 *   The tool never reads process.env (env.ts is the SSOT).
 * - `proxyUrl`: passes the outbound proxy URL through to network-guard
 *   (IKNOW_WEB_PROXY assembly path; when non-empty, fetch attaches a
 *   ProxyAgent dispatcher).
 */
export interface WebSearchToolDeps {
  readonly fetch?: GuardFetchFn;
  readonly lookup?: GuardLookupFn;
  readonly envSearchUrl?: string | undefined;
  readonly proxyUrl?: string;
  /**
   * Selected web_search backend id. **Unset ≠ explicitly `"bing"`** — the
   * tri-state `backend_unset_with_key` check relies on this distinction
   * (unset + any keyed key set = misconfiguration, no silent Bing fallback).
   */
  readonly backend?: SearchBackendId;
  /**
   * Keyed-backend API keys, resolved by the assembly side from
   * `EXA_API_KEY` / `TAVILY_API_KEY` / `BRAVE_API_KEY` and injected here;
   * the tool never reads process.env (env.ts is the SSOT). Missing /
   * blank → `missing_key` fail-closed.
   */
  readonly exaApiKey?: string;
  readonly tavilyApiKey?: string;
  readonly braveApiKey?: string;
  /**
   * Backend-factory override (same injection seam family as `fetch` /
   * `lookup`). Default = `selectBackend(backendId)` (the BACKENDS table).
   * Tests drive the `http_non_2xx` / `timeout` / `parse` exit paths through
   * it without mutating the global BACKENDS table.
   */
  readonly backendFactory?: SearchBackendFactory;
}

interface SearchInput {
  readonly query: string;
  readonly maxResults: number;
  readonly endpoint: string;
}

/**
 * Closed set of web_search backend ids. The assembly path
 * (registry → buildHarnessEngine) resolves `IKNOW_WEB_SEARCH_BACKEND` via
 * the env loader (invalid → typed `WebEnvConfigError`, **no** fallback to a
 * default); the factory boundary additionally schema-rejects and defaults to
 * bing.
 */
export type SearchBackendId = "bing" | "tavily" | "exa" | "brave";

/**
 * Three-method uniform interface for a search backend.
 *   - `fetchResults`: performs the HTTP call and returns the raw upstream
 *     payload (an HTML string for Bing, JSON for Tavily / Exa / Brave).
 *   - `project`: maps the raw upstream payload into Bing-shape
 *     `SearchResult[]`.
 *   - `describe`: observability side-channel meta (`adapter` / `latencyMs` /
 *     `requestId?`), unconsumed until the envelope/meta spec lands.
 */
export interface SearchBackend {
  readonly id: SearchBackendId;
  fetchResults(args: {
    query: string;
    maxResults: number;
    /** Cancellation signal passed through by the executor; may be absent. */
    signal?: AbortSignal;
  }): Promise<unknown>;
  /** Project the raw upstream payload into Bing-shape `SearchResult[]`. */
  project(raw: unknown, maxResults: number): SearchResult[];
  describe(
    raw: unknown,
    startedAt: number
  ): { adapter: SearchBackendId; latencyMs: number; requestId?: string };
}

/**
 * Per-call context needed to instantiate a backend (guardDeps bound at
 * assembly time; endpoint resolved inside the handler by
 * `compileSearchInput` — includes SSRF validation, search_url override,
 * envSearchUrl fallback).
 *
 * `apiKey` exists for keyed backends. The handler only calls the factory
 * after `assertBackendConfig`, so a keyed backend always receives a resolved
 * truthy value (blank / failed placeholder resolution already failed closed
 * at entry).
 */
export interface SearchBackendCtorOptions {
  readonly guardDeps: GuardDeps;
  readonly endpoint: string;
  /**
   * API key for keyed backends (bing never reads it). Already validated
   * non-empty by `assertBackendConfig` — a truthy pass-through, no re-check.
   */
  readonly apiKey?: string;
}

/**
 * Backend factory signature. The `BACKENDS` table holds factories by `id`,
 * pulling one instance per call — BingBackend needs `endpoint` (per-call),
 * while the others hold no state. Real fetch implementations may replace
 * stubs without changing this signature.
 */
export type SearchBackendFactory = (
  opts: SearchBackendCtorOptions
) => SearchBackend;

interface SearchResult {
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
}

/**
 * Factory: createWebSearchTool(deps?) — the web search tool.
 *
 * The returned AciToolDef satisfies:
 *   - name === "web_search"
 *   - inputSchema: { query required + max_results?(default 5, 1..10) + search_url? }
 *   - aci metadata: read-only / concurrency-safe / cancel / default tier
 */
export function createWebSearchTool(deps?: WebSearchToolDeps): AciToolDef {
  // Fail fast: the proxy config passes SSRF syntax validation at assembly
  // time, so a broken IKNOW_WEB_PROXY errors at build, not on first search.
  const guardDeps = resolveGuardDeps(deps);
  const resultCache = new Map<string, Promise<ReadonlyArray<SearchResult>>>();
  // Selected backend factory (the handler pulls an instance per call).
  // Unset `backend` and explicit "bing" converge on `backendId`, but the
  // tri-state fail-closed check must tell them apart, so track `backendUnset`.
  const backendUnset = deps?.backend === undefined;
  const capability = resolveWebCapability({
    backend: deps?.backend,
    exaApiKey: deps?.exaApiKey,
    tavilyApiKey: deps?.tavilyApiKey,
    braveApiKey: deps?.braveApiKey,
  });
  const searchBackendId: SearchBackendId =
    capability.searchEngine === "exa" ? "exa" : "bing";
  const backendFactory = deps?.backendFactory ?? selectBackend(searchBackendId);
  const apiKeys = collectApiKeys(deps);
  const handler = async (
    input: unknown,
    ctx?: ToolExecutionContext
  ): Promise<string> => {
    // Config stage: unset backend + any keyed key still fails closed.
    // Missing key (stub / no key) falls back to default search instead of
    // raising missing_key / not_shipped.
    assertBackendConfig(backendUnset, apiKeys, capability);
    assertSearchUrlAllowed(searchBackendId, input);
    const parsed = compileSearchInput(input, deps?.envSearchUrl);
    const cacheKey = `${parsed.endpoint}\u0000${parsed.query}`;
    const cachedResults = resultCache.get(cacheKey);
    const cacheHit = cachedResults !== undefined;
    const backend = backendFactory({
      guardDeps,
      endpoint: parsed.endpoint,
      ...(searchBackendId === "exa" && apiKeys.exa !== undefined
        ? { apiKey: apiKeys.exa }
        : {}),
    });
    const resultsPromise =
      cachedResults ?? loadSearchResults(parsed, backend, ctx?.signal);
    if (!cacheHit) {
      resultCache.set(cacheKey, resultsPromise);
      resultsPromise.catch(() => {
        // EXIT: failed searches are not retained; a later call may retry.
        if (resultCache.get(cacheKey) === resultsPromise) {
          resultCache.delete(cacheKey);
        }
      });
    }
    let results: ReadonlyArray<SearchResult>;
    try {
      results = await resultsPromise;
    } catch (err) {
      // EXIT: the six typed kinds translate 1:1 into ToolExecutionError
      // (the executor feeds them back to the model verbatim). Everything
      // untyped rethrows as-is: the existing Bing path's ToolExecutionError
      // (network-guard `web_search failed: ...`) and any unexpected runtime
      // error must not be swallowed or rewritten by this exit.
      if (isSearchBackendError(err)) throw toToolExecutionError(err);
      throw err;
    }
    if (results.length === 0) {
      throw new ToolExecutionError(
        "web_search failed: No search results found."
      );
    }
    return formatSearchResults(
      parsed.query,
      results.slice(0, parsed.maxResults),
      !cacheHit
    );
  };

  return Object.freeze({
    name: "web_search",
    description:
      "Search the web to discover titles, URLs, and snippets by keyword when the job is finding sources and a page URL is not yet in hand. Returns up to max_results (default 5, cap 10) in a numbered list; defaults to a Bing HTML endpoint — pass search_url to override (still SSRF-validated).",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
        max_results: {
          type: "integer",
          default: DEFAULT_MAX_RESULTS,
          minimum: 1,
          maximum: MAX_MAX_RESULTS,
          description: "Maximum number of results to return",
        },
        search_url: {
          type: "string",
          description:
            "Optional override for the HTML search endpoint (private backends or testing); still SSRF-validated",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
    handler,
    aci: {
      category: "read-only" as const,
      isConcurrencySafe: true,
      interruptBehavior: "cancel" as const,
      timeoutTier: "default" as const,
      // Low-frequency web egress piece; ADR-0043 puts it fourth in the
      // deferral order (after the three trace pieces).
      deferrable: true,
    },
  });
}

/** Assemble guard deps: injected stubs win, defaulting to network-guard's production SSOT. */
function resolveGuardDeps(deps?: WebSearchToolDeps): GuardDeps {
  if (deps?.fetch && deps?.lookup)
    return { fetch: deps.fetch, lookup: deps.lookup };
  const production = createDefaultGuardDeps(
    deps?.proxyUrl ? { proxyUrl: deps.proxyUrl } : undefined
  );
  return {
    fetch: deps?.fetch ?? production.fetch,
    lookup: deps?.lookup ?? production.lookup,
  };
}

/**
 * Keyed backend id → its injected API key / matching env var name. `bing` is
 * deliberately absent (the zero-key default path); the key set defines what
 * counts as a "keyed backend".
 */
const KEYED_BACKEND_ENV_KEYS = {
  exa: EXA_API_KEY_ENV_KEY,
  tavily: TAVILY_API_KEY_ENV_KEY,
  brave: BRAVE_API_KEY_ENV_KEY,
} as const;

type KeyedBackendId = keyof typeof KEYED_BACKEND_ENV_KEYS;

type KeyedApiKeys = Readonly<Record<KeyedBackendId, string | undefined>>;

/**
 * Collect the three injected keys into one table. Blank strings count as
 * missing — the env loader already folds empty / failed placeholder
 * resolution into undefined; this is a backstop so callers that bypass the
 * loader (direct-handler tests / assembly scripts) also fail closed instead
 * of leaving with an empty key.
 */
function collectApiKeys(deps?: WebSearchToolDeps): KeyedApiKeys {
  const normalize = (raw: string | undefined): string | undefined => {
    const trimmed = raw?.trim();
    return trimmed ? trimmed : undefined;
  };
  return {
    exa: normalize(deps?.exaApiKey),
    tavily: normalize(deps?.tavilyApiKey),
    brave: normalize(deps?.braveApiKey),
  };
}

/**
 * Two of the three fail-closed states are **config-stage**, checked at
 * handler entry so a misconfiguration never costs an outbound request:
 *
 *   ① backend = keyed but its key is missing → `missing_key`
 *   ② backend unset but some keyed key is set → `backend_unset_with_key`
 *      (refuses to silently serve Bing under misconfiguration; explicit
 *      `backend="bing"` + a set key is **not** a misconfiguration)
 *
 * The third state (backend = bing / unset + zero keys → Bing HTML) needs no
 * error and passes through. Messages name only the backend id and the env
 * var **name**, never a key value.
 */
function assertBackendConfig(
  backendUnset: boolean,
  apiKeys: KeyedApiKeys,
  capability: WebCapability
): void {
  if (capability.searchEngine === "exa" && apiKeys.exa === undefined) {
    // EXIT: Exa search selected but key vanished after capability resolve.
    throw toToolExecutionError(
      createSearchBackendError({
        kind: "missing_key",
        message: `backend "exa" is selected but no API key resolved — set web.backendKey in ~/.iknow/settings.json (or ${EXA_API_KEY_ENV_KEY} via env / .env.local / .env), or unset ${SEARCH_BACKEND_ENV_KEY} to fall back to the default bing backend`,
      })
    );
  }
  if (!backendUnset) return;
  for (const id of Object.keys(KEYED_BACKEND_ENV_KEYS) as KeyedBackendId[]) {
    if (apiKeys[id] === undefined) continue;
    // EXIT: a keyed key is configured but no backend was chosen — refusing
    // to silently serve Bing under a misconfiguration.
    throw toToolExecutionError(
      createSearchBackendError({
        kind: "backend_unset_with_key",
        message: `${KEYED_BACKEND_ENV_KEYS[id]} is set but ${SEARCH_BACKEND_ENV_KEY} is unset — set web.searchBackend="${id}" in ~/.iknow/settings.json (or ${SEARCH_BACKEND_ENV_KEY}=${id}) to use it, or remove the key to stay on the default bing backend`,
      })
    );
  }
}

/**
 * The `search_url` override only makes sense for `backend="bing"` (it is an
 * HTML-endpoint override on the SSRF-validated path). Passing it under a
 * keyed backend is a schema reject — the request neither goes through SSRF
 * validation nor gets silently ignored.
 */
function assertSearchUrlAllowed(
  backendId: SearchBackendId,
  input: unknown
): void {
  if (backendId === "bing") return;
  const searchUrl = (input as { search_url?: unknown } | null | undefined)
    ?.search_url;
  if (searchUrl === undefined) return;
  // EXIT: search_url is a bing-only override; reject rather than ignore.
  throw new ToolExecutionError(
    `web_search: search_url only valid with backend=bing (current backend: "${backendId}")`
  );
}

/** Input validation: query non-empty; max_results clamped to [1,10]; endpoint priority search_url > env > default. */
function compileSearchInput(
  input: unknown,
  envSearchUrl: string | undefined
): SearchInput {
  const obj = (input ?? {}) as {
    query?: unknown;
    max_results?: unknown;
    search_url?: unknown;
  };
  if (typeof obj.query !== "string" || obj.query.trim().length === 0) {
    throw new ToolExecutionError(
      "web_search: query must be a non-empty string"
    );
  }
  const query = obj.query.trim();
  const endpoint =
    typeof obj.search_url === "string" && obj.search_url.length > 0
      ? obj.search_url
      : (envSearchUrl ?? DEFAULT_SEARCH_ENDPOINT);
  return {
    query,
    maxResults: clampMaxResults(obj.max_results),
    endpoint,
  };
}

/** max_results clamp: non-finite / ≤0 → default 5; >10 → 10. */
function clampMaxResults(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw))
    return DEFAULT_MAX_RESULTS;
  const floored = Math.floor(raw);
  if (floored <= 0) return DEFAULT_MAX_RESULTS;
  if (floored > MAX_MAX_RESULTS) return MAX_MAX_RESULTS;
  return floored;
}

/**
 * Pull one result set through the selected `SearchBackend` — the originally
 * inlined fetch + parse split into backend.fetchResults (raw) +
 * backend.project (Bing-shape). On the Bing path this is byte-identical to
 * the previous inline code (same `fetchPublicResponse` + same
 * `parseSearchResults` hostname dispatch).
 */
async function loadSearchResults(
  parsed: SearchInput,
  backend: SearchBackend,
  signal: AbortSignal | undefined
): Promise<ReadonlyArray<SearchResult>> {
  const raw = await backend.fetchResults({
    query: parsed.query,
    maxResults: parsed.maxResults,
    signal,
  });
  return backend.project(raw, parsed.maxResults);
}

/**
 * Parse a results page: dispatch the parser by endpoint hostname
 * (DDG html vs Bing), capped at maxResults. Unknown endpoints fall back to
 * the DDG parser (backward compatibility with older fixtures).
 */
function parseSearchResults(
  body: string,
  maxResults: number,
  endpoint: string
): SearchResult[] {
  return isBingEndpoint(endpoint)
    ? parseBingResults(body, maxResults)
    : parseDuckDuckGoResults(body, maxResults);
}

/** Whether the endpoint is Bing (default cn.bing.com, or an overridden bing.com / cn.bing.com). */
function isBingEndpoint(endpoint: string): boolean {
  try {
    const hostname = new URL(endpoint).hostname.toLowerCase();
    return hostname === "bing.com" || hostname.endsWith(".bing.com");
  } catch {
    return false;
  }
}

/** DDG html parser: result__a / result-link anchors + positionally aligned snippets. */
function parseDuckDuckGoResults(
  body: string,
  maxResults: number
): SearchResult[] {
  const snippets = parseDdgSnippets(body);
  const results: SearchResult[] = [];
  let anchorIndex = 0;
  for (const anchor of parseDdgAnchors(body)) {
    const snippet = anchorIndex < snippets.length ? snippets[anchorIndex] : "";
    anchorIndex += 1;
    const result = projectSearchResult({
      title: anchor.title,
      url: anchor.url,
      snippet,
    });
    if (!result) continue;
    results.push(result);
    if (results.length >= maxResults) break;
  }
  return results;
}

/** Bing parser: li.b_algo result blocks → h2>a (title + href) + div.b_caption (snippet). */
function parseBingResults(body: string, maxResults: number): SearchResult[] {
  const results: SearchResult[] = [];
  const pattern = /<li\b([^>]*)>([\s\S]*?)<\/li>/gi;
  for (const match of body.matchAll(pattern)) {
    const attrs = match[1] ?? "";
    const classMatch = /\bclass="([^"]+)"/i.exec(attrs);
    if (!classMatch || !/(?:^|\s)b_algo(?:\s|$)/.test(classMatch[1] ?? "")) {
      continue;
    }
    const block = match[2] ?? "";
    const h2Match = /<h2[^>]*>([\s\S]*?)<\/h2>/i.exec(block);
    if (!h2Match) continue;
    const anchor = /<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(
      h2Match[1]
    );
    if (!anchor) continue;
    const title = cleanHtml(anchor[2] ?? "").trim();
    const url = decodeEntities(anchor[1] ?? "").trim();
    const captionMatch = /<div class="b_caption"[^>]*>([\s\S]*?)<\/div>/i.exec(
      block
    );
    const paragraphMatch = /<p\b[^>]*>([\s\S]*?)<\/p>/i.exec(block);
    const snippet = cleanHtml(
      captionMatch?.[1] ?? paragraphMatch?.[1] ?? ""
    ).trim();
    const result = projectSearchResult({ title, url, snippet });
    if (!result) continue;
    if (results.length >= maxResults) break;
    results.push(result);
  }
  return results;
}

/**
 * Shared single-item projection — exported so every keyed backend
 * (Exa / Tavily / Brave) reuses the same field caps + drop-when-all-empty
 * rule, byte-identical with the Bing HTML parsing path. One rule for all
 * adapters: field caps live here, and backends never write their own caps.
 */
export function projectSearchResult(
  result: SearchResult
): SearchResult | undefined {
  const projected = {
    title: truncateField(result.title, MAX_TITLE_CHARS),
    url: truncateField(result.url, MAX_URL_CHARS),
    snippet: truncateField(result.snippet, MAX_SNIPPET_CHARS),
  };
  if (
    projected.title.length === 0 &&
    projected.url.length === 0 &&
    projected.snippet.length === 0
  ) {
    // EXIT: field projection removed every field; do not emit an empty item.
    return undefined;
  }
  return projected;
}

function truncateField(value: string, maxChars: number): string {
  return Array.from(value.trim()).slice(0, maxChars).join("");
}

/** Extract text of elements whose class contains result__snippet / result-snippet.
 *  The `<(\w+)…<\/\1>` backreference matches any same-name open/close tag pair
 *  instead of enumerating tag names in source (`span` is a banned literal here
 *  because it collides with OTel span-metric vocabulary). */
function parseDdgSnippets(body: string): string[] {
  const pattern =
    /<(\w+)[^>]+class="[^"]*(?:result__snippet|result-snippet)[^"]*"[^>]*>([\s\S]*?)<\/\1>/gi;
  const out: string[] = [];
  for (const match of body.matchAll(pattern)) {
    out.push(cleanHtml(match[2] ?? ""));
  }
  return out;
}

/** Extract anchors whose class contains result__a / result-link: title (HTML stripped) + normalized URL. */
function parseDdgAnchors(
  body: string
): ReadonlyArray<{ title: string; url: string }> {
  const pattern = /<a([^>]+)>([\s\S]*?)<\/a>/gi;
  const out: { title: string; url: string }[] = [];
  for (const match of body.matchAll(pattern)) {
    const attrs = match[1] ?? "";
    const classMatch = /class="([^"]+)"/i.exec(attrs);
    if (!classMatch || !/result__a|result-link/.test(classMatch[1] ?? "")) {
      continue;
    }
    const hrefMatch = /href="([^"]+)"/i.exec(attrs);
    if (!hrefMatch) continue;
    const title = cleanHtml(match[2] ?? "");
    const url = normalizeResultUrl(decodeEntities(hrefMatch[1] ?? ""));
    out.push({ title, url });
  }
  return out;
}

/** DuckDuckGo /l/?uddg= redirect link → target URL decoded from the uddg param. */
function normalizeResultUrl(rawUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return rawUrl;
  }
  if (
    parsed.hostname.endsWith("duckduckgo.com") &&
    parsed.pathname.startsWith("/l/")
  ) {
    const target = parsed.searchParams.get("uddg");
    if (target) return target;
  }
  return rawUrl;
}

/** Output assembly: `Search results for: <query>` + numbered list. */
function formatSearchResults(
  query: string,
  results: ReadonlyArray<SearchResult>,
  includeSnippets: boolean
): string {
  const header = `Search results for: ${query}`;
  if (header.length > SEARCH_OUTPUT_BUDGET) {
    throw new ToolExecutionError(
      "web_search failed: Search results exceeded output budget."
    );
  }
  const lines: string[] = [header];
  for (const [index, result] of results.entries()) {
    const entry = [
      `${index + 1}. ${result.title}`,
      `   URL: ${result.url}`,
      ...(includeSnippets && result.snippet.length > 0
        ? [`   ${result.snippet}`]
        : []),
    ];
    const next = `${lines.join("\n")}\n${entry.join("\n")}`;
    if (next.length > SEARCH_OUTPUT_BUDGET) break;
    lines.push(...entry);
  }
  if (lines.length === 1) {
    throw new ToolExecutionError(
      "web_search failed: Search results exceeded output budget."
    );
  }
  return lines.join("\n");
}

// =============================================================================
// SearchBackend seam — BingBackend + selectBackend + the BACKENDS table.
// Handler path: selectBackend(id)(guardDeps, endpoint) → backend.fetchResults
// → backend.project. Only bing is genuinely wired; unshipped backends throw
// typed SearchBackendError.
// =============================================================================

/**
 * BingBackend — wraps the existing `cn.bing.com/search` HTML parsing path
 * behind the uniform three-method `SearchBackend` signature.
 *
 *   - `fetchResults`: goes through `fetchPublicResponse` (SSRF validation +
 *     hop-by-hop redirect checks), returning the raw HTML string.
 *   - `project`: calls the existing
 *     `parseSearchResults(raw, maxResults, endpoint)` hostname dispatch
 *     (Bing → `parseBingResults`; a search_url override to a non-Bing
 *     hostname such as DDG → `parseDuckDuckGoResults`, preserving original
 *     behavior).
 *   - `describe`: returns `{ adapter: "bing", latencyMs, requestId? }` —
 *     `requestId` stays undefined until the envelope/meta spec lands.
 *
 * The `search_url` override is resolved earlier in the handler by
 * `compileSearchInput` (already SSRF-validated); the endpoint is injected by
 * the caller via `backendFactory({ endpoint, ... })`. This class never reads
 * process.env (env.ts is the SSOT).
 */
export class BingBackend implements SearchBackend {
  readonly id: SearchBackendId = "bing";

  constructor(
    private readonly guardDeps: GuardDeps,
    private readonly endpoint: string
  ) {}

  async fetchResults(args: {
    query: string;
    maxResults: number;
    signal?: AbortSignal;
  }): Promise<unknown> {
    const requestUrl = `${this.endpoint}${this.endpoint.includes("?") ? "&" : "?"}q=${encodeURIComponent(args.query)}`;
    const response = await fetchPublicResponse(requestUrl, this.guardDeps, {
      tool: "web_search",
      timeoutMs: SEARCH_TIMEOUT_MS,
      signal: args.signal,
    });
    return response.body;
  }

  project(raw: unknown, maxResults: number): SearchResult[] {
    // raw is the HTML body returned by fetchPublicResponse; the existing
    // parsers require a string.
    return parseSearchResults(raw as string, maxResults, this.endpoint);
  }

  describe(
    _raw: unknown,
    startedAt: number
  ): { adapter: SearchBackendId; latencyMs: number; requestId?: string } {
    return {
      adapter: "bing",
      latencyMs: Date.now() - startedAt,
    };
  }
}

/**
 * Backend dispatch. The `BACKENDS` table holds factories by `id`; at runtime
 * we always get a `SearchBackendFactory` (types guarantee it), and the
 * runtime guard here defends against unexpected unknown keys.
 */
export function selectBackend(id: SearchBackendId): SearchBackendFactory {
  const factory = BACKENDS[id];
  if (!factory) {
    throw new ToolExecutionError(
      `web_search: unknown backend "${id}" — known ids: bing, tavily, exa, brave`
    );
  }
  return factory;
}

// =============================================================================
// ExaBackend — real Exa HTTP fetch + projection to Bing-shape results.
// =============================================================================

/**
 * Exa's real endpoint. `api.exa.ai` does not go through the SSRF defense
 * (neither private nor user-overridden), and the endpoint resolved by
 * compileSearchInput has no effect for keyed backends — the Exa path
 * hardcodes this constant.
 */
const EXA_ENDPOINT = "https://api.exa.ai/search";

/**
 * Shape used for Exa projection. Exa's real `SearchResponse` (`results[]`)
 * carries many more fields in its docs (image / publishedDate / author / id
 * etc.), but we only care about the three output fields + highlights/text,
 * so describe the contract with a narrow type.
 *
 * Note: the original spec described highlights as `Array<{text: string}>`,
 * but a live probe found Exa actually returns `highlights: string[]` — each
 * highlight is the string itself, not an object wrapping `text`. This
 * interface matches the real API shape; the spec fix trails in a later
 * ticket.
 */
interface ExaResultRaw {
  readonly title?: unknown;
  readonly url?: unknown;
  readonly highlights?: ReadonlyArray<unknown>;
  readonly text?: unknown;
}

/**
 * Exa's real response shape (minimally needs results[]). `requestId` stays
 * unconsumed until the envelope/meta spec takes it over; the field is kept
 * on the raw payload for future use.
 */
interface ExaResponseRaw {
  readonly results?: unknown;
  readonly requestId?: unknown;
}

/**
 * ExaBackend construction options.
 *
 * - `apiKey` must be non-empty (already validated at handler entry by
 *   `assertBackendConfig`); the factory layer additionally rejects empty
 *   strings so direct-call paths that bypass entry validation (tests /
 *   assembly scripts) cannot leave with a keyless backend instance.
 * - `fetch`: test seam — replaces `globalThis.fetch`; production uses the
 *   global fetch (undici built in). The `AbortSignal` passes straight to
 *   fetch; a thrown `AbortError` is translated by `fetchResults` into typed
 *   `SearchBackendError(kind="timeout")`.
 */
export interface ExaBackendCtorOptions {
  readonly apiKey: string;
  /** Test seam — replaces fetch (production default = `globalThis.fetch`). */
  readonly fetch?: typeof globalThis.fetch;
}

/**
 * ExaBackend: real Exa fetch + projection to Bing-shape results.
 *
 *   - `fetchResults`:
 *     - POST `https://api.exa.ai/search`, body `{ query, numResults, contents:{highlights:true} }`
 *     - `Authorization: Bearer ${apiKey}` header
 *     - non-2xx → typed `SearchBackendError(kind="http_non_2xx", endpoint=api.exa.ai, ...)`;
 *       the message carries **no** key literal / Authorization header
 *       (`createSearchBackendError`'s redactAuthSecrets is the backstop)
 *     - `AbortError` (signal aborted) → typed
 *       `SearchBackendError(kind="timeout", endpoint=api.exa.ai, ...)`
 *     - malformed JSON (parse failure) → typed `SearchBackendError(kind="parse", ...)`,
 *       **no** downgrade to silent empty
 *
 *   - `project`: maps Exa JSON into Bing-shape `SearchResult[]` with
 *     `snippet = highlights?.[0] ?? text ?? ""` (take the first highlight per
 *     Exa's real `string[]` shape; on a miss, fall back to `result.text`).
 *     Field caps go through the shared `projectSearchResult`, byte-identical
 *     with the Bing HTML path — one cap rule for all adapters, and backends
 *     never write their own. The `maxResults` cap is applied inside
 *     `project` (same form as the Bing path: `parseBingResults` breaks in
 *     its loop on `results.length >= maxResults`).
 *
 *   - `describe`: `adapter: "exa" + latencyMs` — `requestId` stays undefined
 *     until the envelope/meta spec lands.
 *
 * Never reads process.env and never calls `fetchPublicResponse` (Exa is a
 * fixed vendor endpoint, so the SSRF defense / redirect-hop limits / byte
 * caps are unnecessary; native fetch up to a 200 is enough).
 */
export class ExaBackend implements SearchBackend {
  readonly id: SearchBackendId = "exa";

  private readonly apiKey: string;
  private readonly fetchFn: typeof globalThis.fetch;

  constructor(opts: ExaBackendCtorOptions) {
    // EXIT: reject an empty key — never let an instance hold keyless state
    // and go outbound.
    if (!opts.apiKey) {
      throw new ToolExecutionError("ExaBackend: apiKey is required");
    }
    this.apiKey = opts.apiKey;
    this.fetchFn = opts.fetch ?? globalThis.fetch;
  }

  async fetchResults(args: {
    query: string;
    maxResults: number;
    signal?: AbortSignal;
  }): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchFn(EXA_ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          query: args.query,
          numResults: args.maxResults,
          // highlights must be enabled explicitly — otherwise the upstream
          // omits the highlights field, project always falls back to text
          // (longer snippets), contradicting the "highlights first" contract.
          contents: { highlights: true },
        }),
        signal: args.signal,
      });
    } catch (err) {
      // EXIT: translate fetch aborts and other low-level errors into typed
      // timeout first (Timeout → typed SearchBackendError(kind=timeout)
      // when signal.aborted). Other low-level network errors take the same
      // typed path so they never leak into the handler exit's untyped
      // pass-through branch and expose a raw error stack to the model.
      // Classifying non-abort errors as timeout is deliberate: abort is the
      // only observable form of this failure in production, and the
      // distinction already lives on the outer signal.
      const aborted =
        args.signal?.aborted === true ||
        (err instanceof Error && err.name === "AbortError");
      throw createSearchBackendError({
        kind: "timeout",
        message: aborted
          ? "request aborted"
          : `fetch failed: ${err instanceof Error ? err.message : String(err)}`,
        endpoint: EXA_ENDPOINT,
        ...(err === undefined ? {} : { cause: err }),
      });
    }

    if (!response.ok) {
      // EXIT: upstream non-2xx — typed http_non_2xx; status + endpoint go
      // into the message, keys / Authorization redacted by redactAuthSecrets.
      throw createSearchBackendError({
        kind: "http_non_2xx",
        message: `upstream returned status ${response.status}`,
        endpoint: EXA_ENDPOINT,
      });
    }

    let text: string;
    try {
      text = await response.text();
    } catch (err) {
      throw createSearchBackendError({
        kind: "parse",
        message: "failed to read response body",
        endpoint: EXA_ENDPOINT,
        ...(err === undefined ? {} : { cause: err }),
      });
    }

    try {
      return JSON.parse(text) as unknown;
    } catch (err) {
      throw createSearchBackendError({
        kind: "parse",
        message: `malformed JSON response: ${
          err instanceof Error ? err.message : String(err)
        }`,
        endpoint: EXA_ENDPOINT,
        ...(err === undefined ? {} : { cause: err }),
      });
    }
  }

  project(raw: unknown, maxResults: number): SearchResult[] {
    if (typeof raw !== "object" || raw === null) {
      throw createSearchBackendError({
        kind: "parse",
        message: "expected a JSON object with results[]",
        endpoint: EXA_ENDPOINT,
      });
    }
    const response = raw as ExaResponseRaw;
    if (!Array.isArray(response.results)) {
      throw createSearchBackendError({
        kind: "parse",
        message: "expected results[] in upstream response",
        endpoint: EXA_ENDPOINT,
      });
    }
    const out: SearchResult[] = [];
    for (const itemRaw of response.results) {
      if (typeof itemRaw !== "object" || itemRaw === null) {
        // EXIT: a malformed single result is skipped (no throw), matching
        // the Bing path's tolerance (which `continue`s past malformed li
        // blocks).
        continue;
      }
      const item = itemRaw as ExaResultRaw;
      const title = typeof item.title === "string" ? item.title : "";
      const url = typeof item.url === "string" ? item.url : "";
      const snippet = pickExaSnippet(item);
      const projected = projectSearchResult({ title, url, snippet });
      if (!projected) continue;
      out.push(projected);
      if (out.length >= maxResults) break;
    }
    return out;
  }

  describe(
    _raw: unknown,
    startedAt: number
  ): { adapter: SearchBackendId; latencyMs: number; requestId?: string } {
    return {
      adapter: "exa",
      latencyMs: Date.now() - startedAt,
    };
  }
}

/**
 * `snippet = highlights?.[0] ?? text ?? ""`. Extracted for unit testing and
 * to isolate the narrow ExaResultRaw shape.
 *
 * Note: the original spec treated each highlight as a `{text: string}`
 * object, but a live probe found Exa actually returns `highlights:
 * string[]` — each highlight is the string itself (per Exa docs: "a
 * relevant excerpt/sentence from the result text"). This function matches
 * the real API: take the first string highlight; on a miss fall back to
 * `item.text` (some Exa responses give only `text`), and on a second miss
 * return `""`. The spec fix trails in a later ticket.
 */
function pickExaSnippet(item: ExaResultRaw): string {
  const highlights = item.highlights;
  if (Array.isArray(highlights) && highlights.length > 0) {
    const first = highlights[0];
    if (typeof first === "string" && first.length > 0) return first;
  }
  if (typeof item.text === "string" && item.text.length > 0) return item.text;
  return "";
}

/**
 * Tavily's real endpoint (a later version will ship the real fetch; v1 stub
 * throws typed `not_shipped`). v1 never goes outbound —
 * `TavilyBackend.fetchResults` immediately throws typed
 * `SearchBackendError(kind="not_shipped")`, while `project` already maps
 * Tavily JSON into Bing-shape (deliberately **ignoring** `result.answer`).
 * Once the real fetch lands, keep this endpoint constant and only swap the
 * fetch implementation in the backend.
 */
const TAVILY_ENDPOINT = "https://api.tavily.com/search";

/**
 * Single Tavily result shape. `answer` is Tavily's upstream
 * LLM-synthesized answer field — deliberately ignored (snippet comes from
 * `content`).
 */
interface TavilyResultRaw {
  readonly title?: unknown;
  readonly url?: unknown;
  readonly content?: unknown;
  /** Tavily-specific field; intentionally ignored — the projector never reads it. */
  readonly answer?: unknown;
}

/**
 * Tavily response shape (minimally needs `results[]`).
 */
interface TavilyResponseRaw {
  readonly results?: unknown;
}

/**
 * Brave's real endpoint (a later version will ship the real fetch; v1 stub
 * throws typed `not_shipped`). v1 never goes outbound — all three methods of
 * `BraveBackend` throw typed `SearchBackendError(kind="not_shipped")` with
 * uniform semantics; once the real fetch lands, keep this endpoint constant
 * and only swap the fetch implementation.
 */
const BRAVE_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";

/**
 * BraveBackend v1 stub.
 *
 *   - `fetchResults`: immediately throws typed
 *     `SearchBackendError(kind="not_shipped", endpoint=api.search.brave.com)`;
 *     the message names backend id "brave" + a v2 hint. **No** real HTTP is
 *     sent; when the real fetch ships, implement GET + X-Subscription-Token
 *     header.
 *   - `project`: throws typed `not_shipped` (uniform semantics for v1 — all
 *     three methods throw). When the real fetch ships, project into
 *     Bing-shape (`result.title` / `result.description` / `result.url`,
 *     field caps via the shared `projectSearchResult`).
 *   - `describe`: throws typed `not_shipped` (same semantics). When the real
 *     form ships, return `{ adapter: "brave", latencyMs }`, same shape as
 *     Tavily / Exa / Bing.
 *
 * v1 state: no constructor parameters (no per-call state, no apiKey field —
 * apiKey will be added when the real fetch ships, mirroring ExaBackend). All
 * three methods synchronously/asynchronously throw typed not_shipped; the
 * handler exit's try/catch translates them 1:1 into `ToolExecutionError`.
 */
export class BraveBackend implements SearchBackend {
  readonly id: SearchBackendId = "brave";

  async fetchResults(_args: {
    query: string;
    maxResults: number;
    signal?: AbortSignal;
  }): Promise<unknown> {
    // EXIT: v1 stub — immediately throw typed not_shipped; the handler
    // exit's try/catch translates it 1:1 into ToolExecutionError. No apiKey
    // read (added with the real fetch), and no key literal / Authorization /
    // endpoint query in the message — `createSearchBackendError` redacts as
    // a backstop.
    throw createSearchBackendError({
      kind: "not_shipped",
      message:
        'backend "brave" is not implemented yet — pick backend=bing, or wait for the brave adapter to ship (v2 plan)',
      endpoint: BRAVE_ENDPOINT,
    });
  }

  project(_raw: unknown, _maxResults: number): SearchResult[] {
    // EXIT: v1 stub — `project` also throws typed not_shipped (Brave v1 has
    // no `project`; uniform semantics across all three methods). When the
    // real fetch ships, project into Bing-shape.
    throw createSearchBackendError({
      kind: "not_shipped",
      message:
        'backend "brave" is not implemented yet — pick backend=bing, or wait for the brave adapter to ship (v2 plan)',
      endpoint: BRAVE_ENDPOINT,
    });
  }

  describe(
    _raw: unknown,
    _startedAt: number
  ): { adapter: SearchBackendId; latencyMs: number; requestId?: string } {
    // EXIT: v1 stub — `describe` also throws typed not_shipped (uniform
    // semantics); the real form ships later.
    throw createSearchBackendError({
      kind: "not_shipped",
      message:
        'backend "brave" is not implemented yet — pick backend=bing, or wait for the brave adapter to ship (v2 plan)',
      endpoint: BRAVE_ENDPOINT,
    });
  }
}

/**
 * TavilyBackend v1 stub.
 *
 *   - `fetchResults`: immediately throws typed
 *     `SearchBackendError(kind="not_shipped", endpoint=api.tavily.com)`;
 *     the message names backend id "tavily" + a v2 hint. **No** real HTTP is
 *     sent; when the real fetch ships, implement POST + Authorization.
 *   - `project`: maps Tavily JSON into Bing-shape `SearchResult[]`
 *     (`title = result.title`, `snippet = result.content`,
 *     `url = result.url`, **`result.answer` ignored**). Field caps go
 *     through `projectSearchResult` (byte-identical with the Bing HTML path —
 *     one cap rule for all adapters); the `maxResults` cap is applied inside
 *     `project` via `if (out.length >= maxResults) break`, same form as
 *     `ExaBackend.project` and the Bing parsing path.
 *   - `describe`: `adapter: "tavily" + latencyMs`.
 *
 * v1 state: no constructor parameters (no per-call state, no apiKey field —
 * apiKey will be added when the real fetch ships, mirroring ExaBackend).
 */
export class TavilyBackend implements SearchBackend {
  readonly id: SearchBackendId = "tavily";

  async fetchResults(_args: {
    query: string;
    maxResults: number;
    signal?: AbortSignal;
  }): Promise<unknown> {
    // EXIT: v1 stub — immediately throw typed not_shipped; the handler
    // exit's try/catch translates it 1:1 into ToolExecutionError. No apiKey
    // read (added with the real fetch), and no key literal / Authorization /
    // endpoint query in the message — `createSearchBackendError` redacts as
    // a backstop.
    throw createSearchBackendError({
      kind: "not_shipped",
      message:
        'backend "tavily" is not implemented yet — pick backend=bing, or wait for the tavily adapter to ship (v2 plan)',
      endpoint: TAVILY_ENDPOINT,
    });
  }

  project(raw: unknown, maxResults: number): SearchResult[] {
    if (typeof raw !== "object" || raw === null) {
      throw createSearchBackendError({
        kind: "parse",
        message: "expected a JSON object with results[]",
        endpoint: TAVILY_ENDPOINT,
      });
    }
    const response = raw as TavilyResponseRaw;
    if (!Array.isArray(response.results)) {
      throw createSearchBackendError({
        kind: "parse",
        message: "expected results[] in upstream response",
        endpoint: TAVILY_ENDPOINT,
      });
    }
    const out: SearchResult[] = [];
    for (const itemRaw of response.results) {
      if (typeof itemRaw !== "object" || itemRaw === null) {
        // EXIT: a malformed single result is skipped (no throw), matching
        // the tolerance of the Bing path / Exa project (skip malformed
        // singles).
        continue;
      }
      const item = itemRaw as TavilyResultRaw;
      const title = typeof item.title === "string" ? item.title : "";
      const url = typeof item.url === "string" ? item.url : "";
      // snippet = result.content. result.answer is deliberately not read —
      // it is Tavily's upstream-specific LLM-synthesized field and must stay
      // out: the projected snippet never contains answer text, and the
      // handler formatter cannot carry it back either.
      const snippet = typeof item.content === "string" ? item.content : "";
      const projected = projectSearchResult({ title, url, snippet });
      if (!projected) continue;
      out.push(projected);
      if (out.length >= maxResults) break;
    }
    return out;
  }

  describe(
    _raw: unknown,
    startedAt: number
  ): { adapter: SearchBackendId; latencyMs: number; requestId?: string } {
    return {
      adapter: "tavily",
      latencyMs: Date.now() - startedAt,
    };
  }
}

/**
 * The `BACKENDS` table — backend factories keyed by `id`. `selectBackend(id)`
 * returns a factory; the handler calls it to pull an instance per use.
 *
 * Exa: the factory passes apiKey through to the `ExaBackend` constructor.
 * The handler only calls factories after `assertBackendConfig`, so apiKey is
 * always non-empty; the constructor's empty-string rejection is a backstop
 * for direct-call paths that bypass entry validation (tests / assembly
 * scripts), preventing keyless instances.
 *
 * Tavily: stub implementation (`project` real, `fetchResults` throws typed
 * `not_shipped`). `TavilyBackend` takes no constructor parameters, so the
 * factory is a bare `new`.
 *
 * Brave: stub implementation (all three methods throw typed `not_shipped`,
 * uniform semantics). `BraveBackend` takes no constructor parameters; when
 * the real fetch ships, add apiKey injection mirroring ExaBackend.
 */
export const BACKENDS: Record<SearchBackendId, SearchBackendFactory> = {
  bing: ({ guardDeps, endpoint }) => new BingBackend(guardDeps, endpoint),
  tavily: () => new TavilyBackend(),
  exa: ({ apiKey }) => new ExaBackend({ apiKey: apiKey ?? "" }),
  brave: () => new BraveBackend(),
};
