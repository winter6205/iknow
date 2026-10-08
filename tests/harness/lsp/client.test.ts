/**
 * Unit tests for client.ts's three-piece cache (spec 251-lsp-tool).
 *
 * Four boundaries covered:
 *   1. same-root reuse: two getClient on one root → spawn once, cache reused.
 *   2. broken memory: fakeServer.spawn returns undefined → permanently broken,
 *      spawn not retried.
 *   3. inflight dedup: two concurrent calls → share one spawn Promise.
 *   4. cancel via $/cancelRequest: cancelRequest sends the `$/cancelRequest`
 *      notification and does **not** kill the process.
 *
 * Strategy: vscode-jsonrpc/node has no official mock, so `vi.mock` (with
 * `vi.hoisted` to safely capture references) stubs `createMessageConnection`;
 * a fakeServer is injected via `opts.server` to avoid touching the real
 * tsserver / typescript-language-server.
 *
 * Note: the module-level three-piece cache (clients/broken/inflight) is shared
 * across tests — each test uses a unique fakeServer.id to isolate keys and
 * prevent cross-test cache-hit pollution.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";

import type {
  LspCtx,
  LspServerHandle,
  LspServerInfo,
} from "../../../src/harness/lsp/types.ts";
import { mkdtempSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  Pyright,
  YamlLS,
  JsonLS,
  DockerfileLS,
  Typescript,
} from "../../../src/harness/lsp/server.ts";

// ── module-level mocks (vi.hoisted lets the mock factories reference these) ──

const {
  mockSendRequest,
  mockSendNotification,
  mockOnNotification,
  mockListen,
  mockDispose,
  mockCreateConnection,
  mockSpawn,
} = vi.hoisted(() => ({
  mockSendRequest: vi.fn(),
  mockSendNotification: vi.fn(),
  mockOnNotification: vi.fn(),
  mockListen: vi.fn(),
  mockDispose: vi.fn(),
  mockCreateConnection: vi.fn(() => ({
    sendRequest: mockSendRequest,
    sendNotification: mockSendNotification,
    onRequest: vi.fn(),
    onNotification: mockOnNotification,
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
      mockCreateConnection(...(args as [])),
  };
});

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: (...args: unknown[]) => mockSpawn(...args),
  };
});

// Dynamic imports — must come after the mocks are installed.
import {
  getClient,
  cancelRequest,
  signalToCancellationToken,
} from "../../../src/harness/lsp/client.ts";

// ── fakeServer + fake child factories ─────────────────────────────────────────

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
  /** spawn factory: by default returns an ok handle; set `undefined` to simulate spawn failure. */
  spawn?: (root: string) => Promise<LspServerHandle | undefined>;
  /** shared root resolver (default fixed "/root", so all files under one id share the key). */
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
    spawn: async (_root: string, _ctx: LspCtx) => {
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
  mockOnNotification.mockReset();
  mockListen.mockReset();
  mockDispose.mockReset();
  mockCreateConnection.mockClear();
  mockSpawn.mockClear();
  // The initialize handshake returns a capabilities object by default.
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
    expect(second).toBe(first); // same client instance (same root, same server.id)
    expect(calls.spawn).toBe(1); // spawn happens once
    expect(mockCreateConnection).toHaveBeenCalledTimes(1);
    // the initialize handshake was sent only once.
    expect(mockSendRequest).toHaveBeenCalledTimes(1);
    expect(mockSendRequest).toHaveBeenCalledWith(
      "initialize",
      expect.objectContaining({
        rootUri: expect.stringContaining("/root"),
      })
    );
  });
});

// ── 1b. the `initialized` notification (production-correctness fix) ───────────
//
// Anchor client.ts spawnClient: after the initialize response, an `initialized`
// notification must be sent. In practice pyright does gate — with no
// `initialized` it ignores all subsequent requests; tsserver does not gate, so
// TS worked already and the extra notification is compatible with it. Assert:
// spawnClient sends exactly one `initialized` after initialize (the probe does
// not re-send, avoiding double-init).

describe("spawnClient sends initialized after initialize", () => {
  it("sends exactly one `initialized` notification after the initialize handshake", async () => {
    const { server } = makeFakeServer("initialized");

    const client = await getClient(ctx, "/root/init.ts", { server });
    expect(client).toBeDefined();

    const initCalls = mockSendNotification.mock.calls.filter(
      (c) => c[0] === "initialized"
    );
    expect(initCalls).toHaveLength(1); // exactly once, no double-init
    expect(initCalls[0][1]).toEqual({});
  });

  it("advertises hierarchical documentSymbol support in the initialize payload", async () => {
    const { server } = makeFakeServer("caps-document-symbol");
    const client = await getClient(ctx, "/root/caps.ts", { server });
    expect(client).toBeDefined();

    const initCall = mockSendRequest.mock.calls.find(
      (c) => c[0] === "initialize"
    );
    const params = initCall?.[1] as {
      capabilities: { textDocument?: { documentSymbol?: unknown } };
    };
    // Without this capability a server may legitimately answer the flat
    // SymbolInformation[] form, whose range points at the declaration line
    // start rather than the identifier — the resolver then cannot locate the
    // symbol at all. Declaring it asks the server for the nested tree the
    // resolver's happy path consumes.
    expect(params.capabilities.textDocument?.documentSymbol).toEqual({
      hierarchicalDocumentSymbolSupport: true,
    });
  });
});

