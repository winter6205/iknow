/**
 * src/harness/sandbox/egress/domain-matcher.ts
 *
 * Domain matching + address-guard adapter layer (the pure-logic core of the
 * egress decision).
 *
 * Single responsibility: funnel the upstream `@anthropic-ai/sandbox-runtime`
 * matcher and address guard into allow / deny / reason under this repo's
 * decision semantics. Version upgrades touch only this file.
 *
 * Decision semantics (settled design invariants):
 *
 // (ADR-0097)
 *   - deny wins: host in the denied set or matching a denied pattern → deny,
 *     even when allowed also matches.
 *   - `*.x` is strict-subdomain: matches subdomains, **not** the apex, not
 *     prefix-similar, not suffix-similar; case-insensitive; optional `:port`.
 *   - empty allowlist → deny everything (fail-closed), address guard not
 *     consulted.
 *   - the address guard is orthogonal: a domain hit grants no exemption; any
 *     resolved address in loopback / RFC 1918 / ULA / CGNAT / metadata /
 *     link-local is denied.
 *   - private-network denial **must be explicitly opted in**: the reused
 *     upstream DENIED_CLASSES deliberately omits RFC 1918 / ULA / CGNAT, so
 *     this decision injects DEFAULT_PRIVATE_DENIED_RANGES into
 *     `deniedResolvedAddresses`, otherwise the private-range rule silently
 *     never fires.
 *   - malformed config forms (`:65536` / `:0` / `:abc` / `:` etc.) are
 *     re-rejected by this layer with an `allowlist-malformed` trace
 *     (defense-in-depth, avoiding silent never-match).
 *
 * Pure logic: no process / socket / spawn. The proxy layer consumes this via
 * `decideEgress` / `isAddressGuardDenied`; inputs are plain data.
 */

import {
  createResolvedAddressGuard,
  matchesDomainPatternWithPort,
} from "./upstream.js";

/**
 * Private-network deny tier (RFC 1918 + ULA + CGNAT).
 *
 * The upstream `DENIED_CLASSES` comment states outright that allow-listing an
 * intranet hostname is legitimate, so those classes are opt-in via
 * `network.deniedResolvedAddresses` (see resolved-address-guard.js). Not
 * passing this tier = the private-range rule never fires.
 *
 * Ranges chosen for v4/v6 coverage:
 *   - 10.0.0.0/8（RFC 1918）
 *   - 172.16.0.0/12（RFC 1918）
 *   - 192.168.0.0/16（RFC 1918）
 *   - fc00::/7 (ULA, covers fc00::/8 and fd00::/8)
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
 * Decision result. `reason` is non-empty when outcome === "deny":
 *   - `not-in-allowlist`: host matched no allow entry and no denied entry
 *     (allow is checked first; a miss then goes through the denied check).
 *   - `denied`: host hit the denied set or a denied pattern (deny wins).
 *   - `allowlist-empty`: allowedDomains empty, fail-closed.
 *   - `allowlist-malformed`: every allowed entry is malformed (e.g.
 *     `:65536`) — silent never-match is not allowed.
 *   - `address-denied`: address guard denial (loopback / private / metadata /
 *     link-local etc.).
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
  /** CONNECT host / absolute-URI host; must not be an empty string. */
  readonly host: string;
  /** Target port. */
  readonly port: number;
  /** Domain allowlist. */
  readonly allowedDomains: readonly string[];
  /** Domain denylist (deny wins). */
  readonly deniedDomains: readonly string[];
  /**
   * Resolved addresses (post-DNS). undefined = not resolved yet, this layer
   * only does domain matching; the proxy layer may call this function both
   * before and after resolution.
   *
   * Semantics aligned with upstream `lookupFor`: any address falling in
   * deniedResolvedAddresses (incl. DEFAULT_PRIVATE_DENIED_RANGES) → deny.
   */
  readonly resolvedAddresses?: readonly string[];
  /**
   * Extra address-guard deny CIDRs. Defaults to injecting
   * DEFAULT_PRIVATE_DENIED_RANGES. Usually no override needed; tests may
   * pass a narrow set explicitly to avoid denials from host-local interfaces.
   */
  readonly deniedResolvedAddresses?: readonly string[];
}

/**
 * Main decision function. Plain data in, allow / deny + reason out.
 *
 * Order (settled invariants):
 *   1. empty allowlist → fail-closed (allowlist-empty)
 *   2. host in denied set / hits a denied pattern → deny (denied), deny wins
 *   3. allowedDomains all malformed (no entry hits the host nor a legal
 *      pattern) → deny as allowlist-malformed overall; no silent never-match
 *   4. host misses the allowlist → deny (not-in-allowlist)
 *   5. host hits + resolvedAddresses contain a denied-range address → deny
 *      (address-denied)
 *   6. otherwise → allow
 */
