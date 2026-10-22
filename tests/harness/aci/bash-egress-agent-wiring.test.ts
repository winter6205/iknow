/**
 * The bash tool's egress seam runs on the session-resident agent (plan T4
 * "出口代理会话级常驻" + T5 "按调用子 socket").
 *
 * Pinned invariants (assembly wiring, not the egress module itself):
 *   - W1: three consecutive bash calls open THREE endpoints (one per call),
 *     while the agent's PROFILE is loaded exactly once for the whole session;
 *   - W2: a violation is attributed to the call that produced it — the
 *     violating call's drain yields the violation, the compliant call's drain
 *     is empty (the bash tool drains THIS call's endpoint sink);
 *   - W3: the endpoint is released at the end of the call (its socket is
 *     gone), and the call never disposes the AGENT;
 *   - D7: a released agent is a lifecycle error — the call fails with that
 *     rendering and never degrades into a bare command without a proxy;
 *   - S4: with the fence RETIRED the seam is skipped wholesale — the agent is
 *     never asked for an endpoint (its own `createCallEndpoint` records no
 *     call) and the command still runs, fence-free.
 *
 * Injection strategy follows the neighbouring suites: the fence builder and
 * the sandbox runner are stubbed (the assertions are about the seam wiring,
 * not about the bwrap spawn), the egress AGENT MODULE IS NEVER MOCKED — the
 * real `createEgressAgent` runs, with its own documented test seams (relay
 * resolver, socket path factory, proxy-server factory) carrying the fixtures.
 */

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The filter closure the proxy server installs per endpoint. The upstream
 * signature also carries the client socket; the seam only needs the decision
 * input, so the captured closure is narrowed to it.
 */
type CapturedFilter = (
  port: number,
  host: string
) => Promise<boolean> | boolean;

/** Module-level capture box (vi.hoisted: the mock factories read it at import time). */
const h = vi.hoisted(() => ({
  /** opts received by createBwrapFence (sandbox barrel). */
  fenceOpts: [] as Record<string, unknown>[],
  /** the filter closure of every proxy-server instance the agent opened. */
  filters: [] as CapturedFilter[],
  /** drive the newest filter with a denied host (the violating call). */
  violate: false,
  /** the host the stubbed runner drives the filter with. */
  violateHost: "blocked.example",
  /**
   * The socket path of every endpoint the agent opened, in creation order.
   * The endpoint's socket path and its filter closure are created back to
   * back, so the Nth path names the Nth filter.
   */
  socketPaths: [] as string[],
  /** the calls that reached the sandbox seam, with the call they serve. */
  served: [] as Array<{
    socketPath: string;
    argv: string[];
    start: number;
    end: number;
  }>,
  /** when set, the sandbox seam holds the call until the gate is opened. */
  gate: undefined as
    | { readonly wait: Promise<void>; readonly open: () => void }
    | undefined,
}));

vi.mock("../../../src/harness/sandbox/index.ts", async () => {
  const mod = await vi.importActual<
    typeof import("../../../src/harness/sandbox/index.ts")
  >("../../../src/harness/sandbox/index.ts");
  return {
    ...mod,
    createBwrapFence: (opts: Record<string, unknown>) => {
      h.fenceOpts.push(opts);
      // The stub fence carries the endpoint's egress spec and the command
      // argv, so the sandbox seam can tell WHICH call it is serving (its own
      // endpoint, its own command).
      const egress = opts["egress"] as { unixSocketPath?: string } | undefined;
      const args = Array.isArray(opts["args"])
        ? (opts["args"] as string[])
        : [];
      return {
        exactFileMaskPaths: [],
        ...(egress !== undefined ? { egress } : {}),
        argv: [String(opts["command"]), ...args],
      };
    },
  };
});

