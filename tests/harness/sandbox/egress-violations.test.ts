/**
 * Tests for `egress/violations.ts` — T4 egress 违例记录器。
 *
 * 钉住的不变式（来自 specs/network-egress-allowlist.md §Violation feedback
 * channel 第 1 跳 + ADR-0097）：
 *   - record() 纯 append；同 sink 内多条违例保留顺序。
 *   - drain() 出快照后清空；二次 drain 返回空数组。
 *   - 防御性：空 host / 非整数 port 不入缓冲（防下游假设破灭）。
 *   - renderEgressViolations() 每个 reason 形出一行可读文本，包含被拒域名 + 端口。
 *   - 命令字段超过 80 字符被截断到 77 + `...`。
 *
 * T5 新增（spec §Violation feedback channel 第 3 跳）：
 *   - renderEgressFailureMessage() 拼 typed failure message：含
 *     `[network_denied]` 前缀 + 每条一行 + 共享补配指引 + 「命令已跑完」
 *     语义；infra / 域判定绝不混排同一段；allowlistSource 透传；
 *     命令已跑完但出网被拒语义保留（不误导为进程崩溃）。
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
    // 二次 drain 返回空（不重用上次快照）
    expect(sink.drain()).toHaveLength(0);
  });

  it("rejects empty host and non-integer port (defensive)", () => {
    const sink = createEgressViolationSink();
    // 空 host 不入
    sink.record(v({ host: "", port: 443 }) as unknown as EgressViolation);
    // port=NaN 不入（防御）
    sink.record(
      v({ host: "a.example", port: Number.NaN }) as unknown as EgressViolation
    );
    // 负 port 不入
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
    // 截断到 77 + "..." = 80 字符
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
    // 修复动作完全不同:infra → 不说「add to allowlist」。
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
    // 前缀 —— 让既有 categorizeResult 命中 networkDenied → mid
    expect(out).toContain("[network_denied]");
    // 「命令已跑完但出网被拒」语义 —— 不误导为进程崩溃
    expect(out).toContain("command ran to completion");
    expect(out).toContain("egress connection was denied");
    // 每条违例一行
    expect(out).toContain("evil.example:443");
    expect(out).toContain("isolation.network.allowedDomains");
    // 共享补配指引尾注 —— 不逐行重复
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
    // 修复指引分两份:infra 路径
    expect(out).toContain("iknow-bundled egress relay");
    // ADR-0107：装包字样钉死不回潮。
    expect(out.toLowerCase()).not.toContain("socat");
    expect(out.toLowerCase()).not.toContain("apt");
    // 域判定拒绝指引**不**出现
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
    // 共享尾注只一份(不是 N 份)
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
    expect(out).toContain(
      "Current allowlist source: session-level allowlist."
    );
  });
});

/**
 * spec invariant 4 / SC4：封闭三档清算后，旧值 pres[e]t（带引号字面值）
 * 不得在任何 source 语义位残留（grep 断言）。渲染文案 "built-in preset
 * allowlist (...)" 是 label 内容不是 source 值，不含引号紧邻的 pres[e]t，
 * 故不被本断言命中；needle 与本文件正文都用 pres[e]t 写法避免自匹配。
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
    // F4 钉死要素：宿主侧 ssh-keyscan / 登录确认 + -o UserKnownHostsFile= 组合写法。
    expect(g).toMatch(/ssh-keyscan/);
    expect(g).toMatch(/UserKnownHostsFile=/);
    // 不默认注入 StrictHostKeyChecking=no（削弱信任面非 spec 授权）。
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
