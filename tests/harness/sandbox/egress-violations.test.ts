/**
 * Tests for `egress/violations.ts` — the egress violation recorder.
 *
 * Pinned invariants (from hop 1 of the violation feedback channel in
 * specs/network-egress-allowlist.md + ADR-0097):
 *   - record() is pure append; multiple violations within one sink keep order.
 *   - drain() takes a snapshot then clears; a second drain returns an empty array.
 *   - defensive: empty host / non-integer port never enter the buffer (downstream
 *     assumptions must not break).
 *   - renderEgressViolations() emits one readable line per reason, including the
 *     denied hostname + port.
 *   - command fields over 80 chars are truncated to 77 + `...`.
 *
 * Hop 3 of the spec's violation feedback channel:
 *   - renderEgressFailureMessage() assembles the typed failure message: the
 *     `[network_denied]` prefix + one line per violation + a shared remediation
 *     footer + "the command ran to completion" semantics; infra and domain
 *     denial never mix in one section; allowlistSource passes through; the
 *     "command completed but egress denied" meaning is kept (never misread as
 *     a process crash).
 */

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createEgressViolationSink,
  renderEgressViolations,
  renderEgressFailureMessage,
  sshHostKeyFailureGuidance,
  type EgressViolation,
} from "../../../src/harness/sandbox/egress/violations.js";

function v(
  partial: Partial<EgressViolation> & Pick<EgressViolation, "host" | "port">
): EgressViolation {
  return {
    kind: "egress_violation",
    reason: "not-in-allowlist",
    command: "echo hi",
    ...partial,
  };
}

describe("createEgressViolationSink", () => {
  it("appends and reports size", () => {
    const sink = createEgressViolationSink();
    expect(sink.size()).toBe(0);
    sink.record(v({ host: "a.example", port: 443 }));
    sink.record(v({ host: "b.example", port: 443 }));
    expect(sink.size()).toBe(2);
  });

  it("drain returns snapshot then clears", () => {
    const sink = createEgressViolationSink();
    sink.record(v({ host: "a.example", port: 443 }));
    sink.record(v({ host: "b.example", port: 443 }));
    const drained = sink.drain();
    expect(drained).toHaveLength(2);
    expect(drained[0]?.host).toBe("a.example");
    expect(drained[1]?.host).toBe("b.example");
    expect(sink.size()).toBe(0);
    // the second drain returns empty (the previous snapshot is not reused)
    expect(sink.drain()).toHaveLength(0);
  });

  it("rejects empty host and non-integer port (defensive)", () => {
    const sink = createEgressViolationSink();
    // empty host rejected
    sink.record(v({ host: "", port: 443 }) as unknown as EgressViolation);
    // NaN port rejected (defensive)
    sink.record(
      v({ host: "a.example", port: Number.NaN }) as unknown as EgressViolation
    );
    // negative port rejected
    sink.record(
      v({ host: "a.example", port: -1 }) as unknown as EgressViolation
    );
    expect(sink.size()).toBe(0);
  });

  it("drain snapshot is immutable (frozen entries)", () => {
    const sink = createEgressViolationSink();
    sink.record(v({ host: "a.example", port: 443 }));
    const drained = sink.drain();
    expect(Object.isFrozen(drained[0])).toBe(true);
  });
});