// bash.ts imports runInSandbox directly from sandbox/runner.js — replace that too.
vi.mock("../../../src/harness/sandbox/runner.ts", async () => {
  const mod = await vi.importActual<
    typeof import("../../../src/harness/sandbox/runner.ts")
  >("../../../src/harness/sandbox/runner.ts");
  return {
    ...mod,
    runInSandbox: async (
      opts: Parameters<
        typeof import("../../../src/harness/sandbox/runner.ts").runInSandbox
      >[0]
    ): Promise<{
      exitCode: number;
      stdout: string;
      stderr: string;
    }> => {
      const fence = opts.fence as {
        egress?: { unixSocketPath?: string };
        argv?: readonly string[];
      };
      const served = {
        socketPath: fence.egress?.unixSocketPath ?? "",
        argv: [...(fence.argv ?? [])],
        start: Date.now(),
        end: 0,
      };
      h.served.push(served);
      // The gate (opt-in): the call is held at the sandbox seam until the test
      // opens it, so the test can drive the endpoint's filter while the call
      // is still in flight.
      await h.gate?.wait;
      served.end = Date.now();
      // The sandbox is the only actor that would drive the endpoint's filter;
      // the stub drives it on demand so a call can produce a violation.
      if (h.violate) {
        const filter = h.filters[h.filters.length - 1];
        if (filter !== undefined) await filter(443, h.violateHost);
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  };
});

import { createBashTool } from "../../../src/harness/aci/tools/bash.js";
import { createAciExecutor } from "../../../src/harness/aci/aci-executor.ts";
import { createPermissionPolicy } from "../../../src/harness/aci/permission.ts";
import { createExecutor } from "../../../src/harness/tools/executor.ts";
import { createRegistry } from "../../../src/harness/tools/registry.ts";
import {
  createEgressAgent,
  EgressAgentDisposedError,
  type EgressAgent,
} from "../../../src/harness/sandbox/egress/agent.js";
import type { EgressRelayPaths } from "../../../src/harness/sandbox/egress/relay-assets.js";
import { ToolExecutionError } from "../../../src/harness/errors.js";

const scratch: string[] = [];
const agents: EgressAgent[] = [];

function scratchDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "iknow-bash-agent-"));
  scratch.push(dir);
  return dir;
}

/** Fixed fake relay path set — the resolver seam means the host layout is never probed. */
function fakeRelay(): EgressRelayPaths {
  const relayDir = "/test-root/vendor/egress-relay";
  return {
    nodePath: "/test-root/bin/node",
    relayDir,
    bridgeScriptPath: join(relayDir, "egress-tcp-relay.mjs"),
    connectScriptPath: join(relayDir, "egress-http-connect.mjs"),
  };
}

interface AgentFixture {
  readonly agent: EgressAgent;
  /** how many endpoints the tool opened through the agent. */
  readonly opened: () => number;
  /** how many times the agent resolved its profile (the expensive half). */
  readonly profileLoads: () => number;
}

/**
 * A real agent with counting seams: the profile resolution is counted (the
 * relay resolver runs exactly once per agent) and the endpoint creation is
 * counted through a thin delegating wrapper — the agent module itself is not
 * mocked, the wrapper only observes.
 */
function agentFixture(): AgentFixture {
  const dir = scratchDir();
  let profileLoads = 0;
  let opened = 0;
  const real = createEgressAgent({
    relayResolver: () => {
      profileLoads += 1;
      return fakeRelay();
    },
    socketPathFactory: (id) => {
      const path = join(dir, `call-${id}.sock`);
      h.socketPaths.push(path);
      return path;
    },
    createHttpProxyServer: (opts) => {
      h.filters.push(opts.filter as CapturedFilter);
      return createServer();
    },
  });
  agents.push(real);
  const agent: EgressAgent = {
    id: real.id,
    violationSink: real.violationSink,
    ensureStarted: () => real.ensureStarted(),
    createCallEndpoint: async (policy) => {
      opened += 1;
      return await real.createCallEndpoint(policy);
    },
    dispose: () => real.dispose(),
  };
  return {
    agent,
    opened: () => opened,
    profileLoads: () => profileLoads,
  };
}

/** A policy the tool may open a seam for. */
function policyFactory(): () => {
  allowedDomains: string[];
  deniedDomains: string[];
  commandLabel: string;
} {
  return () => ({
    allowedDomains: ["allowed.example"],
    deniedDomains: [],
    commandLabel: "test:bash-agent",
  });
}

function makeTool(
  agent: EgressAgent,
  overrides: { readonly fenceRetired?: boolean } = {}
): ReturnType<typeof createBashTool> {
  return createBashTool(scratchDir(), {
    egressPolicyFactory: policyFactory(),
    egressAgent: agent,
    homeRoot: scratchDir(),
    // ADR-0141: the derived fence posture — a get-only reader, so the tool
    // cannot flip the axis.
    ...(overrides.fenceRetired !== undefined
      ? { fenceRetired: { get: () => overrides.fenceRetired === true } }
      : {}),
  });
}

/** The socket path of the endpoint the Nth call opened (from the fence opts). */
function fenceSocketPaths(): string[] {
  return h.fenceOpts
    .map(
      (opts) =>
        (opts.egress as { unixSocketPath: string } | undefined)?.unixSocketPath
    )
    .filter((path): path is string => path !== undefined);
}

