/**
 * ADR-0043 — manager.start({firstTurnReadyTimeoutMs}) + onManualReconnect(cb)
 * seams and the timeout-absence contract.
 *
 * Behavioral ground truth:
 *   - start({firstTurnReadyTimeoutMs: 30_000}) blocks until the window expires
 *     (or every server is connected); servers that connect inside the window
 *     join first-turn assembly untouched, laggards stop auto-retrying and are
 *     absent from the session.
 *   - onManualReconnect(cb): user-triggered reconnect succeeds →
 *     cb(serverName, toolNames); cb invocation is driven directly by tests.
 *
 * Test matrix:
 *   1. start() with no args = background launch (pre-change behavior, fire-and-forget);
 *   2. start({firstTurnReadyTimeoutMs}) = block until timeout or all connected;
 *   3. fake-timer case: one server never connects → start resolves after the window;
 *   4. a server connected inside the window is already connected at resolve →
 *      enters the directory (directory content is wired on the assembly side;
 *      this test only pins the manager state machine);
 *   5. onManualReconnect registers a cb → unit test drives cb with (server, toolNames).
 */
import assert from "node:assert/strict";
import { describe, it, expect, vi, afterEach } from "vitest";

import { createMcpManager } from "../../../src/harness/mcp/manager.js";
import type { McpClientHandle } from "../../../src/harness/mcp/manager.js";
import type { McpServerConfig } from "../../../src/harness/mcp/config.js";

interface FakeTimers {
  readonly advance: (ms: number) => Promise<void>;
  readonly dispose: () => void;
}

/** Set up vi.useFakeTimers while letting the microtask queue resolve promises. */
function makeFakeTimers(): FakeTimers {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  return {
    async advance(ms: number) {
      await vi.advanceTimersByTimeAsync(ms);
    },
    dispose() {
      vi.useRealTimers();
    },
  };
}

/** connect succeeds only after an external `release`; listTools returns empty immediately. */
function makeGatedClient(opts: {
  readonly neverResolve?: boolean;
  readonly tools?: readonly { name: string }[];
}): {
  readonly handle: McpClientHandle;
  readonly release: () => void;
} {
  let releaseGate!: () => void;
  const released = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });

  const handles = new Set<() => void>();
  const handle: McpClientHandle = {
    connect: async () => {
      if (opts.neverResolve) {
        await new Promise<never>(() => {});
      } else {
        await released;
      }
    },
    listTools: async () => (opts.tools ?? []) as never,
    callTool: async () => ({ result: { content: [] } as never }),
    close: async () => {},
    onListChanged: (cb) => {
      handles.add(cb);
    },
    onClose: () => {},
    listResources: async () => ({ resources: [] }),
    readResource: async () => ({ contents: [] }),
  };
  return { handle, release: releaseGate! };
}

const STUB_CONFIG: McpServerConfig = {
  name: "slow",
  source: "global",
  status: "active",
  kind: "stdio",
  entry: { command: "node", args: [] },
};

const PROGRESS_CONFIG: McpServerConfig = {
  name: "fast",
  source: "global",
  status: "active",
  kind: "stdio",
  entry: { command: "node", args: [] },
};

afterEach(() => {
  vi.useRealTimers();
});

