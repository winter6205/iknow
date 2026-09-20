/**
 * Tests for `aci/tools/bash.ts` first-domain approval-flow wiring
 * (specs/network-egress-allowlist.md).
 *
 * Pinned invariants:
 *   - when the bash tool is assembled with askApproval, the policy returned by
 *     egressPolicyFactory automatically carries an `approvalGate` (built in the
 *     bash factory closure, shared across calls as one session-level set);
 *   - driving the gate from the filter path: approve → true + no violation
 *     recorded; deny → false + `denied-by-user` violation;
 *     gate absent → not-in-allowlist host recorded as `no-approval-inlet`;
 *   - askApproval throwing → fail-closed (equivalent to deny: `denied-by-user`);
 *   - second call for the same host → askApproval not called again (gate's
 *     in-session set hit).
 *
 * No real relay/proxy is started — a stub session injected via
 * `createEgressSessionFactory` captures the policy at construction so the test
 * drives filter → gate → violation directly.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { createBashTool } from "../../../src/harness/aci/tools/bash.js";
import { ToolExecutionError } from "../../../src/harness/errors.js";
import { createEgressViolationSink } from "../../../src/harness/sandbox/egress/violations.js";
import type {
  EgressPolicyInput,
  EgressSession,
  EgressSessionOptions,
} from "../../../src/harness/sandbox/egress/session.js";

const FIX_CWD = mkdtempSync(join(tmpdir(), "bash-egress-approval-cwd-"));

afterAll(() => {
  rmSync(FIX_CWD, { recursive: true, force: true });
});

/**
 * Stub session factory — captures the policy so tests can trigger its gate
 * manually (no real relay / proxy / path guard started). Calling the captured
 * gate mimics "proxy filter sees a host → gate.askIfUnknown(host) → allow/deny".
 */
function makeDrivenEgressSessionFactory(): {
  factory: (opts: EgressSessionOptions) => Promise<EgressSession>;
  captured: { policy?: EgressPolicyInput };
} {
  const captured: { policy?: EgressPolicyInput } = {};
  const factory = async (
    opts: EgressSessionOptions
  ): Promise<EgressSession> => {
    captured.policy = opts.policy;
    const sink = createEgressViolationSink();
    return Object.freeze({
      id: "stub-approval",
      spec: {
        unixSocketPath: "/tmp/iknow-egress-stub.sock",
        sandboxLocalPort: 0,
        env: {},
        innerBridgeScript: "",
        relayAssetsDir: "/test/iknow/vendor/egress-relay",
      },
      violationSink: sink,
      dispose: async () => undefined,
    });
  };
  return { factory, captured };
}

/** Same bash envelope shape parsing as the existing typed-failure tests. */
interface BashEnvelope {
  readonly output: string;
}
interface BashResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}
function parseBashEnvelope(envelope: BashEnvelope): BashResult {
  return JSON.parse(envelope.output) as BashResult;
}

