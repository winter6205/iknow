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
   * #826 T2: 选定的 web_search 后端 id。**未设 = 未设**，不等于显式
   * `"bing"` —— T3 的 `backend_unset_with_key` 三态判定依赖这个区分
   * （未设 + 某 keyed key 已设 = 配错，不静默回 Bing）。
   */
  readonly backend?: SearchBackendId;
  /**
   * #826 T3: keyed 后端 API key（装配方经 T1 env loader 解析 `EXA_API_KEY` /
   * `TAVILY_API_KEY` / `BRAVE_API_KEY` 后注入；工具自身不读 process.env，
   * env.ts SSOT）。缺失 / 空白 → `missing_key` fail-closed。
   */
  readonly exaApiKey?: string;
  readonly tavilyApiKey?: string;
  readonly braveApiKey?: string;
  /**
   * #826 T3: backend 工厂覆盖点（与 `fetch` / `lookup` 同族的注入缝）。
   * 缺省 = `selectBackend(backendId)`（BACKENDS 表）。测试用它驱动
   * `http_non_2xx` / `timeout` / `parse` 出口路径，而不改全局 BACKENDS 表。
   */
  readonly backendFactory?: SearchBackendFactory;
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
 *
 * #826 T4: 增 `apiKey` 字段（keyed backend 需要）。handler 在
 * `assertBackendConfig` 之后才调工厂，故 keyed backend 拿到的一定是
 * 已解析的真值（空白 / 占位符解析失败已在 entry fail-closed）。
 */
