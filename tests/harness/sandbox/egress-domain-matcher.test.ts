/**
 * Tests for `egress/domain-matcher.ts` — domain matching + address guard
 * adapter layer.
 *
 * Pinned invariants (from specs/network-egress-allowlist.md + ADR-0097):
 *   - pure logic, no IO; input (host, port, resolvedAddresses?) → output
 *     allow | deny | reason.
 *   - deny precedence: host in the denied set or hitting a denied pattern →
 *     deny, even when allowed also matches.
 *   - `*.example.com` is strict-subdomain: matches subdomains, **not** the
 *     apex, not prefix-similar, not suffix-similar.
 *   - case insensitive.
 *   - `:port` is legal: matches only that port; a pattern without a port
 *     matches every port.
 *   - an illegal `:port` that reaches this layer (`65536` / `0` / `abc` /
 *     empty) → refuse with a trace (never silently "matches nothing").
 *   - empty allowlist → deny everything (fail-closed), address guard not
 *     consulted.
 *   - address guard is orthogonal: domain hit + private address → deny; an
 *     injected `deniedResolvedAddresses` must actually take effect (covering
 *     RFC 1918 / ULA / CGNAT, none of which are upstream's default-denied set).
 *
 * This file does **not** touch bwrap / bash / settings; downstream faces wire
 * up this decision function once these tests pass.
 */

import { describe, it, expect } from "vitest";
import {
  decideEgress,
  isAddressGuardDenied,
  DEFAULT_PRIVATE_DENIED_RANGES,
} from "../../../src/harness/sandbox/egress/domain-matcher.js";
import { BUILTIN_PRESET_ALLOWED_DOMAINS } from "../../../src/harness/sandbox/egress/preset-domains.js";

describe("decideEgress — 域名匹配", () => {
  it("精确匹配 allow list 中的域名", () => {
    const result = decideEgress({
      host: "github.com",
      port: 443,
      allowedDomains: ["github.com"],
      deniedDomains: [],
    });
    expect(result.outcome).toBe("allow");
  });

  it("大小写不敏感", () => {
    const lower = decideEgress({
      host: "github.com",
      port: 443,
      allowedDomains: ["GitHub.COM"],
      deniedDomains: [],
    });
    const upper = decideEgress({
      host: "GitHub.com",
      port: 443,
      allowedDomains: ["github.com"],
      deniedDomains: [],
    });
    expect(lower.outcome).toBe("allow");
    expect(upper.outcome).toBe("allow");
  });

  it("未命中允许集 → deny", () => {
    const result = decideEgress({
      host: "evil.example.com",
      port: 443,
      allowedDomains: ["github.com"],
      deniedDomains: [],
    });
    expect(result.outcome).toBe("deny");
    expect(result.reason).toBe("not-in-allowlist");
  });

  it("空 allowedDomains → 全拒 (fail-closed)", () => {
    const result = decideEgress({
      host: "github.com",
      port: 443,
      allowedDomains: [],
      deniedDomains: [],
    });
    expect(result.outcome).toBe("deny");
    expect(result.reason).toBe("allowlist-empty");
  });

  it("空 allowedDomains 时不查地址守卫（即便传了 resolvedAddresses）", () => {
    // even though it resolves to loopback, an empty allowlist is already fail-closed and the reason should be allowlist-empty
    const result = decideEgress({
      host: "github.com",
      port: 443,
      allowedDomains: [],
      deniedDomains: [],
      resolvedAddresses: ["127.0.0.1"],
    });
    expect(result.reason).toBe("allowlist-empty");
  });
});

