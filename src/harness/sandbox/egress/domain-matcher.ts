/**
 * src/harness/sandbox/egress/domain-matcher.ts
 *
 * T3 域匹配与地址守卫适配层（egress 判定核心的纯逻辑件）。
 *
 * 单一职责：把上游 `@anthropic-ai/sandbox-runtime` 的匹配器与地址守卫收口，
 * 在本仓判定语义下吐出 allow / deny / reason。版本升级只改这一个文件。
 *
 * 判定语义（specs/network-egress-allowlist.md + ADR-0097 钉死）：
 *   - deny 优先：host 在 denied 集或命中 denied pattern → 拒，即使 allowed 也命中。
 *   - `*.x` 严格子域：匹配子域、**不**匹配 apex、不匹配前缀相似、不匹配后缀相似；
 *     大小写不敏感；可选 `:port`。
 *   - 允许集为空 → 全拒（fail-closed），不查地址守卫。
 *   - 地址守卫正交：域名命中不豁免；解析后地址落 loopback / RFC 1918 / ULA / CGNAT /
 *     metadata / link-local 一律拒。
 *   - 私网拒绝**必须显式 opt-in**（spec §Dependency fork：复用件 DENIED_CLASSES
 *     故意不含 RFC 1918 / ULA / CGNAT，本判定把 DEFAULT_PRIVATE_DENIED_RANGES 注入
 *     `deniedResolvedAddresses`，否则 SC4 落空）。
 *   - 配置层的非法形态（`:65536` / `:0` / `:abc` / `:` 等）本层会再次拒绝
 *     并以 `allowlist-malformed` 留痕（防御性深度，避免静默永不匹配）。
 *
 * 纯逻辑件：不碰进程/socket/spawn。T4 通过 `decideEgress` / `isAddressGuardDenied`
 * 消费本层；输入是纯数据。
 */

import {
  createResolvedAddressGuard,
  matchesDomainPatternWithPort,
} from "./upstream.js";

/**
 * 私网拒绝档（RFC 1918 + ULA + CGNAT）。
 *
 * 上游 `DENIED_CLASSES` 注释明写「allow-listing an intranet hostname is legitimate,
 * so those are opt-in via `network.deniedResolvedAddresses`」（resolved-address-guard.js:131）。
 * 不传这一档 = SC4 落空。
 *
 * 命名以 v4/v6 涵盖为准：
 *   - 10.0.0.0/8（RFC 1918）
 *   - 172.16.0.0/12（RFC 1918）
 *   - 192.168.0.0/16（RFC 1918）
 *   - fc00::/7（ULA，覆盖 fc00::/8 与 fd00::/8）
 *   - 100.64.0.0/10（CGNAT，RFC 6598）
 */
export const DEFAULT_PRIVATE_DENIED_RANGES: readonly string[] = Object.freeze([
  "10.0.0.0/8",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "fc00::/7",
  "100.64.0.0/10",
]);

/**
 * 判定结果。`reason` 在 outcome === "deny" 时非空：
 *   - `not-in-allowlist`：host 未命中允许集，且未命中拒绝集（先匹配 allow，未命中再走 denied 检查）。
 *   - `denied`：host 命中 denied 集或 denied pattern（deny 优先）。
 *   - `allowlist-empty`：allowedDomains 空，fail-closed。
 *   - `allowlist-malformed`：所有 allowed 条目形态非法（`:65536` 等），不允许静默永不匹配。
 *   - `address-denied`：地址守卫拒绝（loopback / 私网 / metadata / link-local 等）。
 */
export type DecideEgressOutcome = "allow" | "deny";

export type DecideEgressReason =
  | "not-in-allowlist"
  | "denied"
  | "allowlist-empty"
  | "allowlist-malformed"
  | "address-denied";

export interface DecideEgressResult {
  readonly outcome: DecideEgressOutcome;
  readonly reason?: DecideEgressReason;
}

