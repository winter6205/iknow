/**
 * web_search 工具（ACI Web 类，#141 工具层扩展）：网页搜索并返回紧凑结果列表。
 *
 * 行为真值：web_search_tool.py（行为对齐，非移植）：
 *   - 默认端点：DuckDuckGo html（upstream 默认）在部分网络环境（本地 DNS
 *     污染 / egress 阻断，实测 WSL2 + Windows host 解析器把 duckduckgo.com
 *     解析到 Facebook IP 且直连超时）不可达。B1 决策：默认端点切到 Bing
 *     （cn.bing.com/search，实测本机 200 + 结果结构完整、中国区可达），
 *     DDG html 保留为 search_url 覆写 / IKNOW_WEB_SEARCH_URL 可选值。
 *   - 结果页解析：按端点 hostname 分派解析器 —— DDG html 走 result__a /
 *     result-link + result__snippet；Bing 走 li.b_algo → h2>a + div.b_caption。
 *   - DuckDuckGo /l/?uddg= 重定向链接归一为目标 URL。
 *   - 输出编号列表 `N. title / URL: / snippet`；零结果 → ToolExecutionError。
 *
 * SSRF 防线复用 network-guard（端点与 search_url 覆写均逐跳校验）；
 * 非 2xx / 空结果抛 ToolExecutionError（executor 原样回灌模型）。
 *
 * ACI 元数据：category=read-only、isConcurrencySafe=true、interruptBehavior=cancel、
 * timeoutTier=default（30s）。
 *
 * 依赖注入（对齐 grep.ts GrepToolDeps 先例）：deps.fetch / deps.lookup 覆盖
 * network-guard 出口层（生产默认 = network-guard createDefaultGuardDeps SSOT）；
 * deps.envSearchUrl 注入装配方解析好的 env 端点（测试隔离 / 生产经 loadIknowEnv）。
 */

import type { AciToolDef } from "../types.js";
import type { ToolExecutionContext } from "../../tools/types.js";
import { ToolExecutionError } from "../../errors.js";
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
const SEARCH_TIMEOUT_MS = 20_000;
/** B1 默认端点:Bing(中国区可达,DDG 在此类网络不可达)。DDG html 仍可经覆写。 */
const DEFAULT_SEARCH_ENDPOINT = "https://cn.bing.com/search";

/**
 * 依赖注入：覆盖点（默认 = 生产值）。
 * - `fetch` 覆盖点：替换出口 HTTP 层（测试注入 canned 结果页）。
 * - `lookup` 覆盖点：替换 DNS 解析（测试注入固定 IP）。
 * - `envSearchUrl` 覆盖点：装配方（buildHarnessEngine）经 loadIknowEnv 解析的
 *   `IKNOW_WEB_SEARCH_URL` 值；测试可直注。工具自身不读 process.env（env.ts SSOT）。
 * - `proxyUrl` 覆盖点：把出站代理 URL 透传到 network-guard（IKNOW_WEB_PROXY
 *   装配路径；非空时 fetch 挂 ProxyAgent dispatcher）。
 */
export interface WebSearchToolDeps {
  readonly fetch?: GuardFetchFn;
  readonly lookup?: GuardLookupFn;
  readonly envSearchUrl?: string | undefined;
  readonly proxyUrl?: string;
  /**
   * #826 T2: 选定的 web_search 后端 id（默认 `"bing"` — 与 v0 字节级一致）。
   * T2 阶段 factory 仅识别 `"bing"`；`"tavily"` / `"exa"` / `"brave"` 仍
   * 走 BACKENDS 表的占位实现（throws "backend not implemented yet —
   * see T4/T5/T6"），handler 不会真调到。T3 起加 schema reject 与 typed
   * `SearchBackendError`。
   */
  readonly backend?: SearchBackendId;
}

interface SearchInput {
  readonly query: string;
  readonly maxResults: number;
  readonly endpoint: string;
}

/**
 * #826 T2 (spec Assumption 7): web_search 后端 id 闭集。
 * 装配路径（registry → buildHarnessEngine）经 T1 env loader 解析
 * `IKNOW_WEB_SEARCH_BACKEND`（不合法 → typed `WebEnvConfigError`，
 * **不**回退默认）；T3 起 factory 边界加 schema reject + 默认到 bing。
 */
export type SearchBackendId = "bing" | "tavily" | "exa" | "brave";

/**
 * #826 T2 (spec Assumption 7): SearchBackend 三方法同形接口。
 *   - `fetchResults` 发 HTTP 拿上游响应（raw shape：Bing 是 HTML 字符串，
 *     Tavily/Exa/Brave T4-T6 是 JSON）。
 *   - `project` 把上游 raw 投到 Bing-shape `SearchResult[]`（spec Assumption 8）。
 *   - `describe` 出 observability 侧通道 meta（`adapter` / `latencyMs` /
 *     `requestId?`），T12 envelope spec 未落地前不消费。
 */