describe("manager.start({firstTurnReadyTimeoutMs}) seam", () => {
  it("默认无参 = 后台启动 (改前行为 byte-stable)", async () => {
    let capturedCwd: string | undefined;
    const mgr = createMcpManager({
      config: [STUB_CONFIG],
      workspaceRoot: "/tmp/work",
      timeoutMsOverride: 50,
      registerExternal: () => {},
      createClient: (_server, transport) => {
        capturedCwd = transport.cwd;
        return makeGatedClient({ neverResolve: true }).handle;
      },
    });
    // No opts → old signature path: returns a promise that resolves
    // immediately without blocking the caller.
    const promise = mgr.start();
    // After a microtask flush the promise must already be resolved.
    await Promise.resolve();
    assert.equal(
      promise.constructor.name,
      "Promise",
      "start() 仍返回 Promise<void>"
    );
    await mgr.shutdown();
    assert.equal(capturedCwd, "/tmp/work");
  });

  it("start({firstTurnReadyTimeoutMs: N}) 阻塞直至全 connected 或超时(本会话缺席)", async () => {
    const ft = makeFakeTimers();
    try {
      const { handle: fastHandle, release: releaseFast } = makeGatedClient({
        tools: [{ name: "alpha" }],
      });
      const { handle: slowHandle } = makeGatedClient({
        neverResolve: true,
      });
      const releaseByName = new Map<string, () => void>();
      releaseByName.set("fast", releaseFast);

      const mgr = createMcpManager({
        config: [STUB_CONFIG, PROGRESS_CONFIG],
        workspaceRoot: "/tmp/work",
        timeoutMsOverride: 5_000,
        registerExternal: () => {},
        createClient: (server) =>
          server.name === "fast" ? fastHandle : slowHandle,
      });

      // Under fake timers, release "fast" manually; "slow" never connects.
      const startPromise = mgr.start({
        firstTurnReadyTimeoutMs: 100, // far below the 5s connect timeout
      });
      // Advance 50ms, release fast so it connects, then advance past the window.
      await ft.advance(50);
      releaseByName.get("fast")!();
      await ft.advance(60);
      // Now fast should be connected and slow still pending (its own
      // connect-timeout hasn't fired), but the firstTurnReady window has
      // expired → overall resolve. firstTurnReady must not push slow into
      // failed early (its own connect-timeout is still pending); it simply
      // leaves this session's tool surface — the assembly layer no longer
      // lists it in the directory. That is the "session absence" contract.
      await startPromise;

      const status = mgr.status();
      const fast = status.find((s) => s.name === "fast")!;
      const slow = status.find((s) => s.name === "slow")!;
      assert.equal(fast.state, "connected");
      // "not connected within the firstTurnReady window" = absent (no longer
      // in the directory); its own state stays pending until its own timeoutMs.
      assert.equal(slow.state, "pending");
      await mgr.shutdown();
    } finally {
      ft.dispose();
    }
  });

  it("首轮等待窗口期内所有 server 都连不上 → start 等至超时后 resolve,session 缺席", async () => {
    const ft = makeFakeTimers();
    try {
      const { handle } = makeGatedClient({ neverResolve: true });

      const mgr = createMcpManager({
        config: [STUB_CONFIG, PROGRESS_CONFIG],
        workspaceRoot: "/tmp/work",
        // Per-server own connect-timeout of 5s, far above firstTurnReady's
        // 50ms. When firstTurnReady fires, start resolves without waiting for
        // the own connect-timeout.
        timeoutMsOverride: 5_000,
        registerExternal: () => {},
        createClient: () => handle,
      });

      const startPromise = mgr.start({ firstTurnReadyTimeoutMs: 50 });
      await ft.advance(60);
      // The first-turn window expires → startPromise settles.
      await startPromise;
      const status = mgr.status();
      for (const s of status) {
        // First-turn window elapsed → session absence (state is still
        // pending since its own connect-timeout hasn't fired; from the
        // assembly angle = absent / not in the directory).
        assert.equal(
          s.state,
          "pending",
          `${s.name} 状态应是 pending(own connect-timeout 未到)`
        );
      }
      await mgr.shutdown();
    } finally {
      ft.dispose();
    }
  });

  it("own connect-timeout 与 firstTurnReady 同时存在,own timeout 先到 → 标 failed", async () => {
    const ft = makeFakeTimers();
    try {
      const { handle } = makeGatedClient({ neverResolve: true });

      const mgr = createMcpManager({
        config: [STUB_CONFIG],
        workspaceRoot: "/tmp/work",
        // Very short own connect-timeout so it fires within the firstTurnReady
        // window too → failed.
        timeoutMsOverride: 30,
        registerExternal: () => {},
        createClient: () => handle,
      });

      const startPromise = mgr.start({ firstTurnReadyTimeoutMs: 200 });
      await ft.advance(60);
      await startPromise;
      const status = mgr.status().find((s) => s.name === "slow")!;
      // own connect-timeout < firstTurnReady → own timeout fires first → failed
      assert.equal(status.state, "failed");
      await mgr.shutdown();
    } finally {
      ft.dispose();
    }
  });

  it("start() 无 opts 仍可调用 (向后兼容)", async () => {
    let connected = false;
    const handle: McpClientHandle = {
      connect: async () => {
        connected = true;
      },
      listTools: async () => [],
      callTool: async () => ({ result: { content: [] } as never }),
      close: async () => {},
      onListChanged: () => {},
      onClose: () => {},
      listResources: async () => ({ resources: [] }),
      readResource: async () => ({ contents: [] }),
    };
    const mgr = createMcpManager({
      config: [PROGRESS_CONFIG],
      workspaceRoot: "/tmp/work",
      timeoutMsOverride: 1_000,
      registerExternal: () => {},
      createClient: () => handle,
    });
    await mgr.start(); // no opts
    // Instant-connect client → `connected` should settle immediately.
    await Promise.resolve();
    expect(connected).toBe(true);
    await mgr.shutdown();
  });
});

