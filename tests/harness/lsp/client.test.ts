/**
 * client.ts 三件套缓存单测 — spec 251-lsp-tool（§ S9）。
 *
 * 覆盖 4 边界：
 *   1. same-root reuse：同 root 两次 getClient → spawn 只一次，缓存复用。
 *   2. broken memory：fakeServer.spawn 返 undefined → 永久 broken，spawn 不重试。
 *   3. inflight dedup：并发两次 → 共享同一 spawn Promise。
 *   4. cancel via $/cancelRequest：cancelRequest 发 `$/cancelRequest` 通知，**不杀**进程。
 *
 * 测试策略：vscode-jsonrpc/node 无官方 mock，用 `vi.mock`（通过 `vi.hoisted`
 * 安全捕获引用）stub `createMessageConnection`；通过 `opts.server` 注入 fakeServer
 * 以避免触碰真实 tsserver / typescript-language-server。
 *
 * 注：模块级三件套（clients/broken/inflight）跨测试共享 —— 每个测试用唯一
 * fakeServer.id 隔离 key，防 cross-test 缓存命中污染。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";

import type { LspServerInfo } from "../../../src/harness/lsp/types.ts";

// ── 模块级 mock（vi.hoisted 保证 mock 工厂能引用这些） ────────────────────────

const {
  mockSendRequest,
  mockSendNotification,
  mockListen,
  mockDispose,
  mockCreateConnection,
  mockSpawn,
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
  mockSpawn: vi.fn(),
}));

vi.mock("vscode-jsonrpc/node", async (importOriginal) => {
  const actual = await importOriginal<typeof import("vscode-jsonrpc/node")>();
  return {
    ...actual,
    createMessageConnection: (...args: unknown[]) =>
      mockCreateConnection(...args),
  };
});

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: (...args: unknown[]) => mockSpawn(...args),
  };
});

// 动态导入 —— 必须在 mock 安装之后。
import {
  getClient,
  cancelRequest,
  signalToCancellationToken,
} from "../../../src/harness/lsp/client.ts";

// ── fakeServer + fake child 工厂 ──────────────────────────────────────────────

function makeFakeChildProcess(pid = 12345) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const child = Object.assign(new EventEmitter(), {
    stdin,
    stdout,
    stderr,
    pid,
    kill: () => true,
  });
  return child;
}

interface FakeServerOpts {
  /** spawn factory：默认返回 ok 句柄；置 `undefined` 模拟 spawn 失败。 */
  spawn?: (root: string) => Promise<unknown>;
  /** 共享 root 解析（默认固定 "/root"，让同一 id 下所有 file 共享 key）。 */
  root?: (file: string) => Promise<string | undefined>;
}

function makeFakeServer(
  id: string,
  opts: FakeServerOpts = {}
): { server: LspServerInfo; calls: { spawn: number } } {
  const calls = { spawn: 0 };
  const server: LspServerInfo = {
    id,
    root: opts.root ?? (async () => "/root"),
    extensions: [".ts"],
    spawn: async (_root, _ctx) => {
      calls.spawn += 1;
      if (opts.spawn) return opts.spawn(_root);
      const child = makeFakeChildProcess();
      return {
        process: child as unknown as import("node:child_process").ChildProcess,
        initialization: { tsserver: { path: "/tsserver.js" } },
      };
    },
  };
  return { server, calls };
}

const ctx = { directory: "/work" };

beforeEach(() => {
  mockSendRequest.mockReset();
  mockSendNotification.mockReset();
  mockListen.mockReset();
  mockDispose.mockReset();
  mockCreateConnection.mockClear();
  mockSpawn.mockClear();
  // initialize 握手默认返能力对象。
  mockSendRequest.mockResolvedValue({ capabilities: {} });
});

afterEach(() => {
  vi.clearAllMocks();
});

// ── 1. same-root reuse ─────────────────────────────────────────────────────────

describe("getClient same-root reuse", () => {
  it("spawns once and reuses the cached client on the second call", async () => {
    const { server, calls } = makeFakeServer("reuse");

    const first = await getClient(ctx, "/root/a.ts", { server });
    const second = await getClient(ctx, "/root/b.ts", { server });

    expect(first).toBeDefined();
    expect(second).toBe(first); // 同一 client 实例（同一 root 同一 server.id）
    expect(calls.spawn).toBe(1); // spawn 只一次
    expect(mockCreateConnection).toHaveBeenCalledTimes(1);
    // initialize 握手只发了一次。
    expect(mockSendRequest).toHaveBeenCalledTimes(1);
    expect(mockSendRequest).toHaveBeenCalledWith(
      "initialize",
      expect.objectContaining({
        rootUri: expect.stringContaining("/root"),
      })
    );
  });
});

// ── 2. broken memory ──────────────────────────────────────────────────────────

