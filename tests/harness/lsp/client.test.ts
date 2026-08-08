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
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Pyright,
  YamlLS,
  JsonLS,
  DockerfileLS,
  Typescript,
} from "../../../src/harness/lsp/server.ts";

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

// ── 6. spawn throw 漏洞回归（exception）──────────────────────────────────────
//
// 漏洞（修复前 client.ts:92-105）：spawnClient(...).then(...).finally(...) 无
// .catch → spawn 抛错时 throw 传播为 rejection、never 触达 `broken.add` →
// broken 不记忆该 key → 下次调用重试 spawn、rejection 逃逸成 unhandled。
//
// 修复：task 链加 `.catch(() => { broken.add(key); return undefined; })` —— 把
// spawn throw 归一为不可用，与 spawn return undefined 同路径（broken 记忆、
// 返 undefined、handler 转哨兵）。
//
// 此测试是漏洞回归：把 .catch 删掉就会变红（断言 getClient 不 rejects、spawn
// 不被重试、broken 记忆生效）。

describe("getClient spawn exception", () => {
  it("spawn throw is treated as unavailable (memoized broken, no retry, no unhandled rejection)", async () => {
    const { server, calls } = makeFakeServer("spawn-throw", {
      spawn: async () => {
        throw new Error("boom");
      },
    });

    // 第一次：spawn 抛错 → getClient 归一为 undefined（不向上抛 unhandled）。
    const first = await getClient(ctx, "/root/a.ts", { server });
    expect(first).toBeUndefined();
    expect(calls.spawn).toBe(1);

    // 第二次：broken 记忆生效，不再重试 spawn（spawn 仍是 1）。
    const second = await getClient(ctx, "/root/b.ts", { server });
    expect(second).toBeUndefined();
    expect(calls.spawn).toBe(1);
  });
});

// ── 7. signalToCancellationToken 已 aborted signal 立即 cancel（exception）───
//
// 锚点 client.ts:194-196：`if (signal.aborted) source.cancel()` 分支。

describe("signalToCancellationToken", () => {
  it("aborted signal cancels token immediately", () => {
    const ac = new AbortController();
    ac.abort();

    const { token, dispose } = signalToCancellationToken(ac.signal);

    expect(token.isCancellationRequested).toBe(true);
    // dispose 是 no-op（listener 从未注册，remove 不抛）。
    expect(() => dispose()).not.toThrow();
  });
});

// ── 8. token=null 仍走 3 实参（negative）─────────────────────────────────────
//
// 锚点 client.ts:164：`token !== undefined` 判断。null ≠ undefined → 走 3 参分支。

describe("client sendRequest arity — null token", () => {
  it("null token still forwards 3 args (only undefined omits)", async () => {
    const { server } = makeFakeServer("arity-null");

    const client = await getClient(ctx, "/root/n.ts", { server });
    expect(client).toBeDefined();
    if (!client) throw new Error("expected client");

    mockSendRequest.mockReset();
    mockSendRequest.mockResolvedValue([]);

    await client.sendRequest(
      "textDocument/definition",
      { x: 1 },
      null as never
    );

    expect(mockSendRequest).toHaveBeenCalledTimes(1);
    const call = mockSendRequest.mock.calls[0];
    expect(call).toHaveLength(3);
    expect(call[2]).toBeNull();
  });
});

// ── 9. child 缺 stdout/stdin → 视为不可用，broken 记忆（empty/exception）──────
//
// 锚点 client.ts:125：`if (!child.stdout || !child.stdin) return undefined;`
// 返回 undefined → 走 broken 记忆，后续不重试。

describe("getClient missing child stdio", () => {
  it("getClient treats missing child stdout/stdin as unavailable", async () => {
    const { server, calls } = makeFakeServer("nostdio", {
      spawn: async () => ({
        process: {
          stdout: undefined,
          stdin: new PassThrough(),
          stderr: new PassThrough(),
          pid: 1,
        } as unknown as import("node:child_process").ChildProcess,
        initialization: { tsserver: { path: "/tsserver.js" } },
      }),
    });

    const first = await getClient(ctx, "/root/a.ts", { server });
    const second = await getClient(ctx, "/root/b.ts", { server });

    expect(first).toBeUndefined();
    expect(second).toBeUndefined();
    expect(calls.spawn).toBe(1); // broken 记忆，不重试
  });
});

