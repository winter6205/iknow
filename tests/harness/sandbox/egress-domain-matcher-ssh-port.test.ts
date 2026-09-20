/**
 * Tests for `egress/domain-matcher.ts` — SSH domain-decision pins
 * (specs/egress-ssh-bridge.md).
 *
 * Pinned invariants:
 *   - assumption 6 (quoted from the package's domain-pattern.js, aligned with
 *     this spec): "A pattern without a port matches every port" ⇒ the bare
 *     host entries in the preset already cover :22 / :443, so the preset list
 *     needs zero `:port`-shaped entries (no-change conclusion).
 *   - invariant 5: the decision inputs for approval / violation / address
 *     guard are always plain (host, port) data; `:22` introduces no new
 *     config shape.
 *   - deny precedence has no port exception: once a host is in
 *     deniedDomains, :22 is denied too.
 *
 * Tests feed explicit policy inputs mirroring the ADR-0104 preset shape; the
 * preset module is not imported: its list ships in a parallel PR and does not
 * exist on this branch, so the decision semantics must not depend on that
 * assembly face.
 *
 * Zero production-code changes: this file is the only surface. If
 * "ssh-port-inherits-bare-host-entry" turns red, upstream
 * `matchesDomainPatternWithPort` changed semantics on a version bump; the
 * only place to adapt is the `upstream.ts` adapter layer (ADR-0097
 * dependency-fork discipline), re-checking assumption 6 in
 * specs/egress-ssh-bridge.md — never the preset spec.
 */

import { describe, it, expect } from "vitest";
import { decideEgress } from "../../../src/harness/sandbox/egress/domain-matcher.js";

/**
 * Shape mirror of ADR-0104's six preset domains: all bare host entries, zero
 * `:port` shapes. This is explicit test input, not a dependency on the preset
 * module (which is absent on this branch).
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
    // Precondition self-check: fed entries must be bare hosts (zero `:port`) —
    // if anyone ever adds `github.com:22` to this table, the pin loses its proof
    // power for "the preset needs no :port entries".
    expect(PRESET_SHAPE_ALLOWED.every((entry) => !entry.includes(":"))).toBe(
      true
    );

    // Conclusion: with zero `:port`-shaped entries, both SSH shapes decide allow.
    // Turning red = upstream changed the "pattern without a port matches every
    // port" semantics (see the handling discipline at the file head).
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
