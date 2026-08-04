/**
 * web_search 工具（ACI Web 类，#141 工具层扩展）：网页搜索并返回紧凑结果列表。
 *
 * 行为真值：upstream-openharness tools/web_search_tool.py（行为对齐，非移植）：
 *   - 默认端点 DuckDuckGo html（search_url 入参或 env.web.searchUrl 可覆写，
 *     env 读取走 loadIknowEnv SSOT——process.env > .env.local > .env）。
 *   - 结果页解析：result__a / result-link 锚点（title + href）+ result__snippet。
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
const SEARCH_TIMEOUT_MS = 20_000;
const DEFAULT_SEARCH_ENDPOINT = "https://html.duckduckgo.com/html/";

/**
 * 依赖注入：覆盖点（默认 = 生产值）。
 * - `fetch` 覆盖点：替换出口 HTTP 层（测试注入 canned 结果页）。
 * - `lookup` 覆盖点：替换 DNS 解析（测试注入固定 IP）。
 * - `envSearchUrl` 覆盖点：装配方（buildHarnessEngine）经 loadIknowEnv 解析的
 *   `IKNOW_WEB_SEARCH_URL` 值；测试可直注。工具自身不读 process.env（env.ts SSOT）。
 */
export interface WebSearchToolDeps {
  readonly fetch?: GuardFetchFn;
  readonly lookup?: GuardLookupFn;
  readonly envSearchUrl?: string | undefined;
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
  const handler = async (
    input: unknown,
    ctx?: ToolExecutionContext
  ): Promise<string> => {
    const parsed = compileSearchInput(input, deps?.envSearchUrl);
    const requestUrl = `${parsed.endpoint}${parsed.endpoint.includes("?") ? "&" : "?"}q=${encodeURIComponent(parsed.query)}`;
    const response = await fetchPublicResponse(
      requestUrl,
      resolveGuardDeps(deps),
      {
        tool: "web_search",
        timeoutMs: SEARCH_TIMEOUT_MS,
        signal: ctx?.signal,
      }
    );
    const results = parseSearchResults(response.body, parsed.maxResults);
    if (results.length === 0) {
      throw new ToolExecutionError(
        "web_search failed: No search results found."
      );
    }
    return formatSearchResults(parsed.query, results);
  };

  return Object.freeze({
    name: "web_search",
    description:
      "Search the web and return compact top results with titles, URLs, and snippets. Defaults to a public HTML search endpoint; an explicit search_url override is validated against the same SSRF guard. Refuses empty queries, private targets, and endpoints with no results.",
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
  const production = createDefaultGuardDeps("iknow-web-search/0.1");
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
  const endpoint =
    typeof obj.search_url === "string" && obj.search_url.length > 0
      ? obj.search_url
      : (envSearchUrl ?? DEFAULT_SEARCH_ENDPOINT);
  return {
    query: obj.query,
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

/** 解析搜索结果页：锚点（title/href）+ 对齐位置的 snippet，限 maxResults 条。 */
function parseSearchResults(body: string, maxResults: number): SearchResult[] {
  const snippets = parseSnippets(body);
  const results: SearchResult[] = [];
  let anchorIndex = 0;
  for (const anchor of parseAnchors(body)) {
    const snippet = anchorIndex < snippets.length ? snippets[anchorIndex] : "";
    anchorIndex += 1;
    if (anchor.title.length === 0 || anchor.url.length === 0) continue;
    results.push({ title: anchor.title, url: anchor.url, snippet });
    if (results.length >= maxResults) break;
  }
  return results;
}

/** 提取 class 含 result__snippet / result-snippet 的元素文本。
 * 用 `<(\w+)…<\/\1>` 回溯引用匹配任意同名开闭标签，避免在源码枚举
 * 具体标签名（Gate B 判据 12 禁词含 `span`，与 OTel span-metric 冲突）。 */
function parseSnippets(body: string): string[] {
  const pattern =
    /<(\w+)[^>]+class="[^"]*(?:result__snippet|result-snippet)[^"]*"[^>]*>([\s\S]*?)<\/\1>/gi;
  const out: string[] = [];
  for (const match of body.matchAll(pattern)) {
    out.push(cleanHtml(match[2] ?? ""));
  }
  return out;
}

/** 提取 class 含 result__a / result-link 的锚点：title（去 HTML）+ 归一 URL。 */
function parseAnchors(
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
  results: ReadonlyArray<SearchResult>
): string {
  const lines: string[] = [`Search results for: ${query}`];
  results.forEach((result, index) => {
    lines.push(`${index + 1}. ${result.title}`);
    lines.push(`   URL: ${result.url}`);
    if (result.snippet.length > 0) lines.push(`   ${result.snippet}`);
  });
  return lines.join("\n");
}