describe("renderEgressViolations", () => {
  it("returns empty string for empty violations", () => {
    expect(renderEgressViolations([])).toBe("");
  });

  it("renders not-in-allowlist with host:port and a config hint", () => {
    const out = renderEgressViolations([
      v({ host: "evil.example", port: 443, reason: "not-in-allowlist" }),
    ]);
    expect(out).toContain("[network_denied]");
    expect(out).toContain("evil.example:443");
    expect(out).toContain("isolation.network.allowedDomains");
  });

  it("renders denied reason", () => {
    const out = renderEgressViolations([
      v({ host: "denied.example", port: 443, reason: "denied" }),
    ]);
    expect(out).toContain("[network_denied]");
    expect(out).toContain("denied.example:443");
    expect(out).toContain("deny rule");
  });

  it("renders allowlist-empty with config hint", () => {
    const out = renderEgressViolations([
      v({ host: "any.example", port: 443, reason: "allowlist-empty" }),
    ]);
    expect(out).toContain("allowed domains list is empty");
  });

  it("renders address-denied with explanation", () => {
    const out = renderEgressViolations([
      v({ host: "loopback.example", port: 443, reason: "address-denied" }),
    ]);
    expect(out).toContain("[network_denied]");
    expect(out).toContain("loopback.example:443");
    expect(out).toContain("denied address");
    // with the preset in play the address-denied text stays verbatim — an exact
    // whole-line pin guards against render drift (egress-preset-allowlist spec).
    expect(out).toBe(
      "[network_denied] loopback.example:443 resolved to a denied address " +
        "(command: echo hi); an allowed hostname must not resolve into " +
        "loopback / private / metadata IP space"
    );
  });

  it("renders no-approval-inlet with non-interactive caveat", () => {
    const out = renderEgressViolations([
      v({
        host: "first-seen.example",
        port: 443,
        reason: "no-approval-inlet",
      }),
    ]);
    expect(out).toContain("[network_denied]");
    expect(out).toContain("no interactive approval");
  });

  it("truncates long command labels to 80 chars", () => {
    const longCmd = "x".repeat(120);
    const out = renderEgressViolations([
      v({ host: "a.example", port: 443, command: longCmd }),
    ]);
    // truncated to 77 + "..." = 80 chars
    expect(out).toContain("...");
    expect(out).not.toContain("x".repeat(120));
  });

  it("multi-violation output is newline-joined", () => {
    const out = renderEgressViolations([
      v({ host: "a.example", port: 443 }),
      v({ host: "b.example", port: 80 }),
    ]);
    const lines = out.split("\n");
    expect(lines.length).toBe(2);
    expect(lines[0]).toContain("a.example:443");
    expect(lines[1]).toContain("b.example:80");
  });

  it("renders infra-unavailable reason (no allowlist hint, no host misleading)", () => {
    const out = renderEgressViolations([
      v({ host: "egress-seam", port: 0, reason: "infra-unavailable" }),
    ]);
    expect(out).toContain("[network_denied]");
    expect(out).toContain("egress seam unavailable");
    expect(out).toContain("infrastructure fault");
    // the fix action is entirely different: infra must not say "add to allowlist".
    expect(out).not.toContain("isolation.network.allowedDomains");
    expect(out).not.toContain("configure isolation.network");
  });
});

describe("renderEgressFailureMessage (T5 typed failure, spec §Violation feedback channel)", () => {
  it("empty violations → empty message", () => {
    expect(renderEgressFailureMessage({ violations: [] })).toBe("");
  });

  it("domain-deny: prefix + per-line violation + remediation footer", () => {
    const out = renderEgressFailureMessage({
      violations: [
        v({ host: "evil.example", port: 443, reason: "not-in-allowlist" }),
      ],
    });
    // the prefix lets the existing categorizeResult hit networkDenied → mid
    expect(out).toContain("[network_denied]");
    // "the command ran to completion but egress was denied" — never misread as a crash
    expect(out).toContain("command ran to completion");
    expect(out).toContain("egress connection was denied");
    // one line per violation
    expect(out).toContain("evil.example:443");
    expect(out).toContain("isolation.network.allowedDomains");
    // shared remediation footer — not repeated per line
    expect(out).toContain("Remediation:");
    expect(out).toContain("add the host to isolation.network.allowedDomains");
  });

  it("infra-unavailable: distinct remediation, no allowlist hint, no host as domain denial", () => {
    const out = renderEgressFailureMessage({
      violations: [
        v({ host: "egress-seam", port: 0, reason: "infra-unavailable" }),
      ],
    });
    expect(out).toContain("[network_denied]");
    expect(out).toContain("egress seam unavailable");
    expect(out).toContain("infrastructure fault");
    // remediation guidance splits in two; the infra path
    expect(out).toContain("iknow-bundled egress relay");
    // ADR-0107: package-install wording is pinned out and must not return.
    expect(out.toLowerCase()).not.toContain("socat");
    expect(out.toLowerCase()).not.toContain("apt");
    // the domain-denial guidance must **not** appear
    expect(out).not.toContain(
      "add the host to isolation.network.allowedDomains"
    );
  });

  it("multi-violation domain-deny: per-line + single shared footer", () => {
    const out = renderEgressFailureMessage({
      violations: [
        v({ host: "evil1.example", port: 443, reason: "not-in-allowlist" }),
        v({ host: "evil2.example", port: 80, reason: "denied" }),
      ],
    });
    expect(out).toContain("evil1.example:443");
    expect(out).toContain("evil2.example:80");
    // exactly one shared footer (not N)
    const matches = out.match(/Remediation:/g) ?? [];
    expect(matches.length).toBe(1);
  });

  it("allowlistSource 'session' → message 含 'Current allowlist source'", () => {
    const out = renderEgressFailureMessage({
      violations: [
        v({ host: "evil.example", port: 443, reason: "not-in-allowlist" }),
      ],
      allowlistSource: "session",
    });
    expect(out).toContain("Current allowlist source: session-level allowlist");
  });

  it("allowlistSource 缺省 → 不伪造来源标注", () => {
    const out = renderEgressFailureMessage({
      violations: [
        v({ host: "evil.example", port: 443, reason: "not-in-allowlist" }),
      ],
    });
    expect(out).not.toContain("Current allowlist source");
  });

  it("allowlistSource 'builtin' → 逐字渲染 built-in preset 文案 (T2 钉死表)", () => {
    const out = renderEgressFailureMessage({
      violations: [
        v({ host: "a.example", port: 443, reason: "not-in-allowlist" }),
      ],
      allowlistSource: "builtin",
    });
    expect(out).toContain(
      "Current allowlist source: built-in preset allowlist (github / npm / playwright defaults)."
    );
  });

  it("allowlistSource 'persisted' → 逐字渲染 user-settings 文案 (T2 钉死表)", () => {
    const out = renderEgressFailureMessage({
      violations: [
        v({ host: "a.example", port: 443, reason: "not-in-allowlist" }),
      ],
      allowlistSource: "persisted",
    });
    expect(out).toContain(
      "Current allowlist source: user-settings persisted allowlist."
    );
  });

  it("allowlistSource 'session' → 逐字渲染 session-level 文案 (T2 钉死表)", () => {
    const out = renderEgressFailureMessage({
      violations: [
        v({ host: "a.example", port: 443, reason: "not-in-allowlist" }),
      ],
      allowlistSource: "session",
    });
    expect(out).toContain("Current allowlist source: session-level allowlist.");
  });
});

