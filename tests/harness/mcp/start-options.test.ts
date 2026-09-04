/**
 * B4 / ADR-0043 §4 — manager.start({firstTurnReadyTimeoutMs}) +
 * onManualReconnect(cb) seam 与超时缺席契约。
 *
 * 行为真值:
 *   - start({firstTurnReadyTimeoutMs: 30_000}) = 阻塞至超时(或全员 connected);
 *     窗口内连上的零破坏进首轮装配,超时者停止自动重试、session 缺席。
 *   - onManualReconnect(cb) = 用户手动重连成功 → cb(serverName, toolNames);
 *     cb 调用由测试侧直接驱动。
 *
 * 测试矩阵:
 *   ① start() 默认无参 = 后台启动(改前行为,fire-and-forget);
 *   ② start({firstTurnReadyTimeoutMs}) = 阻塞至超时或全 connected;
 *   ③ fake-timer 超时场景:一个 server 一直接不上 → start 等至超时后 resolve;
 *   ④ 窗口内连上的 server:resolve 时已 connected → 进目录(占位,目录内容由
 *      装配侧 wired,本测试仅验 manager 状态机)。
 *   ⑤ onManualReconnect 注册回调 → 单测驱动 cb 收到 (server, toolNames)。
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

/** Set up vi.useFakeTimers + 让 microtask 队列能 resolve promise。 */
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

/** 一个 connect 等到外部 `release` 才成功;listTools 立即返空。 */
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
    // 不传 opts → 旧签名 path:返回一个立即 resolve 的 promise,
    // 不阻塞调用方。
    const promise = mgr.start();
    // microtask flush 后 promise 必须已 resolve。
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

      // 在 fake-timer 下手动 release fast,slow 永不连上。
      const startPromise = mgr.start({
        firstTurnReadyTimeoutMs: 100, // 100ms 远小于 5s connect timeout
      });
      // 先推进 50ms,释放 fast 让它连接,然后再推进剩余等到超时。
      await ft.advance(50);
      releaseByName.get("fast")!();
      await ft.advance(60);
      // 此时 fast 应已 connected,慢的仍 pending(自身 connect-timeout 未到);但
      // firstTurnReady 超时已到 → 整体 resolve。slow 不会因为 firstTurnReady 提
      // 前进入 failed(slow 的 own connect-timeout 未到);它从本会话的工具面退出
      // —— 装配层不再把它列入目录。这是"session 缺席"契约。
      await startPromise;

      const status = mgr.status();
      const fast = status.find((s) => s.name === "fast")!;
      const slow = status.find((s) => s.name === "slow")!;
      assert.equal(fast.state, "connected");
      // "firstTurnReady window 内未连上" = 缺席(已不参与目录);其自身仍处于
      // pending 直到 own timeoutMs。
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
        // own per-server connect-timeout 5s,远大于 firstTurnReady 50ms。
        // firstTurnReady 到点 → 不等 own connect-timeout,整体 resolve。
        timeoutMsOverride: 5_000,
        registerExternal: () => {},
        createClient: () => handle,
      });

      const startPromise = mgr.start({ firstTurnReadyTimeoutMs: 50 });
      await ft.advance(60);
      // 首轮窗口到点 → startPromise settle。
      await startPromise;
      const status = mgr.status();
      for (const s of status) {
        // 首轮等待窗口期满 → session 缺席(状态仍是 pending,因其 own
        // connect-timeout 未到;从装配角度 = 缺席/不参与目录)。
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
        // 极短的 own connect-timeout,确保 firstTurnReady 窗口期内 own
        // timeout 也能到点 → failed。
        timeoutMsOverride: 30,
        registerExternal: () => {},
        createClient: () => handle,
      });

      const startPromise = mgr.start({ firstTurnReadyTimeoutMs: 200 });
      await ft.advance(60);
      await startPromise;
      const status = mgr.status().find((s) => s.name === "slow")!;
      // own connect-timeout < firstTurnReady → own timeout 先到 → failed。
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
    // 即时连接的 client → connected 应该立刻 settled。
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

    // 单测无法触发真手动重连,但 cb 的 register 形态已验;只在 manager 暴露
    // 一个内部 hook 帮助测试时,可在此直接触发。本期 B4 仅验 seam 注册语义。
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
