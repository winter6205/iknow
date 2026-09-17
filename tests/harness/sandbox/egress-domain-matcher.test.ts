/**
 * Tests for `egress/domain-matcher.ts` — T3 域匹配与地址守卫适配层。
 *
 * 钉住的不变式（来自 specs/network-egress-allowlist.md + ADR-0097）：
 *   - 纯逻辑件，无 IO；输入 (host, port, resolvedAddresses?) 输出 allow | deny | reason。
 *   - deny 优先：host 在 denied 集或命中 denied pattern → 拒，即使 allowed 也命中。
 *   - `*.example.com` 严格子域：匹配子域、**不**匹配 apex、不匹配前缀相似、不匹配后缀相似。
 *   - 大小写不敏感。
 *   - `:port` 合法：仅匹配该端口；不带 port 的 pattern 匹配任意端口。
 *   - `:port` 非法到达本层（`65536` / `0` / `abc` / 空）→ 拒绝并留痕（不静默永不匹配）。
 *   - 允许集为空 → 全拒（fail-closed），不查地址守卫。
 *   - 地址守卫正交：域名命中 + 私网地址 → 拒；注入 `deniedResolvedAddresses` 须实测生效
 *     （含 RFC 1918 / ULA / CGNAT，既非上游默认拒绝档）。
 *
 * 这一文件**不**触碰 bwrap / bash / settings；T4 在测试通过后接该判定函数。
 */

import { describe, it, expect } from "vitest";
import {
  decideEgress,
  isAddressGuardDenied,
  DEFAULT_PRIVATE_DENIED_RANGES,
} from "../../../src/harness/sandbox/egress/domain-matcher.js";

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
    // 即使解析到 loopback,空 allowed 已 fail-closed,reason 应是 allowlist-empty
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
    // *.example.com 允许 *.example.com,但 denied 集里 *.example.com 应覆盖之
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
  // 配置层（T2）本应在 :65536 之类的非法形态到达本层前就拒掉。
  // 但本层必须自身也能正确处置（防御性深度）——不留静默永不匹配的空档。
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
    // 行为：拒绝该次请求（域名未匹配），而不是让 pattern 像不存在一样 → allowlist-empty 仅当整张表空时；
    // 这里表非空但每条都非法 → 整张 allowedDomains 无效 → fail-closed。
    expect(result.outcome).toBe("deny");
    expect(result.reason).toBe("allowlist-malformed");
  });
});

describe("decideEgress — 地址守卫正交", () => {
  // SC4：域名命中 + 私网地址 → 拒。
  // 注：本层仅裁决「允不允许这个 (host, port, addresses) 组合出站」。
  // T4 接入时会在 DNS 解析后调用本判定；若 resolvedAddresses 已含全部解析结果，
  // 本判定按 OR 拒绝（任一地址落在 deniedResolvedAddresses 即拒，与上游语义对齐）。
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
    // T4 可能在解析前先做一次快速域名判定；解析后再二次判定。
    // 这里要确保：未传 resolvedAddresses 时仍按域名允许集走。
    const result = decideEgress({
      host: "github.com",
      port: 443,
      allowedDomains: allowed,
      deniedDomains: denied,
    });
    expect(result.outcome).toBe("allow");
  });
});

describe("DEFAULT_PRIVATE_DENIED_RANGES", () => {
  // 钉住 SC4 落地前提：deniedResolvedAddresses 须含 RFC 1918 + ULA + CGNAT（spec/ADR 显式要求 opt-in）
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
  // T4 可能在解析链路中以更细粒度调用：判定单个 host+address+port 是否被地址守卫拒。
  // 该函数仅做地址守卫层判定，不重复 allowlist 域名匹配（T4 应另走 decideEgress）。
  //
  // 上游契约（resolved-address-guard.d.ts:64-67）：
  //   - "Always true when hostname is itself an IP literal" —— IP 字面量作 hostname
  //   时地址守卫恒为 allow（视为显式选择,不再二次判定）。
  //   - name → IP 走完整 DENIED_CLASSES + deniedResolvedAddresses。
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