describe("getClient broken memory", () => {
  it("returns undefined on spawn failure and does not retry", async () => {
    const { server, calls } = makeFakeServer("broken", {
      spawn: async () => undefined, // 模拟 typescript-language-server 缺失
    });

    const first = await getClient(ctx, "/root/x.ts", { server });
    const second = await getClient(ctx, "/root/y.ts", { server });

    expect(first).toBeUndefined();
    expect(second).toBeUndefined();
    expect(calls.spawn).toBe(1); // broken 之后不重试
  });
});

// ── 3. inflight dedup ─────────────────────────────────────────────────────────

describe("getClient inflight dedup", () => {
  it("dedupes concurrent first-call spawn into a single promise", async () => {
    let resolveSpawn: ((value: unknown) => void) | undefined;
    const { server, calls } = makeFakeServer("inflight", {
      spawn: () =>
        new Promise((resolve) => {
          resolveSpawn = resolve;
        }),
    });

    const p1 = getClient(ctx, "/root/conc.ts", { server });
    const p2 = getClient(ctx, "/root/conc.ts", { server });

    // 让两个 getClient 都跨过 root await 阶段，inflight.set 完成、p2 命中 inflight。
    // 此时 spawn 仅触发一次（p1 那次），p2 直接复用 inflight Promise。
    await vi.waitFor(() => expect(calls.spawn).toBe(1));

    const child = makeFakeChildProcess();
    resolveSpawn?.({
      process: child,
      initialization: { tsserver: { path: "/tsserver.js" } },
    });

    const [c1, c2] = await Promise.all([p1, p2]);
    expect(c1).toBeDefined();
    expect(c2).toBe(c1); // 同一实例（共享一次 spawn）
    expect(calls.spawn).toBe(1);
  });
});

// ── 4. cancel via $/cancelRequest (no kill) ───────────────────────────────────

describe("cancelRequest", () => {
  it("sends $/cancelRequest notification and never kills the process", async () => {
    const { server } = makeFakeServer("cancel");

    const client = await getClient(ctx, "/root/cancel.ts", { server });
    expect(client).toBeDefined();
    if (!client) throw new Error("expected client from fakeServer");

    // spyOn 需要方法已存在（fake child 已带 stub `kill: () => true`）。
    const killSpy = vi.spyOn(client.process, "kill");

    await cancelRequest(client, 42);

    expect(mockSendNotification).toHaveBeenCalledWith("$/cancelRequest", {
      id: 42,
    });
    expect(killSpy).not.toHaveBeenCalled();
  });
});

// ── 5. sendRequest 实参数目（回归 #-32602）──────────────────────────────────
//
// 复现：lsp.ts handler 调 `client.sendRequest(method, params, token)`，token 来自
// `signalToCancellationToken(execCtx.signal).token`（可能为 undefined）。改动前
// 包装层 `sendRequest: (method, params, token) => connection.sendRequest(method,
// params, token)` **总是**传 3 个实参 → vscode-jsonrpc `numberOfParams=2` → 把
// named params 包成位置数组 `[params, null]` 发出 → tsserver 返 -32602。
// 修复：token 缺席时只传 2 个实参（named params 单参）。

describe("client sendRequest param arity (regression -32602)", () => {
  function makeParams() {
    return {
      textDocument: { uri: "file:///x.ts" },
      position: { line: 0, character: 0 },
    };
  }

  it("forwards 2 args (no token) when token is undefined", async () => {
    const { server } = makeFakeServer("arity-notoken");

    const client = await getClient(ctx, "/root/arity.ts", { server });
    expect(client).toBeDefined();
    if (!client) throw new Error("expected client");

    mockSendRequest.mockReset();
    mockSendRequest.mockResolvedValue([]);

    await client.sendRequest("textDocument/definition", makeParams());

    // 关键断言：只有 2 个实参（method + params），**没有**第 3 个 token 实参。
    expect(mockSendRequest).toHaveBeenCalledTimes(1);
    const call = mockSendRequest.mock.calls[0];
    expect(call).toHaveLength(2);
    expect(call[0]).toBe("textDocument/definition");
    expect(call[1]).toEqual(makeParams());
  });

  it("forwards 3 args (method, params, token) when token is present", async () => {
    const { server } = makeFakeServer("arity-token");

    const client = await getClient(ctx, "/root/arity.ts", { server });
    expect(client).toBeDefined();
    if (!client) throw new Error("expected client");

    mockSendRequest.mockReset();
    mockSendRequest.mockResolvedValue([]);

    // 真实 token：signalToCancellationToken 返回的 source.token（Q2/A9 cancel 路径）。
    const cancel = signalToCancellationToken(new AbortController().signal);
    try {
      await client.sendRequest(
        "textDocument/definition",
        makeParams(),
        cancel.token
      );
    } finally {
      cancel.dispose();
    }

    expect(mockSendRequest).toHaveBeenCalledTimes(1);
    const call = mockSendRequest.mock.calls[0];
    expect(call).toHaveLength(3);
    expect(call[0]).toBe("textDocument/definition");
    expect(call[1]).toEqual(makeParams());
    expect(call[2]).toBe(cancel.token);
  });
});