describe("decideEgress — deny 优先", () => {
  it("host 同时在 allow 与 deny → deny (denied 优先)", () => {
    const result = decideEgress({
      host: "evil.example.com",
      port: 443,
      allowedDomains: ["*.example.com"],
      deniedDomains: ["evil.example.com"],
    });
    expect(result.outcome).toBe("deny");
    expect(result.reason).toBe("denied");
  });

  it("host 命中 allowed pattern 但 pattern 形式在 denied 集也命中 → deny", () => {
    // *.example.com allows subdomains, but the same pattern in the denied set must override it
    const result = decideEgress({
      host: "api.example.com",
      port: 443,
      allowedDomains: ["*.example.com"],
      deniedDomains: ["*.example.com"],
    });
    expect(result.outcome).toBe("deny");
    expect(result.reason).toBe("denied");
  });
});

describe("decideEgress — `*.x` 严格子域语义（四向）", () => {
  const allowed = ["*.example.com"];

  it("子域命中", () => {
    expect(
      decideEgress({
        host: "api.example.com",
        port: 443,
        allowedDomains: allowed,
        deniedDomains: [],
      }).outcome
    ).toBe("allow");
    expect(
      decideEgress({
        host: "a.b.example.com",
        port: 443,
        allowedDomains: allowed,
        deniedDomains: [],
      }).outcome
    ).toBe("allow");
  });

  it("apex 不命中", () => {
    expect(
      decideEgress({
        host: "example.com",
        port: 443,
        allowedDomains: allowed,
        deniedDomains: [],
      }).outcome
    ).toBe("deny");
  });

  it("前缀相似不命中 (evilexample.com)", () => {
    expect(
      decideEgress({
        host: "evilexample.com",
        port: 443,
        allowedDomains: allowed,
        deniedDomains: [],
      }).outcome
    ).toBe("deny");
  });

  it("后缀相似不命中 (example.com.evil.com)", () => {
    expect(
      decideEgress({
        host: "example.com.evil.com",
        port: 443,
        allowedDomains: allowed,
        deniedDomains: [],
      }).outcome
    ).toBe("deny");
  });
});

describe("decideEgress — :port 合法匹配", () => {
  it("pattern 带 port 时仅匹配该端口", () => {
    const allowed = ["github.com:443"];
    expect(
      decideEgress({
        host: "github.com",
        port: 443,
        allowedDomains: allowed,
        deniedDomains: [],
      }).outcome
    ).toBe("allow");
    expect(
      decideEgress({
        host: "github.com",
        port: 80,
        allowedDomains: allowed,
        deniedDomains: [],
      }).outcome
    ).toBe("deny");
  });

  it("pattern 不带 port 时匹配任意端口", () => {
    const allowed = ["github.com"];
    expect(
      decideEgress({
        host: "github.com",
        port: 22,
        allowedDomains: allowed,
        deniedDomains: [],
      }).outcome
    ).toBe("allow");
    expect(
      decideEgress({
        host: "github.com",
        port: 65535,
        allowedDomains: allowed,
        deniedDomains: [],
      }).outcome
    ).toBe("allow");
  });

  it(":port 配合 *. 通配", () => {
    const allowed = ["*.example.com:443"];
    expect(
      decideEgress({
        host: "api.example.com",
        port: 443,
        allowedDomains: allowed,
        deniedDomains: [],
      }).outcome
    ).toBe("allow");
    expect(
      decideEgress({
        host: "api.example.com",
        port: 80,
        allowedDomains: allowed,
        deniedDomains: [],
      }).outcome
    ).toBe("deny");
  });
});

describe("decideEgress — :port 非法到达本层", () => {
  // The config layer should reject illegal shapes like :65536 before they reach
  // this layer, but this layer must still handle them correctly (defensive depth)
  // — no silently-never-matching gap.
  it.each([
    { pattern: "github.com:65536", label: "65536 上界越界" },
    { pattern: "github.com:0", label: "0 下界越界" },
    { pattern: "github.com:abc", label: "非数字" },
    { pattern: "github.com:", label: "空端口" },
  ])(":65536 / :0 / :abc / : 不静默永不匹配 ($label)", ({ pattern }) => {
    const result = decideEgress({
      host: "github.com",
      port: 443,
      allowedDomains: [pattern],
      deniedDomains: [],
    });
    // Behavior: refuse this request (domain unmatched) rather than let the pattern
    // act as if absent; allowlist-empty applies only to a wholly empty table —
    // here the table is non-empty yet every entry is illegal, so the whole
    // allowedDomains is invalid → fail-closed.
    expect(result.outcome).toBe("deny");
    expect(result.reason).toBe("allowlist-malformed");
  });
});