export interface SearchBackendCtorOptions {
  readonly guardDeps: GuardDeps;
  readonly endpoint: string;
  /**
   * #826 T4: keyed backend 的 API key。仅 keyed backend 关心（bing
   * 不读）。`assertBackendConfig` 已在 entry 校验 non-empty，本字段
   * 是「已验证非空」的真值透传 —— 不再二次判空。
   */
  readonly apiKey?: string;
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
  // #826 T2/T3: 选定后端工厂(per-call 由 handler 拉实例)。`backend` 未设
  // 与显式 "bing" 在 `backendId` 上收敛,但三态 fail-closed 需要区分,
  // 故单独记 `backendUnset`。
  const backendUnset = deps?.backend === undefined;
  const backendId: SearchBackendId = deps?.backend ?? "bing";
  const backendFactory = deps?.backendFactory ?? selectBackend(backendId);
  const apiKeys = collectApiKeys(deps);
  const handler = async (
    input: unknown,
    ctx?: ToolExecutionContext
  ): Promise<string> => {
    // #826 T3: 三态 fail-closed 的两个配置态在 handler entry 判定 —— 先于
    // compileSearchInput / 任何 backend 调用,配错不消耗一次出网。
    assertBackendConfig(backendId, backendUnset, apiKeys);
    assertSearchUrlAllowed(backendId, input);
    const parsed = compileSearchInput(input, deps?.envSearchUrl);
    const cacheKey = `${parsed.endpoint}\u0000${parsed.query}`;
    const cachedResults = resultCache.get(cacheKey);
    const cacheHit = cachedResults !== undefined;
    // #826 T2: per-call backend 实例(带 endpoint;Tavily/Exa/Brave
    // 占位 backend 不读 endpoint,但传同一个 shape 保持工厂同形)。
    // T4: 透传 keyed backend 的 apiKey（已由 assertBackendConfig 校验
    // 非空；bing 不读此字段）。
    const backend = backendFactory({
      guardDeps,
      endpoint: parsed.endpoint,
      ...(isKeyedBackendId(backendId) && apiKeys[backendId] !== undefined
        ? { apiKey: apiKeys[backendId] }
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
      // EXIT: #826 T3 — 六 kind typed 失败 1:1 转译为 ToolExecutionError
      // (executor 原样回灌模型)。非 typed 的一律原样上抛:既有 Bing 路径的
      // ToolExecutionError (network-guard `web_search failed: ...`) 与任何
      // 意外运行时错误都不得被本出口吞掉 / 改写 (SC #5 字节级一致)。
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

/**
 * #826 T3: keyed 后端 id → 注入的 API key / 对应 env var 名。
 * `bing` 不在表里（零 key 默认路径）；表的键集 = spec Assumption 6 里
 * "keyed backend" 的定义。
 */
const KEYED_BACKEND_ENV_KEYS = {
  exa: EXA_API_KEY_ENV_KEY,
  tavily: TAVILY_API_KEY_ENV_KEY,
  brave: BRAVE_API_KEY_ENV_KEY,
} as const;

type KeyedBackendId = keyof typeof KEYED_BACKEND_ENV_KEYS;

type KeyedApiKeys = Readonly<Record<KeyedBackendId, string | undefined>>;

/** keyed backend id 判定（`bing` 之外的三家）。 */
function isKeyedBackendId(id: SearchBackendId): id is KeyedBackendId {
  return id !== "bing";
}

/**
 * #826 T3: 把注入的三个 key 收成一张表。空白串按缺失处理 —— T1 env loader
 * 已把「空串 / 占位符解析失败」折成 undefined，这里再兜一次（直调 handler
 * 的测试 / 装配方绕过 loader 的路径同样 fail-closed，而非带着空 key 出网）。
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
 * #826 T3 (spec Assumption 6): 三态 fail-closed 里的两个**配置态**，在
 * handler entry 判定 —— 不依赖 fetch 阶段，配错不消耗一次出网。
 *
 *   ① backend = keyed 但对应 key 缺失 → `missing_key`
 *   ② backend 未设 但某个 keyed key 已设 → `backend_unset_with_key`
 *      （防配错静默回 Bing；显式 `backend="bing"` + key 已设**不是**配错）
 *
 * 第三态（backend = bing / 未设 + 零 key → 走 Bing HTML）无错误，直接放行。
 * message 只出 backend id 与 env var **名**，绝不出 key 值。
 */
function assertBackendConfig(
  backendId: SearchBackendId,
  backendUnset: boolean,
  apiKeys: KeyedApiKeys
): void {
  if (isKeyedBackendId(backendId)) {
    if (apiKeys[backendId] === undefined) {
      // EXIT: keyed backend selected without a usable key — fail closed.
      throw toToolExecutionError(
        createSearchBackendError({
          kind: "missing_key",
          message: `backend "${backendId}" is selected but no API key resolved — set ${KEYED_BACKEND_ENV_KEYS[backendId]} (env / .env.local / .env), or unset ${SEARCH_BACKEND_ENV_KEY} to fall back to the default bing backend`,
        })
      );
    }
    return;
  }
  if (!backendUnset) return;
  for (const id of Object.keys(KEYED_BACKEND_ENV_KEYS) as KeyedBackendId[]) {
    if (apiKeys[id] === undefined) continue;
    // EXIT: a keyed key is configured but no backend was chosen — refusing
    // to silently serve Bing under a misconfiguration.
    throw toToolExecutionError(
      createSearchBackendError({
        kind: "backend_unset_with_key",
        message: `${KEYED_BACKEND_ENV_KEYS[id]} is set but ${SEARCH_BACKEND_ENV_KEY} is unset — set ${SEARCH_BACKEND_ENV_KEY}=${id} to use it, or remove the key to stay on the default bing backend`,
      })
    );
  }
}

/**
 * #826 T3 (spec Assumption 9): `search_url` 覆写只对 `backend="bing"` 有意义
 * （它是 HTML 端点覆写 + SSRF 验证路径）。keyed backend 下传入 = schema
 * reject，**不**走 SSRF 验证路径，也不静默忽略。
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

/**
 * #826 T4: shared 单条投影 —— `projectSearchResult` 升级为 export，让
 * ExaBackend（T4）/ TavilyBackend（T5）/ BraveBackend（T6）走同一份
 * T2 字段 cap + 全空丢弃，与 Bing HTML 解析路径字节级一致。
 *
 * spec SC #3 + Assumption 8 锚定："T2 字段 cap 一刀切，adapter 不写自家 cap"。
 * T2 把这条 cap 落到了 Bing path 内的私有函数；T4 起 export 出来供
 * keyed backend 共用，避免每家重写一份。
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

// =============================================================================
// #826 T4: ExaBackend v1 真 fetch — Exa 真 HTTP + spec Assumption 8 投影。
// =============================================================================

/**
 * #826 T4: Exa 真端点。`api.exa.ai` 不走 SSRF 防线（既非私网也不是用户
 * 覆写），handler 里 compileSearchInput 解析的 endpoint 对 keyed backend
 * 不生效 —— Exa 路径写死此常量。
 */
const EXA_ENDPOINT = "https://api.exa.ai/search";

/**
 * #826 T4: Exa 投影用的形态描述。Exa 真响应 `SearchResponse` (`results[]`)
 * 在 Exa docs 里字段非常宽（image / publishedDate / author / id 等），但
 * spec Assumption 8 只关心三字段 + highlights/text，故用窄类型描述 contract。
 *
 * 注：spec Assumption 8 原本写 `highlights[0].text`（视 highlights 为
 * `Array<{text: string}>`），但 T8 真出网 probe 实测发现 Exa 真响应
 * `highlights: string[]` —— 每条 highlight 是字符串本身，不是包了 `text`
 * 字段的对象。本接口已对齐真 API 形态；spec 修正留后续 ticket。
 */
interface ExaResultRaw {
  readonly title?: unknown;
  readonly url?: unknown;
  readonly highlights?: ReadonlyArray<unknown>;
  readonly text?: unknown;
}

/**
 * #826 T4: Exa 真响应形态（最少需要 results[]）。`requestId` 由 envelope
 * meta spec 接管前不消费；T4 保留字段在 raw 上以备后续。
 */
interface ExaResponseRaw {
  readonly results?: unknown;
  readonly requestId?: unknown;
}

/**
 * #826 T4: ExaBackend 构造选项。
 *
 * - `apiKey` 必须非空（已由 `assertBackendConfig` 在 handler entry 校验）；
 *   工厂层兜底拒绝空串，防止绕过 entry 校验的直调路径（测试 / 装配脚本）、
 *   让 backend 实例持有无 key 状态而出网。
 * - `fetch` 注入点：测试用 stub fetch 替换 `globalThis.fetch`，生产
 *   默认走全局 fetch（undici 已内置）。`AbortSignal` 直接透传给 fetch，
 *   fetch 抛 `AbortError` 时由 `fetchResults` 翻译为 typed
 *   `SearchBackendError(kind="timeout")`。
 */
export interface ExaBackendCtorOptions {
  readonly apiKey: string;
  /** #826 T4: 测试 seam —— 替换 fetch（生产默认 = `globalThis.fetch`）。 */
  readonly fetch?: typeof globalThis.fetch;
}

/**
 * #826 T4: Exa 真 fetch + spec Assumption 8 投影。
 *
 *   - `fetchResults`：
 *     - POST `https://api.exa.ai/search`，body `{ query, numResults, contents:{highlights:true} }`
 *     - `Authorization: Bearer ${apiKey}` header
 *     - 非 2xx → typed `SearchBackendError(kind="http_non_2xx", endpoint=api.exa.ai, ...)`；
 *       message **不**带 key 字面值 / Authorization header（`createSearchBackendError`
 *       的 redactAuthSecrets 兜底）
 *     - `AbortError`（signal aborted）→ typed
 *       `SearchBackendError(kind="timeout", endpoint=api.exa.ai, ...)`
 *     - 畸形 JSON（parse 失败）→ typed `SearchBackendError(kind="parse", ...)`，
 *       **不**降级为 silent empty
 *
 *   - `project`：把 Exa JSON 投到 Bing-shape `SearchResult[]`，
 *     `snippet = highlights?.[0] ?? text ?? ""`（高亮按 Exa 真 API
 *     `string[]` 形态取第一条；落空时按 spec 兜底走 `result.text`）。
 *     字段 cap 走
 *     `projectSearchResult`（T4 起 export 出来供各家 keyed backend 共用，
 *     与 Bing HTML 路径字节级一致 —— spec SC #3「T2 字段 cap 一刀切，
 *     adapter 不写自家 cap」）。`maxResults` cap 在 `project` 内部施加
 *     （Bing 路径同形态：`parseBingResults` 在循环里 `if (results.length >= maxResults) break`）。
 *
 *   - `describe`：`adapter: "exa" + latencyMs` —— envelope meta spec
 *     未落地前 `requestId` 留 undefined。
 *
 * 不读 process.env、不调 `fetchPublicResponse`（Exa 是固定 vendor endpoint，
 * 不需要 SSRF 防线 / 重定向跳限制 / 字节上限；改走 native fetch 拿 200 即可）。
 */
export class ExaBackend implements SearchBackend {
  readonly id: SearchBackendId = "exa";

  private readonly apiKey: string;
  private readonly fetchFn: typeof globalThis.fetch;

  constructor(opts: ExaBackendCtorOptions) {
    // EXIT: 拒绝空 key —— 防 backend 实例持有无 key 状态而出网。
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
          // highlights 必须显式开 —— 否则上游不返回 highlights 字段，
          // project 会一律落 text（snippet 偏长），与 spec Assumption 8
          // 的「highlights[0] 优先」承诺不一致。
          contents: { highlights: true },
        }),
        signal: args.signal,
      });
    } catch (err) {
      // EXIT: fetch 抛的 abort / 其它底层错都先翻译为 typed timeout
      // （spec SC #3 「Timeout → typed SearchBackendError(kind=timeout)
      // when signal.aborted」）。其它底层网络错也走同 typed 路径，避免
      // 漏到 handler 出口的「untyped pass-through」分支给模型看到原始
      // 错误栈。非 abort 错误仍归 timeout 是有意偏离 —— abort 是这类
      // 失败在生产环境的唯一可观察态，区分信号本身已经在外层 signal 上。
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
      // EXIT: 上游非 2xx —— typed http_non_2xx；status + endpoint 进 message，
      // key / Authorization 由 redactAuthSecrets 兜底脱敏。
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
        // EXIT: 单条 result 形态畸形 —— 跳过（不抛错），保持与 Bing 路径
        // 单条解析失败的容错形态一致（Bing 用 `continue` 跳过畸形 li 块）。
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
 * #826 T4 / spec Assumption 8：`snippet = highlights?.[0] ?? text ?? ""`。
 * 抽出来便于单测 + 隔离 ExaResultRaw 的窄类型描述。
 *
 * 注：spec Assumption 8 原本写 `highlights[0].text`（视每条 highlight 为
 * ` {text: string}` 对象），但 T8 真出网 probe 实测发现 Exa 真响应
 * `highlights: string[]` —— 每条 highlight 是字符串本身（按 Exa docs：
 * 「a relevant excerpt/sentence from the result text」）。本函数已对齐真
 * API 形态：`highlights?.[0]` 取第一条字符串 highlight；落空时按 spec
 * 兜底走 `item.text`（部分 Exa 响应只给 `text` 不给 highlights），再
 * 落空返 `""`。spec 修正留后续 ticket。
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
 * #826 T5: Tavily 真端点（v2 真 fetch 推进；v1 stub 抛 typed `not_shipped`）。
 * v1 不出网 —— `TavilyBackend.fetchResults` 立即抛 typed
 * `SearchBackendError(kind="not_shipped")`；`project` 按 spec Assumption 8
 * 把 Tavily JSON 投到 Bing-shape（**忽略** `result.answer`）。真 fetch 落地
 * 后保留 endpoint 常量，factory 替换 fetch 实现即可。
 */
const TAVILY_ENDPOINT = "https://api.tavily.com/search";

/**
 * #826 T5: Tavily 单条 result 形态（spec Assumption 8）。
 * `answer` 是 Tavily 上游 LLM-synthesized answer field —— spec 明文**忽略**，
 * 不进 snippet（snippet 走 `content`）。
 */
interface TavilyResultRaw {
  readonly title?: unknown;
  readonly url?: unknown;
  readonly content?: unknown;
  /** #826 T5: Tavily 上游特有字段；spec 强制忽略 —— 投影函数直接不看。 */
  readonly answer?: unknown;
}

/**
 * #826 T5: Tavily 响应形态（最少需要 `results[]`）。
 */
interface TavilyResponseRaw {
  readonly results?: unknown;
}

/**
 * #826 T6: Brave 真端点（v2 真 fetch 推进；v1 stub 抛 typed `not_shipped`）。
 * v1 不出网 —— `BraveBackend.fetchResults` / `project` / `describe` 三方法
 * 均抛 typed `SearchBackendError(kind="not_shipped")`，统一语义；
 * 真 fetch 落地后保留 endpoint 常量，工厂替换 fetch 实现即可。
 */
const BRAVE_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";

/**
 * #826 T6: BraveBackend v1 stub。
 *
 *   - `fetchResults`：立即抛 typed
 *     `SearchBackendError(kind="not_shipped", endpoint=api.search.brave.com)`，
 *     message 含 backend id "brave" + v2 提示。**不**发真 HTTP；v2 真 fetch
 *     推进时实现 GET + X-Subscription-Token header。
 *   - `project`：抛 typed `not_shipped`（spec Assumption 8「Brave v1 不实现
 *     `project`」+ T6 acceptance #2 推荐「uniform semantics —— all three
 *     methods throw not_shipped for v1」）。v2 真 fetch 推进时按
 *     spec Assumption 8 投影（`result.title` / `result.description` /
 *     `result.url`，字段 cap 走共享 `projectSearchResult`）。
 *   - `describe`：抛 typed `not_shipped`（T6 acceptance #3 同语义）。
 *     v2 推进时落真形态 `{ adapter: "brave" + latencyMs }`，与 Tavily /
 *     Exa / Bing 同形态。
 *
 * v1 状态：无 constructor 参数（无 per-call state、无 apiKey 字段 —— 真 fetch
 * 推进时再加 apiKey，与 ExaBackend 一致）。所有三方法都直接 sync / async
 * 抛 typed not_shipped；handler 出口的 try/catch 据此 1:1 转译为
 * `ToolExecutionError`（spec SC #8）。
 */
export class BraveBackend implements SearchBackend {
  readonly id: SearchBackendId = "brave";

  async fetchResults(_args: {
    query: string;
    maxResults: number;
    signal?: AbortSignal;
  }): Promise<unknown> {
    // EXIT: v1 stub — 立即抛 typed not_shipped；handler 出口的 try/catch
    // 据此 1:1 转译为 ToolExecutionError（spec SC #8）。不读 apiKey（v2
    // 真 fetch 时再读），不带 key 字面值 / Authorization / endpoint query
    // —— `createSearchBackendError` 兜底脱敏。
    throw createSearchBackendError({
      kind: "not_shipped",
      message:
        'backend "brave" is not implemented yet — pick backend=bing, or wait for the brave adapter to ship (v2 plan)',
      endpoint: BRAVE_ENDPOINT,
    });
  }

  project(_raw: unknown, _maxResults: number): SearchResult[] {
    // EXIT: v1 stub — `project` 也抛 typed not_shipped（spec Assumption 8
    // 钉"Brave v1 不实现 `project`"；T6 acceptance #2 推荐三方法统一语义）。
    // v2 真 fetch 推进时按 spec Assumption 8 投影到 Bing-shape。
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
    // EXIT: v1 stub — `describe` 也抛 typed not_shipped（T6 acceptance #3
    // 同语义）；v2 推进时落真形态。
    throw createSearchBackendError({
      kind: "not_shipped",
      message:
        'backend "brave" is not implemented yet — pick backend=bing, or wait for the brave adapter to ship (v2 plan)',
      endpoint: BRAVE_ENDPOINT,
    });
  }
}

/**
 * #826 T5: TavilyBackend v1 stub。
 *
 *   - `fetchResults`：立即抛 typed
 *     `SearchBackendError(kind="not_shipped", endpoint=api.tavily.com)`，
 *     message 含 backend id "tavily" + v2 提示。**不**发真 HTTP；v2 真 fetch
 *     推进时实现 POST + Authorization。
 *   - `project`：把 Tavily JSON 投到 Bing-shape `SearchResult[]`
 *     （`title = result.title`、`snippet = result.content`、
 *     `url = result.url`，**`result.answer` 忽略**）。字段 cap 走
 *     `projectSearchResult`（与 Bing HTML 路径字节级一致 —— spec SC #3
 *     「T2 字段 cap 一刀切，adapter 不写自家 cap」）；`maxResults` cap 在
 *     `project` 内 `if (out.length >= maxResults) break` 施加，与
 *     `ExaBackend.project` / Bing 解析路径同形态。
 *   - `describe`：`adapter: "tavily" + latencyMs`。
 *
 * v1 状态：无 constructor 参数（无 per-call state、无 apiKey 字段 ——
 * 真 fetch 推进时再加 apiKey，与 ExaBackend 一致）。
 */
export class TavilyBackend implements SearchBackend {
  readonly id: SearchBackendId = "tavily";

  async fetchResults(_args: {
    query: string;
    maxResults: number;
    signal?: AbortSignal;
  }): Promise<unknown> {
    // EXIT: v1 stub — 立即抛 typed not_shipped；handler 出口的 try/catch
    // 据此 1:1 转译为 ToolExecutionError（spec SC #8）。不读 apiKey（v2
    // 真 fetch 时再读），不带 key 字面值 / Authorization / endpoint query
    // —— `createSearchBackendError` 兜底脱敏。
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
        // EXIT: 单条 result 形态畸形 —— 跳过（不抛错），保持与 Bing 路径 /
        // Exa project 的容错形态一致（skip malformed 单条）。
        continue;
      }
      const item = itemRaw as TavilyResultRaw;
      const title = typeof item.title === "string" ? item.title : "";
      const url = typeof item.url === "string" ? item.url : "";
      // spec Assumption 8: snippet = result.content。**刻意不看 result.answer**
      // —— Tavily 上游独有 LLM-synthesized 字段，spec 强制忽略；projected
      // snippet 永不含 answer 字面值，handler formatter 也不会带回。
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
 * #826 T2: `BACKENDS` 表 — 按 `id` 持 backend 工厂。T2 仅 bing 真接；
 * tavily/exa/brave 占位 throws。`selectBackend(id)` 返回工厂；handler
 * 调工厂拉实例。
 *
 * T4 起：Exa 真 fetch 落地，`BACKENDS.exa` 工厂改为透传 apiKey 给
 * `ExaBackend` 构造函数。handler 在 `assertBackendConfig` 之后才调
 * 工厂，故 apiKey 一定 non-empty；构造函数的空串兜底是防绕过 entry
 * 校验的直调路径（测试 / 装配脚本）留下无 key 实例。
 *
 * T5 起：Tavily stub 落地（`project` 真实、`fetchResults` 抛 typed
 * `not_shipped`）。`TavilyBackend` 无 constructor 参数，工厂直接 `new`
 * 即可。
 *
 * T6 起：Brave stub 落地（三方法均抛 typed `not_shipped`，统一语义）。
 * `BraveBackend` 无 constructor 参数，工厂直接 `new` 即可。v2 真 fetch
 * 推进时按 ExaBackend 形态补 apiKey 注入即可。
 */
export const BACKENDS: Record<SearchBackendId, SearchBackendFactory> = {
  bing: ({ guardDeps, endpoint }) => new BingBackend(guardDeps, endpoint),
  tavily: () => new TavilyBackend(),
  exa: ({ apiKey }) => new ExaBackend({ apiKey: apiKey ?? "" }),
  brave: () => new BraveBackend(),
};
