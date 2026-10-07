/**
 * Startup failure identity: server identity + typed stage + retained cause
 * (plan T5 behaviors 2–4; T1 evidence Finding 3: the result named the server
 * but not the failing stage, not the cause, and dropped the server's stderr).
 *
 * Only the JSON-RPC transport is stubbed (the external boundary under test is
 * the real `spawnClient` state machine); the fakes are ordinary EventEmitters,
 * so the `exit` / `error` / stderr paths run for real.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  LspCtx,
  LspServerHandle,
  LspServerInfo,
} from "../../../src/harness/lsp/types.ts";

const {
  mockSendRequest,
  mockSendNotification,
  mockOnNotification,
  mockCreateConnection,
} = vi.hoisted(() => ({
  mockSendRequest: vi.fn(),
  mockSendNotification: vi.fn(),
  mockOnNotification: vi.fn(),
  mockCreateConnection: vi.fn(() => ({
    sendRequest: mockSendRequest,
    sendNotification: mockSendNotification,
    onRequest: vi.fn(),
    onNotification: mockOnNotification,
    listen: vi.fn(),
    dispose: vi.fn(),
  })),
}));

vi.mock("vscode-jsonrpc/node", async (importOriginal) => {
  const actual = await importOriginal<typeof import("vscode-jsonrpc/node")>();
  return {
    ...actual,
    createMessageConnection: () => mockCreateConnection(),
  };
});

import {
  MAX_LSP_RECOVERY_ATTEMPTS,
  createLspClientPool,
  getClientDetailed,
  isMethodNotFoundError,
  retryFailedLspStart,
} from "../../../src/harness/lsp/client.ts";

const tmpDirs: string[] = [];

function makeSandbox(): string {
  const dir = mkdtempSync(join(tmpdir(), "lsp-startfail-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  mockSendRequest.mockReset();
  while (tmpDirs.length > 0) {
    rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

/** A child process double with real stdio pipes and real exit/error events. */
function makeChild(pid = 4242) {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    pid,
    kill: vi.fn(() => true),
  });
  return child;
}

interface FakeServerOpts {
  spawn?: (root: string) => Promise<LspServerHandle | undefined>;
  executableCandidates?: (root: string) => readonly string[];
}

function makeFakeServer(id: string, opts: FakeServerOpts = {}): LspServerInfo {
  return {
    id,
    root: async () => "/root",
    extensions: [".ts"],
    spawn: async (root: string) => {
      if (opts.spawn) return opts.spawn(root);
      return { process: makeChild() as never, initialization: {} };
    },
    ...(opts.executableCandidates
      ? {
          executableCandidates: async (root: string) =>
            opts.executableCandidates!(root),
        }
      : {}),
  };
}

const ctxWithPool = (pool: ReturnType<typeof createLspClientPool>): LspCtx => ({
  directory: "/work",
  pool,
});

