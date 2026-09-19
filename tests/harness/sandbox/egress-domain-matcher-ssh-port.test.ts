/**
 * Tests for `egress/domain-matcher.ts` — SSH 域判定语义钉子（specs/egress-ssh-bridge.md T4 / SC4）。
 *
 * 钉住的不变式：
 *   - assumption 6（引文 domain-pattern.js:106-114，与本 spec 对齐）：「A pattern
 *     without a port matches every port」⇒ preset 的裸 host 条目已覆盖 :22 / :443，
 *     preset 清单无需任何 `:port` 形态条目（零改动结论）。
 *   - invariant 5：批准 / 违例 / 地址守卫的判定输入恒为 (host, port) 纯数据；
 *     `:22` 不引入新配置形态。
 *   - deny 优先无端口例外：host 进 deniedDomains 后 :22 同拒。
 *
 * 测试用显式 policy 输入喂条目（镜像 ADR-0104 preset 形状），不 import preset 模块：
 * preset 清单是并行 PR，本分支上不存在，判定语义不依赖其装配面。
 *
 * 零生产码改动：本文件是唯一 Surface。若「ssh-port-inherits-bare-host-entry」
 * 转红 = 上游 `matchesDomainPatternWithPort` 升版改语义，唯一改动点是
 * `upstream.ts` 适配层（0097 Dependency fork 纪律），并按 assumption 6 回改
 * specs/egress-ssh-bridge.md，不改 preset spec。
 */

import { describe, it, expect } from "vitest";
import { decideEgress } from "../../../src/harness/sandbox/egress/domain-matcher.js";

/**
 * ADR-0104 preset 六域的**形状镜像**：全部裸 host 条目，零 `:port` 形态。
 * 这是显式测试输入，非对 preset 模块的依赖（后者不在本分支）。
 */
const PRESET_SHAPE_ALLOWED: readonly string[] = [
  "github.com",
  "*.github.com",
  "*.githubusercontent.com",
  "registry.npmjs.org",
  "playwright.download.prss.microsoft.com",
  "cdn.playwright.dev",
];

describe("decideEgress — SSH 域判定四态（spec T4 表）", () => {
  const table = [
    {
      name: "github.com:22 → allow（裸条目匹任意端口，assumption 6）",
      host: "github.com",
      port: 22,
      deniedDomains: [] as string[],
      outcome: "allow" as const,
      reason: undefined,
    },
    {
      name: "ssh.github.com:443 → allow（命中 *.github.com 严格子域）",
      host: "ssh.github.com",
      port: 443,
      deniedDomains: [] as string[],
      outcome: "allow" as const,
      reason: undefined,
    },
    {
      name: "example.com:22 → deny not-in-allowlist",
      host: "example.com",
      port: 22,
      deniedDomains: [] as string[],
      outcome: "deny" as const,
      reason: "not-in-allowlist" as const,
    },
    {
      name: "deny 优先含 :22：github.com 进 deniedDomains → :22 同拒（无端口例外）",
      host: "github.com",
      port: 22,
      deniedDomains: ["github.com"],
      outcome: "deny" as const,
      reason: "denied" as const,
    },
  ];

  it.each(table)("$name", ({ host, port, deniedDomains, outcome, reason }) => {
    const result = decideEgress({
      host,
      port,
      allowedDomains: PRESET_SHAPE_ALLOWED,
      deniedDomains,
    });
    expect(result.outcome).toBe(outcome);
    expect(result.reason).toBe(reason);
  });

  it("deny 优先对 pattern 形态的 :22 条目同样成立（*.github.com 进 denied → 子域 :22 拒）", () => {
    const result = decideEgress({
      host: "ssh.github.com",
      port: 22,
      allowedDomains: PRESET_SHAPE_ALLOWED,
      deniedDomains: ["*.github.com"],
    });
    expect(result.outcome).toBe("deny");
    expect(result.reason).toBe("denied");
  });
});

describe("ssh-port-inherits-bare-host-entry — SC4 回归钉子（preset 零改动前提）", () => {
  it("ssh-port-inherits-bare-host-entry：允许集零 :port 条目时，SSH 端口轴 (:22/:443) 仍由裸 host 条目覆盖", () => {
    // 前提自检：喂入的条目形态必须是裸 host（零 `:port`）——若哪天有人往这张表
    // 加了 `github.com:22`，本钉子就失去「preset 无需 :port 条目」的证明力。
    expect(PRESET_SHAPE_ALLOWED.every((entry) => !entry.includes(":"))).toBe(
      true
    );

    // 结论：不带任何 :port 形态条目，SSH 两形态均判 allow。
    // 翻红 = 上游「pattern without a port matches every port」语义变更
    // （见文件头处置纪律）。
    expect(
      decideEgress({
        host: "github.com",
        port: 22,
        allowedDomains: PRESET_SHAPE_ALLOWED,
        deniedDomains: [],
      }).outcome
    ).toBe("allow");
    expect(
      decideEgress({
        host: "ssh.github.com",
        port: 443,
        allowedDomains: PRESET_SHAPE_ALLOWED,
        deniedDomains: [],
      }).outcome
    ).toBe("allow");
  });
});
