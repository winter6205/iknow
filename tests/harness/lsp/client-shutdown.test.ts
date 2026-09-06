/**
 * LspClientPool.shutdownAll — TUI /quit 挂起修复。
 *
 * 根因（真实 PTY 复验）：退出链从未终止 LSP 子进程 —— pool 只有 connection
 * 级 disposeAll()，typescript-language-server / vscode-json-languageserver
 * 子进程及其 stdio 管道存活，Bun 事件循环在 runTui 返回 0 后永不排空；
 * 手动 SIGTERM 两个 LSP 子进程后父进程立即退出（隔离实验）。
 *
 * 本文件钉两条行为：
 *   1. shutdownAll 真杀子进程（SIGTERM，exit 事件落地）+ 清空池状态；
 *   2. shutdownAll 之后 getClient 不再 respawn（spawn-failed，防泄漏重建）。
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
import type { LspServerInfo } from "../../../src/harness/lsp/types.ts";
import {
  createLspClientPool,
  getClient,
  getClientDetailed,
} from "../../../src/harness/lsp/client.ts";

/** 本文件 spawn 过的真实子进程 —— afterEach 兜底清理,失败路径不泄漏。 */
const spawnedChildren: ChildProcess[] = [];

/** 真实长驻子进程：有 stdio 管道，收到 SIGTERM 默认退出。 */
function spawnRealChild(): ChildProcess {
  const child = spawn(
    process.execPath,
    ["-e", "setInterval(() => {}, 1000)"],
    { stdio: ["pipe", "pipe", "pipe"] }
  );
  spawnedChildren.push(child);
  return child;
}

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

/** 等待 child exit 事件（SIGTERM 后 node 默认退出，2s 上限）。 */
function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
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
    const client = await getClient(
      { directory: "/work", pool },
      "/root/a.ts",
      { server }
    );
    const child = client!.process;
    // 前置：子进程确实活着（kill(pid,0) 不抛）。
    expect(child.pid).toBeGreaterThan(0);
    expect(() => process.kill(child.pid!, 0)).not.toThrow();

    await pool.shutdownAll();

    await waitForExit(child);
    expect(mockDispose).toHaveBeenCalled(); // connection 先释放
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