describe("startup failure carries server identity, stage and cause", () => {
  it("executable resolution failure: stage + serverId + cause", async () => {
    const pool = createLspClientPool();
    const server = makeFakeServer("nores-bin", {
      spawn: async () => undefined,
    });

    const { failure } = await getClientDetailed(
      ctxWithPool(pool),
      "/root/a.ts",
      { server }
    );

    expect(failure?.serverId).toBe("nores-bin");
    expect(failure?.reason).toBe("spawn-failed");
    expect(failure?.stage).toBe("executable-resolution");
    expect(failure?.cause).toContain("nores-bin");
  });

  it("initialization failure: the initialize rejection is retained as the cause", async () => {
    const pool = createLspClientPool();
    const child = makeChild();
    mockSendRequest.mockRejectedValue(new Error("handshake refused by server"));
    const server = makeFakeServer("initfail", {
      spawn: async () => ({ process: child as never, initialization: {} }),
    });

    const { failure } = await getClientDetailed(
      ctxWithPool(pool),
      "/root/a.ts",
      { server }
    );

    expect(failure?.stage).toBe("initialization");
    expect(failure?.cause).toContain("handshake refused by server");
    // A failed start must not leave the child running.
    expect(child.kill).toHaveBeenCalled();
  });

  it("process exit before initialization completes: stage process-exit + stderr evidence", async () => {
    const pool = createLspClientPool();
    const child = makeChild();
    const server = makeFakeServer("exitfail", {
      spawn: async () => ({ process: child as never, initialization: {} }),
    });
    // initialize never answers; the child dies with stderr evidence instead.
    mockSendRequest.mockImplementation(
      () =>
        new Promise((resolve) => {
          child.stderr.write("Fatal: could not locate tsserver.js\n");
          setImmediate(() => child.emit("exit", 1, null));
          void resolve;
        })
    );

    const { failure } = await getClientDetailed(
      ctxWithPool(pool),
      "/root/a.ts",
      { server }
    );

    expect(failure?.stage).toBe("process-exit");
    expect(failure?.cause).toContain("could not locate tsserver.js");
  });

  it("spawn error (ENOENT) is distinguishable from initialization failure", async () => {
    const pool = createLspClientPool();
    const child = makeChild();
    const server = makeFakeServer("spawnfail", {
      spawn: async () => ({ process: child as never, initialization: {} }),
    });
    mockSendRequest.mockImplementation(
      () =>
        new Promise((resolve) => {
          setImmediate(() => child.emit("error", new Error("spawn ENOENT")));
          void resolve;
        })
    );

    const { failure } = await getClientDetailed(
      ctxWithPool(pool),
      "/root/a.ts",
      { server }
    );

    expect(failure?.stage).toBe("process-spawn");
    expect(failure?.cause).toContain("spawn ENOENT");
  });

  it("missing stdio is reported as a spawn-stage failure, not silently undefined", async () => {
    const pool = createLspClientPool();
    const child = Object.assign(new EventEmitter(), {
      stdin: null,
      stdout: null,
      stderr: null,
      pid: 7,
      kill: vi.fn(() => true),
    });
    const server = makeFakeServer("nostdio", {
      spawn: async () => ({ process: child as never, initialization: {} }),
    });

    const { failure } = await getClientDetailed(
      ctxWithPool(pool),
      "/root/a.ts",
      { server }
    );

    expect(failure?.stage).toBe("process-spawn");
    expect(failure?.cause).toContain("stdio");
  });

  it("retained stderr is bounded (a flood cannot grow the failure record)", async () => {
    const pool = createLspClientPool();
    const child = makeChild();
    const server = makeFakeServer("stderrflood", {
      spawn: async () => ({ process: child as never, initialization: {} }),
    });
    mockSendRequest.mockImplementation(
      () =>
        new Promise((resolve) => {
          child.stderr.write("x".repeat(200_000));
          setImmediate(() => child.emit("exit", 1, null));
          void resolve;
        })
    );

    const { failure } = await getClientDetailed(
      ctxWithPool(pool),
      "/root/a.ts",
      { server }
    );

    expect(failure?.stage).toBe("process-exit");
    expect((failure?.cause ?? "").length).toBeLessThan(2000);
  });

  it("selection failures carry a stage too (no-server / no-root)", async () => {
    const pool = createLspClientPool();
    const noServer = await getClientDetailed(
      ctxWithPool(pool),
      "/root/readme.md"
    );
    expect(noServer.failure?.stage).toBe("server-selection");

    const noRoot = await getClientDetailed(ctxWithPool(pool), "/root/a.ts", {
      server: makeFakeServer("noroot", {
        spawn: async () => ({
          process: makeChild() as never,
          initialization: {},
        }),
      }),
    });
    void noRoot;
    const rootless = makeFakeServer("rootless", {
      spawn: async () => undefined,
    });
    const byRoot = await getClientDetailed(ctxWithPool(pool), "/root/a.ts", {
      server: { ...rootless, root: async () => undefined },
    });
    expect(byRoot.failure?.stage).toBe("server-selection");
    expect(byRoot.failure?.serverId).toBe("rootless");
  });
});

describe("unsupported method stays a capability result", () => {
  it("MethodNotFound is not a startup failure and leaves failure memory untouched", async () => {
    const pool = createLspClientPool();
    mockSendRequest.mockResolvedValue({ capabilities: {} });
    const server = makeFakeServer("capability");
    const { client } = await getClientDetailed(
      ctxWithPool(pool),
      "/root/a.ts",
      { server }
    );
    expect(client).toBeDefined();

    const err = Object.assign(new Error("Unhandled method workspace/symbol"), {
      code: -32601,
    });
    mockSendRequest.mockRejectedValue(err);
    await expect(
      client!.sendRequest("workspace/symbol", { query: "x" })
    ).rejects.toBe(err);

    expect(isMethodNotFoundError(err)).toBe(true);
    // A capability gap must not mark the server broken nor latch the pool.
    expect(pool.broken.size).toBe(0);
    expect(pool.shutDown).toBe(false);
    expect(client!.getServerCapabilities()).toEqual({});
  });
});