/**
 * spec invariant 4: after the closed three-tier settlement, the legacy quoted
 * literal pres[e]t must not linger in any source-semantic position (grep
 * assertion). The rendered label "built-in preset allowlist (...)" is label
 * content, not a source value, and contains no quote-adjacent pres[e]t, so this
 * assertion does not hit it; both the needle and this file's prose use the
 * pres[e]t spelling to avoid self-matching.
 */
describe("T2 三档清算 grep 钉子：全仓代码面无 pres[e]t 值残留", () => {
  it("src / tests / scripts 的 .ts 文件零 pres[e]t 带引号字面值", () => {
    const root = fileURLToPath(new URL("../../../", import.meta.url));
    const quotedPreset = /["']pres[e]t["']/;
    const offenders: string[] = [];
    const scan = (dir: string): void => {
      for (const ent of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, ent.name);
        if (ent.isDirectory()) scan(p);
        else if (ent.name.endsWith(".ts")) {
          if (quotedPreset.test(readFileSync(p, "utf8"))) offenders.push(p);
        }
      }
    };
    for (const d of ["src", "tests", "scripts"]) {
      const p = join(root, d);
      if (existsSync(p)) scan(p);
    }
    expect(offenders).toEqual([]);
  });
});

describe("sshHostKeyFailureGuidance — F4 known_hosts 指引 (spec §Failure paths F4)", () => {
  it("returns undefined for empty / non-ssh stderr（无误报，命令正常路径不变形）", () => {
    expect(sshHostKeyFailureGuidance("")).toBeUndefined();
    expect(
      sshHostKeyFailureGuidance("fatal: not a git repository")
    ).toBeUndefined();
    expect(
      sshHostKeyFailureGuidance("Permission denied (publickey).")
    ).toBeUndefined();
  });

  it("detects the first-time unknown-host fingerprint prompt", () => {
    const stderr =
      "The authenticity of host 'github.com (140.82.116.4)' can't be established.\n" +
      "ED25519 key fingerprint is SHA256:+DiG....\n" +
      "This key is not known by any other names.\n";
    const g = sshHostKeyFailureGuidance(stderr);
    expect(g).toBeDefined();
    // pinned guidance elements: host-side ssh-keyscan / interactive login confirmation, combined with the -o UserKnownHostsFile= spelling.
    expect(g).toMatch(/ssh-keyscan/);
    expect(g).toMatch(/UserKnownHostsFile=/);
    // never injects StrictHostKeyChecking=no by default (weakening the trust surface is not spec-authorized).
    expect(g).not.toMatch(/StrictHostKeyChecking=no/);
  });

  it("detects the batch-mode 'Host key verification failed' refusal", () => {
    const g = sshHostKeyFailureGuidance(
      "git@github.com: Permission denied (publickey).\r\n" +
        "Host key verification failed.\r\n"
    );
    expect(g).toBeDefined();
    expect(g).toMatch(/ssh-keyscan/);
  });
});
