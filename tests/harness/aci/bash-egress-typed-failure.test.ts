/**
 * tests/harness/aci/bash-egress-typed-failure.test.ts
 *
 * Tier 1→mid end-to-end walkthrough (specs/network-egress-allowlist.md,
 * violation feedback channel: prefix and tier entry).
 *
 * Pinned invariants (spec-selected shape + false-green warning):
 *   - when the egress session records a violation, the bash handler throws
 *     `ToolExecutionError` with the `[network_denied]` prefix in the message —
 *     the executor's `buildFailureResult` path wraps it as
 *     `kind: "execution_failed"`;
 *   - feeding that result to the existing `categorizeResult` → tier == "mid";
 *   - do NOT hand-construct `kind: "execution_failed"` (false green) — the
 *     message must flow out of the bash handler's real return path (the spec
 *     names `violation-handling.test.ts:269-279` as the counter-example).
 *
 * No real relay / bwrap dependency: the bash tool's
 * `createEgressSessionFactory` test seam (never passed in production) injects
 * a stub session that proactively records one violation at construction;
 * then the full chain runs: bash handler drain → throw → executor wrap →
 * categorizeResult.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { createBashTool } from "../../../src/harness/aci/tools/bash.js";
import {
  EgressRelayUnavailableError,
  type EgressSession,
  type EgressSessionOptions,
} from "../../../src/harness/sandbox/egress/session.js";
import {
  createEgressViolationSink,
  type EgressAllowlistSource,
  type EgressViolation,
} from "../../../src/harness/sandbox/egress/violations.js";
import type { ToolExecutionContext } from "../../../src/harness/tools/types.js";
import { createExecutor } from "../../../src/harness/tools/executor.js";
import { createRegistry } from "../../../src/harness/tools/registry.js";
import { categorizeResult } from "../../../src/harness/sandbox/violation-handling.js";
import type { ToolCall } from "../../../src/harness/tools/types.js";
import { buildViolationWiring } from "../../../src/harness/sandbox/violation-executor.js";

const FIX_CWD = mkdtempSync(join(tmpdir(), "bash-egress-typed-failure-"));

afterAll(() => {
  rmSync(FIX_CWD, { recursive: true, force: true });
});

/**
 * Builds a stub `createEgressSession` — no real relay / proxy: it returns a
 * session-shaped object whose spec holds empty fence placeholders (the bash
 * handler reads `spec.unixSocketPath` / `sandboxLocalPort` / `env` during
 * fence assembly; skipping the real bridge still satisfies assembly because
 * runSandbox never dials the socket).
 *
 * The stub also proactively records one `not-in-allowlist` violation into the
 * sink at construction, so the bash handler's drain picks it up → throws a
 * typed failure.
 */
function makeStubEgressSessionFactory(args: {
  readonly host: string;
  readonly port: number;
  readonly command: string;
  readonly reason: EgressViolation["reason"];
  readonly allowlistSource?: EgressAllowlistSource;
}): (opts: EgressSessionOptions) => Promise<EgressSession> {
  return async () => {
    const sink = createEgressViolationSink();
    sink.record({
      kind: "egress_violation",
      host: args.host,
      port: args.port,
      reason: args.reason,
      command: args.command,
    });
    const id = "stub-session-id";
    const spec = {
      unixSocketPath: "/tmp/iknow-egress-stub.sock",
      sandboxLocalPort: 0,
      env: {},
      // EgressFenceSpec requires an inner-bridge preamble; this stub never listens, so it stays empty.
      innerBridgeScript: "",
      relayAssetsDir: "/test/iknow/vendor/egress-relay",
    };
    return Object.freeze({
      id,
      spec,
      violationSink: sink,
      dispose: async () => undefined,
    });
  };
}