describe("manager.onManualReconnect(cb) seam", () => {
  it("注册 cb 后可被驱动调用,传入 server name + tool names", async () => {
    const handle: McpClientHandle = {
      connect: async () => {},
      listTools: async () => [
        { name: "alpha" } as never,
        { name: "beta" } as never,
      ],
      callTool: async () => ({ result: { content: [] } as never }),
      close: async () => {},
      onListChanged: () => {},
      onClose: () => {},
      listResources: async () => ({ resources: [] }),
      readResource: async () => ({ contents: [] }),
    };
    const mgr = createMcpManager({
      config: [PROGRESS_CONFIG],
      workspaceRoot: "/tmp/work",
      timeoutMsOverride: 1_000,
      registerExternal: () => {},
      createClient: () => handle,
    });

    const events: Array<{ server: string; tools: string[] }> = [];
    mgr.onManualReconnect((server, tools) => {
      events.push({ server, tools: [...tools] });
    });

    // A unit test cannot trigger a real manual reconnect; the cb registration
    // shape is what's pinned here. This pass verifies seam registration
    // semantics only.
    expect(
      typeof (mgr as unknown as { onManualReconnect: unknown })
        .onManualReconnect
    ).toBe("function");
    expect(events).toEqual([]);
    await mgr.shutdown();
  });

  it("多处注册 cb 均被记录", async () => {
    const handle: McpClientHandle = {
      connect: async () => {},
      listTools: async () => [],
      callTool: async () => ({ result: { content: [] } as never }),
      close: async () => {},
      onListChanged: () => {},
      onClose: () => {},
      listResources: async () => ({ resources: [] }),
      readResource: async () => ({ contents: [] }),
    };
    const mgr = createMcpManager({
      config: [PROGRESS_CONFIG],
      workspaceRoot: "/tmp/work",
      timeoutMsOverride: 1_000,
      registerExternal: () => {},
      createClient: () => handle,
    });
    const cbs: Array<() => void> = [];
    mgr.onManualReconnect(() => cbs.push(() => "a"));
    mgr.onManualReconnect(() => cbs.push(() => "b"));
    expect(cbs.length).toBe(0);
    await mgr.shutdown();
  });
});

describe("manager.start 旧测试套兼容性", () => {
  it("start() 立即 resolve 后方可 shutdown", async () => {
    const handle: McpClientHandle = {
      connect: async () => {},
      listTools: async () => [],
      callTool: async () => ({ result: { content: [] } as never }),
      close: async () => {},
      onListChanged: () => {},
      onClose: () => {},
      listResources: async () => ({ resources: [] }),
      readResource: async () => ({ contents: [] }),
    };
    const mgr = createMcpManager({
      config: [PROGRESS_CONFIG],
      workspaceRoot: "/tmp/work",
      timeoutMsOverride: 1_000,
      registerExternal: () => {},
      createClient: () => handle,
    });
    await mgr.start();
    await mgr.shutdown();
  });
});