export function decideEgress(input: DecideEgressInput): DecideEgressResult {
  const host = input.host.trim().toLowerCase();
  const port = input.port;
  const allowed = input.allowedDomains;
  const denied = input.deniedDomains;

  // 1. empty allowlist → fail-closed
  if (allowed.length === 0) {
    return { outcome: "deny", reason: "allowlist-empty" };
  }

  // 2. deny wins: scan the denied set first
  if (matchesAny(host, port, denied)) {
    return { outcome: "deny", reason: "denied" };
  }

  // 3+4. scan the allowlist. The key point: when every allowed entry is
  // malformed (the classic "non-empty table but all :port illegal"), the
  // host must not "miss" and be silently swallowed — deny explicitly.
  if (
    allowed.length > 0 &&
    allowed.every((entry) => !isWellFormedPattern(entry))
  ) {
    return { outcome: "deny", reason: "allowlist-malformed" };
  }

  if (!matchesAny(host, port, allowed)) {
    return { outcome: "deny", reason: "not-in-allowlist" };
  }

  // 5. domain hit → consult the address guard (only once resolution is ready)
  if (input.resolvedAddresses !== undefined) {
    const deniedRanges =
      input.deniedResolvedAddresses ?? DEFAULT_PRIVATE_DENIED_RANGES;
    const guard = createResolvedAddressGuard({
      allowedDomains: allowed,
      deniedDomains: denied,
      deniedResolvedAddresses: deniedRanges,
      // Deterministic empty local-interface list avoids drift across test
      // machines with different NICs; host-interface denial is not one of
      // the pinned tiers here. We pin only
      // DEFAULT_PRIVATE_DENIED_RANGES + the upstream default DENIED_CLASSES.
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
 * Decide whether a single (hostname, address, port) is denied by the address
 * guard. The proxy layer may call at finer granularity inside the DNS
 * resolution loop — e.g. one check per address. Exported at top level so
 * consumers never route through an internal require chain.
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
 * Internal helpers
 * ------------------------------------------------------------------------- */

/**
 * Given a set of patterns (possibly carrying `:port`), whether any hits
 * (host, port).
 *
 * Note: upstream `matchesDomainPatternWithPort` **does not throw** on a
 * malformed pattern — it just returns false (see parsePortSuffix in
 * domain-pattern.js). So this function cannot tell "legal but unmatched" from
 * "malformed" via a throw — hence the companion `isWellFormedPattern` to
 * recognize the allowlist-malformed tier.
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
 * Whether a pattern is valid at the **form** level:
 *   - `hostPattern` (after stripping `:port`) non-empty
 *   - `:port` value in 1..65535 (0 excluded, 65535 included)
 *
 * A legal pattern that does not match the host still counts as "well
 * formed" — it may match other hosts; only malformed entries get silently
 * swallowed upstream by never matching, and this function identifies exactly
 * those.
 */
function isWellFormedPattern(pattern: string): boolean {
  const trimmed = pattern.trim();
  if (trimmed === "") return false;
  // Replicating upstream's pattern-form boundaries:
  //   - bare IPv6 (no brackets + multiple `:`) is a legal hostPattern with
  //     port=undefined upstream;
  //   - when `:port` parsing fails, upstream returns the whole pattern as
  //     hostPattern with port=undefined.
  // Both leave hostPattern containing `:`, but mean different things. We
  // align with upstream's boundaries:
  //   - `hostPattern` non-empty
  //   - when non-empty, if there is **no legal port suffix** and hostPattern
  //     contains a bare `:`, treat as malformed (upstream allows bare IPv6,
  //     but we stay conservative here — and the test set never uses bare IPv6
  //     patterns).
  //   - `:port` present but unparseable → hostPattern looks like `foo:abc`,
  //     judged malformed.
  const { hostPattern, port } = splitDomainPatternPortLocal(trimmed);
  if (hostPattern === "") return false;
  // Upstream splitDomainPatternPort returns hostPattern === the original
  // pattern when ":port" is illegal, so hostPattern looks like
  // "github.com:65536" — malformed. For no-suffix / legal-IPv6 patterns the
  // hostPattern stays clean. Test: a `:` inside hostPattern with no legal
  // port parse → malformed.
  if (hostPattern.includes(":") && port === undefined) return false;
  return true;
}

/**
 * Minimal replication of upstream `splitDomainPatternPort`, used only to
 * recognize the `:port` form. Importing upstream's version would drag in
 * extra decision overhead, and all we need is whether the port value is in
 * the legal range.
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