// ── 10. 首次并发失败 → 后续见 broken 不重试（concurrent）─────────────────────
//
// 锚点 client.ts:92-103：两个并发 getClient 同 key，spawn 返 undefined（broken
// 路径）→ 两者都 undefined、spawn 只一次、第三次见 broken 不再 spawn。

describe("getClient concurrent first-call failure", () => {
  it("concurrent first-call failure memoizes broken so later calls never retry", async () => {
    const { server, calls } = makeFakeServer("concfail", {
      spawn: async () => undefined, // broken 路径
    });

    const [c1, c2] = await Promise.all([
      getClient(ctx, "/root/a.ts", { server }),
      getClient(ctx, "/root/b.ts", { server }),
    ]);
    const third = await getClient(ctx, "/root/c.ts", { server });

    expect(c1).toBeUndefined();
    expect(c2).toBeUndefined();
    expect(third).toBeUndefined();
    expect(calls.spawn).toBe(1); // 并发只 spawn 一次；broken 后第三也不重试
  });
});

// ── 11. cancelRequest 透传 NaN id（empty/negative）───────────────────────────
//
// 锚点 client.ts:214-218：`{ id: reqId }` 原样透传，不 throw。

describe("cancelRequest NaN id", () => {
  it("cancelRequest forwards NaN id", async () => {
    const { server } = makeFakeServer("cancel-nan");

    const client = await getClient(ctx, "/root/nan.ts", { server });
    expect(client).toBeDefined();
    if (!client) throw new Error("expected client");

    await cancelRequest(client, NaN);

    expect(mockSendNotification).toHaveBeenCalledTimes(1);
    expect(mockSendNotification.mock.calls[0][0]).toBe("$/cancelRequest");
    expect(mockSendNotification.mock.calls[0][1]).toEqual({ id: NaN });
  });
});

// ── 12. getClient root=undefined → undefined,不 spawn（empty）────────────────
//
// 锚点 client.ts:84-85：`if (!root) return undefined;` 在 spawn 之前早返。

describe("getClient root undefined (empty)", () => {
  it("returns undefined without spawning when root resolves to undefined", async () => {
    const { server, calls } = makeFakeServer("root-empty", {
      root: async () => undefined, // 无 LSP 服务（如 file 不在扩展名列表 / 跨出 workdir）
    });

    const client = await getClient(ctx, "/root/a.ts", { server });

    expect(client).toBeUndefined();
    expect(calls.spawn).toBe(0); // 早返,绝不 spawn
    expect(mockCreateConnection).not.toHaveBeenCalled();
  });

  it("empty file string still routes through root (no throw, no spawn when root empty)", async () => {
    const { server, calls } = makeFakeServer("file-empty", {
      root: async () => undefined,
    });

    const client = await getClient(ctx, "", { server });

    expect(client).toBeUndefined();
    expect(calls.spawn).toBe(0);
  });
});

// ── 13. 缺 stderr 不影响连接建立（negative）──────────────────────────────────
//
// 锚点 client.ts:124-127：stdio 检查只看 stdout/stdin；stderr 走可选 `?.resume()`。

describe("getClient child with undefined stderr (negative)", () => {
  it("succeeds when only stderr is missing (stdout/stdin present)", async () => {
    const { server, calls } = makeFakeServer("nostderr", {
      spawn: async () => {
        const stdin = new PassThrough();
        const stdout = new PassThrough();
        const child = Object.assign(new EventEmitter(), {
          stdin,
          stdout,
          stderr: undefined,
          pid: 7,
          kill: () => true,
        });
        return {
          process:
            child as unknown as import("node:child_process").ChildProcess,
          initialization: { tsserver: { path: "/tsserver.js" } },
        };
      },
    });

    const client = await getClient(ctx, "/root/a.ts", { server });

    expect(client).toBeDefined();
    expect(calls.spawn).toBe(1);
    expect(mockCreateConnection).toHaveBeenCalledTimes(1);
  });
});