describe("decideEgress — 地址守卫正交", () => {
  // Domain hit + private address → deny.
  // Note: this layer only adjudicates whether this (host, port, addresses) combo
  // may egress. It is called after DNS resolution; when resolvedAddresses carries
  // all results, denial is OR-joined (any address in deniedResolvedAddresses
  // denies, aligned with upstream semantics).
  const allowed = ["github.com"];
  const denied = [] as string[];

  it("域名命中 + 所有地址为合法公网 → allow", () => {
    const result = decideEgress({
      host: "github.com",
      port: 443,
      allowedDomains: allowed,
      deniedDomains: denied,
      resolvedAddresses: ["140.82.121.4"],
    });
    expect(result.outcome).toBe("allow");
  });

  it("域名命中 + 任一地址为 loopback → deny", () => {
    const result = decideEgress({
      host: "github.com",
      port: 443,
      allowedDomains: allowed,
      deniedDomains: denied,
      resolvedAddresses: ["127.0.0.1"],
    });
    expect(result.outcome).toBe("deny");
    expect(result.reason).toBe("address-denied");
  });

  it("域名命中 + 任一地址为 RFC 1918 (10/8) → deny", () => {
    const result = decideEgress({
      host: "github.com",
      port: 443,
      allowedDomains: allowed,
      deniedDomains: denied,
      resolvedAddresses: ["10.0.0.1"],
    });
    expect(result.outcome).toBe("deny");
    expect(result.reason).toBe("address-denied");
  });

  it("域名命中 + 任一地址为 RFC 1918 (192.168/16) → deny", () => {
    const result = decideEgress({
      host: "github.com",
      port: 443,
      allowedDomains: allowed,
      deniedDomains: denied,
      resolvedAddresses: ["192.168.1.1"],
    });
    expect(result.outcome).toBe("deny");
    expect(result.reason).toBe("address-denied");
  });

  it("域名命中 + 任一地址为 RFC 1918 (172.16/12) → deny", () => {
    const result = decideEgress({
      host: "github.com",
      port: 443,
      allowedDomains: allowed,
      deniedDomains: denied,
      resolvedAddresses: ["172.16.0.1"],
    });
    expect(result.outcome).toBe("deny");
    expect(result.reason).toBe("address-denied");
  });

  it("域名命中 + 任一地址为 ULA (fc00::/7) → deny", () => {
    const result = decideEgress({
      host: "github.com",
      port: 443,
      allowedDomains: allowed,
      deniedDomains: denied,
      resolvedAddresses: ["fc00::1"],
    });
    expect(result.outcome).toBe("deny");
    expect(result.reason).toBe("address-denied");
  });

  it("域名命中 + 任一地址为 CGNAT (100.64/10) → deny", () => {
    const result = decideEgress({
      host: "github.com",
      port: 443,
      allowedDomains: allowed,
      deniedDomains: denied,
      resolvedAddresses: ["100.64.0.1"],
    });
    expect(result.outcome).toBe("deny");
    expect(result.reason).toBe("address-denied");
  });

  it("域名命中 + 任一地址为 metadata (169.254.169.254) → deny", () => {
    const result = decideEgress({
      host: "github.com",
      port: 443,
      allowedDomains: allowed,
      deniedDomains: denied,
      resolvedAddresses: ["169.254.169.254"],
    });
    expect(result.outcome).toBe("deny");
    expect(result.reason).toBe("address-denied");
  });

  it("域名命中 + 任一地址为 link-local v6 (fe80::/10) → deny", () => {
    const result = decideEgress({
      host: "github.com",
      port: 443,
      allowedDomains: allowed,
      deniedDomains: denied,
      resolvedAddresses: ["fe80::1"],
    });
    expect(result.outcome).toBe("deny");
    expect(result.reason).toBe("address-denied");
  });

  it("域名命中 + 多地址混合 (公网 + loopback) → deny", () => {
    const result = decideEgress({
      host: "github.com",
      port: 443,
      allowedDomains: allowed,
      deniedDomains: denied,
      resolvedAddresses: ["140.82.121.4", "127.0.0.1"],
    });
    expect(result.outcome).toBe("deny");
    expect(result.reason).toBe("address-denied");
  });

  it("未传 resolvedAddresses 时仅做域名判定", () => {
    // Consumers may do a fast domain-only pass before resolution and re-check after.
    // Ensure: with no resolvedAddresses passed, the domain allowlist still decides.
    const result = decideEgress({
      host: "github.com",
      port: 443,
      allowedDomains: allowed,
      deniedDomains: denied,
    });
    expect(result.outcome).toBe("allow");
  });
});