describe("bounded, non-terminal recovery after an install or repair", () => {
  it("a failed start can be retried in the same session once the install lands", async () => {
    const pool = createLspClientPool();
    let installed = false;
    const server = makeFakeServer("recoverable", {
      spawn: async () =>
        installed
          ? { process: makeChild() as never, initialization: {} }
          : undefined,
    });
    const ctx = ctxWithPool(pool);

    const failed = await getClientDetailed(ctx, "/root/a.ts", { server });
    expect(failed.failure?.stage).toBe("executable-resolution");

    // The approved install completes: the executable becomes resolvable.
    installed = true;
    expect(
      retryFailedLspStart(ctx, { root: "/root", serverId: "recoverable" })
    ).toBe(true);

    const recovered = await getClientDetailed(ctx, "/root/b.ts", { server });
    expect(recovered.client).toBeDefined();
    expect(recovered.failure).toBeUndefined();
  });

  it("retry attempts are bounded — an unrepaired install cannot spin", async () => {
    const pool = createLspClientPool();
    const server = makeFakeServer("still-broken", {
      spawn: async () => undefined,
    });
    const ctx = ctxWithPool(pool);

    await getClientDetailed(ctx, "/root/a.ts", { server });
    for (let i = 0; i < MAX_LSP_RECOVERY_ATTEMPTS + 3; i++) {
      expect(
        retryFailedLspStart(ctx, { root: "/root", serverId: "still-broken" })
      ).toBe(i < MAX_LSP_RECOVERY_ATTEMPTS);
      await getClientDetailed(ctx, "/root/a.ts", { server });
    }

    // Exhausted: the key stays broken and no further spawn happens.
    const last = await getClientDetailed(ctx, "/root/a.ts", { server });
    expect(last.failure?.stage).toBe("executable-resolution");
    expect(pool.broken.size).toBe(1);
  });

  it("recovery is not terminal: the pool latch stays off and other keys keep working", async () => {
    const pool = createLspClientPool();
    const broken = makeFakeServer("key-a", { spawn: async () => undefined });
    const healthy = makeFakeServer("key-b");
    const ctx = ctxWithPool(pool);

    await getClientDetailed(ctx, "/root/a.ts", { server: broken });
    retryFailedLspStart(ctx, { root: "/root", serverId: "key-a" });

    expect(pool.shutDown).toBe(false);
    const ok = await getClientDetailed(ctx, "/root/b.ts", { server: healthy });
    expect(ok.client).toBeDefined();
    // No terminal path was taken: a shutDown pool would answer spawn-failed for
    // every key, including the healthy one.
    expect(pool.shutDown).toBe(false);
  });

  it("recovery on a key that never failed is a no-op (no budget spent)", async () => {
    const pool = createLspClientPool();
    const ctx = ctxWithPool(pool);

    expect(retryFailedLspStart(ctx, { root: "/nope", serverId: "ghost" })).toBe(
      false
    );
  });

  it("an install that makes the project executable appear recovers on the next call", async () => {
    const root = makeSandbox();
    const executable = join(root, "node_modules", ".bin", "late-server");
    const pool = createLspClientPool();
    const server = makeFakeServer("late", {
      spawn: async () => undefined,
      executableCandidates: () => [executable],
    });
    const ctx = ctxWithPool(pool);

    const before = await getClientDetailed(ctx, "/root/a.ts", { server });
    expect(before.failure?.stage).toBe("executable-resolution");
    expect(existsSync(executable)).toBe(false);

    // The install completes between calls; no explicit retry call is needed.
    mkdirSync(join(root, "node_modules", ".bin"), { recursive: true });
    writeFileSync(executable, "#!/bin/sh\nexit 0\n");
    const serverInstalled: LspServerInfo = {
      ...server,
      spawn: async () => ({
        process: makeChild() as never,
        initialization: {},
      }),
    };

    const after = await getClientDetailed(ctx, "/root/b.ts", {
      server: serverInstalled,
    });
    expect(after.client).toBeDefined();
  });
});
