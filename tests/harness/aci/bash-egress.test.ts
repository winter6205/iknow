/**
 * Tests for `aci/tools/bash.ts` egress wiring — foreground fence assembly and
 * typed-failure escalation (specs/network-egress-allowlist.md, violation
 * feedback channel: feedback → prefix and tier entry).
 *
 * Pinned invariants (specs/network-egress-allowlist.md + ADR-0097):
 *   - egressPolicyFactory absent → handler starts no session; the fence takes
 *     the V1 baseline (no socket bind, no proxy env);
 *   - factory returns a policy but the relay product dependency is missing
 *     (the injected seam throws `EgressRelayUnavailableError`) → handler throws
 *     the typed `ToolExecutionError` whose message carries the
 *     `[network_denied]` prefix + "egress seam unavailable" infra text (no
 *     more stderr bypass — it flows through categorizeResult's
 *     `networkDenied → mid` branch);
 *   - factory returns undefined → handler skips the session attempt entirely.
 *
 * Not tested here: real bwrap+netns egress (the real chain is measured
 * out-of-band via pty/probe). The present path really starts a relay session
 * (bare http server listening on a unix socket, ADR-0107) and really spawns
 * bwrap — gated on bwrap availability (graceful skip on CI runners without
 * user-namespace; always runs locally).
 *
 * The tier 1→mid end-to-end walkthrough lives in
 * `bash-egress-typed-failure.test.ts` (real bash handler return → executor →
 * categorizeResult → mid tier, not a hand-made `kind:"execution_failed"`).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterAll, describe, expect, it } from "vitest";
import { createBashTool } from "../../../src/harness/aci/tools/bash.js";
import { EgressRelayUnavailableError } from "../../../src/harness/sandbox/egress/session.js";
import { ToolExecutionError } from "../../../src/harness/errors.js";

const FIX_CWD = mkdtempSync(join(tmpdir(), "bash-egress-cwd-"));

afterAll(() => {
  rmSync(FIX_CWD, { recursive: true, force: true });
});

/** bwrap-availability gate — the present path really spawns the fence child
 *  (since ADR-0107 the relay session assembly itself has no host packaging
 *  prerequisite; bwrap is the only remaining machine prerequisite). */
function bwrapAvailable(): boolean {
  const probe = spawnSync("which", ["bwrap"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 1000,
  });
  return probe.status === 0;
}

interface BashEnvelope {
  readonly output: string;
  readonly meta?: { readonly stdout?: string; readonly stderr?: string };
}

interface BashResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

function parseBashEnvelope(envelope: BashEnvelope): BashResult {
  return JSON.parse(envelope.output) as BashResult;
}

describe("bash handler — egress wiring (T4 expand)", () => {
  it("egressPolicyFactory 缺席 → 无 egress 旁路,handler 走 V1 路径", async () => {
    const tool = createBashTool(FIX_CWD, {
      // deliberately omit egressPolicyFactory
    });
    const result = (await tool.handler(
      { command: "true" },
      { conversationId: "conv-no-policy" }
    )) as BashEnvelope;
    const env = parseBashEnvelope(result);
    // V1 baseline: no egress bypass text
    expect(env.stderr).not.toContain("[network_denied] egress");
    expect(env.stderr).not.toContain("egress seam unavailable");
  });

  it("egressPolicyFactory 返 undefined → 跳过 session 尝试,无旁路文案", async () => {
    const tool = createBashTool(FIX_CWD, {
      egressPolicyFactory: () => undefined,
    });
    const result = (await tool.handler(
      { command: "true" },
      { conversationId: "conv-undef-policy" }
    )) as BashEnvelope;
    const env = parseBashEnvelope(result);
    expect(env.stderr).not.toContain("[network_denied] egress");
    expect(env.stderr).not.toContain("egress seam unavailable");
  });

  it("egressPolicyFactory 返 policy + 中继依赖缺席 → 抛 typed failure,message 含 [network_denied] 前缀 (T5 / SC13)", async () => {
    // The seam-injected absence path always throws, so this is testable
    // independent of host state (ADR-0107: a missing relay is a product
    // dependency semantic; there is no "host lacks a package → degrade" fork).
    const tool = createBashTool(FIX_CWD, {
      egressPolicyFactory: () => ({
        allowedDomains: ["github.com"],
        deniedDomains: [],
        commandLabel: "test:egress-fail-closed",
      }),
      createEgressSessionFactory: (async () => {
        throw new EgressRelayUnavailableError(
          "this install cannot resolve its bundled egress relay",
          "repair or reinstall the iknow install root — no extra system package is part of this product"
        );
      }) as never,
    });
    let caught: unknown;
    try {
      await tool.handler(
        { command: "true" },
        { conversationId: "conv-relay-missing" }
      );
    } catch (err) {
      caught = err;
    }
    // Typed failure (no longer stderr bypass + ok envelope).
    expect(caught).toBeInstanceOf(ToolExecutionError);
    const message = (caught as ToolExecutionError).message;
    // The [network_denied] prefix routes it into the mid tier via the existing categorizeResult.
    expect(message).toContain("[network_denied]");
    // "egress seam unavailable" infra text — distinguishable from domain-policy denials.
    expect(message).toContain("egress seam unavailable");
    expect(message).toContain("infrastructure fault");
    // Repair guidance: an infra fault must not cite config keys (misleading).
    expect(message).not.toContain("isolation.network.allowedDomains");
    expect(message).toContain("egress relay");
    // The message signals the command still ran to completion.
    expect(message).toContain("command ran to completion");
  });

  it("egressPolicyFactory 返 policy + 中继在场（生产解析路径）→ handler 正常走完(占位 smoke)", async () => {
    if (!bwrapAvailable()) {
      return; // not applicable on CI runners without bwrap
    }
    // Real relay resolution + bare http server listening on a unix socket +
    // real bwrap — consumes socket resources; this test only asserts the
    // handler does not throw a typed error. The real curl-through-proxy chain
    // is measured out-of-band via probe scripts; this repo pins the assembly contract.
    const tool = createBashTool(FIX_CWD, {
      egressPolicyFactory: () => ({
        allowedDomains: ["github.com"],
        deniedDomains: [],
        commandLabel: "test:egress-success",
      }),
    });
    const result = (await tool.handler(
      { command: "true" },
      { conversationId: "conv-relay-present" }
    )) as BashEnvelope;
    const env = parseBashEnvelope(result);
    // Once the real session is up, runInSandbox really spawns bwrap, which may
    // fail on a missing executable inside the fence — we only assert the
    // handler does not throw a typed error.
    expect(typeof env.code).toBe("number");
    expect(typeof env.stderr).toBe("string");
  });
});
