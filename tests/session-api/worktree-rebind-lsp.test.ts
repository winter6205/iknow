/**
 * T3 (plans/lsp-worktree-paths.md) — host rebinds and repeated switches driven
 * through the PRODUCTION host/session seam, with stub language servers.
 *
 * The real-server half of T3 lives in `tests/harness/lsp/rebind-real-server.test.ts`
 * (real typescript-language-server + pyright answering real requests). This file
 * pins the TRANSITION MATRIX deterministically, because a real-server-only
 * matrix cannot distinguish "the sweep ran" from "the timing happened to be
 * lucky", and a stub-only matrix cannot prove a server ever answered.
 *
 * What is real here (nothing about the seam under test is faked):
 *   - a disposable temp Git repository with real `git worktree add` / `remove`
 *     operations driven by `createTaskWorktreeProvisioner`;
 *   - the production seam wrapper (`withLiveTaskRootWrite` around
 *     provision / enter / exit) exactly as `build-engine.ts:1304-1319` wires it;
 *   - `LspClientPool` + `getClientDetailed` with the real `resolveDirectorySnapshot`
 *     single-cell read and the real `NearestRoot` root finders (taken from the
 *     real `Typescript` / `Pyright` declarations — only `spawn` is replaced);
 *   - per-tree fixture bytes on disk.
 *
 * What is stubbed (only the subprocess): the JSON-RPC connection and the child
 * process. The stub answers `textDocument/documentSymbol` by PARSING THE FILE
 * THE REQUEST NAMES off disk, so a result can only be correct if the request
 * reached the active tree — an echo of the call's own arguments would fail.
 *
 * Pinned here:
 *   1. main → tree A → main → tree B through provision / exit / enter, with
 *      different unique symbols at the same relative path in each tree;
 *   2. the rebind sweep reclaims the stale client (SIGTERM + pool eviction) and
 *      pool keys stay distinct per root (no tree reuses another's project);
 *   3. a concurrent wave issued across the flip uses its captured root
 *      consistently — no client straddles two trees;
 *   4. a second session (own cell + own pool) stays isolated;
 *   5. every pool is disposed and every temp git tree removed in finally /
 *      afterAll paths.
 */
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PassThrough } from "node:stream";

import {
  createLiveTaskRoot,
  withLiveTaskRootWrite,
} from "../../src/harness/session-roots.ts";
import { createTaskWorktreeProvisioner } from "../../src/session-api/worktree-rebind.ts";
import { Pyright, Typescript } from "../../src/harness/lsp/server.ts";
import type { LspServerInfo } from "../../src/harness/lsp/types.ts";

// ── vscode-jsonrpc/node stand-in ─────────────────────────────────────────────
//
// Captured through vi.hoisted so vi.mock never sees an uninitialized
// `createMessageConnection` reference. Same shape as the client-layer tests.

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

// ── client layer must be imported AFTER the mock is installed ─────────────────

const { createLspClientPool, getClientDetailed, resolveDirectorySnapshot } =
  await import("../../src/harness/lsp/client.ts");

// ── stub subprocess (only the process/transport is stubbed) ───────────────────

/** Which tree a spawned child belongs to — proves "no client straddles". */
const spawnRootOf = new WeakMap<object, string>();