afterEach(async () => {
  h.fenceOpts.length = 0;
  h.filters.length = 0;
  h.violate = false;
  h.socketPaths.length = 0;
  h.served.length = 0;
  h.gate = undefined;
  for (const agent of agents.splice(0)) await agent.dispose();
  for (const dir of scratch.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * The filter closure of the endpoint that owns this socket path. The endpoint's
 * socket path and its filter closure are created back to back (one endpoint,
 * one proxy-server instance), so the Nth path names the Nth filter.
 */
function filterForSocketPath(socketPath: string): CapturedFilter | undefined {
  const index = h.socketPaths.indexOf(socketPath);
  return index < 0 ? undefined : h.filters[index];
}

/** A gate the sandbox seam holds the calls at until the test opens it. */
function createGate(): { readonly wait: Promise<void>; readonly open: () => void } {
  let open: () => void = () => {};
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

/** Wait until the predicate holds (or the deadline passes). */
async function waitFor(
  predicate: () => boolean,
  timeoutMs = 5_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error("timed out waiting for the condition");
    }
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("bash tool — 会话级常驻 egress agent (T4/T5)", () => {
  it("W1: 三次连续调用开三个端点,agent 的 profile 只加载一次", async () => {
    const fixture = agentFixture();
    const tool = makeTool(fixture.agent);

    for (let i = 0; i < 3; i++) {
      await tool.handler({ command: "true" }, { conversationId: `conv-${i}` });
    }

    // One endpoint per call …
    expect(fixture.opened()).toBe(3);
    const paths = fenceSocketPaths();
    expect(paths).toHaveLength(3);
    expect(new Set(paths).size).toBe(3);
    // … while the session-level half is loaded exactly once.
    expect(fixture.profileLoads()).toBe(1);
  });

  it("W2: 违规归到产生它的那次调用:违规调用的 drain 有记录,合规调用的 drain 为空", async () => {
    const fixture = agentFixture();
    const tool = makeTool(fixture.agent);

    // The violating call: the stubbed sandbox drives this call's filter with a
    // host that is not on the allow-list.
    h.violate = true;
    let violatingError: unknown;
    try {
      await tool.handler({ command: "true" }, { conversationId: "conv-bad" });
    } catch (err) {
      violatingError = err;
    }
    expect(violatingError).toBeInstanceOf(ToolExecutionError);
    const violatingMessage = (violatingError as ToolExecutionError).message;
    expect(violatingMessage).toContain("blocked.example");
    expect(violatingMessage).toContain("[network_denied]");

    // The compliant call: no violation is recorded, so its own drain is empty
    // and the call succeeds (a shared sink would have failed it too).
    h.violate = false;
    const okResult = (await tool.handler(
      { command: "true" },
      { conversationId: "conv-good" }
    )) as { output: string };
    const parsed = JSON.parse(okResult.output) as {
      code: number;
      stderr: string;
    };
    expect(parsed.code).toBe(0);
    expect(parsed.stderr).not.toContain("[network_denied]");
  });

  it("W2 concurrent: 两个并发调用共享同一个 agent,违规只归属产生它的那次调用", async () => {
    // The concurrent form of W2: both read-only bash calls share the
    // session-resident agent (one endpoint each), they run in ONE wave, and
    // the violation one of them produces is recorded ONLY under that call.
    const fixture = agentFixture();
    const tool = makeTool(fixture.agent);
    const gate = createGate();
    h.gate = gate;

    const registry = createRegistry([tool]);
    const aciExec = createAciExecutor({
      inner: createExecutor(registry),
      catalog: {
        get: (name: string) => (name === "bash" ? tool : undefined),
        all: () => [tool],
      },
      // bash is allowed, so both calls start in the executor's concurrent
      // stage (an "ask" verdict would run them one at a time).
      policy: createPermissionPolicy({ defaultRule: "allow" }),
    });

    const pending = aciExec.executeAll([
      {
        id: "violating",
        name: "bash",
        input: { command: "true mark-violating" },
      },
      {
        id: "compliant",
        name: "bash",
        input: { command: "true mark-compliant" },
      },
    ]);

    // Both calls reached the sandbox seam, and they are held there at the
    // SAME time: neither window has closed yet (both `end` markers are still
    // unset). A serial run could not produce this — the second call could
    // never reach the seam while the first one is still held there.
    await waitFor(() => h.served.length === 2);
    expect(h.served.length).toBe(2);
    expect(h.served.every((s) => s.end === 0)).toBe(true);
    // The agent gave each call its OWN endpoint (and its own filter).
    expect(fixture.opened()).toBe(2);
    expect(h.filters.length).toBe(2);
    expect(h.socketPaths.length).toBe(2);

    // Drive the VIOLATING call's own endpoint filter: the compliant call's
    // endpoint is never driven.
    const violating = h.served.find((s) =>
      s.argv.join(" ").includes("mark-violating")
    );
    expect(violating).toBeDefined();
    const filter = filterForSocketPath(violating!.socketPath);
    expect(filter).toBeDefined();
    await filter!(443, h.violateHost);

    // Let both calls finish.
    gate.open();
    const results = await pending;

    // The two calls overlapped in time: the second call had already reached
    // the seam while the first one was still held there, so their windows
    // intersect. (The wall-clock comparison is non-strict: the two markers
    // can land in the same millisecond.)
    const [first, second] = h.served;
    expect(first!.start).toBeLessThanOrEqual(second!.end);
    expect(second!.start).toBeLessThanOrEqual(first!.end);

    // The violation is attributed to the call that produced it …
    expect(results.length).toBe(2);
    const violatingResult = results.find((r) => r.toolUseId === "violating")!;
    expect(violatingResult.kind).toBe("execution_failed");
    const violatingMessage = (violatingResult as { message: string }).message;
    expect(violatingMessage).toContain("blocked.example");
    expect(violatingMessage).toContain("[network_denied]");

    // … and the compliant call's own drain stays empty, so it succeeds.
    const compliantResult = results.find((r) => r.toolUseId === "compliant")!;
    expect(compliantResult.kind).toBe("ok");
    const compliantText = (compliantResult as { payload: { text: string }[] })
      .payload[0]!.text;
    const parsed = JSON.parse(compliantText) as {
      code: number;
      stderr: string;
    };
    expect(parsed.code).toBe(0);
    expect(parsed.stderr).not.toContain("[network_denied]");
  });

  it("W3: 调用结束即释放端点(socket 消失),且调用不会释放 agent", async () => {
    const fixture = agentFixture();
    const tool = makeTool(fixture.agent);

    await tool.handler({ command: "true" }, { conversationId: "conv-release" });

    const [socketPath] = fenceSocketPaths();
    expect(socketPath).toBeDefined();
    // The endpoint was released: its socket is gone.
    expect(existsSync(socketPath!)).toBe(false);
    // The AGENT survived the call: it can still open the next endpoint.
    const next = await fixture.agent.createCallEndpoint({
      allowedDomains: ["allowed.example"],
      deniedDomains: [],
      commandLabel: "test:after-release",
    });
    expect(existsSync(next.socketPath)).toBe(true);
    await next.dispose();
  });

  it("S4: fence 退役时不启动代理 —— agent 的 createCallEndpoint 从未被调用,命令照常运行", async () => {
    const fixture = agentFixture();
    const tool = makeTool(fixture.agent, { fenceRetired: true });

    const result = (await tool.handler(
      { command: "true" },
      { conversationId: "conv-retired" }
    )) as { output: string };
    const parsed = JSON.parse(result.output) as {
      code: number;
      stderr: string;
    };

    // The command ran, fence-free.
    expect(parsed.code).toBe(0);
    // The agent was never touched: no endpoint, and not even a profile load.
    expect(fixture.opened()).toBe(0);
    expect(fixture.profileLoads()).toBe(0);
    // The fence carries the retirement switch and no proxy spec (no netns →
    // no seam to carry).
    expect(h.fenceOpts).toHaveLength(1);
    expect(h.fenceOpts[0]!["fenceRetired"]).toBe(true);
    expect(h.fenceOpts[0]!["egress"]).toBeUndefined();
  });

  it("D7: agent 已释放 → 生命周期错误(不是域拒绝),命令不执行也不裸奔", async () => {
    const fixture = agentFixture();
    const tool = makeTool(fixture.agent);
    await fixture.agent.dispose();

    let caught: unknown;
    try {
      await tool.handler(
        { command: "true" },
        { conversationId: "conv-disposed" }
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ToolExecutionError);
    const message = (caught as ToolExecutionError).message;
    // A lifecycle fault — explicitly not a domain denial and not an infra fault.
    expect(message).toContain("Lifecycle error");
    expect(message).toContain("the command did not run");
    expect(message).not.toContain("[network_denied]");
    expect(message).not.toContain("infrastructure fault");
    // Fail-closed: the call never reached the fence.
    expect(h.fenceOpts).toHaveLength(0);
    // The typed cause is the agent's own error class.
    expect(caught).toBeInstanceOf(EgressAgentDisposedError);
  });
});
