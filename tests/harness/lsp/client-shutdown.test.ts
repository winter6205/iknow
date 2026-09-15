/**
 * LspClientPool 回收缝 — 终结 LSP 子进程。
 *
 * 根因（真实 PTY 复验）：退出链从未终止 LSP 子进程 —— pool 只有 connection
 * 级 disposeAll()，typescript-language-server / vscode-json-languageserver
 * 子进程及其 stdio 管道存活，Bun 事件循环在 runTui 返回 0 后永不排空；
 * 手动 SIGTERM 两个 LSP 子进程后父进程立即退出（隔离实验）。同一条泄漏在
 * 长 session 的 idle 回收与 worktree rebind 上同样成立：连接关闭不释放
 * stdio 管道句柄，子进程会活到宿主退出。
 *
 * 本文件钉四条行为：
 *   1. sweepIdleClients 到期回收 → 子进程 SIGTERM 退出 + 池状态清空；
 *   2. worktree rebind stale sweep → 旧 root 子进程退出（含本次未命中的
 *      serverId）；
 *   3. disposeAll → 子进程退出，且不 latch（之后 getClient 可重新 spawn）；
 *   4. shutdownAll → 子进程退出 + latch（之后 getClient 一律 spawn-failed）。
 *
 * 测试策略：createMessageConnection mock（同 client.test.ts），但 spawn 用
 * **真实子进程**（node -e setInterval），证明 kill 落在真 ChildProcess 上。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";

const { mockSendRequest, mockSendNotification, mockListen, mockDispose } =
  vi.hoisted(() => ({
    mockSendRequest: vi.fn(),
    mockSendNotification: vi.fn(),
    mockListen: vi.fn(),
    mockDispose: vi.fn(),
  }));

vi.mock("vscode-jsonrpc/node", async (importOriginal) => {
  const actual = await importOriginal<typeof import("vscode-jsonrpc/node")>();
  return {
    ...actual,
    createMessageConnection: () => ({
      sendRequest: mockSendRequest,
      sendNotification: mockSendNotification,
      onRequest: vi.fn(),
      onNotification: vi.fn(),
      listen: mockListen,
      dispose: mockDispose,
    }),
  };
});

// 动态导入 —— 必须在 mock 安装之后。
import type { LspCtx, LspServerInfo } from "../../../src/harness/lsp/types.ts";
import {
  createLiveTaskRoot,
  writeLiveTaskRoot,
} from "../../../src/harness/session-roots.ts";
import {
  createLspClientPool,
  getClient,
  getClientDetailed,
} from "../../../src/harness/lsp/client.ts";

/** 本文件 spawn 过的真实子进程 —— afterEach 兜底清理,失败路径不泄漏。 */
const spawnedChildren: ChildProcess[] = [];

/** 真实长驻子进程：有 stdio 管道，收到 SIGTERM 默认退出。 */
function spawnRealChild(): ChildProcess {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  spawnedChildren.push(child);
  return child;
}

/** 固定 root 的 server：key 落 `/root:<id>`，用于单 entry 回收路径。 */
function makeServerWithRealChild(id: string): {
  server: LspServerInfo;
  calls: { spawn: number };
} {
  const calls = { spawn: 0 };
  const server: LspServerInfo = {
    id,
    root: async () => "/root",
    extensions: [".ts"],
    spawn: async () => {
      calls.spawn += 1;
      return {
        process: spawnRealChild() as unknown as ChildProcess,
        initialization: {},
      };
    },
  };
  return { server, calls };
}

/** root 跟随 ctx.directory 的 server：rebind 前后各落一个 pool key。 */
function makeDirectoryServerWithRealChild(id: string): {
  server: LspServerInfo;
  calls: { spawn: number };
} {
  const calls = { spawn: 0 };
  const server: LspServerInfo = {
    id,
    root: async (_file, ctx) => ctx.directory,
    extensions: [".ts"],
    spawn: async () => {
      calls.spawn += 1;
      return {
        process: spawnRealChild() as unknown as ChildProcess,
        initialization: {},
      };
    },
  };
  return { server, calls };
}

/** 等待 child exit 事件（SIGTERM 后 node 默认退出，2s 上限）。 */
function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null)
    return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      // 超时先杀再拒绝：不留活子进程持事件循环句柄。
      child.kill("SIGKILL");
      reject(new Error("child did not exit within 2s"));
    }, 2000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/** 前置：子进程确实活着（kill(pid,0) 不抛；pid 是真实 OS pid）。 */
function expectAlive(child: ChildProcess): void {
  expect(child.pid).toBeGreaterThan(0);
  expect(() => process.kill(child.pid!, 0)).not.toThrow();
}

beforeEach(() => {
  mockSendRequest.mockReset();
  mockSendNotification.mockReset();
  mockListen.mockReset();
  mockDispose.mockReset();
  mockSendRequest.mockResolvedValue({ capabilities: {} });
});

afterEach(() => {
  vi.clearAllMocks();
  // 失败路径兜底：断言失败时 spawn 的子进程仍在 → 全部 SIGTERM,不泄漏。
  for (const child of spawnedChildren.splice(0)) {
    child.kill("SIGTERM");
  }
});

