/**
 * Tests for `egress/session.ts` filter + approvalGate integration —
 * end-to-end walk of the first-seen-domain approval decision side
 * (specs/network-egress-allowlist.md, first-domain approval flow).
 *
 * Pinned invariants:
 *   - not-in-allowlist + gate present + approved → return true, record no violation;
 *   - not-in-allowlist + gate present + denied → return false, record a
 *     `denied-by-user` violation;
 *   - not-in-allowlist + gate absent → return false, record a `no-approval-inlet`
 *     violation (spec failure path: a non-interactive inlet seeing a new domain);
 *   - other deny reasons (denied / allowlist-empty / allowlist-malformed /
 *     address-denied) never reach the gate — deny precedence and config-layer
 *     errors must not be bypassed by "asking the user";
 *   - second filter entry for the same host after the gate ran → askApproval is not
 *     called again (session-set hit).
 *
 * The test injects a fake factory through the `createHttpProxyServer` seam and
 * drives the captured filter callback directly, avoiding a real HTTP proxy server,
 * the real CONNECT protocol and auth-token handling — it verifies the decision
 * logic only, never an actual outbound dial.
 */

import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createEgressSession,
  type EgressPolicyInput,
} from "../../../src/harness/sandbox/egress/session.js";
import { createEgressApprovalGate } from "../../../src/harness/sandbox/egress/approval.js";
import {
  createEgressViolationSink,
  type EgressViolationSink,
} from "../../../src/harness/sandbox/egress/violations.js";
import { createHttpProxyServer as createHttpProxyServerOrig } from "../../../src/harness/sandbox/egress/upstream.js";
import type { EgressRelayPaths } from "../../../src/harness/sandbox/egress/relay-assets.js";

const scratchPaths: string[] = [];

function scratchDir(): string {
  const d = mkdtempSync(join(tmpdir(), "iknow-egress-approval-test-"));
  scratchPaths.push(d);
  return d;
}

afterEach(() => {
  for (const p of scratchPaths.splice(0)) {
    rmSync(p, { recursive: true, force: true });
  }
});

const STUB_RELAY: EgressRelayPaths = {
  nodePath: "/test-root/bin/node",
  relayDir: "/test-root/vendor/egress-relay",
  bridgeScriptPath: "/test-root/vendor/egress-relay/egress-tcp-relay.mjs",
  connectScriptPath: "/test-root/vendor/egress-relay/egress-http-connect.mjs",
};

/** The proxy-server options the injected fake factory receives. */
type ProxyServerOptions = Parameters<typeof createHttpProxyServerOrig>[0];

/**
 * Capture the filter callback during session assembly by intercepting through the
 * injected fake `createHttpProxyServer`.
 */
interface CapturedFilter {
  /**
   * The session installs its own 2-arg decision closure through this seam (see
   * `createFilterCallback` in session.ts). The proxy-server option type is the
   * wider contract that also carries the socket / CONNECT-command arguments,
   * which the closure ignores — these cases drive the closure directly, so the
   * capture is narrowed back to the 2-arg form the session actually installs.
   */
  readonly filter: (port: number, host: string) => Promise<boolean> | boolean;
}
function captureFilter(): {
  createHttpProxyServer: NonNullable<
    Parameters<typeof createEgressSession>[0]["createHttpProxyServer"]
  >;
  captured: { value?: CapturedFilter };
} {
  const captured: { value?: CapturedFilter } = {};
  const createHttpProxyServer = (opts: ProxyServerOptions) => {
    captured.value = { filter: opts.filter as CapturedFilter["filter"] };
    // minimal server shape so the session's later listenOnUnixSocket completes
    // (a plain http server listening on a unix socket suffices).
    return createServer();
  };
  return { createHttpProxyServer, captured };
}