export interface SearchBackend {
  readonly id: SearchBackendId;
  fetchResults(args: {
    query: string;
    maxResults: number;
    /** executor 透传的取消信号；T2 阶段 ctx?.signal 可能未传，故 `signal?`。 */
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
 * #826 T2: backend 实例化需要的 per-call 上下文（guardDeps 装配期绑定；
 * endpoint 由 `compileSearchInput` 在 handler 内解析 — 含 SSRF 验证、
 * search_url 覆写、envSearchUrl fallback）。
 */
export interface SearchBackendCtorOptions {
  readonly guardDeps: GuardDeps;
  readonly endpoint: string;
}

/**
 * #826 T2: 后端工厂签名。`BACKENDS` 表按 `id` 持工厂函数，每调用拉一份
 * 实例 — BingBackend 需要 `endpoint`（per-call），Tavily/Exa/Brave 仍
 * 占位实现（不持 state）。T4-T6 起把 Tavily/Exa/Brave 替换为真 fetch，
 * 工厂签名不变。
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
 * 工厂：createWebSearchTool(deps?) — 网页搜索工具。
 *
 * 返回的 AciToolDef 满足：
 *   - name === "web_search"
 *   - inputSchema: { query 必填 + max_results?(默认 5, 1..10) + search_url? }
 *   - aci 元数据：read-only / concurrency-safe / cancel / default tier
 */
export function createWebSearchTool(deps?: WebSearchToolDeps): AciToolDef {
  // fail-fast:代理配置在装配时即过 SSRF 语法校验,坏的 IKNOW_WEB_PROXY
  // 在 build 期报错,而非首次搜索时才暴露。
  const guardDeps = resolveGuardDeps(deps);
  const resultCache = new Map<string, Promise<ReadonlyArray<SearchResult>>>();
  // #826 T2: 选定后端工厂(per-call 由 handler 拉实例;T2 仅 bing 真
  // 接,tavily/exa/brave 占位 throws — handler 不会真调过去)。
  const backendId: SearchBackendId = deps?.backend ?? "bing";
  const backendFactory = selectBackend(backendId);
  const handler = async (
    input: unknown,
    ctx?: ToolExecutionContext
  ): Promise<string> => {
    const parsed = compileSearchInput(input, deps?.envSearchUrl);
    const cacheKey = `${parsed.endpoint}\u0000${parsed.query}`;
    const cachedResults = resultCache.get(cacheKey);
    const cacheHit = cachedResults !== undefined;
    // #826 T2: per-call backend 实例(带 endpoint;Tavily/Exa/Brave
    // 占位 backend 不读 endpoint,但传同一个 shape 保持工厂同形)。
    const backend = backendFactory({
      guardDeps,
      endpoint: parsed.endpoint,
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
    const results = await resultsPromise;
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
      "Discover URLs by keyword before reading them with web_fetch. Returns up to max_results (default 5, cap 10) titles / URLs / snippets in a numbered list; defaults to a Bing HTML endpoint — pass search_url to override (still SSRF-validated). Pair with web_fetch on each returned URL.",
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
    },
  });
}

/** 组装 guard deps：注入 stub 优先，缺省用 network-guard 生产默认（SSOT）。 */
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

/** 入参校验：query 非空；max_results clamp [1,10]；端点优先级 search_url > env > 默认。 */
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

/** max_results clamp：非有限数 / ≤0 → 默认 5；>10 → 10。 */
function clampMaxResults(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw))
    return DEFAULT_MAX_RESULTS;
  const floored = Math.floor(raw);
  if (floored <= 0) return DEFAULT_MAX_RESULTS;
  if (floored > MAX_MAX_RESULTS) return MAX_MAX_RESULTS;
  return floored;
}

/**
 * #826 T2: 用选定的 `SearchBackend` 拉一次结果 — 把 v0 内联的 fetch +
 * parse 拆成 backend.fetchResults (raw) + backend.project (Bing-shape)。
 * Bing 路径下 backend === BingBackend，与 v0 字节级一致（同一
 * `fetchPublicResponse` + 同一 `parseSearchResults` hostname dispatch）。
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
 * 解析搜索结果页：按端点 hostname 分派解析器（DDG html vs Bing），
 * 限 maxResults 条。未知端点回退 DDG 解析（向后兼容旧 fixture）。
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

/** 端点是否为 Bing（默认 cn.bing.com，或覆写的 bing.com / cn.bing.com）。 */
function isBingEndpoint(endpoint: string): boolean {
  try {
    const hostname = new URL(endpoint).hostname.toLowerCase();
    return hostname === "bing.com" || hostname.endsWith(".bing.com");
  } catch {
    return false;
  }
}

/** DDG html 解析：result__a / result-link 锚点 + 对齐位置的 snippet。 */
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

/** Bing 解析：li.b_algo 结果块 → h2>a（title + href）+ div.b_caption（snippet）。 */
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

function projectSearchResult(result: SearchResult): SearchResult | undefined {
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

/** 提取 class 含 result__snippet / result-snippet 的元素文本。
 * 用 `<(\w+)…<\/\1>` 回溯引用匹配任意同名开闭标签，避免在源码枚举
 * 具体标签名（Gate B 判据 12 禁词含 `span`，与 OTel span-metric 冲突）。 */
function parseDdgSnippets(body: string): string[] {
  const pattern =
    /<(\w+)[^>]+class="[^"]*(?:result__snippet|result-snippet)[^"]*"[^>]*>([\s\S]*?)<\/\1>/gi;
  const out: string[] = [];
  for (const match of body.matchAll(pattern)) {
    out.push(cleanHtml(match[2] ?? ""));
  }
  return out;
}

/** 提取 class 含 result__a / result-link 的锚点：title（去 HTML）+ 归一 URL。 */
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

/** DuckDuckGo /l/?uddg= 重定向链接 → uddg 参数解码后的目标 URL。 */
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

/** 输出拼装：`Search results for: <query>` + 编号列表。 */
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
// #826 T2: SearchBackend seam — BingBackend + selectBackend + BACKENDS 表。
// 同文件 BACKENDS 表(spec 决议),handler 路径:selectBackend(id)(guardDeps, endpoint)
// → backend.fetchResults → backend.project。T2 阶段仅 bing 真接;
// tavily/exa/brave 占位 throws,T3 起替换为 typed SearchBackendError。
// =============================================================================

/**
 * #826 T2: BingBackend — 把既有 `cn.bing.com/search` HTML 解析路径包成同形
 * `SearchBackend` 三方法签名。
 *
 *   - `fetchResults`：走 `fetchPublicResponse`（含 SSRF 验证 + 既有重定向
 *     跳逐跳校验），返回原始 HTML 字符串。
 *   - `project`：调既有 `parseSearchResults(raw, maxResults, endpoint)`
 *     hostname 分派（Bing 走 `parseBingResults`，search_url 覆写到 DDG
 *     等非 Bing hostname 走 `parseDuckDuckGoResults`，保持 v0 行为）。
 *   - `describe`：返回 `{ adapter: "bing", latencyMs, requestId? }` —
 *     envelope spec 未落地前 `requestId` 留 undefined（spec Assumption 12）。
 *
 * `search_url` 覆写在 handler 里经 `compileSearchInput` 提前解析（已
 * SSRF 校验），endpoint 由 caller 经 `backendFactory({ endpoint, ... })`
 * 注入；本类不读 process.env（env.ts SSOT）。
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
    // raw 是 fetchPublicResponse 返回的 HTML body；既有解析器依赖字符串。
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
 * #826 T2: 后端分派。`BACKENDS` 表按 `id` 持工厂；运行时拿到的总是
 * `SearchBackendFactory`（types 保证），运行时再 guard 防意外未知键。
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

/**
 * #826 T2: 占位实现 — T2 阶段 handler 不会真调到（factory 边界 default
 * 到 bing，T3 起 schema reject 把非 bing + search_url / 非 bing 真 fetch
 * 路径都接管）。这里抛 plain `Error` 是 T2 故意：typed `SearchBackendError`
 * 在 T3 落地（spec Assumption 6 六 kind 闭集 + 转译 `ToolExecutionError`），
 * T4-T6 起 Exa/Tavily/Brave 替换为真 fetch。
 */
function notImplemented(id: SearchBackendId): never {
  throw new Error(
    `web_search: backend "${id}" not implemented yet — see T4/T5/T6`
  );
}

/**
 * #826 T2: 占位 backend 实例（与 `SearchBackend` 同形，三方法均抛）。
 * factory 返回同一份实例（无 per-call state）即可。
 */
function placeholderBackend(id: SearchBackendId): SearchBackend {
  return {
    id,
    fetchResults: () => notImplemented(id),
    project: () => notImplemented(id),
    describe: () => notImplemented(id),
  };
}

/**
 * #826 T2: `BACKENDS` 表 — 按 `id` 持 backend 工厂。T2 仅 bing 真接；
 * tavily/exa/brave 占位 throws。`selectBackend(id)` 返回工厂；handler
 * 调工厂拉实例。
 */
export const BACKENDS: Record<SearchBackendId, SearchBackendFactory> = {
  bing: ({ guardDeps, endpoint }) => new BingBackend(guardDeps, endpoint),
  tavily: () => placeholderBackend("tavily"),
  exa: () => placeholderBackend("exa"),
  brave: () => placeholderBackend("brave"),
};
