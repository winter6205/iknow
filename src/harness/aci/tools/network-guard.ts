/**
 * network-guard（SSRF 安全出口层）：web_fetch / web_search 共用的出站 HTTP 防线。
 *
 * 行为真值：upstream-ref 的通用 Agent 工具层 utils/network_guard.py 的 DIRECT 解析模式裁剪版
 * （ACR corrective #2：不移植 PROXY / SYNTHETIC_DNS 配置管线——iknow 无此需求）。
 *
 * 防线（逐跳生效，含重定向）：
 *   1. URL 语法：仅 http/https、必须有 host、拒绝嵌入凭据。
 *   2. IP 字面量：非公网段（loopback / 私网 / link-local / CGNAT / 多播 / 保留）拒绝。
 *   3. 主机名：localhost / 本地后缀 / 单标签主机名拒绝。
 *   4. DNS 解析：解析结果含任一非公网 IP → 拒绝；解析失败 → could not resolve。
 *   5. 重定向：≤5 跳，每一跳重新走 1-4；落到非公网目标即拒绝。
 *   6. 非 2xx → 拒绝（带状态码）。
 *
 * 已知边界（与 upstream DIRECT 模式同构，非本实现偏离）：校验用 lookup 与
 * 生产 fetch（undici 自行解析）之间无 IP 钉扎，理论上存在 DNS rebinding
 * TOCTOU 窗口；缓解需自定义 undici dispatcher 钉扎已验证 IP（后续工单）。
 *
 * 依赖注入（对齐 grep.ts 的 GrepToolDeps 先例）：fetch / lookup 均可被测试 stub
 * 覆盖，全部测试离线跑。生产默认用 createDefaultGuardDeps(userAgent) 组装
 * （fetch = globalThis.fetch redirect:manual；lookup = node:dns/promises.lookup all）。
 *
 * 所有失败抛 ToolExecutionError，消息以 `${tool} failed:` 开头（对齐 upstream
 * "web_fetch failed: ..." 约定），由 executor sanitizeFailure 原样回灌模型。
 */

import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { ProxyAgent } from "undici";

import { ToolExecutionError } from "../../errors.js";
import { classifyIp } from "./ip-classify.js";

/**
 * 全局 fetch 的 RequestInit.dispatcher 类型来自 @types/node 捆绑的
 * undici-types@6(结构旧),而 undici@7 的 ProxyAgent 实现的是 undici@7
 * Dispatcher(FormData 等类型签名不同)。两套类型签名结构不兼容,但
 * 运行值是同一代理语义。此处用窄类型断言桥接 —— 只声明"满足全局 fetch
 * 需要的 dispatcher 形状",不引入 any。
 */
type FetchDispatcher = NonNullable<Parameters<typeof fetch>[1]>["dispatcher"];

/** 重定向上限（与 upstream MAX_REDIRECTS 对齐）。 */
export const MAX_REDIRECTS = 5;

/**
 * 浏览器伪装 UA（web_fetch / web_search 工具生产默认出口共享）。
 *
 * 选用 Chrome 130 桌面 UA + iknow 产品后缀，对齐 upstream-ref 的通用 Agent 工具层
 * `Mozilla/... iknow/<version>` 风格——伪装为真实浏览器以通过 Cloudflare
 * 等反爬 UA 过滤（实测：纯产品 UA "iknow-web-fetch/0.1" 被 Ars Technica
 * Cloudflare 拦截为 202 challenge；浏览器 UA 通过）。UA 中显式带 `iknow/`
 * 标识，避免完全伪装为不知名流量。
 *
 * 版本号写死是已知偏离（不随 Chrome 版本自动更新），与 upstream 同。
 * 测试覆盖：此常量导出供工具层引用；测试本身不检查 UA（注入 fetch stub
 * 不消费 headers）。
 */
export const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7_2) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/130.0.0.0 Safari/537.36 iknow/0.1";