describe("bash handler — T6 首次域名批准流接线 (SC10)", () => {
  it("egressPolicyFactory 缺席 + askApproval 在场 → handler 仍走 V1 路径(egress 不起)", async () => {
    // askApproval present but egressPolicyFactory absent → the bash factory
    // builds no gate (the gate is injected only on the policy path); V1
    // baseline: the handler takes the no-egress path and the stub is never called.
    const { factory } = makeDrivenEgressSessionFactory();
    const tool = createBashTool(FIX_CWD, {
      askApproval: async () => true,
      createEgressSessionFactory: factory as never,
    });
    const result = (await tool.handler(
      { command: "true" },
      { conversationId: "conv-no-policy" }
    )) as BashEnvelope;
    const env = parseBashEnvelope(result);
    expect(env.stderr).not.toContain("[network_denied]");
  });

  it("askApproval 缺席 + egressPolicyFactory 返 policy → handler 不带 gate,filter 走 no-approval-inlet", async () => {
    // No askApproval injected → approvalGate is undefined in the factory
    // closure, so the policy carries no gate. Verified via the stub session +
    // captured.policy.
    const { factory, captured } = makeDrivenEgressSessionFactory();
    const tool = createBashTool(FIX_CWD, {
      // deliberately omit askApproval.
      egressPolicyFactory: () => ({
        allowedDomains: ["github.com"],
        deniedDomains: [],
        commandLabel: "test:no-approval-inlet",
      }),
      createEgressSessionFactory: factory as never,
    });
    await tool.handler({ command: "true" }, { conversationId: "conv-no-ask" });
    expect(captured.policy?.approvalGate).toBeUndefined();
    // Invoking the filter on a not-in-allowlist host would now record
    // no-approval-inlet. The filter is bound inside the real session; here
    // only the policy shape is verified — full filter behavior is covered by
    // session.ts unit tests.
  });

  it("askApproval 在场 + egressPolicyFactory 返 policy → captured.policy 挂 gate + allowlistSource fallback = session", async () => {
    const { factory, captured } = makeDrivenEgressSessionFactory();
    const tool = createBashTool(FIX_CWD, {
      askApproval: async () => true,
      egressPolicyFactory: () => ({
        allowedDomains: ["github.com"],
        deniedDomains: [],
        commandLabel: "test:gate-wired",
        // deliberately omit allowlistSource — the bash factory should fall back to "session"
      }),
      createEgressSessionFactory: factory as never,
    });
    await tool.handler({ command: "true" }, { conversationId: "conv-gate" });
    expect(captured.policy?.approvalGate).toBeDefined();
    expect(typeof captured.policy?.approvalGate?.askIfUnknown).toBe("function");
    expect(captured.policy?.allowlistSource).toBe("session");
  });

  it("caller 显式 allowlistSource='persisted' → bash 不覆盖该值", async () => {
    const { factory, captured } = makeDrivenEgressSessionFactory();
    const tool = createBashTool(FIX_CWD, {
      askApproval: async () => true,
      egressPolicyFactory: () => ({
        allowedDomains: ["github.com"],
        deniedDomains: [],
        commandLabel: "test:source-pinned",
        allowlistSource: "persisted",
      }),
      createEgressSessionFactory: factory as never,
    });
    await tool.handler(
      { command: "true" },
      { conversationId: "conv-pinned-source" }
    );
    expect(captured.policy?.allowlistSource).toBe("persisted");
  });

  it("跨调用同 host → gate 命中 allowed 集,不再调 askApproval", async () => {
    // Real session creation through the stub factory — the second call still
    // hits the same gate under the same bash tool instance.
    const askApproval = vi.fn(async () => true);
    const { factory, captured } = makeDrivenEgressSessionFactory();
    const tool = createBashTool(FIX_CWD, {
      askApproval,
      egressPolicyFactory: () => ({
        allowedDomains: [],
        deniedDomains: [],
        commandLabel: "test:cross-call",
      }),
      createEgressSessionFactory: factory as never,
    });
    // First call — captured.policy is injected inside the factory for later assertions.
    await tool.handler({ command: "true" }, { conversationId: "c1" });
    const gate = captured.policy?.approvalGate;
    expect(gate).toBeDefined();
    // Drive the gate directly (mimicking the filter): two different
    // conversationIds, but the same bash tool instance shares one gate.
    const r1 = await gate!.askIfUnknown("github.com");
    expect(r1).toBe(true);
    expect(askApproval).toHaveBeenCalledTimes(1);
    const r2 = await gate!.askIfUnknown("github.com");
    expect(r2).toBe(true);
    expect(askApproval).toHaveBeenCalledTimes(1); // still 1 — gate set hit
    expect(gate!.allowedThisSession()).toContain("github.com");
  });

  it("askApproval 抛 → gate fail-closed,违例 reason `denied-by-user`", async () => {
    // Drive filter-like behavior directly through the gate, mirroring the
    // sink.record call on session.ts's filter-denial path.
    const { factory, captured } = makeDrivenEgressSessionFactory();
    const tool = createBashTool(FIX_CWD, {
      askApproval: async () => {
        throw new Error("ask surface broken");
      },
      egressPolicyFactory: () => ({
        allowedDomains: [],
        deniedDomains: [],
        commandLabel: "test:ask-throws",
      }),
      createEgressSessionFactory: factory as never,
    });
    await tool.handler({ command: "true" }, { conversationId: "c-throws" });
    const gate = captured.policy?.approvalGate;
    expect(gate).toBeDefined();
    const r = await gate!.askIfUnknown("github.com");
    expect(r).toBe(false);
    expect(gate!.deniedThisSession()).toContain("github.com");
  });
});