// ── 14. 1000 并发同 key → 单次 spawn,共享同一实例（overflow/concurrent）──────
//
// 锚点 client.ts:90-105：inflight 去重。1000 并发同 (root,id) 只 spawn 一次,
// 全部返回同一 client 实例。

describe("getClient 1000 concurrent same key (overflow)", () => {
  it("dedupes 1000 concurrent first-call spawns into a single shared client", async () => {
    let resolveSpawn: ((value: unknown) => void) | undefined;
    const { server, calls } = makeFakeServer("conc-1000", {
      spawn: () =>
        new Promise((resolve) => {
          resolveSpawn = resolve;
        }),
    });

    const N = 1000;
    const pending = Array.from({ length: N }, () =>
      getClient(ctx, "/root/conc.ts", { server })
    );

    await vi.waitFor(() => expect(calls.spawn).toBe(1));

    const child = makeFakeChildProcess();
    resolveSpawn?.({
      process: child,
      initialization: { tsserver: { path: "/tsserver.js" } },
    });

    const results = await Promise.all(pending);
    expect(calls.spawn).toBe(1); // 1000 并发共享一次 spawn
    for (const r of results) expect(r).toBeDefined();
    for (const r of results) expect(r).toBe(results[0]); // 同实例
  });
});

// ── 15. dispose 并发：释放一个 client 不影响另一 key 的 client（concurrent）───
//
// 锚点 client.ts:173：dispose 只调 connection.dispose（释放连接,不杀进程,
// 不与三件套缓存交互）。两 key 各自独立 client,dispose 一个不波及另一个。

describe("dispose isolation across keys (concurrent)", () => {
  it("disposing one client leaves another key's client usable", async () => {
    const { server } = makeFakeServer("dispose-a", {
      root: async () => "/rootA",
    });
    const { server: serverB } = makeFakeServer("dispose-b", {
      root: async () => "/rootB",
    });

    const clientA = await getClient(ctx, "/rootA/x.ts", { server });
    const clientB = await getClient(ctx, "/rootB/y.ts", { server });
    expect(clientA).toBeDefined();
    expect(clientB).toBeDefined();
    if (!clientA || !clientB) throw new Error("expected clients");

    clientA.dispose();
    expect(mockDispose).toHaveBeenCalledTimes(1);

    // clientB 仍可发请求（dispose 只释放 clientA 的连接）。
    mockSendRequest.mockReset();
    mockSendRequest.mockResolvedValue([]);
    await clientB.sendRequest("textDocument/definition", { x: 1 });
    expect(mockSendRequest).toHaveBeenCalledTimes(1);
  });
});

// ── 16. signalToCancellationToken：live signal 后 abort → token 变 cancelled ──
//
// 锚点 client.ts:190-198：注册 abort listener,abort 时 source.cancel()。

describe("signalToCancellationToken live abort (exception)", () => {
  it("token becomes cancellation-requested after signal aborts", async () => {
    const ac = new AbortController();
    const { token, dispose } = signalToCancellationToken(ac.signal);

    expect(token.isCancellationRequested).toBe(false);
    ac.abort();
    expect(token.isCancellationRequested).toBe(true);
    expect(() => dispose()).not.toThrow();
  });

  it("dispose before abort removes the listener (no later cancel)", async () => {
    const ac = new AbortController();
    const { token, dispose } = signalToCancellationToken(ac.signal);
    dispose();
    ac.abort();
    // listener 已移除 → token 不被 cancel。
    expect(token.isCancellationRequested).toBe(false);
  });
});

// ── 17. ensureOpen 幂等（textDocument/didOpen 只发一次/文件）───────────────
//
// 锚点 client.ts:LspClient.ensureOpen。tsserver 对未打开文件不建 project,
// 符号类操作全返空;handler 每次请求前 ensureOpen。本测试验证 client.ts 的
// 幂等缓存:同文件重复 ensureOpen 只发一次 didOpen;不同文件各自发一次。
// 用真实 spawnClient 链路(置 fake spawn 返回可读 .ts 文件 child)。