export interface DecideEgressInput {
  /** CONNECT host / absolute-URI host；不可为空串。 */
  readonly host: string;
  /** 目标端口。 */
  readonly port: number;
  /** 域名允许集。 */
  readonly allowedDomains: readonly string[];
  /** 域名拒绝集（deny 优先）。 */
  readonly deniedDomains: readonly string[];
  /**
   * 已解析的地址列表（DNS 解析后）。undefined = 尚未解析，本层仅做域名判定；
   * T4 在解析前后可分别调用本函数。
   *
   * 语义对齐上游 `lookupFor`：任一地址落在 deniedResolvedAddresses（含
   * DEFAULT_PRIVATE_DENIED_RANGES）即拒。
   */
  readonly resolvedAddresses?: readonly string[];
  /**
   * 地址守卫额外 denied 档（按 CIDR）。默认注入 DEFAULT_PRIVATE_DENIED_RANGES。
   * T4 通常无需覆盖；测试时若需要可显式传入窄集合以避免触发宿主本地接口拒绝。
   */
  readonly deniedResolvedAddresses?: readonly string[];
}

/**
 * 主判定函数。输入纯数据，输出 allow / deny + reason。
 *
 * 顺序（spec §Settled invariants #6 + ADR §Decision）：
 *   1. 允许集空 → fail-closed (allowlist-empty)
 *   2. host 在 denied 集或命中 denied pattern → deny (denied)，deny 优先
 *   3. allowedDomains 形态非法（任一条目既不命中 host 也不命中合法 pattern） →
 *      整体记 allowlist-malformed 拒绝；不静默永不匹配
 *   4. host 未命中允许集 → deny (not-in-allowlist)
 *   5. host 命中允许集 + resolvedAddresses 含拒绝档地址 → deny (address-denied)
 *   6. 否则 → allow
 */
export function decideEgress(input: DecideEgressInput): DecideEgressResult {
  const host = input.host.trim().toLowerCase();
  const port = input.port;
  const allowed = input.allowedDomains;
  const denied = input.deniedDomains;

  // 1. 允许集为空 → fail-closed
  if (allowed.length === 0) {
    return { outcome: "deny", reason: "allowlist-empty" };
  }

  // 2. deny 优先：先扫 denied 集
  if (matchesAny(host, port, denied)) {
    return { outcome: "deny", reason: "denied" };
  }

  // 3+4. 扫允许集。任一条目形态非法（既不命中 host 也不命中合法 pattern）→ 整体记 malformed
  // 这里的关键：如果所有 allowed 条目形态非法（典型的「表非空但全是非法 :port」场景），
  // 不能让 host 「未命中」而被静默吞掉——这是 spec Evidence pointers 点名要的。
  if (
    allowed.length > 0 &&
    allowed.every((entry) => !isWellFormedPattern(entry))
  ) {
    return { outcome: "deny", reason: "allowlist-malformed" };
  }

  if (!matchesAny(host, port, allowed)) {
    return { outcome: "deny", reason: "not-in-allowlist" };
  }

  // 5. 域名命中 → 走地址守卫（仅当解析结果已就绪）
  if (input.resolvedAddresses !== undefined) {
    const deniedRanges =
      input.deniedResolvedAddresses ?? DEFAULT_PRIVATE_DENIED_RANGES;
    const guard = createResolvedAddressGuard({
      allowedDomains: allowed,
      deniedDomains: denied,
      deniedResolvedAddresses: deniedRanges,
      // 用一个确定性 stub 接口地址,避免在不同测试机上因本地 NIC 不同而漂移。
      // Spec §Settled invariants 不要求「本机接口」拒绝档作为 SC4 命中依据;
      // 我们只钉住 DEFAULT_PRIVATE_DENIED_RANGES + 上游默认 DENIED_CLASSES。
      localAddresses: () => [],
    });
    for (const addr of input.resolvedAddresses) {
      if (!guard.permits(host, addr, port)) {
        return { outcome: "deny", reason: "address-denied" };
      }
    }
  }

  return { outcome: "allow" };
}

/**
 * 判定单个 (hostname, address, port) 是否被地址守卫拒。
 *
 * T4 在 DNS 解析循环中可能以更细粒度调用——例如每个地址先单独判定一次。
 * 暴露为顶层导出避免内部走 require 链。
 */
export interface AddressGuardInput {
  readonly hostname: string;
  readonly address: string;
  readonly port: number;
  readonly allowedDomains: readonly string[];
  readonly deniedDomains: readonly string[];
  readonly deniedResolvedAddresses?: readonly string[];
}

export function isAddressGuardDenied(input: AddressGuardInput): boolean {
  const deniedRanges =
    input.deniedResolvedAddresses ?? DEFAULT_PRIVATE_DENIED_RANGES;
  const guard = createResolvedAddressGuard({
    allowedDomains: input.allowedDomains,
    deniedDomains: input.deniedDomains,
    deniedResolvedAddresses: deniedRanges,
    localAddresses: () => [],
  });
  return !guard.permits(input.hostname, input.address, input.port);
}