describe("bash handler → executor → categorizeResult → mid tier (T5 typed failure, SC3)", () => {
  it("egress 拒绝 → handler 抛 ToolExecutionError → executor 包 execution_failed → categorizeResult → mid", async () => {
    const stub = makeStubEgressSessionFactory({
      host: "evil.example",
      port: 443,
      command: "curl -sS https://evil.example/x",
      reason: "not-in-allowlist",
    });

    const tool = createBashTool(FIX_CWD, {
      egressPolicyFactory: () => ({
        allowedDomains: ["github.com"],
        deniedDomains: [],
        commandLabel: "curl -sS https://evil.example/x",
      }),
      createEgressSessionFactory: stub as never,
    });

    // Real executor + registry wiring — exercise the actual
    // buildOkResult / buildFailureResult path, no hand-made
    // `kind: "execution_failed"` false green inside the test.
    const registry = createRegistry([tool]);
    const inner = createExecutor(registry);
    const { executor } = buildViolationWiring(inner, {
      sink: () => undefined,
    });

    const calls: ReadonlyArray<ToolCall> = [
      Object.freeze({
        id: "u1",
        name: "bash",
        input: { command: "curl -sS https://evil.example/x" },
      }) as ToolCall,
    ];

    const results = await executor.executeAll(calls);
    expect(results).toHaveLength(1);
    const r = results[0]!;

    // Really flows through bash handler → executor: the result is
    // execution_failed (typed-error catch → buildFailureResult) and the
    // message carries the [network_denied] prefix, streamed straight from the
    // ToolExecutionError.message thrown by the handler.
    expect(r.kind).toBe("execution_failed");
    const message = (r as { message: string }).message;
    expect(message).toContain("[network_denied]");
    expect(message).toContain("evil.example:443");
    expect(message).toContain("isolation.network.allowedDomains");
    // Semantics: the command ran to completion but its egress was denied.
    expect(message).toContain("command ran to completion");
    // The exit-code bypass (partial stdout/stderr) does not trigger here: the
    // stub session makes the violation path throw before runSandbox. The
    // `curl ...` command would really run inside bwrap under `--unshare-net`
    // and exit non-zero, but the observation surface is the typed failure,
    // not the exit code.

    // Feed the existing categorizeResult — it must land in the mid tier (the
    // spec's false-green warning: the message streamed out of the real bash
    // handler return, not hand-made).
    const cat = categorizeResult({
      name: "bash",
      input: { command: "curl -sS https://evil.example/x" },
      kind: r.kind,
      message,
    });
    expect(cat.tier).toBe("mid");
    expect(cat.detail).toContain("[network_denied]");
    expect(cat.detail).toContain("evil.example");
  });

  it("infra failure (egressStartError) → handler 抛 ToolExecutionError,message 显式标 'infrastructure fault' 不给配置键指引", async () => {
    // Make the stub throw at construction — the bash handler treats it as a
    // startError and takes the infra path.
    const stub = (async () => {
      throw new Error(
        "egress seam unavailable for this call: stub bridge dead"
      );
    }) as never;

    const tool = createBashTool(FIX_CWD, {
      egressPolicyFactory: () => ({
        allowedDomains: ["github.com"],
        deniedDomains: [],
        commandLabel: "test:infra-fail",
      }),
      createEgressSessionFactory: stub,
    });

    const registry = createRegistry([tool]);
    const inner = createExecutor(registry);
    const { executor } = buildViolationWiring(inner, {
      sink: () => undefined,
    });

    const calls: ReadonlyArray<ToolCall> = [
      Object.freeze({
        id: "u2",
        name: "bash",
        input: { command: "true" },
      }) as ToolCall,
    ];

    const results = await executor.executeAll(calls);
    const r = results[0]!;
    expect(r.kind).toBe("execution_failed");
    const message = (r as { message: string }).message;
    expect(message).toContain("[network_denied]");
    // Infra faults and domain-policy denials stay textually distinguishable
    // (specs/network-egress-allowlist.md: three signals + failure paths).
    expect(message).toContain("egress seam unavailable");
    expect(message).toContain("infrastructure fault");
    // Repair guidance: an infra fault must not cite config keys (misleading).
    expect(message).not.toContain("isolation.network.allowedDomains");
    expect(message).not.toContain("configure isolation.network");

    // Same mid-tier routing (the prefix hits the networkDenied branch).
    const cat = categorizeResult({
      name: "bash",
      input: {},
      kind: r.kind,
      message,
    });
    expect(cat.tier).toBe("mid");
  });

  it("drain 空 + 无 startError → handler 维持 V1 ok 形状(byte-identical 于 T4 前)", async () => {
    // A stub session whose drain is empty (nothing recorded): the handler must
    // keep the V1 ok shape and never enter the ToolExecutionError throw path.
    // This pins "violations / startError both empty ⇒ still ok" as an
    // invariant preserved by the typed-failure upgrade (regression baseline).
    const stub = (async () => {
      const sink = createEgressViolationSink();
      return Object.freeze({
        id: "stub-empty",
        spec: {
          unixSocketPath: "/tmp/iknow-egress-empty.sock",
          sandboxLocalPort: 0,
          env: {},
          innerBridgeScript: "",
        },
        violationSink: sink,
        dispose: async () => undefined,
      });
    }) as never;

    const tool = createBashTool(FIX_CWD, {
      egressPolicyFactory: () => ({
        allowedDomains: ["github.com"],
        deniedDomains: [],
        commandLabel: "test:empty-drain",
      }),
      createEgressSessionFactory: stub,
    });

    const ctx: ToolExecutionContext = { conversationId: "conv-empty" };
    const out = await tool.handler({ command: "true" }, ctx);
    // V1 ok shape: envelope { output, meta? }
    expect(out).toBeTypeOf("object");
    const envelope = out as {
      output: string;
      meta?: { stdout: string; stderr: string };
    };
    expect(typeof envelope.output).toBe("string");
    const parsed = JSON.parse(envelope.output) as {
      code: number;
      stdout: string;
      stderr: string;
    };
    // Exit code comes from the bwrap runInSandbox — normally 0 for `true`.
    expect(typeof parsed.code).toBe("number");
    // stderr carries no typed-failure prefix
    expect(parsed.stderr).not.toContain("[network_denied]");
  });

  it("EgressRelayUnavailableError typed-error catch 契约 → typed failure message 含产品依赖指引，且不含 socat/apt 装包字样 (ADR-0107)", async () => {
    // Typed-error catch contract (code-quality.md): the catch in
    // startEgressSessionForCall must first discriminate the concrete type of
    // the union. For EgressRelayUnavailableError — a typed error carrying
    // detail + remediationHint — it builds a structured startError /
    // infraHint directly; once that reaches renderEgressFailureMessage's
    // infraHint, the typed failure message must show the model/TUI which
    // product dependency is missing and how to repair it. ADR-0107 reskin:
    // the hint carries product-dependency semantics (repair or reinstall the
    // iknow install root) and the old "apt install socat" text must never
    // resurface — this pin was inverted from "contains packaging text" to
    // "never contains it".
    const stubThrowRelayUnavailable = (async () => {
      throw new EgressRelayUnavailableError(
        "this install cannot resolve its bundled egress relay (node runtime or vendor/egress-relay assets missing)",
        "The relay ships with iknow; repair or reinstall the iknow install root — no extra system package is part of this product."
      );
    }) as never;

    const tool = createBashTool(FIX_CWD, {
      egressPolicyFactory: () => ({
        allowedDomains: ["github.com"],
        deniedDomains: [],
        commandLabel: "curl https://example.com/x",
      }),
      createEgressSessionFactory: stubThrowRelayUnavailable,
    });

    const registry = createRegistry([tool]);
    const inner = createExecutor(registry);
    const { executor } = buildViolationWiring(inner, {
      sink: () => undefined,
    });

    const calls: ReadonlyArray<ToolCall> = [
      Object.freeze({
        id: "u4",
        name: "bash",
        input: { command: "curl https://example.com/x" },
      }) as ToolCall,
    ];
    const results = await executor.executeAll(calls);
    const r = results[0]!;
    expect(r.kind).toBe("execution_failed");
    const message = (r as { message: string }).message;

    // Typed-error rendering contract: the message must carry the
    // product-dependency guidance, not be swallowed into [object Object].
    expect(message).toContain("[network_denied]");
    // Product-dependency semantics appear explicitly (not [object Object]).
    expect(message).toContain("bundled egress relay");
    expect(message).toContain("no extra system package");
    // ADR-0107: the old packaging-install text is pinned out for good.
    expect(message.toLowerCase()).not.toContain("socat");
    expect(message.toLowerCase()).not.toContain("apt install");
    // Infra/domain separation still holds: no domain-repair hint appears.
    expect(message).not.toContain("isolation.network.allowedDomains");
    expect(message).not.toContain("configure isolation.network");
    // The infrastructure-fault wording is preserved.
    expect(message).toContain("infrastructure fault");

    // Mid-tier routing is kept (prefix hits networkDenied → mid).
    const cat = categorizeResult({
      name: "bash",
      input: {},
      kind: r.kind,
      message,
    });
    expect(cat.tier).toBe("mid");
  });

  it("allowlistSource 透传 → typed failure message 标注 'Current allowlist source'", async () => {
    // Even without the real approval-gate value wired in, the allowlistSource
    // pass-through chain must be live: assembly-side injection → typed-failure
    // rendering consumes it → the text carries the source annotation.
    const stub = makeStubEgressSessionFactory({
      host: "evil.example",
      port: 443,
      command: "curl",
      reason: "not-in-allowlist",
      allowlistSource: "session",
    });

    const tool = createBashTool(FIX_CWD, {
      egressPolicyFactory: () => ({
        allowedDomains: ["github.com"],
        deniedDomains: [],
        commandLabel: "curl",
        allowlistSource: "session",
      }),
      createEgressSessionFactory: stub as never,
    });

    const registry = createRegistry([tool]);
    const inner = createExecutor(registry);
    const { executor } = buildViolationWiring(inner, {
      sink: () => undefined,
    });

    const calls: ReadonlyArray<ToolCall> = [
      Object.freeze({
        id: "u3",
        name: "bash",
        input: { command: "curl" },
      }) as ToolCall,
    ];
    const results = await executor.executeAll(calls);
    const r = results[0]!;
    expect(r.kind).toBe("execution_failed");
    const message = (r as { message: string }).message;
    expect(message).toContain(
      "Current allowlist source: session-level allowlist"
    );
  });

  it("session 档真生产者：caller 未设 source + 交互批准面在场 → 包装层 fallback 标注 session (T2 钉死表)", async () => {
    // The bash factory wrapper is the only true producer of the "session"
    // tier: the caller (assembly) produces only builtin / persisted. When the
    // source is unset and askApproval is present, the wrapper fills in "session".
    const stub = makeStubEgressSessionFactory({
      host: "evil.example",
      port: 443,
      command: "curl",
      reason: "not-in-allowlist",
    });

    const tool = createBashTool(FIX_CWD, {
      egressPolicyFactory: () => ({
        allowedDomains: ["github.com"],
        deniedDomains: [],
        commandLabel: "curl",
      }),
      askApproval: async () => true,
      createEgressSessionFactory: stub as never,
    });

    const registry = createRegistry([tool]);
    const inner = createExecutor(registry);
    const { executor } = buildViolationWiring(inner, {
      sink: () => undefined,
    });

    const calls: ReadonlyArray<ToolCall> = [
      Object.freeze({
        id: "u4",
        name: "bash",
        input: { command: "curl" },
      }) as ToolCall,
    ];
    const results = await executor.executeAll(calls);
    const r = results[0]!;
    expect(r.kind).toBe("execution_failed");
    const message = (r as { message: string }).message;
    expect(message).toContain(
      "Current allowlist source: session-level allowlist."
    );
  });
});