describe("bash handler — egress typed failure 反映 denied-by-user", () => {
  it("filter 拒绝(denied-by-user) → handler 抛 typed failure + message 含 denied-by-user 文案", async () => {
    // Skip the stub filter — inject a sink already holding one denied-by-user
    // violation and run the bash handler typed-failure pipeline. Message
    // rendering aligns with the `denied-by-user` case in violations.ts.
    const stub = (async (
      opts: EgressSessionOptions
    ): Promise<EgressSession> => {
      const sink = createEgressViolationSink();
      sink.record({
        kind: "egress_violation",
        host: "evil.example",
        port: 443,
        reason: "denied-by-user",
        command: "curl evil.example",
      });
      // policyInput placeholder — this test does not consume filter behavior.
      void opts;
      return Object.freeze({
        id: "stub",
        spec: {
          unixSocketPath: "/tmp/iknow-egress-stub.sock",
          sandboxLocalPort: 0,
          env: {},
          innerBridgeScript: "",
          relayAssetsDir: "/test/iknow/vendor/egress-relay",
        },
        violationSink: sink,
        dispose: async () => undefined,
      });
    }) as (opts: EgressSessionOptions) => Promise<EgressSession>;

    const tool = createBashTool(FIX_CWD, {
      egressPolicyFactory: () => ({
        allowedDomains: ["github.com"],
        deniedDomains: [],
        commandLabel: "curl evil.example",
      }),
      createEgressSessionFactory: stub,
    });

    let caught: unknown;
    try {
      await tool.handler(
        { command: "curl evil.example" },
        { conversationId: "conv-denied" }
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ToolExecutionError);
    const message = (caught as ToolExecutionError).message;
    expect(message).toContain("[network_denied]");
    expect(message).toContain("denied by user for this session");
    expect(message).toContain("evil.example");
  });

  it("filter 拒绝(no-approval-inlet) → handler 抛 typed failure + message 含 no-approval-inlet 文案", async () => {
    const stub = (async (): Promise<EgressSession> => {
      const sink = createEgressViolationSink();
      sink.record({
        kind: "egress_violation",
        host: "github.com",
        port: 443,
        reason: "no-approval-inlet",
        command: "curl github.com",
      });
      return Object.freeze({
        id: "stub",
        spec: {
          unixSocketPath: "/tmp/iknow-egress-stub.sock",
          sandboxLocalPort: 0,
          env: {},
          innerBridgeScript: "",
          relayAssetsDir: "/test/iknow/vendor/egress-relay",
        },
        violationSink: sink,
        dispose: async () => undefined,
      });
    }) as (opts: EgressSessionOptions) => Promise<EgressSession>;

    const tool = createBashTool(FIX_CWD, {
      egressPolicyFactory: () => ({
        allowedDomains: [],
        deniedDomains: [],
        commandLabel: "curl github.com",
      }),
      createEgressSessionFactory: stub,
    });

    let caught: unknown;
    try {
      await tool.handler(
        { command: "curl github.com" },
        { conversationId: "conv-no-approval" }
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ToolExecutionError);
    const message = (caught as ToolExecutionError).message;
    expect(message).toContain("[network_denied]");
    expect(message).toContain("no interactive approval inlet");
    expect(message).toContain("github.com");
  });
});