describe("decideEgress — F5: preset 域命中不豁免地址守卫（rebinding）", () => {
  // spec egress-preset-allowlist invariant 5: swapping the allowlist to the
  // builtin preset must not shrink address-guard orthogonality — a preset-hit
  // domain that rebinding resolves to loopback / private / metadata is still
  // denied (address-denied).
  // Unlike the "address guard" section above, allowedDomains consumes the preset
  // SSOT constant directly, pinning the real shipped merged set rather than a
  // hand-written single-domain table.
  const preset = BUILTIN_PRESET_ALLOWED_DOMAINS;

  it("对照：preset 域 + 公网地址 → allow（证明拒绝源自地址档而非域表）", () => {
    expect(
      decideEgress({
        host: "github.com",
        port: 443,
        allowedDomains: preset,
        deniedDomains: [],
        resolvedAddresses: ["140.82.121.4"],
      })
    ).toEqual({ outcome: "allow" });
  });

  it("preset apex github.com rebinding 到 loopback → address-denied", () => {
    const result = decideEgress({
      host: "github.com",
      port: 443,
      allowedDomains: preset,
      deniedDomains: [],
      resolvedAddresses: ["127.0.0.1"],
    });
    expect(result.outcome).toBe("deny");
    expect(result.reason).toBe("address-denied");
  });

  it("preset 通配子域 objects.githubusercontent.com → 私网 10/8 → address-denied", () => {
    const result = decideEgress({
      host: "objects.githubusercontent.com",
      port: 443,
      allowedDomains: preset,
      deniedDomains: [],
      resolvedAddresses: ["10.1.2.3"],
    });
    expect(result.outcome).toBe("deny");
    expect(result.reason).toBe("address-denied");
  });

  it("preset registry.npmjs.org → metadata 169.254.169.254 → address-denied", () => {
    const result = decideEgress({
      host: "registry.npmjs.org",
      port: 443,
      allowedDomains: preset,
      deniedDomains: [],
      resolvedAddresses: ["169.254.169.254"],
    });
    expect(result.outcome).toBe("deny");
    expect(result.reason).toBe("address-denied");
  });

  it("preset cdn.playwright.dev → 192.168/16 → address-denied", () => {
    const result = decideEgress({
      host: "cdn.playwright.dev",
      port: 443,
      allowedDomains: preset,
      deniedDomains: [],
      resolvedAddresses: ["192.168.0.1"],
    });
    expect(result.outcome).toBe("deny");
    expect(result.reason).toBe("address-denied");
  });

  it("preset 域多地址混合（公网 + ULA v6）→ address-denied（任一命中即拒）", () => {
    const result = decideEgress({
      host: "github.com",
      port: 443,
      allowedDomains: preset,
      deniedDomains: [],
      resolvedAddresses: ["140.82.121.4", "fd12:3456::1"],
    });
    expect(result.outcome).toBe("deny");
    expect(result.reason).toBe("address-denied");
  });
});