/** 本地主机名黑名单（对齐 upstream _LOCAL_HOSTNAMES）。 */
const LOCAL_HOSTNAMES: ReadonlySet<string> = new Set([
  "localhost",
  "localhost.localdomain",
  "metadata.google.internal",
]);

/** 本地主机名后缀黑名单（对齐 upstream _LOCAL_HOST_SUFFIXES）。 */
const LOCAL_HOST_SUFFIXES: readonly string[] = [
  ".localhost",
  ".local",
  ".localdomain",
  ".internal",
  ".cluster.local",
];

/** 注入的 fetch 收到的每请求选项（signal 已合并 caller + 超时）。 */
export interface GuardFetchOptions {
  readonly signal?: AbortSignal;
}

/** 注入 fetch 的单次响应（redirect: manual 语义：3xx 带 location）。 */
export interface GuardHttpResponse {
  readonly status: number;
  readonly contentType: string;
  readonly body: string;
  readonly location?: string;
}

/** fetchPublicResponse 的返回：原始响应 + 最终 URL（重定向后）。 */
export interface GuardPublicResponse extends GuardHttpResponse {
  readonly finalUrl: string;
}

/** 测试 seam / 生产默认：发一次 GET（不自动跟随重定向）。 */
export type GuardFetchFn = (
  url: string,
  options: GuardFetchOptions
) => Promise<GuardHttpResponse>;

/** 测试 seam / 生产默认：把主机名解析为 IP 地址列表。 */
export type GuardLookupFn = (hostname: string) => Promise<readonly string[]>;

/** 依赖注入对（fetch + lookup 均必传，由工具工厂填生产默认或测试 stub）。 */
export interface GuardDeps {
  readonly fetch: GuardFetchFn;
  readonly lookup: GuardLookupFn;
}

/** fetchPublicResponse 的调用选项。 */
export interface FetchPublicOptions {
  /** 工具名（用于错误前缀，如 "web_fetch"）。 */
  readonly tool: string;
  /** 整个出站调用（含全部重定向）的超时毫秒。 */
  readonly timeoutMs: number;
  /** caller 取消信号（executor 透传）。 */
  readonly signal?: AbortSignal;
}

/** createDefaultGuardDeps 的配置选项。 */
export interface DefaultGuardDepsOptions {
  /** 显式出站代理 URL（http/https）。缺省 = 直连（不挂 dispatcher）。 */
  readonly proxyUrl?: string;
  /** 可选 UA 覆写；缺省用 {@link DEFAULT_USER_AGENT}。 */
  readonly userAgent?: string;
}

/**
 * 生产默认出口 deps（SSOT）：fetch = globalThis.fetch（redirect: manual，
 * UA 默认浏览器伪装串）+ lookup = node:dns/promises.lookup(all)。
 * web_fetch / web_search 工厂不再各自复制默认实现（code-review 整改）。
 *
 * 代理臂（对齐 upstream `fetch_public_http_response` 的 `proxy` 配置，
 * trust_env=False 语义 —— 显式配置才生效，不读系统 HTTP(S)_PROXY）：
 *   - `opts.proxyUrl` 提供时，fetch 挂 `undici.ProxyAgent` dispatcher，
 *     出站流量经代理转发（远端解析 + 出网，绕开本地 DNS 污染 / egress 阻断）。
 *   - 代理 URL 走与目标 URL 同套 httpUrlViolation 校验（协议 / host / 凭据），
 *     对齐 upstream `validate_http_url(resolved_proxy)`。
 *   - 代理主机名不做公网 IP 防线 —— 本地代理（127.0.0.1 / 内网）必须允许，
 *     否则本地代理装配即失败。
 *   - 走代理时不改目标 URL 的 SSRF 校验：target 仍逐跳走语法 + IP + DNS 防线
 *     （代理在远端解析，本地 DNS 结果对 target 校验的语义与直连一致）。
 *
 * @param opts 配置：proxyUrl / userAgent；二者均可缺省。
 */