describe("LspClientPool.shutdownAll — 退出链终止 LSP 子进程", () => {
  it("SIGTERM 杀掉所有已 spawn 子进程，exit 落地，池状态清空", async () => {
    const pool = createLspClientPool();
    const { server } = makeServerWithRealChild("shutkill");
    const client = await getClient({ directory: "/work", pool }, "/root/a.ts", {
      server,
    });
    const child = client!.process;
    expectAlive(child);
    expect(pool.clients.size).toBe(1);

    await pool.shutdownAll();

    await waitForExit(child);
    expect(child.signalCode).toBe("SIGTERM"); // 死于本次 SIGTERM，非自然退出
    expect(mockDispose).toHaveBeenCalled(); // connection 先释放
    expect(() => process.kill(child.pid!, 0)).toThrow(); // OS 侧已无此进程
    expect(pool.clients.size).toBe(0);
    expect(pool.lastUsedAt.size).toBe(0);
    expect(pool.broken.size).toBe(0);
    expect(pool.inflight.size).toBe(0);
  });

  it("shutdownAll 之后 getClient 不再 respawn（spawn-failed）", async () => {
    const pool = createLspClientPool();
    const { server, calls } = makeServerWithRealChild("shutnoretry");
    const first = await getClient({ directory: "/work", pool }, "/root/a.ts", {
      server,
    });
    expect(first).toBeDefined();
    await pool.shutdownAll();
    expect(calls.spawn).toBe(1);

    const second = await getClientDetailed(
      { directory: "/work", pool },
      "/root/b.ts",
      { server }
    );
    expect(second.failure?.reason).toBe("spawn-failed"); // 哨兵，不发起新 spawn
    expect(second.client).toBeUndefined();
    expect(calls.spawn).toBe(1); // 没有重建子进程
    expect(pool.clients.size).toBe(0);
  });
});

describe("LspClientPool 回收缝 — 长 session / rebind 不漏子进程", () => {
  it("sweepIdleClients 到期回收 → 子进程 SIGTERM 退出 + 池状态清空", async () => {
    const pool = createLspClientPool();
    const { server } = makeServerWithRealChild("idlesweep");
    const client = await getClient({ directory: "/work", pool }, "/root/a.ts", {
      server,
    });
    const child = client!.process;
    expectAlive(child);

    // 到期：把 lastUsedAt 拨回过去再 sweep（不依赖真实时钟睡眠）。
    pool.lastUsedAt.set("/root:idlesweep", Date.now() - 60_000);
    pool.sweepIdleClients(1_000);

    await waitForExit(child);
    expect(child.signalCode).toBe("SIGTERM");
    expect(mockDispose).toHaveBeenCalled();
    expect(pool.clients.size).toBe(0);
    expect(pool.lastUsedAt.size).toBe(0);
  });

  it("rebind stale sweep → 旧 root 同 serverId 子进程退出 + key 逐出", async () => {
    const pool = createLspClientPool();
    const cell = createLiveTaskRoot("/work-old");
    const ctx: LspCtx = { directory: cell.read(), directoryCell: cell, pool };
    const { server } = makeDirectoryServerWithRealChild("rebind-same");
    const oldClient = await getClient(ctx, "/root/a.ts", { server });
    const oldChild = oldClient!.process;
    expectAlive(oldChild);

    writeLiveTaskRoot(cell, "/work-new");
    const newClient = await getClient(ctx, "/root/b.ts", { server });

    await waitForExit(oldChild);
    expect(oldChild.signalCode).toBe("SIGTERM");
    expect(newClient).not.toBe(oldClient); // 旧实例不复活
    expect(pool.clients.has("/work-old:rebind-same")).toBe(false);
    expect(pool.clients.has("/work-new:rebind-same")).toBe(true);
  });

  it("rebind stale sweep → 旧 root 下本次未命中 dispatch 的 server 子进程也退出", async () => {
    const pool = createLspClientPool();
    const cell = createLiveTaskRoot("/work-old");
    const ctx: LspCtx = { directory: cell.read(), directoryCell: cell, pool };
    const ts = makeDirectoryServerWithRealChild("rebind-ts");
    const yaml = makeDirectoryServerWithRealChild("rebind-yaml");
    const tsClient = await getClient(ctx, "/root/a.ts", { server: ts.server });
    const yamlClient = await getClient(ctx, "/root/b.yaml", {
      server: yaml.server,
    });
    expectAlive(tsClient!.process);
    expectAlive(yamlClient!.process);
    expect(pool.clients.size).toBe(2);

    writeLiveTaskRoot(cell, "/work-new");
    // 只 dispatch TS server —— yaml 在旧 root 的 client 不得因此漏杀。
    await getClient(ctx, "/root/c.ts", { server: ts.server });

    await waitForExit(yamlClient!.process); // 旧扫描只认 serverId 时这里超时
    expect(yamlClient!.process.signalCode).toBe("SIGTERM");
    expect(pool.clients.has("/work-old:rebind-yaml")).toBe(false);
    expect(pool.clients.has("/work-old:rebind-ts")).toBe(false);
    expect(pool.clients.size).toBe(1); // 只剩新 root 的 TS client
  });

  it("disposeAll 终结子进程且不 latch（之后 getClient 重新 spawn）", async () => {
    const pool = createLspClientPool();
    const { server, calls } = makeServerWithRealChild("disposeall");
    const first = await getClient({ directory: "/work", pool }, "/root/a.ts", {
      server,
    });
    const child = first!.process;
    expectAlive(child);

    await pool.disposeAll();

    await waitForExit(child);
    expect(child.signalCode).toBe("SIGTERM");
    expect(mockDispose).toHaveBeenCalled();
    expect(pool.clients.size).toBe(0);

    // 不 latch：同 key 再取 → 重新 spawn 新子进程（现有行为，不回归）。
    const second = await getClient({ directory: "/work", pool }, "/root/a.ts", {
      server,
    });
    expect(second).toBeDefined();
    expect(second).not.toBe(first);
    expect(calls.spawn).toBe(2);
    expectAlive(second!.process);
  });
});