function makeFakeChild(pid: number): import("node:child_process").ChildProcess {
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

interface StubServerSet {
  readonly ts: LspServerInfo;
  readonly py: LspServerInfo;
  readonly tsSpawns: { root: string }[];
  readonly pySpawns: { root: string }[];
}

/**
 * Replace ONLY `spawn` on the real server declarations: the `root` finders stay
 * the production `NearestRoot` closures, so root resolution over the real git
 * worktrees is the code under test.
 */
function makeStubServers(nextPid: () => number): StubServerSet {
  const tsSpawns: { root: string }[] = [];
  const pySpawns: { root: string }[] = [];
  return {
    tsSpawns,
    pySpawns,
    ts: {
      id: "stub-ts",
      extensions: Typescript.extensions,
      root: Typescript.root,
      spawn: async (root) => {
        tsSpawns.push({ root });
        const child = makeFakeChild(nextPid());
        spawnRootOf.set(child, root);
        return { process: child, initialization: undefined };
      },
    },
    py: {
      id: "stub-py",
      extensions: Pyright.extensions,
      root: Pyright.root,
      spawn: async (root) => {
        pySpawns.push({ root });
        const child = makeFakeChild(nextPid());
        spawnRootOf.set(child, root);
        return { process: child, initialization: undefined };
      },
    },
  };
}

/**
 * Declared names inside the file the request names, parsed from that file's real
 * bytes on disk. A request that reaches the wrong tree therefore cannot answer
 * with the right names — the stub has no other source of truth.
 */
function declaredNamesOf(uri: string): string[] {
  let file: string;
  try {
    file = fileURLToPath(uri);
  } catch {
    return [];
  }
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  return [...text.matchAll(/\b(?:const|function|def) (\w+)/g)].map(
    (match) => match[1] ?? ""
  );
}

// ── git fixture ──────────────────────────────────────────────────────────────

const tmpRoots: string[] = [];

afterAll(() => {
  for (const dir of tmpRoots.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

/** Per-tree symbols at the SAME relative paths in every tree. */
interface Markers {
  readonly ts: string;
  readonly py: string;
}

const MAIN_MARKERS: Markers = { ts: "main_ts_marker", py: "main_py_marker" };

function tsSource(marker: string): string {
  return `export const ${marker} = 1;\n\nexport function use_${marker}(): number {\n  return ${marker};\n}\n`;
}

function pySource(marker: string): string {
  return `def ${marker}() -> int:\n    return 1\n\n\ndef use_${marker}() -> int:\n    return ${marker}()\n`;
}

/**
 * Write the marker files (and the two root markers `NearestRoot` needs) into
 * `root`. Called once for the main checkout (committed, so every worktree
 * inherits it) and again inside each worktree to plant that tree's own
 * symbols at the same relative path.
 */
function plantTree(root: string, markers: Markers): void {
  mkdirSync(join(root, "src"), { recursive: true });
  // Root markers: package-lock.json (TS) and pyproject.toml (Pyright). No
  // package.json — the provisioner's default project-dep installer then skips
  // with `no_package_json`, so no case shells out to a real `npm ci`.
  writeFileSync(join(root, "package-lock.json"), "{}\n", "utf8");
  writeFileSync(
    join(root, "pyproject.toml"),
    '[project]\nname = "t3"\nversion = "0.0.0"\n'
  );
  writeFileSync(join(root, "src", "unique.ts"), tsSource(markers.ts), "utf8");
  writeFileSync(join(root, "src", "unique.py"), pySource(markers.py), "utf8");
}

function makeGitRepo(markers: Markers = MAIN_MARKERS): string {
  const dir = mkdtempSync(join(tmpdir(), "iknow-t3-rebind-"));
  tmpRoots.push(dir);
  git(dir, "init", "-q");
  writeFileSync(join(dir, ".gitignore"), ".iknow/\n", "utf8");
  plantTree(dir, markers);
  git(dir, "add", "-A");
  git(
    dir,
    "-c",
    "user.email=t@t",
    "-c",
    "user.name=t",
    "commit",
    "-qm",
    "seed"
  );
  return dir;
}

// ── production seam harness ──────────────────────────────────────────────────

let nextPid = 9001;

beforeEach(() => {
  mockSendRequest.mockReset();
  mockSendNotification.mockReset();
  mockListen.mockReset();
  mockDispose.mockReset();
  mockCreateConnection.mockClear();
  mockSendRequest.mockImplementation(
    async (method: string, params: unknown): Promise<unknown> => {
      if (method === "initialize") return { capabilities: {} };
      if (method === "textDocument/documentSymbol") {
        const uri = (params as { textDocument?: { uri?: string } } | undefined)
          ?.textDocument?.uri;
        return { symbols: declaredNamesOf(uri ?? "") };
      }
      return null;
    }
  );
});

afterEach(() => {
  mockSendRequest.mockReset();
});

/**
 * One session wired exactly like `build-engine.ts`: a live task-root cell, the
 * three seams wrapped by `withLiveTaskRootWrite`, and an `LspCtx` whose
 * `directoryCell` is that cell (own pool per session — the production pool is
 * process-level, so per-session isolation is asserted with per-session pools).
 *
 * The bare (unwrapped) provisioner is also returned: tree B is created by a
 * DIFFERENT conversation (`conv-b`), which must not move THIS session's cell —
 * only the session's own wrapped `enter` does that.
 */
function makeSession(repo: string) {
  const cell = createLiveTaskRoot(repo);
  // Hub-mode provisioner (no `store`): the same shape build-engine's isolation
  // host is built from — SessionHub persists the returned root through its
  // conditional-save protocol instead of the legacy store hook.
  const provisioner = createTaskWorktreeProvisioner({});
  const provision = withLiveTaskRootWrite(provisioner.provision, cell);
  const enter = withLiveTaskRootWrite(
    provisioner.enter,
    cell,
    (resolved) => resolved.path
  );
  const exit = withLiveTaskRootWrite(provisioner.exit, cell);
  const pool = createLspClientPool();
  const ctx = {
    directory: repo,
    directoryCell: cell,
    pool,
  } as const;
  return { cell, provisioner, provision, enter, exit, pool, ctx };
}

/** Declared names the stub server reports for `file` under the session ctx. */
async function namesFor(
  ctx: Parameters<typeof getClientDetailed>[0],
  file: string,
  server: LspServerInfo
): Promise<string[]> {
  const { client, failure } = await getClientDetailed(ctx, file, { server });
  if (client === undefined) {
    throw new Error(`no client for ${file}: ${JSON.stringify(failure)}`);
  }
  const answer = (await client.withDocumentOpen(file, () =>
    client.sendRequest("textDocument/documentSymbol", {
      textDocument: { uri: pathToFileURL(file).href },
    })
  )) as { symbols?: string[] };
  return answer.symbols ?? [];
}

describe("T3: production host seam rebinds the LSP task root", () => {
  it("main → tree A → main → tree B: only the active tree's symbols answer, stale clients are reclaimed, pool keys stay per-root", async () => {
    const repo = makeGitRepo();
    const servers = makeStubServers(() => nextPid++);
    const session = makeSession(repo);
    const { cell, provisioner, provision, enter, exit, pool, ctx } = session;

    const namesIn = async (
      root: string
    ): Promise<{ ts: string[]; py: string[] }> => ({
      ts: await namesFor(ctx, join(root, "src", "unique.ts"), servers.ts),
      py: await namesFor(ctx, join(root, "src", "unique.py"), servers.py),
    });

    try {
      // ── leg 1: main ────────────────────────────────────────────────────────
      const mainNames = await namesIn(repo);
      expect(mainNames.ts).toContain(MAIN_MARKERS.ts);
      expect(mainNames.py).toContain(MAIN_MARKERS.py);
      expect(pool.clients.has(`${repo}:stub-ts`)).toBe(true);
      expect(pool.clients.has(`${repo}:stub-py`)).toBe(true);
      const mainTsClient = pool.clients.get(`${repo}:stub-ts`)!;
      const mainPyClient = pool.clients.get(`${repo}:stub-py`)!;

      // ── leg 2: provision tree A (production provision seam) ────────────────
      const treeA = await provision({ conversationId: "conv-a", root: repo });
      expect(cell.read()).toBe(treeA);
      const aMarkers: Markers = {
        ts: "tree_a_ts_marker",
        py: "tree_a_py_marker",
      };
      plantTree(treeA, aMarkers);

      const aNames = await namesIn(treeA);
      expect(aNames.ts).toContain(aMarkers.ts);
      expect(aNames.py).toContain(aMarkers.py);
      expect(aNames.ts).not.toContain(MAIN_MARKERS.ts);
      expect(aNames.py).not.toContain(MAIN_MARKERS.py);

      // The rebind sweep reclaimed BOTH of the main-root clients (not just the
      // dispatched one): connection released + subprocess SIGTERMed + evicted.
      expect(vi.mocked(mainTsClient.process.kill)).toHaveBeenCalledWith(
        "SIGTERM"
      );
      expect(vi.mocked(mainPyClient.process.kill)).toHaveBeenCalledWith(
        "SIGTERM"
      );
      expect(pool.clients.has(`${repo}:stub-ts`)).toBe(false);
      expect(pool.clients.has(`${repo}:stub-py`)).toBe(false);
      // Pool keys are per (root, server): tree A got its own key, no reuse.
      expect(pool.clients.has(`${treeA}:stub-ts`)).toBe(true);
      expect(pool.clients.has(`${treeA}:stub-py`)).toBe(true);
      expect([...pool.clients.keys()]).toEqual([
        `${treeA}:stub-ts`,
        `${treeA}:stub-py`,
      ]);

      // ── leg 3: exit back to main (production exit seam) ────────────────────
      const treeATsClient = pool.clients.get(`${treeA}:stub-ts`)!;
      const treeAPyClient = pool.clients.get(`${treeA}:stub-py`)!;
      const back = await exit({ conversationId: "conv-a", root: treeA });
      expect(cell.read()).toBe(back);
      expect(back).toBe(repo);
      const mainAgain = await namesIn(repo);
      expect(mainAgain.ts).toContain(MAIN_MARKERS.ts);
      expect(mainAgain.py).toContain(MAIN_MARKERS.py);
      expect(mainAgain.ts).not.toContain(aMarkers.ts);
      // Tree A's pair was reclaimed by the sweep on the first post-exit call.
      expect(vi.mocked(treeATsClient.process.kill)).toHaveBeenCalledWith(
        "SIGTERM"
      );
      expect(vi.mocked(treeAPyClient.process.kill)).toHaveBeenCalledWith(
        "SIGTERM"
      );
      expect(pool.clients.has(`${treeA}:stub-ts`)).toBe(false);
      expect(pool.clients.has(`${treeA}:stub-py`)).toBe(false);

      // ── leg 4: enter tree B (production enter seam) ────────────────────────
      // Tree B is created by a DIFFERENT conversation's provision (the bare
      // provisioner, so this session's cell must not move); this session then
      // ENTERS it — the enter seam is what rebinds the cell in production.
      const treeB = await provisioner.provision({
        conversationId: "conv-b",
        root: repo,
      });
      expect(cell.read()).toBe(repo);
      const entered = await enter({
        conversationId: "conv-a",
        root: repo,
        targetConversationId: "conv-b",
      });
      expect(entered.path).toBe(treeB);
      expect(cell.read()).toBe(treeB);
      const bMarkers: Markers = {
        ts: "tree_b_ts_marker",
        py: "tree_b_py_marker",
      };
      plantTree(treeB, bMarkers);

      const bNames = await namesIn(treeB);
      expect(bNames.ts).toContain(bMarkers.ts);
      expect(bNames.py).toContain(bMarkers.py);
      expect(bNames.ts).not.toContain(MAIN_MARKERS.ts);
      expect(bNames.ts).not.toContain(aMarkers.ts);
      expect(pool.clients.has(`${treeB}:stub-ts`)).toBe(true);
      expect(pool.clients.has(`${treeB}:stub-py`)).toBe(true);
      // Three roots were used across the matrix (main, A, B); only the active
      // tree's pair survives — every stale root was reclaimed on each flip.
      expect([...pool.clients.keys()]).toEqual([
        `${treeB}:stub-ts`,
        `${treeB}:stub-py`,
      ]);

      // Repeated switches did not accumulate clients: every stale root was
      // reclaimed on the next flip, so exactly the active tree's pair remains.
      expect(servers.tsSpawns.map((call) => call.root)).toEqual([
        repo,
        treeA,
        repo,
        treeB,
      ]);
      expect(servers.pySpawns.map((call) => call.root)).toEqual([
        repo,
        treeA,
        repo,
        treeB,
      ]);

      await exit({ conversationId: "conv-a", root: treeB });
    } finally {
      await pool.disposeAll();
    }
  }, 120_000);

  it("a concurrent wave issued across the flip never straddles two trees", async () => {
    const repo = makeGitRepo();
    const servers = makeStubServers(() => nextPid++);
    const { cell, provision, exit, pool, ctx } = makeSession(repo);

    // Establish the main-root clients FIRST (cell still = repo): the sweep then
    // has something stale to reclaim, and the later flip is a genuine change of
    // `lastSeenTaskRoot`.
    const mainNames = await namesFor(
      ctx,
      join(repo, "src", "unique.ts"),
      servers.ts
    );
    expect(mainNames).toContain(MAIN_MARKERS.ts);

    const treeA = await provision({ conversationId: "conv-a", root: repo });
    const aMarkers: Markers = {
      ts: "wave_a_ts_marker",
      py: "wave_a_py_marker",
    };
    plantTree(treeA, aMarkers);

    /** root → markers; the wave asserts against the tree each file lives in. */
    const markersByRoot = new Map<string, Markers>([
      [repo, MAIN_MARKERS],
      [treeA, aMarkers],
    ]);

    // The wave mirrors what the tool layer does per entry: ONE live-root read
    // (`resolveDirectorySnapshot`) to resolve the relative input, then the
    // client call. The first half of the wave starts while the cell still says
    // treeA; the exit rebind lands; the second half starts on the rebound
    // (main) root. Joining everything proves a request that started on one
    // side of the flip never carries the other side's content.
    const waveItem = async (index: number) => {
      const snapshot = resolveDirectorySnapshot(ctx);
      const relative = index % 2 === 0 ? "src/unique.ts" : "src/unique.py";
      const file = join(snapshot, relative);
      const server = index % 2 === 0 ? servers.ts : servers.py;
      const { client, failure } = await getClientDetailed(ctx, file, {
        server,
      });
      if (client === undefined) {
        // Fail-closed is a legal outcome of a flip landing between the tool's
        // snapshot and the client's own cell read: the file is then outside the
        // active root and the call is refused instead of answering from the
        // wrong tree.
        return { kind: "refused" as const, reason: failure?.reason };
      }
      const spawnRoot = spawnRootOf.get(client.process);
      const answer = (await client.withDocumentOpen(file, () =>
        client.sendRequest("textDocument/documentSymbol", {
          textDocument: { uri: pathToFileURL(file).href },
        })
      )) as { symbols?: string[] };
      return {
        kind: "answered" as const,
        file,
        spawnRoot: spawnRoot ?? "",
        symbols: answer.symbols ?? [],
      };
    };

    const firstHalf = Array.from({ length: 4 }, (_unused, i) => waveItem(i));
    await exit({ conversationId: "conv-a", root: treeA });
    expect(cell.read()).toBe(repo);
    const secondHalf = Array.from({ length: 4 }, (_unused, i) =>
      waveItem(i + 4)
    );
    const settled = await Promise.all([...firstHalf, ...secondHalf]);

    expect(cell.read()).toBe(repo);
    const answered = settled.filter((entry) => entry.kind === "answered");
    expect(answered.length).toBeGreaterThan(0);
    // Both sides of the flip genuinely occurred: tree-rooted answers from the
    // first half and main-rooted answers from the second half.
    const answeredRoots = new Set(
      answered.map((entry) =>
        entry.kind === "answered" ? entry.spawnRoot : ""
      )
    );
    expect(answeredRoots.has(treeA)).toBe(true);
    expect(answeredRoots.has(repo)).toBe(true);
    for (const entry of answered) {
      if (entry.kind !== "answered") continue;
      // 1. The client this call used belongs to exactly one tree.
      expect(entry.spawnRoot).not.toBe("");
      expect(entry.file.startsWith(`${entry.spawnRoot}/`)).toBe(true);
      // 2. And the answer came from that same tree's bytes.
      const own = markersByRoot.get(entry.spawnRoot);
      if (own === undefined)
        throw new Error(`unknown spawn root ${entry.spawnRoot}`);
      const ownMarker = entry.file.endsWith(".ts") ? own.ts : own.py;
      const otherMarker = entry.file.endsWith(".ts") ? own.py : own.ts;
      expect(entry.symbols).toContain(ownMarker);
      expect(entry.symbols).not.toContain(otherMarker);
    }
    // Refusals, if any, are typed and never an empty success.
    for (const entry of settled) {
      if (entry.kind !== "refused") continue;
      expect(["no-root", "no-server", "spawn-failed"]).toContain(entry.reason);
    }

    await pool.disposeAll();
  }, 120_000);

  it("a second session (own cell + own pool) stays isolated from the first session's rebind", async () => {
    const repo = makeGitRepo();
    const servers = makeStubServers(() => nextPid++);
    const sessionA = makeSession(repo);
    const sessionB = makeSession(repo);

    const treeA = await sessionA.provision({
      conversationId: "conv-a",
      root: repo,
    });
    const aMarkers: Markers = { ts: "iso_a_ts_marker", py: "iso_a_py_marker" };
    plantTree(treeA, aMarkers);

    // Session B is anchored on the main checkout and has already resolved its
    // clients there.
    const bBefore = await namesFor(
      sessionB.ctx,
      join(repo, "src", "unique.ts"),
      servers.ts
    );
    expect(bBefore).toContain(MAIN_MARKERS.ts);
    const bClientBefore = sessionB.pool.clients.get(`${repo}:stub-ts`);
    expect(bClientBefore).toBeDefined();

    // Session A flips into its own tree; session B's cell and pool must not move.
    const aNames = await namesFor(
      sessionA.ctx,
      join(treeA, "src", "unique.ts"),
      servers.ts
    );
    expect(aNames).toContain(aMarkers.ts);
    expect(sessionA.cell.read()).toBe(treeA);
    expect(sessionB.cell.read()).toBe(repo);

    // Session B: same cached client (no re-spawn), never SIGTERMed by session
    // A's sweep (separate pools), still answering from the main checkout.
    const bAfter = await namesFor(
      sessionB.ctx,
      join(repo, "src", "unique.ts"),
      servers.ts
    );
    expect(bAfter).toContain(MAIN_MARKERS.ts);
    expect(bAfter).not.toContain(aMarkers.ts);
    expect(sessionB.pool.clients.get(`${repo}:stub-ts`)).toBe(bClientBefore);
    expect(vi.mocked(bClientBefore!.process.kill)).not.toHaveBeenCalled();
    expect(sessionB.pool.clients.size).toBe(1);

    await sessionA.pool.disposeAll();
    await sessionB.pool.disposeAll();
  }, 120_000);
});
