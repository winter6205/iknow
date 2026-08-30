/**
 * #826 T3 (spec Assumption 6): `web_search` 后端失败的 typed 判别联合。
 *
 * 形态选择：**plain object**（不是 class），镜像 `WebEnvConfigError`
 * (`src/config/env.ts:190`) / `WorkspaceRootError` 的既有形态。理由与
 * `code-quality.md` typed-error catch 契约同源：callers 走
 * `isSearchBackendError` 守卫按 `kind` 分流，绝不 `err instanceof Error`
 * —— 后者把 plain object 打成 `[object Object]`，`kind` / `endpoint` 全不可见。
 *
 * 六 kind 闭集（**不得**扩，扩需回 spec）：
 *   - `missing_key`            选了 keyed backend 但对应 key 缺失 / 占位符解析失败
 *   - `backend_unset_with_key` backend 未设但某个 keyed key 已设（防配错静默回 Bing）
 *   - `http_non_2xx`           上游非 2xx（401 / 429 / 5xx）
 *   - `parse`                  上游响应结构不可解（**不**降级成 silent empty）
 *   - `timeout`                取消 / 超时
 *   - `not_shipped`            v1 未实现的 backend 被选中（Tavily / Brave）
 *
 * 安全契约（spec Assumption 6 明列）：`message` / `endpoint` 都**不得**带
 * key 字面值、`Authorization` header 或上游 request body。`endpoint` 只留
 * 域名（`createSearchBackendError` 强制收窄，query string 一并丢弃）；
 * `message` 过一遍 `redactAuthSecrets` 兜底。原始故障留在 `cause`（不进
 * 模型视野的 `ToolExecutionError.message`，只作调试链路）。
 */

import { ToolExecutionError } from "../../errors.js";

/**
 * #826 T3: 六 kind 闭集。顺序与 spec Assumption 6 一致（配置态 → 传输态 →
 * 未实现态），测试按此顺序 deepEqual 钉死闭集不被悄悄扩。
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
 * #826 T3: web_search 后端 typed 失败。
 * `endpoint` 是**域名**（无 scheme / path / query / 凭据），可缺省
 * （配置态失败还没走到任何 endpoint）。
 */
export type SearchBackendError = {
  readonly kind: SearchBackendErrorKind;
  readonly message: string;
  readonly endpoint?: string;
  readonly cause?: unknown;
};

/**
 * #826 T3: typed 判别守卫（镜像 `isWebEnvConfigError`，`src/config/env.ts:203`）。
 * `kind` 必须命中闭集 + `message` 是 string + `endpoint` 缺省或 string。
 * 显式排除 `Error` 实例：`ToolExecutionError` 等既有错误族不得被误判为本类型。
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
 * URL / 裸域名 → 裸域名。解析失败（已经是裸域名，或压根不是 URL）时原样回退
 * 但仍砍掉 `?`/`#` 之后的部分 —— 宁可少信息，也不把 query 里的 key 带出去。
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
 * 兜底脱敏：`Authorization: ...` / `Bearer <token>` / `api_key=<v>` 形态一律
 * 抹掉。构造点本就不应插入 key（这是第一道防线）；本函数是第二道，防止
 * 上游 error 文本被原样搬进 message。形态与 `errors.ts`
 * `sanitizeMcpLifecycleDetail` 同族，但只覆盖 web_search 会撞到的三种。
 */
function redactAuthSecrets(message: string): string {
  return (
    message
      // `bearer` 先于 `authorization`：`Authorization: Bearer <key>` 里
      // 若先跑 authorization 规则，`\S+` 只吃掉 "Bearer"，key 会漏出来。
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
 * #826 T3: `SearchBackendError` 构造入口。**唯一**允许构造本类型的地方 ——
 * 集中施加两条安全不变量：`endpoint` 收窄到域名、`message` 过脱敏。
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
 * #826 T3: 出口转译 —— typed `SearchBackendError` → `ToolExecutionError`
 * （executor 原样回灌模型的既有失败族；**不**新造错误类）。
 *
 * message 形态 `web_search failed: <kind>: <message>[ (endpoint: <domain>)]`：
 *   - `web_search failed:` 前缀与 `network-guard` 既有失败对齐；
 *   - `<kind>` 让六 kind 在模型视野里可区分（`${kind}: ...` 渲染契约，
 *     见 `code-quality.md` typed-error catch 契约）；
 *   - `endpoint` 只出域名，绝不出 key。
 * 原始 typed error 挂 `cause`，供上层调试，不进 message。
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