describe("ensureOpen idempotency", () => {
  it("dedupes same-file ensureOpen but didOpens distinct files", async () => {
    // 真实文件：mkdtempSync 写两个 .ts 文件,ensureOpen 必须能读到。
    // handler 层经 client.ensureOpen(file) → readFile(file),因此文件必须
    // 在 disk 上存在(EACCES 会让 readFile 拒绝)。
    const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "iknow-lsp-ensure-open-"));
    const fileA = join(dir, "a.ts");
    const fileB = join(dir, "b.ts");
    writeFileSync(fileA, "export const a = 1;\n", "utf8");
    writeFileSync(fileB, "export const b = 2;\n", "utf8");
    try {
      const { server } = makeFakeServer("ensure-open", {
        spawn: async (_root) => {
          const stdin = new PassThrough();
          const stdout = new PassThrough();
          const child = Object.assign(new EventEmitter(), {
            stdin,
            stdout,
            stderr: new PassThrough(),
            pid: 99,
            kill: () => true,
          });
          return {
            process:
              child as unknown as import("node:child_process").ChildProcess,
            initialization: { tsserver: { path: "/tsserver.js" } },
          };
        },
      });

      const client = await getClient(ctx, fileA, { server });
      expect(client).toBeDefined();
      if (!client) throw new Error("expected client");

      mockSendNotification.mockReset();
      mockSendNotification.mockResolvedValue(undefined);

      // 同一文件 ensureOpen 两次 → 只发一次 didOpen(幂等缓存)。
      await client.ensureOpen(fileA);
      await client.ensureOpen(fileA);
      // 不同文件 → 各自发一次。
      await client.ensureOpen(fileB);

      const didOpenCalls = mockSendNotification.mock.calls.filter(
        (c) => c[0] === "textDocument/didOpen"
      );
      expect(didOpenCalls).toHaveLength(2);
      const uris = didOpenCalls.map((c) => {
        const p = c[1] as { textDocument: { uri: string } };
        return p.textDocument.uri;
      });
      // pathToFileURL 编码空格/特殊字符;此处只有 ASCII,直接断言后缀。
      expect(uris[0]).toMatch(/\/a\.ts$/);
      expect(uris[1]).toMatch(/\/b\.ts$/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("100 concurrent ensureOpen on same never-opened file sends didOpen only once", async () => {
    // 回归:ensureOpen 早期实现 check-then-act 跨 await readFile → 并发 100
    // 次同文件调用,各通过 has 检查、各发一次 didOpen(version:1 重复)。
    // 修复:openedUris.add(uri) 在 await 之前占位;readFile 失败回滚。
    const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "iknow-lsp-ensure-race-"));
    const file = join(dir, "x.ts");
    writeFileSync(file, "export const x = 1;\n", "utf8");
    try {
      const { server } = makeFakeServer("ensure-race", {
        spawn: async (_root) => {
          const stdin = new PassThrough();
          const stdout = new PassThrough();
          const child = Object.assign(new EventEmitter(), {
            stdin,
            stdout,
            stderr: new PassThrough(),
            pid: 1,
            kill: () => true,
          });
          return {
            process:
              child as unknown as import("node:child_process").ChildProcess,
            initialization: { tsserver: { path: "/tsserver.js" } },
          };
        },
      });
      const client = await getClient(ctx, file, { server });
      if (!client) throw new Error("expected client");
      mockSendNotification.mockReset();
      mockSendNotification.mockResolvedValue(undefined);

      const N = 100;
      await Promise.all(
        Array.from({ length: N }, () => client.ensureOpen(file))
      );
      const didOpens = mockSendNotification.mock.calls.filter(
        (c) => c[0] === "textDocument/didOpen"
      );
      expect(didOpens).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("readFile failure rolls back openedUris (next call retries)", async () => {
    // 锚点 client.ts:ensureOpen 先 add 占位 → readFile 失败 → delete 回滚。
    // 不回滚则失败文件永久 cache 污染,后续 ensureOpen 早返,handler 走假阳性。
    const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "iknow-lsp-ensure-rollback-"));
    const file = join(dir, "y.ts");
    writeFileSync(file, "export const y = 1;\n", "utf8");
    try {
      const { server } = makeFakeServer("ensure-rollback", {
        spawn: async (_root) => {
          const stdin = new PassThrough();
          const stdout = new PassThrough();
          const child = Object.assign(new EventEmitter(), {
            stdin,
            stdout,
            stderr: new PassThrough(),
            pid: 1,
            kill: () => true,
          });
          return {
            process:
              child as unknown as import("node:child_process").ChildProcess,
            initialization: { tsserver: { path: "/tsserver.js" } },
          };
        },
      });
      const client = await getClient(ctx, file, { server });
      if (!client) throw new Error("expected client");

      mockSendNotification.mockReset();
      mockSendNotification.mockResolvedValue(undefined);

      // 删文件 → readFile 抛 ENOENT → ensureOpen reject 且 cache 回滚。
      rmSync(file, { force: true });
      await expect(client.ensureOpen(file)).rejects.toThrow();

      // 写回文件 → 再次 ensureOpen 应真发 didOpen(非占位命中)。
      writeFileSync(file, "export const y = 2;\n", "utf8");
      await client.ensureOpen(file);

      const didOpens = mockSendNotification.mock.calls.filter(
        (c) => c[0] === "textDocument/didOpen"
      );
      expect(didOpens).toHaveLength(1); // 回滚后真的发了一次
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
// ── 18. getClient dispatch（spec 302-lsp-multilang § client.ts，#304 决策1）───
//
// `getClient` 不再硬编默认 `Typescript`，改按 `file` 扩展名经 `resolveServer`
// 路由到对应 server；`opts.server` 注入点语义从「默认 server」变「覆盖 dispatch
// 结果」；无匹配扩展名 → early-return `undefined`。
//
// 策略：路由测试用**真实 server**（Pyright/YamlLS/JsonLS/DockerfileLS/Typescript）
// 但对其 `spawn` 用 `vi.spyOn` 替换——返回值走 spawnClient 的 initialize 握手，
// 需要真实 `child.stdout`/`child.stdin` 可读流，因此 spy 用 `makeFakeChildProcess()`
// 伪造。`mockSpawn`（node:child_process 拦截）验证 dispatch 正确走到 spawn，
// 且**不 fork**（每次调用 spy 计数恒定）。
//
// 三件套缓存跨测试共享：Pyright/Typescript 的 NearestRoot 需要磁盘标记文件，
// 每个测试用 `mkdtempSync` 独立目录（root 唯一 → key 唯一），避开 cross-test
// 缓存命中污染。

describe("getClient dispatch by extension (spec 302)", () => {
  // real server 的 root 需要磁盘标记文件（Pyright/Typescript 的 NearestRoot）；
  // 每个测试用 mkdtempSync 独立目录（root 唯一 → key 唯一），避开三件套
  // cross-test 缓存命中污染。spawn 用 vi.spyOn 拦截 → 不触真实 bin。
  function fakeSpawnFor() {
    const impl = async () => {
      const child = makeFakeChildProcess(9000 + Math.floor(Math.random() * 100));
      return {
        process: child as unknown as import("node:child_process").ChildProcess,
        initialization: { tsserver: { path: "/tsserver.js" } },
      };
    };
    return vi.fn(impl);
  }

  // 断言：getClient 经 resolveServer 路由到 expected，spawn 只调一次，
  // initialize 握手 rootUri 命中该 server 的 root。
  async function assertRoutesTo(
    file: string,
    expected: LspServerInfo,
    dir: string,
    ctxDir: string
  ) {
    const spawnStub = fakeSpawnFor();
    const spy = vi.spyOn(expected, "spawn").mockImplementation(spawnStub);
    try {
      const client = await getClient({ directory: ctxDir }, file);
      expect(client).toBeDefined();
      if (!client) throw new Error("expected client from dispatched server");
      expect(mockSendRequest).toHaveBeenCalledWith(
        "initialize",
        expect.objectContaining({
          rootUri: expect.stringContaining(dir),
        })
      );
      expect(spawnStub).toHaveBeenCalledTimes(1); // dispatch 正确且只 spawn 一次
    } finally {
      spy.mockRestore();
    }
  }

  it("routes .py to Pyright (NearestRoot pyproject.toml)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "iknow-lsp-dispatch-py-"));
    writeFileSync(join(dir, "pyproject.toml"), "\n", "utf8");
    try {
      await assertRoutesTo(join(dir, "app.py"), Pyright, dir, join(dir, ".."));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("routes .yaml to YamlLS (root = ctx.directory)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "iknow-lsp-dispatch-yaml-"));
    try {
      await assertRoutesTo(join(dir, "k8s.yaml"), YamlLS, dir, dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("routes .json to JsonLS (root = ctx.directory)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "iknow-lsp-dispatch-json-"));
    try {
      await assertRoutesTo(join(dir, "tsconfig.json"), JsonLS, dir, dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("routes Dockerfile (no ext) to DockerfileLS (root = ctx.directory)", async () => {
    // 注：`resolveServer` 用 `path.extname(file) || file` 回退——无扩展名时用
    // **全文件名**当 key。`path.extname("/proj/Dockerfile")` 为 `""` → 回退全路径
    // `/proj/Dockerfile`，不匹配 DockerfileLS.extensions["Dockerfile"]。当前
    // 契约只支持裸文件名 `"Dockerfile"`（T2 resolveServer 行为，见 server.test.ts
    // 217 行）；全路径 Dockerfile 路由缺口见汇报。此处测真实契约（裸名）。
    const dir = mkdtempSync(join(tmpdir(), "iknow-lsp-dispatch-docker-"));
    try {
      await assertRoutesTo("Dockerfile", DockerfileLS, dir, dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("routes .ts to Typescript (NearestRoot package-lock.json)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "iknow-lsp-dispatch-ts-"));
    writeFileSync(join(dir, "package-lock.json"), "{}", "utf8");
    try {
      await assertRoutesTo(join(dir, "index.ts"), Typescript, dir, join(dir, ".."));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("no matching extension → getClient returns undefined without spawning", async () => {
    const dir = mkdtempSync(join(tmpdir(), "iknow-lsp-dispatch-none-"));
    try {
      const result = await getClient({ directory: dir }, join(dir, "a.xyz"));
      expect(result).toBeUndefined();
      expect(mockSpawn).not.toHaveBeenCalled();
      expect(mockCreateConnection).not.toHaveBeenCalled();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("opts.server overrides dispatch result (fakeServer wins over pyright)", async () => {
    const { server, calls } = makeFakeServer("override-dispatch");
    const dir = mkdtempSync(join(tmpdir(), "iknow-lsp-dispatch-override-"));
    writeFileSync(join(dir, "pyproject.toml"), "\n", "utf8");
    try {
      // file 按扩展名本会路由到 Pyright，但 opts.server 覆盖 → fakeServer 生效。
      const client = await getClient(
        { directory: join(dir, "..") },
        join(dir, "app.py"),
        { server }
      );
      expect(client).toBeDefined();
      expect(calls.spawn).toBe(1); // fakeServer.spawn 被调用（而非 Pyright）
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("dispatch layer does not fork spawn: concurrent same file dedupes into one spawn", async () => {
    // 与 187-210 行 inflight 去重同源，但走 dispatch 路径（不传 opts.server）：
    // 同 .py 文件并发两次 → Pyright.spawn 只一次，返回同一 client 实例。
    const dir = mkdtempSync(join(tmpdir(), "iknow-lsp-dispatch-conc-"));
    writeFileSync(join(dir, "pyproject.toml"), "\n", "utf8");
    const file = join(dir, "app.py");
    let resolveSpawn: ((value: unknown) => void) | undefined;
    const spawnStub = fakeSpawnFor();
    spawnStub.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSpawn = resolve;
        })
    );
    const spy = vi.spyOn(Pyright, "spawn").mockImplementation(spawnStub);
    try {
      const ctxL = { directory: join(dir, "..") };
      const p1 = getClient(ctxL, file);
      const p2 = getClient(ctxL, file);
      await vi.waitFor(() => expect(spawnStub).toHaveBeenCalledTimes(1));
      const child = makeFakeChildProcess();
      resolveSpawn?.({
        process: child,
        initialization: { pythonPath: undefined },
      });
      const [c1, c2] = await Promise.all([p1, p2]);
      expect(c1).toBeDefined();
      expect(c2).toBe(c1); // 同一实例（dispatch 层共享一次 spawn）
      expect(spawnStub).toHaveBeenCalledTimes(1); // 不 fork
    } finally {
      spy.mockRestore();
    }
  });
});
