/**
 * Approval-gate restoration + lifecycle-gap closure pins
 * (specs/egress-preset-allowlist.md, invariants 3 and 5).
 *
 * Lifecycle gap (referenced explicitly per spec invariant 3, no separate
 * carve-out):
 *   ADR-0097's lifecycle table says the proxy session starts only "when the
 *   allowlist is non-empty or an approval flow can ask". Old implementation:
 *   settings without an `isolation.network` section →
 *   `createEgressPolicyFactory` returned `undefined` → no egress session ever
 *   started → the first-seen approval gate "died at the inlet" (the gate
 *   pieces in approval.ts / session.ts and the filter wiring were all there,
 *   but the inlet short-circuited them: an off-profile domain was neither
 *   asked nor denied — commands just got a silent DNS failure). ADR-0104's
 *   Consequences rules the gap closed: a non-empty preset means the
 *   production inlet starts the egress session by default and the gate is
 *   back on duty. The factory's section-absent branch already became a
 *   preset-only policy; this file pins "the approval gate is on duty" with a
 *   three-arm test to prevent regression.
 *
 * Invariant 5 (the fail-closed surface must not shrink, inherited verbatim):
 *   - non-interactive gate rejection → `no-approval-inlet` (arm 2);
 *   - user denial → `denied-by-user` → typed failure fed back (deny half of
 *     arm 1);
 *   - proxy-dead fail-closed (egress-proxy-behavior.test.ts) and the address
 *     guard (egress-domain-matcher.test.ts) are already pinned by existing
 *     tests and not re-covered here.
 *
 * Technique (spec: "reuse the injected-filter driving seam, never start a
 * real proxy"): every policy comes from the real
 * `createEgressPolicyFactory` (clean settings = no `isolation.network`
 * section) and every session from the real `createEgressSession`; the filter
 * callback is captured through the `createHttpProxyServer` / `probeSocat` /
 * `spawn` / `socketPathFactory` injection seams and driven directly — no
 * real HTTP CONNECT proxy, no host socat, no real egress.
 */