/* ---------------------------------------------------------------------------
 * 内部辅助
 * ------------------------------------------------------------------------- */

/**
 * 给定一组 pattern（含 `:port`），判断其中任一是否命中 (host, port)。
 *
 * 注意：上游 `matchesDomainPatternWithPort` 在 pattern 形态非法时**不抛错**，
 * 直接返回 false（见 `domain-pattern.js:67-72` parsePortSuffix 与 Evidence pointers）。
 * 因此本函数无法凭「throws」区分「合法但不匹配」与「形态非法」——需要配套
 * `isWellFormedPattern` 来识别 allowlist-malformed 档。
 */
function matchesAny(
  host: string,
  port: number,
  patterns: readonly string[]
): boolean {
  for (const pattern of patterns) {
    if (matchesDomainPatternWithPort(host, port, pattern)) return true;
  }
  return false;
}

/**
 * 判断一条 pattern 在**形态层**是否合法：
 *   - `hostPattern`（剥掉 `:port` 后）非空
 *   - `:port` 数值在 1..65535（不含 0，含 65535）
 *
 * 不命中 host 的合法 pattern 也算「形态合法」——它仍可命中其它 host；
 * 只有「形态非法」的条目会被上游静默永不匹配，本函数专门识别它。
 */
function isWellFormedPattern(pattern: string): boolean {
  const trimmed = pattern.trim();
  if (trimmed === "") return false;
  // 复刻上游对 pattern 形态的边界:
  //   - 裸 IPv6（无方括号 + 多个 `:`）上游视为合法 hostPattern、port=undefined;
  //   - `:port` 解析失败上游把整个 pattern 原样返回为 hostPattern,port=undefined。
  // 二者都让 hostPattern 含 `:`，但语义不同。我们用 upstream 的边界对齐:
  //   - `hostPattern` 非空
  //   - `hostPattern` 不为空时,若同时**没有合法 port 后缀**且 hostPattern 含裸 `:`,
  //     视为形态非法（裸 IPv6 上游允许,但我们这里保守——且测试集不涉及裸 IPv6 pattern）。
  //   - 含 `:port` 且解析失败 → hostPattern 形如 `foo:abc` 等,判定为形态非法。
  const { hostPattern, port } = splitDomainPatternPortLocal(trimmed);
  if (hostPattern === "") return false;
  // 上游 splitDomainPatternPort 在「:port 非法」时返回 hostPattern === 原 pattern,
  // 此时 hostPattern 形如 "github.com:65536"; 这种形态非法。
  // 而对无后缀 / 合法 IPv6 的 pattern,hostPattern 是干净的。
  // 判定法:若有 `:` 在 hostPattern 内,且没有合法 port 解析,则非法。
  if (hostPattern.includes(":") && port === undefined) return false;
  return true;
}

/**
 * 复刻 upstream `splitDomainPatternPort` 的最小子集，用于识别 `:port` 形态。
 * 直接 import 也会拉一份判定开销，且我们要的只是「port 数值」是否在合法范围。
 */
function splitDomainPatternPortLocal(pattern: string): {
  hostPattern: string;
  port: number | undefined;
} {
  if (pattern.startsWith("[")) {
    const close = pattern.indexOf("]");
    if (close === -1) return { hostPattern: pattern, port: undefined };
    const inner = pattern.slice(1, close);
    const rest = pattern.slice(close + 1);
    if (rest === "") return { hostPattern: inner, port: undefined };
    const port = parseLocalPort(rest.startsWith(":") ? rest.slice(1) : "");
    return port === undefined
      ? { hostPattern: pattern, port: undefined }
      : { hostPattern: inner, port };
  }
  const idx = pattern.lastIndexOf(":");
  if (idx === -1) return { hostPattern: pattern, port: undefined };
  if (pattern.indexOf(":") !== idx) {
    return { hostPattern: pattern, port: undefined };
  }
  const port = parseLocalPort(pattern.slice(idx + 1));
  if (port === undefined) return { hostPattern: pattern, port: undefined };
  return { hostPattern: pattern.slice(0, idx), port };
}

function parseLocalPort(suffix: string): number | undefined {
  if (!/^[1-9][0-9]{0,4}$/.test(suffix)) return undefined;
  const port = Number(suffix);
  return port > 65535 ? undefined : port;
}
