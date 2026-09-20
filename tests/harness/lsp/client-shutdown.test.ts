/**
 * LspClientPool recycling seam — terminates LSP child processes.
 *
 * Root cause (reproduced on a real PTY): the exit chain never terminated LSP
 * children — the pool only had a connection-level disposeAll(), so
 * typescript-language-server / vscode-json-languageserver children and their
 * stdio pipes stayed alive and the Bun event loop never drained after runTui
 * returned 0; manually SIGTERM-ing the two LSP children let the parent exit
 * immediately (isolation experiment). The same leak applies to idle recycling
 * in long sessions and to worktree rebind: closing a connection does not
 * release the stdio pipe handles, so children live until the host exits.
 *
 * This file pins four behaviors:
 *   1. sweepIdleClients expiry recycling → child exits via SIGTERM + pool state
 *      cleared;
 *   2. worktree rebind stale sweep → old-root children exit (including
 *      serverIds not touched by the current dispatch);
 *   3. disposeAll → children exit, no latch (a later getClient can respawn);
 *   4. shutdownAll → children exit + latch (a later getClient always reports
 *      spawn failure).
 *
 * Strategy: mocked createMessageConnection (same as client.test.ts), but
 * spawning uses **real child processes** (node -e setInterval) to prove the
 * kill lands on a genuine ChildProcess.
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

// Dynamic imports — must come after the mocks are installed.
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

/** Real children spawned by this file — afterEach backstop so failure paths never leak. */
const spawnedChildren: ChildProcess[] = [];

/** A real long-lived child: has stdio pipes and exits on SIGTERM by default. */
function spawnRealChild(): ChildProcess {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  spawnedChildren.push(child);
  return child;
}

/** Server with a fixed root: pool key lands at `/root:<id>`, for single-entry recycling paths. */
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

/** Server whose root follows ctx.directory: yields one pool key before and one after a rebind. */
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

/** Waits for the child's exit event (node exits on SIGTERM by default; 2s ceiling). */
function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null)
    return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      // On timeout, kill first, then reject: never leave a live child holding event-loop handles.
      child.kill("SIGKILL");
      reject(new Error("child did not exit within 2s"));
    }, 2000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/** Precondition: the child is genuinely alive (kill(pid,0) does not throw; pid is a real OS pid). */
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
  // Failure-path backstop: if an assertion failed, spawned children may still be alive → SIGTERM them all, no leaks.
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
    expect(child.signalCode).toBe("SIGTERM"); // died from this SIGTERM, not a natural exit
    expect(mockDispose).toHaveBeenCalled(); // the connection is released first
    expect(() => process.kill(child.pid!, 0)).toThrow(); // the OS no longer has this process
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
    expect(second.failure?.reason).toBe("spawn-failed"); // sentinel; no new spawn is initiated
    expect(second.client).toBeUndefined();
    expect(calls.spawn).toBe(1); // no child was re-created
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

    // Expire it: rewind lastUsedAt, then sweep (no dependence on real-clock sleep).
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
    expect(newClient).not.toBe(oldClient); // the old instance is not revived
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
    // Dispatch only the TS server — the yaml client on the old root must not escape the kill.
    await getClient(ctx, "/root/c.ts", { server: ts.server });

    await waitForExit(yamlClient!.process); // this times out if the stale sweep only matches by serverId
    expect(yamlClient!.process.signalCode).toBe("SIGTERM");
    expect(pool.clients.has("/work-old:rebind-yaml")).toBe(false);
    expect(pool.clients.has("/work-old:rebind-ts")).toBe(false);
    expect(pool.clients.size).toBe(1); // only the new root's TS client remains
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

    // No latch: re-acquiring the same key spawns a fresh child (existing behavior, no regression).
    const second = await getClient({ directory: "/work", pool }, "/root/a.ts", {
      server,
    });
    expect(second).toBeDefined();
    expect(second).not.toBe(first);
    expect(calls.spawn).toBe(2);
    expectAlive(second!.process);
  });
});
