/**
 * T8 (plans/worktree-live-task-root.md §6 T8 / §5 D5) — LSP `LspCtx.directory`
 * follows the live `taskRoot` cell across worktree rebind.
 *
 * Acceptance (named by plan §6 T8):
 *   1. `LspCtx.directory` is read at call time, not captured at build time —
 *      `NearestRoot` upper-bound moves with rebind (symbol tools can reach the
 *      new tree, cannot reach files outside the active root).
 *   2. After rebind, old-root LSP clients are explicitly disposed — no
 *      lingering spawned server processes (no leak) and no reuse of the
 *      old client (so a request after rebind never lands a write in the
 *      old tree).
 *
 * The directory snapshot is taken once per `getClient` call, mirroring
 * the batch-snapshot discipline (D2): one tool call → one root value.
 *
 * Test strategy: stub `node:child_process` `spawn` so we can intercept
 * how `client.ts` invokes the LSP server. Two temporary roots simulate
 * old (main) and new (rebound) task worktrees; rebind writes the live
 * cell, then we assert the pool key for the old client is gone and the
 * new root gets a fresh client.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import {
  createLiveTaskRoot,
  writeLiveTaskRoot,
  type LiveTaskRoot,
} from "../../../src/harness/session-roots.ts";
import type { LspServerInfo } from "../../../src/harness/lsp/types.ts";
import type { LspCtx } from "../../../src/harness/lsp/types.ts";
import {
  createLspClientPool,
  type LspClientPool,
} from "../../../src/harness/lsp/client.ts";

// ── vscode-jsonrpc/node 替身 ──────────────────────────────────────────────────
//
// 用 vi.hoisted 捕获引用,避免 vi.mock 提前看到 createMessageConnection。

const {
  mockSendRequest,
  mockSendNotification,
  mockListen,
  mockDispose,
  mockCreateConnection,
} = vi.hoisted(() => ({
  mockSendRequest: vi.fn(),
  mockSendNotification: vi.fn(),
  mockListen: vi.fn(),
  mockDispose: vi.fn(),
  mockCreateConnection: vi.fn(() => ({
    sendRequest: mockSendRequest,
    sendNotification: mockSendNotification,
    onRequest: vi.fn(),
    onNotification: vi.fn(),
    listen: mockListen,
    dispose: mockDispose,
  })),
}));

vi.mock("vscode-jsonrpc/node", async (importOriginal) => {
  const actual = await importOriginal<typeof import("vscode-jsonrpc/node")>();
  return {
    ...actual,
    createMessageConnection: (...args: unknown[]) =>
      mockCreateConnection(...args),
  };
});

// ── 动态导入必须在 mock 安装之后 ──────────────────────────────────────────────

const { getClient } = await import("../../../src/harness/lsp/client.ts");

// ── fake child + fake server 工厂 ──────────────────────────────────────────────

function makeFakeChild(pid = 9001) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  return Object.assign(new EventEmitter(), {
    stdin,
    stdout,
    stderr,
    pid,
    kill: vi.fn(() => true),
  }) as unknown as import("node:child_process").ChildProcess;
}

function makeFakeServer(opts: {
  readonly id: string;
  readonly rootFor: (file: string, directory: string) => string | undefined;
  readonly spawnCalls: { root: string }[];
}): LspServerInfo {
  return {
    id: opts.id,
    extensions: [".ts"],
    root: async (file, ctx) => {
      // 与真 NearestRoot 同形态: ctx.directory 即上界 stop。
      return opts.rootFor(file, ctx.directory);
    },
    spawn: async (root) => {
      opts.spawnCalls.push({ root });
      return {
        process: makeFakeChild(),
        initialization: { tsserver: { path: "/tsserver.js" } },
      };
    },
  };
}

// ── 临时目录管理 ──────────────────────────────────────────────────────────────

const tmpRoots: string[] = [];

function freshDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmpRoots.push(d);
  return d;
}

afterEach(() => {
  while (tmpRoots.length > 0) {
    const d = tmpRoots.pop();
    if (d) rmSync(d, { recursive: true, force: true });
  }
});

beforeEach(() => {
  mockSendRequest.mockReset();
  mockSendNotification.mockReset();
  mockListen.mockReset();
  mockDispose.mockReset();
  mockCreateConnection.mockClear();
  mockSendRequest.mockResolvedValue({ capabilities: {} });
});

// ── tests ─────────────────────────────────────────────────────────────────────

describe("LspCtx.directory follows live taskRoot cell", () => {
  it("after rebind, ctx.directory moves to the new tree (NearestRoot reads at call time)", async () => {
    // 两个独立 taskRoot (模拟主仓与 rebind 后的 task worktree),
    // 每个目录放一份 .ts 文件;NearestRoot 直接按 (file, directory) 形态返
    // directory 自身 (与 YamlLS / JsonLS 的 ctx.directory 边界同源)。
    const oldDir = freshDir("iknow-lsp-live-old-");
    const newDir = freshDir("iknow-lsp-live-new-");
    const oldFile = join(oldDir, "a.ts");
    const newFile = join(newDir, "a.ts");
    writeFileSync(oldFile, "export const a = 1;\n", "utf8");
    writeFileSync(newFile, "export const a = 2;\n", "utf8");

    const spawnCalls: { root: string }[] = [];
    const server = makeFakeServer({
      id: "live-dir",
      rootFor: (_file, directory) => directory,
      spawnCalls,
    });

    const cell: LiveTaskRoot = createLiveTaskRoot(oldDir);
    // 与 build-engine 一致:lspCtx.directory 由 cell.read() 派生,
    // LspClientPool + getClient 入口读 cell。每条 case 用独立 pool,
    // 避免模块级 defaultPool 的 lastSeenTaskRoot 在 case 间漂移。
    const pool: LspClientPool = createLspClientPool();
    const ctx: LspCtx = {
      directory: cell.read(),
      directoryCell: cell,
      pool,
    };

    // 1. 旧根:getClient 在 ctx.directory = oldDir 下拿到客户端。
    const c1 = await getClient(ctx, oldFile, { server });
    expect(c1).toBeDefined();
    expect(spawnCalls).toEqual([{ root: oldDir }]);

    // 2. 翻 cell 到新根。模拟 host `provision` 缝成功返回。
    writeLiveTaskRoot(cell, newDir);

    // 3. 用新文件调 getClient,ctx.directory 必须已是 newDir,
    //    否则 NearestRoot 上界 stop 还是 oldDir → newDir 的文件被认为 outside → no-root。
    const c2 = await getClient(ctx, newFile, { server });
    expect(c2).toBeDefined();
    // 旧 key (oldDir) 与新 key (newDir) 不重叠 → pool 必然再 spawn 一次,
    // 且新 spawn 拿 newDir (验证 ctx.directory 已切到 cell 当前值)。
    expect(spawnCalls.length).toBeGreaterThanOrEqual(2);
    expect(spawnCalls.at(-1)?.root).toBe(newDir);
    // 新 client ≠ 旧 client (新 key 实例,不复用旧 client)。
    expect(c2).not.toBe(c1);
  });

  it("after rebind, the OLD-root client is terminated (no leak, no reuse)", async () => {
    const oldDir = freshDir("iknow-lsp-live-old2-");
    const newDir = freshDir("iknow-lsp-live-new2-");
    const oldFile = join(oldDir, "x.ts");
    const newFile = join(newDir, "x.ts");
    writeFileSync(oldFile, "export const x = 1;\n", "utf8");
    writeFileSync(newFile, "export const x = 2;\n", "utf8");

    const spawnCalls: { root: string }[] = [];
    const server = makeFakeServer({
      id: "live-dir-leak",
      rootFor: (_file, directory) => directory,
      spawnCalls,
    });

    const cell: LiveTaskRoot = createLiveTaskRoot(oldDir);
    const pool: LspClientPool = createLspClientPool();
    const ctx: LspCtx = {
      directory: cell.read(),
      directoryCell: cell,
      pool,
    };

    const oldClient = await getClient(ctx, oldFile, { server });
    expect(oldClient).toBeDefined();
    if (!oldClient) throw new Error("expected old client");

    // rebind
    writeLiveTaskRoot(cell, newDir);

    // 触发新根上的 getClient —— 旧 client 必须被终结。
    await getClient(ctx, newFile, { server });

    // 断言:连接先释放 + 子进程 SIGTERM。关连接不释放 stdio 管道句柄,
    // 只 dispose() 会让旧 server 活到宿主退出 —— 池回收缝的职责是两者都做。
    expect(mockDispose).toHaveBeenCalled();
    expect(vi.mocked(oldClient.process.kill)).toHaveBeenCalledWith("SIGTERM");
    // 池不再持有旧 key:后续同 root 调用必然重新 spawn,不复用已终结实例。
    expect(pool.clients.has(`${oldDir}:live-dir-leak`)).toBe(false);

    // 旧 client 已被池逐出;后续再以 oldDir 调一次,必须重新 spawn
    // (不复用旧的、已终结的实例),且第二次不触发任何 dispose。
    mockDispose.mockClear();
    const oldAgain = await getClient(ctx, oldFile, { server });
    expect(oldAgain).toBeDefined();
    expect(oldAgain).not.toBe(oldClient);
    expect(mockDispose).not.toHaveBeenCalled();
  });

  it("after rebind, stale sweep reclaims every server's old-root client (not just the dispatched one)", async () => {
    const oldDir = freshDir("iknow-lsp-live-old3-");
    const newDir = freshDir("iknow-lsp-live-new3-");
    const oldTs = join(oldDir, "a.ts");
    const oldYaml = join(oldDir, "b.yaml");
    const newTs = join(newDir, "a.ts");
    for (const f of [oldTs, oldYaml, newTs]) {
      writeFileSync(f, "x\n", "utf8");
    }

    const tsServer = makeFakeServer({
      id: "multi-ts",
      rootFor: (_file, directory) => directory,
      spawnCalls: [],
    });
    const yamlServer = makeFakeServer({
      id: "multi-yaml",
      rootFor: (_file, directory) => directory,
      spawnCalls: [],
    });

    const cell: LiveTaskRoot = createLiveTaskRoot(oldDir);
    const pool: LspClientPool = createLspClientPool();
    const ctx: LspCtx = {
      directory: cell.read(),
      directoryCell: cell,
      pool,
    };

    const tsClient = await getClient(ctx, oldTs, { server: tsServer });
    const yamlClient = await getClient(ctx, oldYaml, { server: yamlServer });
    expect(tsClient).toBeDefined();
    expect(yamlClient).toBeDefined();
    expect(pool.clients.size).toBe(2);

    writeLiveTaskRoot(cell, newDir);
    // 只 dispatch TS —— yaml 的旧根 client 不因「本次未命中」而漏回收:
    // rebind 后 lastSeenTaskRoot 即更新,再过滤 serverId 就永远扫不到它。
    await getClient(ctx, newTs, { server: tsServer });

    expect(vi.mocked(yamlClient!.process.kill)).toHaveBeenCalledWith("SIGTERM");
    expect(vi.mocked(tsClient!.process.kill)).toHaveBeenCalledWith("SIGTERM");
    expect(pool.clients.has(`${oldDir}:multi-yaml`)).toBe(false);
    expect(pool.clients.has(`${oldDir}:multi-ts`)).toBe(false);
    expect(pool.clients.has(`${newDir}:multi-ts`)).toBe(true);
  });

  it("before rebind, behavior is byte-identical to a frozen-directory ctx (legacy parity)", async () => {
    // 守门:门禁未翻 ⇒ 未 rebind 时行为逐字节同今日。
    // 这条断言不依赖 live cell;只比较传统 string directory vs cell-backed。
    const dir = freshDir("iknow-lsp-live-legacy-");
    const file = join(dir, "y.ts");
    writeFileSync(file, "export const y = 1;\n", "utf8");

    const cell: LiveTaskRoot = createLiveTaskRoot(dir);

    // legacy ctx: directory = string, no cell
    const legacySpawns: { root: string }[] = [];
    const legacyServer = makeFakeServer({
      id: "legacy",
      rootFor: (_file, directory) => directory,
      spawnCalls: legacySpawns,
    });
    const legacy: LspCtx = {
      directory: dir,
      pool: createLspClientPool(),
    };
    const legacyClient = await getClient(legacy, file, {
      server: legacyServer,
    });
    expect(legacyClient).toBeDefined();
    expect(legacySpawns).toEqual([{ root: dir }]);

    // cell-backed ctx with same initial value: 同样 spawn 一次,同 key 复用
    const cellSpawns: { root: string }[] = [];
    const cellServer = makeFakeServer({
      id: "cell",
      rootFor: (_file, directory) => directory,
      spawnCalls: cellSpawns,
    });
    const cellCtx: LspCtx = {
      directory: cell.read(),
      directoryCell: cell,
      pool: createLspClientPool(),
    };
    const cellClient = await getClient(cellCtx, file, { server: cellServer });
    expect(cellClient).toBeDefined();
    expect(cellSpawns).toEqual([{ root: dir }]);
    // 再次同 key 调用 → 复用同一 client,不再 spawn。
    const cellClient2 = await getClient(cellCtx, file, { server: cellServer });
    expect(cellClient2).toBe(cellClient);
    expect(cellSpawns).toHaveLength(1);
  });
});