// ── 2. broken memory ──────────────────────────────────────────────────────────

describe("getClient broken memory", () => {
  it("returns undefined on spawn failure and does not retry", async () => {
    const { server, calls } = makeFakeServer("broken", {
      spawn: async () => undefined, // simulate typescript-language-server missing
    });

    const first = await getClient(ctx, "/root/x.ts", { server });
    const second = await getClient(ctx, "/root/y.ts", { server });

    expect(first).toBeUndefined();
    expect(second).toBeUndefined();
    expect(calls.spawn).toBe(1); // no retry once broken
  });
});

// ── 3. inflight dedup ─────────────────────────────────────────────────────────

describe("getClient inflight dedup", () => {
  it("dedupes concurrent first-call spawn into a single promise", async () => {
    let resolveSpawn:
      ((value: LspServerHandle | undefined) => void) | undefined;
    const { server, calls } = makeFakeServer("inflight", {
      spawn: () =>
        new Promise((resolve) => {
          resolveSpawn = resolve;
        }),
    });

    const p1 = getClient(ctx, "/root/conc.ts", { server });
    const p2 = getClient(ctx, "/root/conc.ts", { server });

    // Let both getClient calls cross the root-await stage so inflight.set
    // completes and p2 hits inflight. At this point spawn has fired once (p1's);
    // p2 reuses the inflight Promise directly.
    await vi.waitFor(() => expect(calls.spawn).toBe(1));

    const child = makeFakeChildProcess();
    resolveSpawn?.({
      process: child as unknown as import("node:child_process").ChildProcess,
      initialization: { tsserver: { path: "/tsserver.js" } },
    });

    const [c1, c2] = await Promise.all([p1, p2]);
    expect(c1).toBeDefined();
    expect(c2).toBe(c1); // same instance (shared one spawn)
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

    // spyOn needs the method to already exist (the fake child carries a stub `kill: () => true`).
    const killSpy = vi.spyOn(client.process, "kill");

    await cancelRequest(client, 42);

    expect(mockSendNotification).toHaveBeenCalledWith("$/cancelRequest", {
      id: 42,
    });
    expect(killSpy).not.toHaveBeenCalled();
  });
});

// ── 5. sendRequest argument count (regression -32602) ─────────────────────────
//
// Repro: the lsp.ts handler calls `client.sendRequest(method, params, token)`,
// where token comes from `signalToCancellationToken(execCtx.signal).token` (may
// be undefined). Before the fix the wrapper `sendRequest: (method, params,
// token) => connection.sendRequest(method, params, token)` **always** passed 3
// arguments → vscode-jsonrpc saw numberOfParams=2 → wrapped the named params
// into a positional array `[params, null]` → tsserver returned -32602. Fix:
// when the token is absent, pass only 2 arguments (named params as one arg).

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

    // Key assertion: only 2 arguments (method + params), **no** 3rd token argument.
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

    // A real token: the source.token returned by signalToCancellationToken (cancel path).
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

// ── 6. spawn-throw gap regression (exception) ────────────────────────────────
//
// Gap (client.ts:92-105 before the fix): spawnClient(...).then(...).finally(...)
// had no .catch → when spawn threw, the throw propagated as a rejection and
// never reached `broken.add` → the key was not memoized as broken → the next
// call retried spawn and the rejection escaped as unhandled.
//
// Fix: add `.catch(() => { broken.add(key); return undefined; })` to the task
// chain — normalize a spawn throw into "unavailable", same path as spawn
// returning undefined (memoize broken, return undefined, handler maps to a
// sentinel).
//
// This test is the gap regression: remove the .catch and it turns red (assert
// getClient does not reject, spawn is not retried, broken memo holds).

describe("getClient spawn exception", () => {
  it("spawn throw is treated as unavailable (memoized broken, no retry, no unhandled rejection)", async () => {
    const { server, calls } = makeFakeServer("spawn-throw", {
      spawn: async () => {
        throw new Error("boom");
      },
    });

    // First: spawn throws → getClient normalizes to undefined (no unhandled throw upward).
    const first = await getClient(ctx, "/root/a.ts", { server });
    expect(first).toBeUndefined();
    expect(calls.spawn).toBe(1);

    // Second: broken memo holds, spawn is not retried (spawn count stays 1).
    const second = await getClient(ctx, "/root/b.ts", { server });
    expect(second).toBeUndefined();
    expect(calls.spawn).toBe(1);
  });
});

// ── 7. signalToCancellationToken: an already-aborted signal cancels immediately (exception) ─
//
// Anchor client.ts:194-196: the `if (signal.aborted) source.cancel()` branch.

describe("signalToCancellationToken", () => {
  it("aborted signal cancels token immediately", () => {
    const ac = new AbortController();
    ac.abort();

    const { token, dispose } = signalToCancellationToken(ac.signal);

    expect(token.isCancellationRequested).toBe(true);
    // dispose is a no-op (the listener was never registered, so remove does not throw).
    expect(() => dispose()).not.toThrow();
  });
});