export function createDefaultGuardDeps(
  opts?: DefaultGuardDepsOptions | string
): GuardDeps {
  // 向后兼容旧签名 createDefaultGuardDeps(userAgent?: string)。
  const userAgent =
    typeof opts === "string" ? opts : (opts?.userAgent ?? DEFAULT_USER_AGENT);
  const proxyUrl = typeof opts === "string" ? undefined : opts?.proxyUrl;
  let dispatcher: ProxyAgent | undefined;
  if (proxyUrl) {
    // 代理 URL 复用目标 URL 的 SSRF 语法防线（协议 / host / 凭据）。
    const violation = httpUrlViolation(proxyUrl);
    if (violation !== null) {
      throw new ToolExecutionError(violation);
    }
    dispatcher = new ProxyAgent(proxyUrl);
  }
  const fetchFn: GuardFetchFn = async (url, options) => {
    const response = await fetch(url, {
      redirect: "manual",
      signal: options.signal,
      headers: { "User-Agent": userAgent },
      ...(dispatcher
        ? // 类型桥接见 FetchDispatcher 注释(undici@7 与全局 fetch 的
          // undici-types 版本不同,结构不兼容但运行值等价)。
          { dispatcher: dispatcher as unknown as FetchDispatcher }
        : {}),
    });
    return {
      status: response.status,
      contentType: response.headers.get("content-type") ?? "",
      body: await response.text(),
      location: response.headers.get("location") ?? undefined,
    };
  };
  const lookupFn: GuardLookupFn = async (hostname) => {
    const records = await dnsLookup(hostname, { all: true });
    return records.map((r) => r.address);
  };
  return { fetch: fetchFn, lookup: lookupFn };
}

/**
 * 同步校验 URL 语法：仅 http/https、必须有 host、拒绝嵌入凭据。
 * 违规抛 ToolExecutionError（无工具前缀——供独立使用与 guard 内部复用）。
 */
export function validateHttpUrl(url: string): void {
  const violation = httpUrlViolation(url);
  if (violation !== null) throw new ToolExecutionError(violation);
}

/**
 * 出站抓取：逐跳校验 + 跟随重定向（≤ MAX_REDIRECTS），返回最终响应。
 * 任何防线失败抛 ToolExecutionError，消息以 `${opts.tool} failed:` 开头。
 */
export async function fetchPublicResponse(
  url: string,
  deps: GuardDeps,
  opts: FetchPublicOptions
): Promise<GuardPublicResponse> {
  const fail = failWithPrefix(opts.tool);
  if (opts.signal?.aborted) fail("request aborted before start");

  const timer = new AbortController();
  const timeoutId = setTimeout(() => timer.abort(), opts.timeoutMs);
  timeoutId.unref();
  const combined = opts.signal
    ? AbortSignal.any([opts.signal, timer.signal])
    : timer.signal;

  try {
    return await followGuardedRedirects(url, deps, combined, fail);
  } finally {
    clearTimeout(timeoutId);
  }
}

/** 重定向主循环：每跳先 ensurePublicTarget 再 fetch，≤ MAX_REDIRECTS 跳。 */
async function followGuardedRedirects(
  url: string,
  deps: GuardDeps,
  signal: AbortSignal,
  fail: (reason: string) => never
): Promise<GuardPublicResponse> {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await ensurePublicTarget(current, deps.lookup, fail);
    const response = await runFetch(deps.fetch, current, signal, fail);
    if (response.status >= 200 && response.status < 300) {
      return { ...response, finalUrl: current };
    }
    if (response.status >= 300 && response.status < 400 && response.location) {
      if (hop >= MAX_REDIRECTS) fail(`too many redirects (>${MAX_REDIRECTS})`);
      current = new URL(response.location, current).toString();
      continue;
    }
    fail(`unexpected status ${response.status}`);
  }
  return fail(`too many redirects (>${MAX_REDIRECTS})`);
}