describe("DEFAULT_PRIVATE_DENIED_RANGES", () => {
  // Pin the landing precondition: deniedResolvedAddresses must cover RFC 1918 + ULA + CGNAT (spec/ADR require an explicit opt-in)
  it("RFC 1918 三段均在内", () => {
    expect(DEFAULT_PRIVATE_DENIED_RANGES).toContain("10.0.0.0/8");
    expect(DEFAULT_PRIVATE_DENIED_RANGES).toContain("172.16.0.0/12");
    expect(DEFAULT_PRIVATE_DENIED_RANGES).toContain("192.168.0.0/16");
  });
  it("ULA 在内", () => {
    expect(DEFAULT_PRIVATE_DENIED_RANGES).toContain("fc00::/7");
  });
  it("CGNAT 在内", () => {
    expect(DEFAULT_PRIVATE_DENIED_RANGES).toContain("100.64.0.0/10");
  });
});

describe("isAddressGuardDenied — 纯函数暴露", () => {
  // Resolution paths may call at finer granularity: is one host+address+port
  // combo denied by the address guard? This function performs only the
  // guard-layer decision and does not duplicate allowlist domain matching
  // (callers should route through decideEgress separately).
  //
  // Upstream contract (resolved-address-guard.d.ts):
  //   - "Always true when hostname is itself an IP literal" — with an IP
  //   literal as hostname the guard outcome is always allow (an explicit
  //   choice, not re-adjudicated).
  //   - name → IP goes through the full DENIED_CLASSES + deniedResolvedAddresses.
  it("hostname literal (IP) 即使落在 RFC 1918 → allow (上游 IP 显式选择契约)", () => {
    expect(
      isAddressGuardDenied({
        hostname: "10.0.0.1",
        address: "10.0.0.1",
        port: 443,
        allowedDomains: [],
        deniedDomains: [],
      })
    ).toBe(false);
  });

  it("hostname literal (IP) 为公网 → allow", () => {
    expect(
      isAddressGuardDenied({
        hostname: "140.82.121.4",
        address: "140.82.121.4",
        port: 443,
        allowedDomains: [],
        deniedDomains: [],
      })
    ).toBe(false);
  });

  it("hostname (name) 解析到 loopback → deny", () => {
    expect(
      isAddressGuardDenied({
        hostname: "github.com",
        address: "127.0.0.1",
        port: 443,
        allowedDomains: [],
        deniedDomains: [],
      })
    ).toBe(true);
  });

  it("hostname (name) 解析到 RFC 1918 → deny", () => {
    expect(
      isAddressGuardDenied({
        hostname: "github.com",
        address: "10.0.0.1",
        port: 443,
        allowedDomains: [],
        deniedDomains: [],
      })
    ).toBe(true);
  });

  it("hostname (name) 解析到公网 → allow", () => {
    expect(
      isAddressGuardDenied({
        hostname: "github.com",
        address: "140.82.121.4",
        port: 443,
        allowedDomains: [],
        deniedDomains: [],
      })
    ).toBe(false);
  });

  it("hostname (name) 解析到 ULA → deny", () => {
    expect(
      isAddressGuardDenied({
        hostname: "github.com",
        address: "fc00::1",
        port: 443,
        allowedDomains: [],
        deniedDomains: [],
      })
    ).toBe(true);
  });

  it("hostname (name) 解析到 metadata → deny", () => {
    expect(
      isAddressGuardDenied({
        hostname: "github.com",
        address: "169.254.169.254",
        port: 443,
        allowedDomains: [],
        deniedDomains: [],
      })
    ).toBe(true);
  });
});