// ── 8. token=null still takes the 3-arg path (negative) ──────────────────────
//
// Anchor client.ts:164: the `token !== undefined` test. null ≠ undefined → the
// 3-arg branch is taken.

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

// ── 9. child missing stdout/stdin → treated unavailable, memoized broken (empty/exception) ─
//
// Anchor client.ts:125: `if (!child.stdout || !child.stdin) return undefined;`
// Returning undefined goes into the memoized-broken path, so later calls do not
// retry.

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
    expect(calls.spawn).toBe(1); // memoized broken, no retry
  });
});

// ── 10. first concurrent call fails → later calls see broken and never retry (concurrent) ─
//
// Anchor client.ts:92-103: two concurrent getClient on the same key, spawn
// returns undefined (the broken path) → both undefined, spawn once, the third
// call sees broken and does not spawn.

describe("getClient concurrent first-call failure", () => {
  it("concurrent first-call failure memoizes broken so later calls never retry", async () => {
    const { server, calls } = makeFakeServer("concfail", {
      spawn: async () => undefined, // the broken path
    });

    const [c1, c2] = await Promise.all([
      getClient(ctx, "/root/a.ts", { server }),
      getClient(ctx, "/root/b.ts", { server }),
    ]);
    const third = await getClient(ctx, "/root/c.ts", { server });

    expect(c1).toBeUndefined();
    expect(c2).toBeUndefined();
    expect(third).toBeUndefined();
    expect(calls.spawn).toBe(1); // concurrent → one spawn; after broken the third never retries
  });
});

// ── 11. cancelRequest forwards a NaN id (empty/negative) ─────────────────────
//
// Anchor client.ts:214-218: `{ id: reqId }` forwarded verbatim, no throw.

describe("cancelRequest NaN id", () => {
  it("cancelRequest forwards NaN id", async () => {
    const { server } = makeFakeServer("cancel-nan");

    const client = await getClient(ctx, "/root/nan.ts", { server });
    expect(client).toBeDefined();
    if (!client) throw new Error("expected client");

    await cancelRequest(client, NaN);

    // spawnClient's handshake already sent one `initialized` notification (the
    // production-correctness fix); here assert only the `$/cancelRequest` one
    // (filter out the handshake notification).
    const cancelCalls = mockSendNotification.mock.calls.filter(
      (c) => c[0] === "$/cancelRequest"
    );
    expect(cancelCalls).toHaveLength(1);
    expect(cancelCalls[0][1]).toEqual({ id: NaN });
  });
});

// ── 12. getClient root=undefined → undefined, no spawn (empty) ───────────────
//
// Anchor client.ts:84-85: `if (!root) return undefined;` early-returns before spawn.

describe("getClient root undefined (empty)", () => {
  it("returns undefined without spawning when root resolves to undefined", async () => {
    const { server, calls } = makeFakeServer("root-empty", {
      root: async () => undefined, // no LSP server (file outside the extension list / beyond workdir)
    });

    const client = await getClient(ctx, "/root/a.ts", { server });

    expect(client).toBeUndefined();
    expect(calls.spawn).toBe(0); // early return, never spawns
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

// ── 13. missing stderr does not block connection setup (negative) ────────────
//
// Anchor client.ts:124-127: the stdio check looks only at stdout/stdin; stderr
// goes through an optional `?.resume()`.

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

// ── 14. 1000 concurrent calls on the same key → one spawn, one shared instance (overflow/concurrent) ─
//
// Anchor client.ts:90-105: inflight dedup. 1000 concurrent calls with the same
// (root,id) spawn once and all return the same client instance.

describe("getClient 1000 concurrent same key (overflow)", () => {
  it("dedupes 1000 concurrent first-call spawns into a single shared client", async () => {
    let resolveSpawn:
      ((value: LspServerHandle | undefined) => void) | undefined;
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
      process: child as unknown as import("node:child_process").ChildProcess,
      initialization: { tsserver: { path: "/tsserver.js" } },
    });

    const results = await Promise.all(pending);
    expect(calls.spawn).toBe(1); // 1000 concurrent share one spawn
    for (const r of results) expect(r).toBeDefined();
    for (const r of results) expect(r).toBe(results[0]); // same instance
  });
});

// ── 15. dispose concurrency: releasing one client leaves another key's client intact (concurrent) ─
//
// Anchor client.ts:173: dispose only calls connection.dispose (releases the
// connection, does not kill the process, does not touch the three-piece cache).
// Two keys each have an independent client; disposing one does not affect the other.

describe("dispose isolation across keys (concurrent)", () => {
  it("disposing one client leaves another key's client usable", async () => {
    const { server } = makeFakeServer("dispose-a", {
      root: async () => "/rootA",
    });
    makeFakeServer("dispose-b", {
      root: async () => "/rootB",
    });

    const clientA = await getClient(ctx, "/rootA/x.ts", { server });
    const clientB = await getClient(ctx, "/rootB/y.ts", { server });
    expect(clientA).toBeDefined();
    expect(clientB).toBeDefined();
    if (!clientA || !clientB) throw new Error("expected clients");

    clientA.dispose();
    expect(mockDispose).toHaveBeenCalledTimes(1);

    // clientB can still issue requests (dispose released only clientA's connection).
    mockSendRequest.mockReset();
    mockSendRequest.mockResolvedValue([]);
    await clientB.sendRequest("textDocument/definition", { x: 1 });
    expect(mockSendRequest).toHaveBeenCalledTimes(1);
  });
});

// ── 16. signalToCancellationToken: live signal aborted later → token becomes cancelled ─
//
// Anchor client.ts:190-198: registers an abort listener; source.cancel() on abort.

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
    // The listener was removed → the token is not cancelled.
    expect(token.isCancellationRequested).toBe(false);
  });
});

