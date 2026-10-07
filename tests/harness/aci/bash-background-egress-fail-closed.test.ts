/**
 * Background route egress: unknown-domain access stays fail-closed.
 *
 * The bash factory injects its session-level approval gate into the policy it
 * builds, and the egress filter consults `policy.approvalGate` whenever it sees
 * `not-in-allowlist`. A background task is a detached, non-interactive inlet:
 * the handler has already returned `task_id` by the time any traffic happens,
 * so a prompt raised from inside the proxy has no one to answer it — and if it
 * is answered, it is answered for a stream the model is no longer waiting on.
 * The settled contract is that background/verify unknown-domain access is
 * denied (`no-approval-inlet`), which only holds if the gate never reaches the
 * background request.
 *
 * The assertion runs the REAL filter: the policy the handler handed the manager
 * is used to assemble a real egress session through the `createHttpProxyServer`
 * seam, and the captured filter callback is driven against an unknown host.
 * A policy-field check alone would only pin the wiring, not the behaviour.
 */
import { createServer } from "node:http";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

import { createBashTool } from "../../../src/harness/aci/tools/bash.js";
import {
  createEgressSession,
  type EgressPolicyInput,
  type EgressSessionOptions,
} from "../../../src/harness/sandbox/egress/session.js";
import {
  createEgressViolationSink,
  type EgressViolationSink,
} from "../../../src/harness/sandbox/egress/violations.js";
import type { EgressRelayPaths } from "../../../src/harness/sandbox/egress/relay-assets.js";
import type { BackgroundSpawnRequest } from "../../../src/harness/background/manager.js";

const FIX_CWD = mkdtempSync(join(tmpdir(), "bash-bg-egress-"));
afterAll(() => rmSync(FIX_CWD, { recursive: true, force: true }));

const STUB_RELAY: EgressRelayPaths = {
  nodePath: "/test-root/bin/node",
  relayDir: "/test-root/vendor/egress-relay",
  bridgeScriptPath: "/test-root/vendor/egress-relay/egress-tcp-relay.mjs",
  connectScriptPath: "/test-root/vendor/egress-relay/egress-http-connect.mjs",
};

type ProxyServerOptions = Parameters<
  NonNullable<EgressSessionOptions["createHttpProxyServer"]>
>[0];

interface CapturedFilter {
  readonly filter: (port: number, host: string) => Promise<boolean> | boolean;
}

/** Capture the session's decision closure without a real proxy server. */
function captureFilter(): {
  createHttpProxyServer: NonNullable<
    EgressSessionOptions["createHttpProxyServer"]
  >;
  captured: { value?: CapturedFilter };
} {
  const captured: { value?: CapturedFilter } = {};
  return {
    createHttpProxyServer: (opts: ProxyServerOptions) => {
      captured.value = {
        filter: opts.filter as CapturedFilter["filter"],
      };
      return createServer();
    },
    captured,
  };
}

describe("background egress stays fail-closed for an unknown domain", () => {
  it("the spawn request carries no approval gate, and its filter denies without asking", async () => {
    const askApproval = vi.fn(async () => true);
    const requests: BackgroundSpawnRequest[] = [];
    const tool = createBashTool(FIX_CWD, {
      // An interactive session: the factory builds the session-level gate.
      askApproval,
      egressPolicyFactory: () => ({
        allowedDomains: ["github.com"],
        deniedDomains: [],
        commandLabel: "curl -sS https://evil.example/x",
      }),
      backgroundManager: {
        spawn: async (request: BackgroundSpawnRequest) => {
          requests.push(request);
          return {
            status: "ok",
            task_id: "bg-0123456789ab",
            log_path: "/tmp/tasks/bg-0123456789ab.log",
          };
        },
        status: async () => {
          throw new Error("unused");
        },
        output: async () => {
          throw new Error("unused");
        },
        stop: async () => {
          throw new Error("unused");
        },
        list: async () => [],
        onConversationDeleted: () => undefined,
      } as never,
    });

    await tool.handler({
      command: "curl -sS https://evil.example/x",
      background: true,
    });

    assert.equal(requests.length, 1);
    const policy: EgressPolicyInput | undefined = requests[0]!.egressPolicy;
    assert.ok(
      policy,
      "a policy factory was injected, so the request carries one"
    );
    assert.equal(
      policy.approvalGate,
      undefined,
      "the background inlet must not carry the interactive approval gate"
    );

    // Behaviour, not just wiring: run the captured policy through a real
    // session filter.
    const sink: EgressViolationSink = createEgressViolationSink();
    const { createHttpProxyServer, captured } = captureFilter();
    const session = await createEgressSession({
      policy,
      relayResolver: () => STUB_RELAY,
      socketPathFactory: (id) =>
        join(mkdtempSync(join(tmpdir(), "iknow-bg-egress-")), `e-${id}.sock`),
      violationSink: sink,
      createHttpProxyServer,
    });
    try {
      const filter = captured.value!.filter;
      assert.equal(await filter(443, "evil.example"), false);
      expect(askApproval).not.toHaveBeenCalled();
      assert.deepEqual(
        sink
          .drain()
          .map((v) => (v.kind === "egress_violation" ? v.reason : v.kind)),
        ["no-approval-inlet"]
      );
    } finally {
      await session.dispose();
    }
  });
});
