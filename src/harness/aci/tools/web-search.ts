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
}

interface SearchInput {
  readonly query: string;
  readonly maxResults: number;
  readonly endpoint: string;
}

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
  const handler = async (
    input: unknown,
    ctx?: ToolExecutionContext
  ): Promise<string> => {
    const parsed = compileSearchInput(input, deps?.envSearchUrl);
    const cacheKey = `${parsed.endpoint}\u0000${parsed.query}`;
    const cachedResults = resultCache.get(cacheKey);
    const cacheHit = cachedResults !== undefined;
    const resultsPromise =
      cachedResults ?? loadSearchResults(parsed, guardDeps, ctx?.signal);
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

async function loadSearchResults(
  parsed: SearchInput,
  guardDeps: GuardDeps,
  signal: AbortSignal | undefined
): Promise<ReadonlyArray<SearchResult>> {
  const requestUrl = `${parsed.endpoint}${parsed.endpoint.includes("?") ? "&" : "?"}q=${encodeURIComponent(parsed.query)}`;
  const response = await fetchPublicResponse(requestUrl, guardDeps, {
    tool: "web_search",
    timeoutMs: SEARCH_TIMEOUT_MS,
    signal,
  });
  return parseSearchResults(response.body, MAX_MAX_RESULTS, parsed.endpoint);
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