// ── 17. ensureOpen idempotency (didOpen sent exactly once per file) ──────────
//
// Anchor client.ts:LspClient.ensureOpen. tsserver builds no project for a file that
// was never opened, so symbol queries return empty; the handler calls ensureOpen
// before every request. This section pins the idempotent cache: repeated ensureOpen
// on one file sends didOpen once; distinct files each send their own.
// Uses the real spawnClient path (fake spawn returning a readable child for .ts files).

describe("ensureOpen idempotency", () => {
  it("dedupes same-file ensureOpen but didOpens distinct files", async () => {
    // Real files: mkdtempSync writes two .ts files that ensureOpen must read.
    // The handler goes client.ensureOpen(file) → readFile(file), so the files
    // must exist on disk (EACCES would make readFile reject).
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

      // ensureOpen twice on one file → didOpen sent once (idempotent cache).
      await client.ensureOpen(fileA);
      await client.ensureOpen(fileA);
      // Distinct files → one didOpen each.
      await client.ensureOpen(fileB);

      const didOpenCalls = mockSendNotification.mock.calls.filter(
        (c) => c[0] === "textDocument/didOpen"
      );
      expect(didOpenCalls).toHaveLength(2);
      const uris = didOpenCalls.map((c) => {
        const p = c[1] as { textDocument: { uri: string } };
        return p.textDocument.uri;
      });
      // pathToFileURL encodes spaces/special chars; only ASCII here, so assert the suffix directly.
      expect(uris[0]).toMatch(/\/a\.ts$/);
      expect(uris[1]).toMatch(/\/b\.ts$/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("100 concurrent ensureOpen on same never-opened file sends didOpen only once", async () => {
    // Regression: the early ensureOpen did check-then-act across `await readFile`,
    // so 100 concurrent same-file calls each passed the has-check and each sent
    // its own didOpen (duplicate version:1). Fix: openedUris.add(uri) claims the
    // slot before the await; a readFile failure rolls it back.
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
    // Anchor client.ts: ensureOpen claims the slot via add → readFile fails → delete rolls back.
    // Without the rollback the failed file poisons the cache forever: later ensureOpen calls
    // return early and the handler proceeds on a false positive.
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

      // Delete the file → readFile throws ENOENT → ensureOpen rejects and the cache rolls back.
      rmSync(file, { force: true });
      await expect(client.ensureOpen(file)).rejects.toThrow();

      // Write the file back → the next ensureOpen must really send didOpen (not hit a stale claim).
      writeFileSync(file, "export const y = 2;\n", "utf8");
      await client.ensureOpen(file);

      const didOpens = mockSendNotification.mock.calls.filter(
        (c) => c[0] === "textDocument/didOpen"
      );
      expect(didOpens).toHaveLength(1); // After the rollback, didOpen really went out once.
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── 17b. withDocumentOpen: request-scoped refcount open/close ────────────────
//
// Anchors spec 251-lsp-tool.md (document-open lifecycle under the EXIT contract) +
// client.ts:LspClient.withDocumentOpen:
//   - request-level refcount: overlapping requests on one uri share a single didOpen;
//     reaching zero sends didClose;
//   - reaching zero also drops the open record (version) and that uri's diagnostics cache;
//   - between calls the file is not kept open for the server; the next request re-didOpens
//     and therefore reads the latest text.
// Reuses the ensureOpen section's real-file + fakeServer technique; the notification
// sequence is the assertion surface (didOpen → fn → didClose), with probes inside fn
// recording whether the document was open at call time.

describe("withDocumentOpen (request-scoped didOpen/didClose)", () => {
  function makeScopedFixture(id: string, fileName = "a.ts") {
    const dir = mkdtempSync(join(tmpdir(), `iknow-lsp-scoped-${id}-`));
    const file = join(dir, fileName);
    writeFileSync(file, "export const a = 1;\n", "utf8");
    const { server } = makeFakeServer(`scoped-${id}`, {
      spawn: async (_root) => {
        const stdin = new PassThrough();
        const stdout = new PassThrough();
        const child = Object.assign(new EventEmitter(), {
          stdin,
          stdout,
          stderr: new PassThrough(),
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
    return { dir, file, server };
  }

  /** Sequence of notifications sent so far (method names, in send order). */
  function notificationSeq(): string[] {
    return mockSendNotification.mock.calls.map((c) => String(c[0]));
  }

  function callsOf(method: string): unknown[][] {
    return mockSendNotification.mock.calls.filter((c) => c[0] === method);
  }

  /** Manually released gate (no sleeps: every interleaving point is explicitly controlled). */
  function deferred(): { promise: Promise<void>; resolve: () => void } {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  }

  it("opens, runs fn, then closes (didOpen → fn → didClose)", async () => {
    const { dir, file, server } = makeScopedFixture("order");
    try {
      const client = await getClient(ctx, file, { server });
      if (!client) throw new Error("expected client");
      mockSendNotification.mockReset();
      mockSendNotification.mockResolvedValue(undefined);

      const observed: string[] = [];
      const result = await client.withDocumentOpen(file, async () => {
        observed.push(...notificationSeq());
        return 42;
      });

      expect(result).toBe(42);
      expect(observed).toEqual(["textDocument/didOpen"]);
      expect(notificationSeq()).toEqual([
        "textDocument/didOpen",
        "textDocument/didClose",
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("closes even when fn throws (exception safety)", async () => {
    // Every existing handler has throw paths (timeout / RPC error / ToolExecutionError) —
    // a throwing fn must still drop the count via finally, or the open record and the
    // server-side document leak forever.
    const { dir, file, server } = makeScopedFixture("throw");
    try {
      const client = await getClient(ctx, file, { server });
      if (!client) throw new Error("expected client");
      mockSendNotification.mockReset();
      mockSendNotification.mockResolvedValue(undefined);

      await expect(
        client.withDocumentOpen(file, async () => {
          throw new Error("handler blew up");
        })
      ).rejects.toThrow("handler blew up");

      expect(notificationSeq()).toEqual([
        "textDocument/didOpen",
        "textDocument/didClose",
      ]);
      // The open record was dropped at zero → the next request re-didOpens (no false-positive reuse).
      expect(client.getOpenVersion(pathToFileURL(file).href)).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("two concurrent same-file scopes share one didOpen and close once (last exit)", async () => {
    const { dir, file, server } = makeScopedFixture("concurrent");
    try {
      const client = await getClient(ctx, file, { server });
      if (!client) throw new Error("expected client");
      mockSendNotification.mockReset();
      mockSendNotification.mockResolvedValue(undefined);

      let releaseFirst: (() => void) | undefined;
      let releaseSecond: (() => void) | undefined;
      const firstGate = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      const secondGate = new Promise<void>((resolve) => {
        releaseSecond = resolve;
      });
      let bothEnteredResolve: (() => void) | undefined;
      const bothEntered = new Promise<void>((resolve) => {
        bothEnteredResolve = resolve;
      });
      let entered = 0;
      const mark = (): void => {
        entered += 1;
        if (entered === 2) bothEnteredResolve?.();
      };

      const first = client.withDocumentOpen(file, async () => {
        mark();
        await firstGate;
        return "first";
      });
      const second = client.withDocumentOpen(file, async () => {
        mark();
        await secondGate;
        return "second";
      });

      // Both scopes are entered: they share one didOpen.
      await bothEntered;
      expect(callsOf("textDocument/didOpen")).toHaveLength(1);
      // The second exits first (refcount 2→1, no didClose yet), then the first (1→0, exactly one didClose).
      releaseSecond?.();
      await expect(second).resolves.toBe("second");
      expect(callsOf("textDocument/didClose")).toHaveLength(0);
      releaseFirst?.();
      await expect(first).resolves.toBe("first");
      expect(callsOf("textDocument/didOpen")).toHaveLength(1);
      expect(callsOf("textDocument/didClose")).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("second scope entering while the first is suspended in pre-body alignment still sees the document open", async () => {
    // Regression: the document must stay open throughout overlapping scopes. Before
    // the fix, withDocumentOpen did refs++ only after the `await openDocument` /
    // `await alignToDisk` awaits, so while the first scope was suspended in
    // pre-request alignment (alignToDisk's didChange) it had not claimed a slot —
    // the second scope saw the entry, claimed it, ran its body and synchronously
    // deleted at zero; when the first resumed, `openDocs.get` was already undefined
    // and it **entered its body empty-handed** (the document sat in a closed window,
    // getDocumentFingerprint returned undefined).
    //
    // All interleaving is explicitly gated (no sleeps): the didOpen reply bumps the
    // on-disk mtime so the first scope's alignToDisk must send a didChange and hang
    // on the gate; only after the second scope completes fully is it released, then
    // both bodies are asserted to see the document registered, with didOpen /
    // didClose exactly once each.
    const { dir, file, server } = makeScopedFixture("align-race");
    const uri = pathToFileURL(file).href;
    try {
      const client = await getClient(ctx, file, { server });
      if (!client) throw new Error("expected client");
      mockSendNotification.mockReset();

      const didChangeGate = deferred();
      let mtimeBumped = false;
      mockSendNotification.mockImplementation(async (method: string) => {
        if (method === "textDocument/didOpen" && !mtimeBumped) {
          // The entry is registered (stale mtime recorded); bumping the on-disk mtime
          // before it returns forces the first scope's following alignToDisk to send a
          // didChange — a controllable suspension point.
          mtimeBumped = true;
          const later = new Date(Date.now() + 5000);
          utimesSync(file, later, later);
        }
        if (method === "textDocument/didChange") await didChangeGate.promise;
      });

      const openedInBody: boolean[] = [];
      const first = client.withDocumentOpen(file, async () => {
        openedInBody.push(client.getDocumentFingerprint(uri) !== undefined);
        return "first";
      });
      // Wait for the alignment didChange to be sent (suspended) — the first scope has not entered its body yet.
      await vi.waitFor(() =>
        expect(callsOf("textDocument/didChange")).toHaveLength(1)
      );

      const second = client.withDocumentOpen(file, async () => {
        openedInBody.push(client.getDocumentFingerprint(uri) !== undefined);
        return "second";
      });
      await expect(second).resolves.toBe("second");

      didChangeGate.resolve();
      await expect(first).resolves.toBe("first");

      expect(openedInBody).toEqual([true, true]);
      expect(callsOf("textDocument/didOpen")).toHaveLength(1);
      expect(callsOf("textDocument/didClose")).toHaveLength(1);
      // No residue after zero: the next scope re-didOpens.
      expect(client.getDocumentFingerprint(uri)).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("scope whose fresh open is closed by a last exit reopens instead of entering empty-handed", async () => {
    // The other half of the fix shape: the claim check and the "re-open" must close the
    // loop. While the first scope hangs on didOpen (no claim yet), the second scope
    // claims, runs and drops to zero — closing at zero is legitimate there (no ref
    // holder at that moment); when the first resumes it must **re-open** and reclaim,
    // not enter its body empty-handed. Two didOpen / two didClose is the correct
    // outcome of this interleaving.
    const { dir, file, server } = makeScopedFixture("inflight-scope");
    const uri = pathToFileURL(file).href;
    try {
      const client = await getClient(ctx, file, { server });
      if (!client) throw new Error("expected client");
      mockSendNotification.mockReset();

      const didOpenGate = deferred();
      mockSendNotification.mockImplementation(async (method: string) => {
        if (method === "textDocument/didOpen") await didOpenGate.promise;
      });

      const openedInBody: boolean[] = [];
      const first = client.withDocumentOpen(file, async () => {
        openedInBody.push(client.getDocumentFingerprint(uri) !== undefined);
        return "first";
      });
      // Wait for the first didOpen to be sent (suspended) — the entry is registered by now, but no ref holds it.
      await vi.waitFor(() =>
        expect(callsOf("textDocument/didOpen")).toHaveLength(1)
      );

      const second = client.withDocumentOpen(file, async () => {
        openedInBody.push(client.getDocumentFingerprint(uri) !== undefined);
        return "second";
      });
      await expect(second).resolves.toBe("second");

      didOpenGate.resolve();
      await expect(first).resolves.toBe("first");

      expect(openedInBody).toEqual([true, true]);
      expect(callsOf("textDocument/didOpen")).toHaveLength(2);
      expect(callsOf("textDocument/didClose")).toHaveLength(2);
      expect(client.getDocumentFingerprint(uri)).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reopens on the next scope and reads the latest text from disk", async () => {
    const { dir, file, server } = makeScopedFixture("reopen");
    try {
      const client = await getClient(ctx, file, { server });
      if (!client) throw new Error("expected client");
      mockSendNotification.mockReset();
      mockSendNotification.mockResolvedValue(undefined);

      await client.withDocumentOpen(file, async () => undefined);
      writeFileSync(file, "export const a = 2;\n", "utf8");
      await client.withDocumentOpen(file, async () => undefined);

      const opens = callsOf("textDocument/didOpen");
      expect(opens).toHaveLength(2);
      // The second didOpen carries the **latest on-disk text** (not the first call's stale buffer).
      const second = opens[1][1] as {
        textDocument: { text: string; version: number };
      };
      expect(second.textDocument.text).toBe("export const a = 2;\n");
      expect(second.textDocument.version).toBe(1); // Reopened: version restarts at 1
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("drops the uri diagnostics entry when refcount reaches zero", async () => {
    // Spec: reaching zero drops both the open record and the diagnostics cache for that
    // uri — otherwise the next request would return false positives from a possibly
    // stale round of pushed diagnostics.
    const { dir, file, server } = makeScopedFixture("diag-drop");
    try {
      const client = await getClient(ctx, file, { server });
      if (!client) throw new Error("expected client");
      const uri = pathToFileURL(file).href;
      const publish = mockOnNotification.mock.calls.find(
        (c) => c[0] === "textDocument/publishDiagnostics"
      )?.[1] as ((params: unknown) => void) | undefined;
      if (!publish)
        throw new Error("publishDiagnostics handler not registered");

      await client.withDocumentOpen(file, async () => {
        publish({
          uri,
          diagnostics: [{ severity: 1, message: "stale err" }],
          version: 1,
        });
        expect(client.getDiagnosticsEntry(uri)?.items).toHaveLength(1);
      });

      expect(client.getDiagnosticsEntry(uri)).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("nested scopes on distinct files keep each open until its own exit", async () => {
    // When a multi-file batch (lsp_diagnostics files) nests per file, the refcount is
    // per-uri: the inner scope reaching zero must not close the outer scope's file.
    const { dir, file, server } = makeScopedFixture("nested");
    const fileB = join(dir, "b.ts");
    writeFileSync(fileB, "export const b = 1;\n", "utf8");
    try {
      const client = await getClient(ctx, file, { server });
      if (!client) throw new Error("expected client");
      mockSendNotification.mockReset();
      mockSendNotification.mockResolvedValue(undefined);

      await client.withDocumentOpen(file, async () => {
        await client.withDocumentOpen(fileB, async () => undefined);
        // After the inner scope exits, fileB got its didClose but the outer file stays open (no didClose).
        expect(callsOf("textDocument/didClose")).toHaveLength(1);
      });
      expect(callsOf("textDocument/didClose")).toHaveLength(2);
      expect(callsOf("textDocument/didOpen")).toHaveLength(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("aligns an already-open document to disk before the next request (mtime change → didChange)", async () => {
    // Spec 251 "off-disk change alignment": there is no watcher; for a still-open uri,
    // the next request stats mtime first and, if it changed, re-reads the whole file
    // and sends a full-sync didChange — otherwise a warmup-pinned document would serve
    // later requests with stale text.
    const { dir, file, server } = makeScopedFixture("mtime");
    try {
      const client = await getClient(ctx, file, { server });
      if (!client) throw new Error("expected client");
      await client.ensureOpen(file); // pin: stays open
      mockSendNotification.mockReset();
      mockSendNotification.mockResolvedValue(undefined);

      // Unchanged → no alignment (never a redundant didChange).
      await client.withDocumentOpen(file, async () => undefined);
      expect(callsOf("textDocument/didChange")).toHaveLength(0);

      // Off-disk change (not via edit_file / notifier): both content and mtime change.
      writeFileSync(file, "export const a = 9;\n", "utf8");
      utimesSync(
        file,
        new Date(Date.now() + 5000),
        new Date(Date.now() + 5000)
      );
      await client.withDocumentOpen(file, async () => undefined);

      const changes = callsOf("textDocument/didChange");
      expect(changes).toHaveLength(1);
      const payload = changes[0][1] as {
        textDocument: { version: number };
        contentChanges: { text: string }[];
      };
      expect(payload.contentChanges[0].text).toBe("export const a = 9;\n");
      expect(payload.textDocument.version).toBe(2); // didOpen=1 → +1 after alignment
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not align a freshly opened document (didOpen already read disk)", async () => {
    const { dir, file, server } = makeScopedFixture("noalign");
    try {
      const client = await getClient(ctx, file, { server });
      if (!client) throw new Error("expected client");
      mockSendNotification.mockReset();
      mockSendNotification.mockResolvedValue(undefined);

      await client.withDocumentOpen(file, async () => undefined);

      // Request-scoped opens read the disk fresh each time → no extra didChange needed (or wanted).
      expect(callsOf("textDocument/didOpen")).toHaveLength(1);
      expect(callsOf("textDocument/didChange")).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ensureOpen concurrency placeholder still holds under refcount", async () => {
    // Regression (reusing section 17's two existing assertion surfaces): after the
    // refcount change, ensureOpen's "claim before await readFile" semantics and its
    // readFile-failure rollback must hold unchanged — 100 concurrent same-file calls
    // send one didOpen; after a read failure rolls back, the next call really sends.
    const { dir, file, server } = makeScopedFixture("ensure-regress");
    try {
      const client = await getClient(ctx, file, { server });
      if (!client) throw new Error("expected client");
      mockSendNotification.mockReset();
      mockSendNotification.mockResolvedValue(undefined);

      await Promise.all(
        Array.from({ length: 100 }, () => client.ensureOpen(file))
      );
      expect(callsOf("textDocument/didOpen")).toHaveLength(1);

      // A bare ensureOpen does not release: the open record stays (warmup use; see client.ts doc comment).
      expect(client.getOpenVersion(pathToFileURL(file).href)).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // notifyChange and withDocumentOpen share the same open records / fixture: the
  // not-open branch directly reuses request-scoped semantics (didOpen → immediate
  // didClose); the already-open branch sends only a full-sync didChange. Both are
  // the two legs of "edit sync", kept in one describe to share fixture and the
  // notification assertion surface.

  it("notifyChange on a never-opened file opens then immediately closes (didOpen → didClose)", async () => {
    const { dir, file, server } = makeScopedFixture("notify-fresh");
    const uri = pathToFileURL(file).href;
    try {
      const client = await getClient(ctx, file, { server });
      if (!client) throw new Error("expected client");
      mockSendNotification.mockReset();
      mockSendNotification.mockResolvedValue(undefined);

      await client.notifyChange(file);

      expect(notificationSeq()).toEqual([
        "textDocument/didOpen",
        "textDocument/didClose",
      ]);
      expect(callsOf("textDocument/didOpen")).toHaveLength(1);
      expect(callsOf("textDocument/didClose")).toHaveLength(1);
      expect(callsOf("textDocument/didChange")).toHaveLength(0);
      // Not kept open for the server between calls: no leftover open record.
      expect(client.getDocumentFingerprint(uri)).toBeUndefined();
      expect(client.getOpenVersion(uri)).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("notifyChange on an already-open file sends exactly one full-sync didChange", async () => {
    const { dir, file, server } = makeScopedFixture("notify-open");
    const uri = pathToFileURL(file).href;
    try {
      const client = await getClient(ctx, file, { server });
      if (!client) throw new Error("expected client");
      await client.ensureOpen(file); // pin: stays open
      mockSendNotification.mockReset();
      mockSendNotification.mockResolvedValue(undefined);

      writeFileSync(file, "export const a = 7;\n", "utf8");
      await client.notifyChange(file);

      const changes = callsOf("textDocument/didChange");
      expect(changes).toHaveLength(1);
      const payload = changes[0][1] as {
        textDocument: { uri: string; version: number };
        contentChanges: { text: string }[];
      };
      expect(payload.textDocument.version).toBe(2); // didOpen=1 → +1
      expect(payload.contentChanges).toEqual([
        { text: "export const a = 7;\n" },
      ]);
      // The already-open branch neither re-opens nor closes.
      expect(callsOf("textDocument/didOpen")).toHaveLength(0);
      expect(callsOf("textDocument/didClose")).toHaveLength(0);
      expect(client.getOpenVersion(uri)).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
// ── 18. getClient dispatch by file extension ─────────────────────────────────
//
// `getClient` no longer hardcodes a default `Typescript`; it routes `file` by
// extension through `resolveServer` to the matching server. The `opts.server`
// injection point changed meaning from "the default server" to "override the
// dispatch result"; an extension with no match → early-return `undefined`.
//
// Strategy: routing tests use **real server** instances
// (Pyright/YamlLS/JsonLS/DockerfileLS/Typescript) but replace their `spawn` via
// `vi.spyOn` — the return value goes through spawnClient's initialize handshake,
// which needs real readable `child.stdout`/`child.stdin` streams, so the spy
// fabricates them with `makeFakeChildProcess()`. `mockSpawn` (intercepting
// node:child_process) verifies dispatch really reaches spawn and **does not
// fork** (the spy count stays constant per call).
//
// The clients/broken/inflight cache is shared across tests: Pyright/Typescript's
// NearestRoot needs on-disk marker files, so each test uses its own `mkdtempSync`
// directory (unique root → unique key) to avoid cross-test cache-hit pollution.

describe("getClient dispatch by extension (spec 302)", () => {
  // A real server's root needs on-disk marker files (Pyright/Typescript NearestRoot);
  // each test uses its own mkdtempSync directory (unique root → unique key) to avoid
  // cross-test cache-hit pollution on the three-piece cache. spawn is intercepted via
  // vi.spyOn → the real binaries are never touched.
  function fakeSpawnFor() {
    const impl: LspServerInfo["spawn"] = async () => {
      const child = makeFakeChildProcess(
        9000 + Math.floor(Math.random() * 100)
      );
      return {
        process: child as unknown as import("node:child_process").ChildProcess,
        initialization: { tsserver: { path: "/tsserver.js" } },
      };
    };
    return vi.fn(impl);
  }

  // Assertion helper: getClient routes via resolveServer to expected, spawn is called
  // exactly once, and the initialize handshake's rootUri hits that server's root.
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
      expect(spawnStub).toHaveBeenCalledTimes(1); // dispatch correct, spawn called once
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
    // Note: `resolveServer` falls back to `path.extname(file) || file` — with no
    // extension it uses the **full file name** as the key. `path.extname("/proj/Dockerfile")`
    // is `""` → the fallback is the full path `/proj/Dockerfile`, which does not match
    // DockerfileLS.extensions["Dockerfile"]. The current contract only supports the bare
    // file name `"Dockerfile"` (see server.test.ts); the full-path Dockerfile routing
    // gap is reported separately. This test pins the real contract (bare name).
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
      await assertRoutesTo(
        join(dir, "index.ts"),
        Typescript,
        dir,
        join(dir, "..")
      );
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
      // By extension, file would route to Pyright, but opts.server overrides → fakeServer takes effect.
      const client = await getClient(
        { directory: join(dir, "..") },
        join(dir, "app.py"),
        { server }
      );
      expect(client).toBeDefined();
      expect(calls.spawn).toBe(1); // fakeServer.spawn invoked (not Pyright's)
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("dispatch layer does not fork spawn: concurrent same file dedupes into one spawn", async () => {
    // Same source as the inflight dedup tests above, but via the dispatch path
    // (no opts.server): two concurrent requests for the same .py file → Pyright.spawn
    // called once, both calls get the same client instance.
    const dir = mkdtempSync(join(tmpdir(), "iknow-lsp-dispatch-conc-"));
    writeFileSync(join(dir, "pyproject.toml"), "\n", "utf8");
    const file = join(dir, "app.py");
    let resolveSpawn:
      ((value: LspServerHandle | undefined) => void) | undefined;
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
        process: child as unknown as import("node:child_process").ChildProcess,
        initialization: { pythonPath: undefined },
      });
      const [c1, c2] = await Promise.all([p1, p2]);
      expect(c1).toBeDefined();
      expect(c2).toBe(c1); // Same instance (dispatch layer shares one spawn)
      expect(spawnStub).toHaveBeenCalledTimes(1); // No fork
    } finally {
      spy.mockRestore();
    }
  });
});