describe("egress session filter — approvalGate 接线 (T6 SC10)", () => {
  it("not-in-allowlist + gate 在场 + 批准 → filter 返回 true + 不记违例", async () => {
    const askApproval = vi.fn(async () => true);
    const gate = createEgressApprovalGate({ askApproval });
    const sink: EgressViolationSink = createEgressViolationSink();
    const policy: EgressPolicyInput = {
      allowedDomains: ["github.com"],
      deniedDomains: [],
      commandLabel: "test:approve",
      approvalGate: gate,
    };
    const { createHttpProxyServer, captured } = captureFilter();
    const session = await createEgressSession({
      policy,
      relayResolver: () => STUB_RELAY,
      socketPathFactory: (id) => join(scratchDir(), `e-${id}.sock`),
      violationSink: sink,
      createHttpProxyServer,
    });
    try {
      expect(captured.value).toBeDefined();
      const filter = captured.value!.filter;
      const result = await filter(443, "evil.example");
      expect(result).toBe(true);
      expect(askApproval).toHaveBeenCalledWith("evil.example");
      expect(sink.size()).toBe(0);
      expect(gate.allowedThisSession()).toContain("evil.example");
    } finally {
      await session.dispose();
    }
  });

  it("not-in-allowlist + gate 在场 + 拒绝 → filter 返回 false + sink 记 denied-by-user", async () => {
    const askApproval = vi.fn(async () => false);
    const gate = createEgressApprovalGate({ askApproval });
    const sink: EgressViolationSink = createEgressViolationSink();
    const policy: EgressPolicyInput = {
      allowedDomains: ["github.com"],
      deniedDomains: [],
      commandLabel: "test:deny",
      approvalGate: gate,
    };
    const { createHttpProxyServer, captured } = captureFilter();
    const session = await createEgressSession({
      policy,
      relayResolver: () => STUB_RELAY,
      socketPathFactory: (id) => join(scratchDir(), `e-${id}.sock`),
      violationSink: sink,
      createHttpProxyServer,
    });
    try {
      const filter = captured.value!.filter;
      const result = await filter(443, "evil.example");
      expect(result).toBe(false);
      expect(askApproval).toHaveBeenCalledWith("evil.example");
      expect(sink.size()).toBe(1);
      const drained = sink.drain();
      expect(drained[0]?.reason).toBe("denied-by-user");
      expect(drained[0]?.host).toBe("evil.example");
      expect(gate.deniedThisSession()).toContain("evil.example");
    } finally {
      await session.dispose();
    }
  });

  it("not-in-allowlist + gate 缺席 → filter 返回 false + sink 记 no-approval-inlet", async () => {
    const sink: EgressViolationSink = createEgressViolationSink();
    const policy: EgressPolicyInput = {
      allowedDomains: ["github.com"],
      deniedDomains: [],
      commandLabel: "test:no-inlet",
      // approvalGate deliberately absent
    };
    const { createHttpProxyServer, captured } = captureFilter();
    const session = await createEgressSession({
      policy,
      relayResolver: () => STUB_RELAY,
      socketPathFactory: (id) => join(scratchDir(), `e-${id}.sock`),
      violationSink: sink,
      createHttpProxyServer,
    });
    try {
      const filter = captured.value!.filter;
      const result = await filter(443, "evil.example");
      expect(result).toBe(false);
      expect(sink.size()).toBe(1);
      const drained = sink.drain();
      expect(drained[0]?.reason).toBe("no-approval-inlet");
    } finally {
      await session.dispose();
    }
  });

  it("deny 优先 —— host 在 denied 集 → 不调 askApproval,reason=denied", async () => {
    // deny precedence (spec settled invariant) — a host in the denied set is
    // rejected by the filter directly, even with approvalGate present.
    const askApproval = vi.fn(async () => true);
    const gate = createEgressApprovalGate({ askApproval });
    const sink: EgressViolationSink = createEgressViolationSink();
    const policy: EgressPolicyInput = {
      allowedDomains: ["github.com"],
      deniedDomains: ["evil.example"],
      commandLabel: "test:deny-priority",
      approvalGate: gate,
    };
    const { createHttpProxyServer, captured } = captureFilter();
    const session = await createEgressSession({
      policy,
      relayResolver: () => STUB_RELAY,
      socketPathFactory: (id) => join(scratchDir(), `e-${id}.sock`),
      violationSink: sink,
      createHttpProxyServer,
    });
    try {
      const filter = captured.value!.filter;
      const result = await filter(443, "evil.example");
      expect(result).toBe(false);
      expect(askApproval).not.toHaveBeenCalled();
      const drained = sink.drain();
      expect(drained[0]?.reason).toBe("denied");
    } finally {
      await session.dispose();
    }
  });

  it("同 host 第二次进入 filter → 不再调 askApproval(集合命中)", async () => {
    const askApproval = vi.fn(async () => true);
    const gate = createEgressApprovalGate({ askApproval });
    const sink: EgressViolationSink = createEgressViolationSink();
    const policy: EgressPolicyInput = {
      allowedDomains: ["github.com"],
      deniedDomains: [],
      commandLabel: "test:cache-hit",
      approvalGate: gate,
    };
    const { createHttpProxyServer, captured } = captureFilter();
    const session = await createEgressSession({
      policy,
      relayResolver: () => STUB_RELAY,
      socketPathFactory: (id) => join(scratchDir(), `e-${id}.sock`),
      violationSink: sink,
      createHttpProxyServer,
    });
    try {
      const filter = captured.value!.filter;
      const r1 = await filter(443, "evil.example");
      const r2 = await filter(443, "evil.example");
      expect(r1).toBe(true);
      expect(r2).toBe(true);
      expect(askApproval).toHaveBeenCalledTimes(1);
      expect(sink.size()).toBe(0);
    } finally {
      await session.dispose();
    }
  });

  it("并发同 host 两次进入 filter → 合并为一次 ask(只调一次)", async () => {
    // concurrent async entries for the same host merge on the gate's in-flight
    // table, so askApproval is called only once.
    let resolveAsk: ((v: boolean) => void) | undefined;
    const askApproval = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          resolveAsk = resolve;
        })
    );
    const gate = createEgressApprovalGate({ askApproval });
    const sink: EgressViolationSink = createEgressViolationSink();
    const policy: EgressPolicyInput = {
      allowedDomains: ["github.com"],
      deniedDomains: [],
      commandLabel: "test:concurrent",
      approvalGate: gate,
    };
    const { createHttpProxyServer, captured } = captureFilter();
    const session = await createEgressSession({
      policy,
      relayResolver: () => STUB_RELAY,
      socketPathFactory: (id) => join(scratchDir(), `e-${id}.sock`),
      violationSink: sink,
      createHttpProxyServer,
    });
    try {
      const filter = captured.value!.filter;
      const p1 = filter(443, "evil.example");
      const p2 = filter(443, "evil.example");
      expect(askApproval).toHaveBeenCalledTimes(1);
      resolveAsk?.(true);
      const [r1, r2] = await Promise.all([p1, p2]);
      expect(r1).toBe(true);
      expect(r2).toBe(true);
      expect(sink.size()).toBe(0);
      expect(gate.allowedThisSession()).toContain("evil.example");
    } finally {
      await session.dispose();
    }
  });
});