/** 构造带 `${tool} failed:` 前缀的 fail（返回 never，供 TS 收窄）。 */
function failWithPrefix(tool: string): (reason: string) => never {
  return (reason: string): never => {
    throw new ToolExecutionError(`${tool} failed: ${reason}`);
  };
}

/** 执行一次注入 fetch，把中止 / 底层错误归一为带前缀的 ToolExecutionError。 */
async function runFetch(
  fetch: GuardFetchFn,
  url: string,
  signal: AbortSignal,
  fail: (reason: string) => never
): Promise<GuardHttpResponse> {
  try {
    // 中止先于 fetch 开始时，注入 stub 的 abort 监听器可能永不触发——先检一次。
    if (signal.aborted) fail("request aborted");
    return await fetch(url, { signal });
  } catch (error) {
    if (signal.aborted) fail("request aborted");
    const detail = error instanceof Error ? error.message : String(error);
    fail(detail);
  }
}

/** 对单个目标 URL 跑 URL 语法 + IP/主机名 + DNS 四道防线。 */
async function ensurePublicTarget(
  url: string,
  lookup: GuardLookupFn,
  fail: (reason: string) => never
): Promise<void> {
  const violation = httpUrlViolation(url);
  if (violation !== null) fail(violation);
  const rawHostname = new URL(url).hostname.toLowerCase().replace(/\.$/, "");
  // WHATWG URL 对 IPv6 字面量保留方括号；分类前剥掉。
  const hostname =
    rawHostname.startsWith("[") && rawHostname.endsWith("]")
      ? rawHostname.slice(1, -1)
      : rawHostname;
  if (isIP(hostname) !== 0) {
    const label = classifyIp(hostname);
    if (label !== null) {
      fail(`target resolves to non-public address(es): ${hostname} (${label})`);
    }
    return; // 公网 IP 字面量：无需主机名 / DNS 防线
  }
  ensureHostnameAllowed(hostname, fail);
  const addresses = await resolveHost(hostname, lookup, fail);
  const blocked = addresses.filter((a) => classifyIp(a) !== null);
  if (blocked.length > 0) {
    const rendered = blocked
      .map((a) => `${a} (${classifyIp(a) ?? "non-public"})`)
      .join(", ");
    fail(`target resolves to non-public address(es): ${rendered}`);
  }
}

/** 主机名黑名单 + 单标签拒绝。 */
function ensureHostnameAllowed(
  hostname: string,
  fail: (reason: string) => never
): void {
  if (
    LOCAL_HOSTNAMES.has(hostname) ||
    LOCAL_HOST_SUFFIXES.some((suffix) => hostname.endsWith(suffix))
  ) {
    fail(`local hostnames are not allowed: ${hostname}`);
  }
  if (!hostname.includes(".")) {
    fail(`single-label hostnames are not allowed: ${hostname}`);
  }
}

/** DNS 解析：失败 / 空结果都拒绝。 */
async function resolveHost(
  hostname: string,
  lookup: GuardLookupFn,
  fail: (reason: string) => never
): Promise<readonly string[]> {
  let addresses: readonly string[];
  try {
    addresses = await lookup(hostname);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    fail(`could not resolve target host ${hostname}: ${detail}`);
    addresses = []; // 不可达 — fail 必抛；仅为 TS definite-assignment 收窄
  }
  if (addresses.length === 0) fail(`target host did not resolve: ${hostname}`);
  return addresses;
}

/** URL 语法违规检查：返回违规原因，合法返回 null。 */
function httpUrlViolation(url: string): string | null {
  if (typeof url !== "string" || url.trim().length === 0) {
    return "URL must be a non-empty string";
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "URL is malformed";
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return "only http and https URLs are allowed";
  }
  if (!parsed.hostname) return "URL must include a host";
  if (parsed.username || parsed.password) {
    return "URLs with embedded credentials are not allowed";
  }
  return null;
}
