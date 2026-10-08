/**
 * LSP `LspCtx.directory` follows the live `taskRoot` cell across worktree
 * rebind.
 *
 * Acceptance:
 *   1. `LspCtx.directory` is read at call time, not captured at build time —
 *      `NearestRoot` upper-bound moves with rebind (symbol tools can reach the
 *      new tree, cannot reach files outside the active root).
 *   2. After rebind, old-root LSP clients are explicitly disposed — no
 *      lingering spawned server processes (no leak) and no reuse of the
 *      old client (so a request after rebind never lands a write in the
 *      old tree).
 *
 * The directory snapshot is taken once per `getClient` call, mirroring
 * the batch-snapshot discipline: one tool call → one root value.
 *
 * Test strategy: stub `node:child_process` `spawn` so we can intercept
 * how `client.ts` invokes the LSP server. Two temporary roots simulate
 * old (main) and new (rebound) task worktrees; rebind writes the live
 * cell, then we assert the pool key for the old client is gone and the
 * new root gets a fresh client.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
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

// ── vscode-jsonrpc/node stand-in ─────────────────────────────────────────────
//
// Capture the connection factory via vi.hoisted so vi.mock never sees an
// uninitialized `createMessageConnection` reference.

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
      mockCreateConnection(...(args as [])),
  };
});

// ── server dispatch stand-in (tool-layer tests only) ─────────────────────────
//
// The tool layer dispatches by `resolveServer(file)`; without this mock a
// relative `.ts` input would reach the REAL Typescript declaration and spawn a
// real typescript-language-server process (the connection mock never wires the
// child's streams, so the process would leak). The ref stays undefined except
// inside the T1 describe, and the existing tests are unaffected: they inject
// `{ server }` explicitly, so `resolveServer` is never consulted by them.

const { fakeServerRef } = vi.hoisted(() => ({
  fakeServerRef: {
    current: undefined as
      import("../../../src/harness/lsp/types.ts").LspServerInfo | undefined,
  },
}));

vi.mock("../../../src/harness/lsp/server.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../src/harness/lsp/server.js")>();
  return {
    ...actual,
    resolveServer: (file: string) =>
      fakeServerRef.current ?? actual.resolveServer(file),
  };
});

// ── dynamic import must happen after the mock is installed ───────────────────

const { getClient } = await import("../../../src/harness/lsp/client.ts");

// ── fake child + fake server factories ─────────────────────────────────────────

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
      // Same shape as the real NearestRoot: ctx.directory is the upper-bound stop.
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

// ── temp directory management ────────────────────────────────────────────────

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
    // Two independent taskRoots (main repo vs rebound task worktree), each
    // holding one .ts file; NearestRoot returns `directory` itself for the
    // (file, directory) shape (same boundary as YamlLS / JsonLS ctx.directory).
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
    // Mirrors build-engine: lspCtx.directory derives from cell.read(), and
    // LspClientPool + getClient read the cell at entry. Each case uses its
    // own pool so the module-level defaultPool's lastSeenTaskRoot cannot
    // drift across cases.
    const pool: LspClientPool = createLspClientPool();
    const ctx: LspCtx = {
      directory: cell.read(),
      directoryCell: cell,
      pool,
    };

    // 1. Old root: getClient obtains a client while ctx.directory = oldDir.
    const c1 = await getClient(ctx, oldFile, { server });
    expect(c1).toBeDefined();
    expect(spawnCalls).toEqual([{ root: oldDir }]);

    // 2. Flip the cell to the new root (simulates host `provision` returning OK).
    writeLiveTaskRoot(cell, newDir);

    // 3. getClient with the new file: ctx.directory must already be newDir,
    //    otherwise NearestRoot's upper-bound stop is still oldDir → files in
    //    newDir count as outside → no-root.
    const c2 = await getClient(ctx, newFile, { server });
    expect(c2).toBeDefined();
    // Old key (oldDir) and new key (newDir) don't overlap → the pool must
    // spawn again, with newDir as root (proving ctx.directory followed the
    // cell's current value).
    expect(spawnCalls.length).toBeGreaterThanOrEqual(2);
    expect(spawnCalls.at(-1)?.root).toBe(newDir);
    // New client ≠ old client (fresh instance under the new key, no reuse).
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

    // Trigger getClient on the new root — the old client must be terminated.
    await getClient(ctx, newFile, { server });

    // Assert: connection released first + child process SIGTERM. Closing the
    // connection alone leaves stdio pipe handles behind, so dispose()-only
    // would keep the old server alive until host exit — the pool's reclaim
    // seam is responsible for doing both.
    expect(mockDispose).toHaveBeenCalled();
    expect(vi.mocked(oldClient.process.kill)).toHaveBeenCalledWith("SIGTERM");
    // The pool no longer holds the old key: a later call on the same root
    // must re-spawn, never reuse the terminated instance.
    expect(pool.clients.has(`${oldDir}:live-dir-leak`)).toBe(false);

    // Old client evicted from the pool; calling again with oldDir must
    // re-spawn (no reuse of the dead instance) and trigger no dispose.
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
    // Dispatch TS only — the yaml old-root client must still be reclaimed,
    // not skipped for "not hit this time": after rebind lastSeenTaskRoot is
    // already updated, so filtering by serverId here would never find it.
    await getClient(ctx, newTs, { server: tsServer });

    expect(vi.mocked(yamlClient!.process.kill)).toHaveBeenCalledWith("SIGTERM");
    expect(vi.mocked(tsClient!.process.kill)).toHaveBeenCalledWith("SIGTERM");
    expect(pool.clients.has(`${oldDir}:multi-yaml`)).toBe(false);
    expect(pool.clients.has(`${oldDir}:multi-ts`)).toBe(false);
    expect(pool.clients.has(`${newDir}:multi-ts`)).toBe(true);
  });

  it("before rebind, behavior is byte-identical to a frozen-directory ctx (legacy parity)", async () => {
    // Guard: while the gate has not flipped (no rebind), behavior is
    // byte-identical to a frozen directory. This assertion does not depend
    // on the live cell; it only compares plain-string directory vs cell-backed.
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

    // cell-backed ctx with same initial value: spawns once too, reused under the same key
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
    // Repeat call under the same key → same client reused, no new spawn.
    const cellClient2 = await getClient(cellCtx, file, { server: cellServer });
    expect(cellClient2).toBe(cellClient);
    expect(cellSpawns).toHaveLength(1);
  });
});

// ── T1: one active-root snapshot per tool entry ──────────────────────────────
//
// After a worktree rebind, a RELATIVE file input must resolve under the live
// cell's CURRENT value (the active tree), and that one resolved path must
// drive root finding, the request URI, and the document open. The tool layer
// is exercised end to end here: a fake server declaration (via the resolveServer
// mock above) is dispatched by extension, the real client.ts spawns against the
// fake child, and the vscode-jsonrpc connection mock records the didOpen
// notification and the request params. Real temp trees hold per-tree unique
// file bytes, so the assertions identify the ACTIVE tree, not a stub.
describe("T1: resolve input paths from one active-root snapshot", () => {
  const spawnCalls: { root: string }[] = [];

  function makeTree(dir: string, marker: string): string {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package-lock.json"), "{}\n", "utf8");
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "a.ts"), marker, "utf8");
    return join(dir, "src", "a.ts");
  }

  function fakeTsServer(): LspServerInfo {
    return makeFakeServer({
      id: "t1-fake-ts",
      rootFor: (_file, directory) => directory,
      spawnCalls,
    });
  }

  afterEach(() => {
    fakeServerRef.current = undefined;
    spawnCalls.length = 0;
  });

  it("resolveInputFile resolves a relative path against the live cell snapshot", async () => {
    const { resolveInputFile } =
      await import("../../../src/harness/aci/tools/lsp.ts");
    const oldDir = freshDir("iknow-lsp-t1-old-");
    const newDir = freshDir("iknow-lsp-t1-new-");
    const cell: LiveTaskRoot = createLiveTaskRoot(oldDir);
    const ctx: LspCtx = { directory: oldDir, directoryCell: cell };

    // Before rebind: relative input lands under the old tree.
    expect(resolveInputFile(ctx, "src/a.ts")).toBe(join(oldDir, "src/a.ts"));
    // After rebind: the SAME input lands under the new tree.
    writeLiveTaskRoot(cell, newDir);
    expect(resolveInputFile(ctx, "src/a.ts")).toBe(join(newDir, "src/a.ts"));
    // An absolute path is normalized, not re-anchored.
    expect(resolveInputFile(ctx, join(newDir, "src", "..", "a.ts"))).toBe(
      join(newDir, "a.ts")
    );
    // Undecidable / home-alias inputs pass through raw: the read policy owns
    // their denial, and rewriting them would change the rendered denial text.
    expect(resolveInputFile(ctx, "")).toBe("");
    expect(resolveInputFile(ctx, "  ")).toBe("  ");
    expect(resolveInputFile(ctx, "~/.ssh/id_rsa")).toBe("~/.ssh/id_rsa");
    expect(resolveInputFile(ctx, "~/notes.ts")).toBe("~/notes.ts");
    // Frozen ctx (no cell): snapshot equals ctx.directory.
    expect(resolveInputFile({ directory: oldDir }, "src/a.ts")).toBe(
      join(oldDir, "src/a.ts")
    );
  });

  it("after a cell rebind, a relative path reaches the NEW tree (uri, didOpen text, spawn root)", async () => {
    const oldDir = freshDir("iknow-lsp-t1-tool-old-");
    const newDir = freshDir("iknow-lsp-t1-tool-new-");
    // Same relative path in both trees, different unique bytes per tree.
    const oldFile = makeTree(oldDir, "export const uniqueOldMarker = 1;\n");
    const newFile = makeTree(newDir, "export const uniqueNewMarker = 2;\n");
    const oldBytes = readFileSync(oldFile, "utf8");
    const newBytes = readFileSync(newFile, "utf8");
    expect(oldBytes).not.toBe(newBytes);

    const server = fakeTsServer();
    fakeServerRef.current = server;

    // The stub server answers per request URI: whichever tree's file the
    // request names, that tree's symbol payload comes back — so a pass here
    // proves the query ran against the active tree, not a stub echo.
    mockSendRequest.mockImplementation((method: string, params: unknown) => {
      if (method === "initialize") return { capabilities: {} };
      const uri = (params as { textDocument?: { uri?: string } } | undefined)
        ?.textDocument?.uri;
      if (uri === pathToFileURL(oldFile).href) return { symbols: "from-old" };
      if (uri === pathToFileURL(newFile).href) return { symbols: "from-new" };
      return { symbols: "from-nowhere" };
    });

    const { createLspToolSet, resolveInputFile } =
      await import("../../../src/harness/aci/tools/lsp.ts");

    const cell: LiveTaskRoot = createLiveTaskRoot(oldDir);
    const pool: LspClientPool = createLspClientPool();
    const ctx: LspCtx = {
      directory: cell.read(),
      directoryCell: cell,
      pool,
    };
    const tools = createLspToolSet(ctx);
    const docSymbol = tools.find((t) => t.name === "lsp_document_symbol");
    if (!docSymbol) throw new Error("tool not found: lsp_document_symbol");

    // Request BEFORE rebind: the old tree is the active tree.
    const outOld = (await docSymbol.handler({
      file: "src/a.ts",
    })) as string;
    expect(JSON.parse(outOld)).toEqual({ symbols: "from-old" });

    // Rebind, then the SAME relative input again.
    writeLiveTaskRoot(cell, newDir);
    const outNew = (await docSymbol.handler({
      file: "src/a.ts",
    })) as string;

    // 1. The response identifies the active (new) tree.
    expect(JSON.parse(outNew)).toEqual({ symbols: "from-new" });

    // 2. The request URI targets the new tree's file.
    const uriCalls = mockSendRequest.mock.calls.filter(
      (call) => call[0] === "textDocument/documentSymbol"
    );
    const lastUri = (
      uriCalls.at(-1)?.[1] as { textDocument?: { uri?: string } } | undefined
    )?.textDocument?.uri;
    expect(lastUri).toBe(pathToFileURL(newFile).href);

    // 3. The didOpen notification carried the new tree's bytes.
    const didOpens = mockSendNotification.mock.calls.filter(
      (call) => call[0] === "textDocument/didOpen"
    );
    const lastDidOpen = didOpens.at(-1)?.[1] as
      { textDocument?: { uri?: string; text?: string } } | undefined;
    expect(lastDidOpen?.textDocument?.uri).toBe(pathToFileURL(newFile).href);
    expect(lastDidOpen?.textDocument?.text).toBe(newBytes);

    // 4. Root finding ran against the live snapshot: the last spawn is the
    //    new root (the rebind sweep reclaimed the old client).
    expect(spawnCalls.at(-1)?.root).toBe(newDir);

    // 5. The old tree's bytes are untouched (read-only path).
    expect(readFileSync(oldFile, "utf8")).toBe(oldBytes);
    expect(resolveInputFile(ctx, "src/a.ts")).toBe(join(newDir, "src/a.ts"));
  });
});