import { spawn as realSpawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { createBashTool } from "../../../src/harness/aci/tools/bash.js";
import { ToolExecutionError } from "../../../src/harness/errors.js";
import { createEgressPolicyFactory } from "../../../src/harness/sandbox/egress/assembly.js";
import { BUILTIN_PRESET_ALLOWED_DOMAINS } from "../../../src/harness/sandbox/egress/preset-domains.js";
import { renderEgressViolations } from "../../../src/harness/sandbox/egress/violations.js";
import {
  createEgressSession,
  type EgressPolicyInput,
  type EgressSession,
  type EgressSessionOptions,
} from "../../../src/harness/sandbox/egress/session.js";
import { createHttpProxyServer as createHttpProxyServerOrig } from "../../../src/harness/sandbox/egress/upstream.js";
import type { IknowSettings } from "../../../src/config/settings.js";

const FIX_CWD = mkdtempSync(join(tmpdir(), "t3-approval-cwd-"));
const scratchPaths: string[] = [];

function scratchDir(): string {
  const d = mkdtempSync(join(tmpdir(), "t3-approval-test-"));
  scratchPaths.push(d);
  return d;
}

afterEach(() => {
  for (const p of scratchPaths.splice(0)) {
    rmSync(p, { recursive: true, force: true });
  }
});

afterAll(() => {
  rmSync(FIX_CWD, { recursive: true, force: true });
});

/** Clean assembly: settings without an `isolation.network` section (ADR-0104 preset-only inlet). */
function cleanPolicyFactory(
  commandLabel: string
): () => EgressPolicyInput | undefined {
  return createEgressPolicyFactory({
    settings: {} as unknown as IknowSettings,
    commandLabel,
  });
}

function fakeSocatProc(pid: number) {
  const proc = realSpawn("/bin/true", ["--version"], { stdio: "ignore" });
  try {
    proc.kill("SIGKILL");
  } catch {
    /* best-effort */
  }
  return Object.assign(proc, { pid });
}

let fakePidCounter = 20000;

interface CapturedCall {
  readonly filter: (port: number, host: string) => Promise<boolean>;
  readonly policy: EgressPolicyInput;
  readonly session: EgressSession;
}

/**
 * Bash-side wrapper of the filter-driving injection seam: real
 * `createEgressSession` over an all-fake assembly (probeSocat always true /
 * fake spawn / on-disk socket file / captured filter).
 * `driveOutboundOnAssembly` = drive the filter once against an off-profile
 * domain during assembly (fire-and-await-microtask), so the denial violation
 * lands in the sink deterministically before the handler drains.
 */
function makeSessionCaptureSeam(driveOutboundOnAssembly = false): {
  factory: (opts: EgressSessionOptions) => Promise<EgressSession>;
  calls: CapturedCall[];
} {
  const calls: CapturedCall[] = [];
  const factory = async (
    opts: EgressSessionOptions
  ): Promise<EgressSession> => {
    const captured: { filter?: CapturedCall["filter"] } = {};
    const session = await createEgressSession({
      ...opts,
      probeSocat: () => true,
      spawn: (() =>
        fakeSocatProc(fakePidCounter++)) as unknown as typeof realSpawn,
      socketPathFactory: (id) => {
        const p = join(scratchDir(), `t3-${id}.sock`);
        // Write a plain placeholder file: the fence's socket bind only needs
        // the source to exist; this test never connects to the proxy.
        writeFileSync(p, "");
        return p;
      },
      createHttpProxyServer: (proxyOpts) => {
        captured.filter = proxyOpts.filter as CapturedCall["filter"];
        if (driveOutboundOnAssembly && captured.filter !== undefined) {
          // The denial-path violation is a pure microtask chain; the handler's
          // sandbox execution crosses a real subprocess spawn (≥1 macrotask),
          // so it is always in the sink before drain.
          void captured.filter(443, "example.com");
        }
        return createServer();
      },
    });
    // session assembled successfully ⇒ filter must already be constructed (createHttpProxyServer is called synchronously).
    calls.push({
      filter: captured.filter!,
      policy: opts.policy,
      session,
    });
    return session;
  };
  return { factory, calls };
}

interface BashEnvelope {
  readonly output: string;
}
function parseBashEnvelope(envelope: BashEnvelope): {
  code: number;
  stdout: string;
  stderr: string;
} {
  return JSON.parse(envelope.output) as {
    code: number;
    stdout: string;
    stderr: string;
  };
}

describe("T3 臂① — 干净装配交互前台：首见批准门在岗（ask 一次 → 会话放行）", () => {
  it("档外域触发 ask；批准 → 本会话放行不再问；档内域不问（回归反转：旧行为批准门死在入口）", async () => {
    const askApproval = vi.fn(async () => true);
    const seam = makeSessionCaptureSeam();
    const tool = createBashTool(FIX_CWD, {
      egressPolicyFactory: cleanPolicyFactory("bash"),
      askApproval,
      createEgressSessionFactory: seam.factory,
    });

    const envelope = (await tool.handler(
      { command: "true" },
      { conversationId: "t3-approve" }
    )) as BashEnvelope;
    // No violation → ok envelope (the approval gate pass-through doesn't interrupt the command).
    expect(parseBashEnvelope(envelope)).toBeDefined();

    expect(seam.calls.length).toBe(1);
    const { filter, policy, session } = seam.calls[0]!;
    // —— observable evidence that the lifecycle gap is closed (record of the
    //    old-behavior reversal): under clean assembly the session starts
    //    (calls.length===1), the policy is preset-only and approvalGate is
    //    attached — the old implementation returned undefined here, never
    //    started a session, and the gate died at the inlet
    //    (ADR-0097 lifecycle table / ADR-0104 Consequences).
    expect(policy.approvalGate).toBeDefined();
    expect(policy.allowedDomains).toEqual([...BUILTIN_PRESET_ALLOWED_DOMAINS]);
    expect(policy.allowlistSource).toBe("builtin");
    expect(askApproval).not.toHaveBeenCalled();

    // In-profile (preset) domains pass straight through, no ask.
    await expect(filter(443, "github.com")).resolves.toBe(true);
    expect(askApproval).not.toHaveBeenCalled();

    // First-seen off-profile domain → one ask → allow.
    await expect(filter(443, "example.com")).resolves.toBe(true);
    expect(askApproval).toHaveBeenCalledTimes(1);
    expect(askApproval).toHaveBeenCalledWith("example.com");
    expect(session.violationSink.size()).toBe(0);

    // Revisiting the off-profile domain in this session → set hit, no re-ask (approval = session-level pass).
    await expect(filter(443, "example.com")).resolves.toBe(true);
    expect(askApproval).toHaveBeenCalledTimes(1);

    // The same gate is shared across per-call sessions (one bash tool instance = one
    // session): revisiting in the fresh session of a second handler call still does not ask.
    await tool.handler({ command: "true" }, { conversationId: "t3-approve" });
    expect(seam.calls.length).toBe(2);
    await expect(seam.calls[1]!.filter(443, "example.com")).resolves.toBe(true);
    expect(askApproval).toHaveBeenCalledTimes(1);

    await session.dispose();
    await seam.calls[1]!.session.dispose();
  });
});

describe("T3 臂① — 干净装配交互前台：拒绝 → denied-by-user 违例回灌 execution_failed", () => {
  it("用户拒绝 → handler drain 到 denied-by-user → 抛 typed failure（[network_denied] + session 级文案 + builtin 来源标注）", async () => {
    const askApproval = vi.fn(async () => false);
    const seam = makeSessionCaptureSeam(true); // drive an off-profile domain during assembly
    const tool = createBashTool(FIX_CWD, {
      egressPolicyFactory: cleanPolicyFactory("bash"),
      askApproval,
      createEgressSessionFactory: seam.factory,
    });

    let caught: unknown;
    try {
      await tool.handler({ command: "true" }, { conversationId: "t3-deny" });
    } catch (err) {
      caught = err;
    }
    // The executor wraps ToolExecutionError as kind:"execution_failed"
    // (bash-egress-typed-failure.test.ts already pins that wrapping end to
    // end; here we assert the typed-failure source with the same contract).
    expect(caught).toBeInstanceOf(ToolExecutionError);
    const message = (caught as ToolExecutionError).message;
    expect(message).toContain("[network_denied]");
    expect(message).toContain(
      "example.com:443 denied by user for this session"
    );
    // Source annotation under clean assembly = the builtin profile (neither silent nor fabricated).
    expect(message).toContain(
      "Current allowlist source: built-in preset allowlist (github / npm / playwright defaults)."
    );
    expect(askApproval).toHaveBeenCalledTimes(1);
    expect(seam.calls[0]!.session.violationSink.size()).toBe(0); // already drained
    await seam.calls[0]!.session.dispose();
  });
});

describe("T3 臂② — 干净装配非交互面（background / verify 形态）：no-approval-inlet fail-closed", () => {
  it("policy 无 approvalGate（非交互 caller 直喂工厂产物）→ 档外域 session 照起、filter fail-closed 且违例有名字（区别于旧「session 不起、静默 DNS 失败」）", async () => {
    // background manager / verify sandbox-run receive the factory's raw policy
    // (the gate is attached only in the bash factory closure — non-interactive
    // faces have no ask inlet).
    const policy = cleanPolicyFactory("background:t3")();
    expect(policy).toBeDefined();
    expect(policy!.approvalGate).toBeUndefined();

    const seam = makeSessionCaptureSeam();
    const session = await seam.factory({ policy: policy! });
    const filter = seam.calls[0]!.filter;

    // Old-behavior contrast: under clean assembly the session now starts (the seam being called at all proves it).
    await expect(filter(443, "example.com")).resolves.toBe(false);
    const drained = session.violationSink.drain();
    expect(drained.length).toBe(1);
    expect(drained[0]!.reason).toBe("no-approval-inlet");
    expect(drained[0]!.host).toBe("example.com");
    // The fed-back violation "has a name": actionable text (states the
    // non-interactive inlet fact + pre-provisioning guidance), unlike the old
    // world of "session never starts → silent DNS failure".
    const rendered = renderEgressViolations(drained);
    expect(rendered).toContain("[network_denied]");
    expect(rendered).toContain(
      "seen for the first time and no interactive approval inlet is available"
    );
    expect(rendered).toContain(
      "pre-add it to isolation.network.allowedDomains for non-interactive runs"
    );
    await session.dispose();
  });
});
