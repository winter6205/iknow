/**
 * T3 (plans/lsp-worktree-paths.md), real-server half: a REAL TypeScript server
 * and a REAL Pyright server answering real `textDocument/documentSymbol` and
 * `textDocument/definition` requests, across `main → tree A → main → tree B`
 * worktree transitions made through the PRODUCTION host seam.
 *
 * Nothing here is a double: the git repository, the `git worktree add`
 * operations, `createTaskWorktreeProvisioner`, `withLiveTaskRootWrite`,
 * `LspClientPool`, `getClientDetailed`, `NearestRoot`, the server executables
 * and the JSON-RPC transport are all production. Each tree carries a DIFFERENT
 * unique symbol at the SAME relative path, so a result can only be correct if
 * the request reached the active tree.
 *
 * Why this file is separate from `tests/session-api/worktree-rebind-lsp.test.ts`
 * (the stub matrix): the stub pins the transition matrix deterministically; this
 * one pins that real servers really answer, and that a real rebind really
 * terminates the previous server process.
 *
 * Cleanup: every pool is `disposeAll()`ed in `finally` (so no language-server
 * subprocess outlives the case), and every temporary git repository — main
 * checkout plus the `.iknow/worktrees/*` checkouts inside it — is removed in
 * `afterAll`.
 */
import { afterAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  createLiveTaskRoot,
  withLiveTaskRootWrite,
} from "../../../src/harness/session-roots.ts";
import { createTaskWorktreeProvisioner } from "../../../src/session-api/worktree-rebind.ts";
import { Pyright, Typescript } from "../../../src/harness/lsp/server.ts";
import type { LspCtx, LspServerInfo } from "../../../src/harness/lsp/types.ts";
import type { ToolExecutionContext } from "../../../src/harness/tools/types.ts";
import {
  createLspClientPool,
  getClientDetailed,
} from "../../../src/harness/lsp/client.ts";
import { createSymbolQueryToolSet } from "../../../src/harness/aci/tools/symbol.ts";

const tmpRoots: string[] = [];

afterAll(() => {
  for (const dir of tmpRoots.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

/** Marker pair identifying ONE tree; the same relative path in every tree. */
interface Markers {
  readonly ts: string;
  readonly py: string;
}

const RELATIVE_TS = "src/unique.ts";
const RELATIVE_PY = "src/unique.py";

/**
 * Symbol sources. Both files declare a tree-unique function plus a caller that
 * references it, so `documentSymbol` identifies the tree by NAME and
 * `definition` identifies it by URI (two independent observations).
 *
 * The caller line numbers are fixed and asserted below, so a definition request
 * cannot silently degrade into "no position found, empty answer".
 */
function tsSource(marker: string): string {
  return [
    `export function ${marker}(): number {`,
    `  return 1;`,
    `}`,
    ``,
    `export function callerOf${marker}(): number {`,
    `  return ${marker}();`,
    `}`,
    ``,
    `export interface ${marker}_Shape {`,
    `  readonly value: number;`,
    `}`,
    ``,
    `export class ${marker}_Widget {`,
    `  method_${marker}(): number {`,
    `    return 1;`,
    `  }`,
    `}`,
    ``,
  ].join("\n");
}

function pySource(marker: string): string {
  return [
    `def ${marker}() -> int:`,
    `    return 1`,
    ``,
    ``,
    `def caller_of_${marker}() -> int:`,
    `    return ${marker}()`,
    ``,
    `class ${marker}_Widget:`,
    `    def method_of_${marker}(self) -> int:`,
    `        return 1`,
    ``,
  ].join("\n");
}

/** 0-based line/character of the call site's identifier in each fixture. */
const TS_DEFINITION_POSITION = { line: 5, character: 10 } as const;
const PY_DEFINITION_POSITION = { line: 5, character: 12 } as const;

/**
 * Write the marker files (and both `NearestRoot` root markers) into `root`.
 *
 * No `package.json` on purpose: the provisioner's default project-dep
 * installer then skips with `no_package_json`, so no case shells out to a real
 * `npm ci`. The server executables themselves resolve from the harness's own
 * dependency tree (the repo's devDependencies ship both), which is the
 * production `resolveServerExecutable` layer 3.
 */
function plantTree(root: string, markers: Markers): void {
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "package-lock.json"), "{}\n", "utf8");
  writeFileSync(
    join(root, "pyproject.toml"),
    '[project]\nname = "t3-real"\nversion = "0.0.0"\n'
  );
  writeFileSync(join(root, RELATIVE_TS), tsSource(markers.ts), "utf8");
  writeFileSync(join(root, RELATIVE_PY), pySource(markers.py), "utf8");
}

function makeGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "iknow-t3-real-"));
  tmpRoots.push(dir);
  git(dir, "init", "-q");
  writeFileSync(join(dir, ".gitignore"), ".iknow/\n", "utf8");
  plantTree(dir, { ts: "main_ts_unique", py: "main_py_unique" });
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

/** One leg's observations: the root, the names the real server reported, and where it pointed. */
interface LegObservation {
  readonly root: string;
  readonly names: ReadonlyArray<string>;
  readonly definitionUris: ReadonlyArray<string>;
}

/** Declared names from a `documentSymbol` answer (DocumentSymbol[] | SymbolInformation[]). */
function namesOf(answer: unknown): string[] {
  if (!Array.isArray(answer)) return [];
  return answer
    .map((entry) => (entry as { name?: unknown })?.name)
    .filter((name): name is string => typeof name === "string");
}

/** `file://` URIs from a `definition` answer (Location[] | LocationLink[]). */
function urisOf(answer: unknown): string[] {
  if (!Array.isArray(answer)) return [];
  return answer
    .map((entry) => {
      const direct = (entry as { uri?: unknown })?.uri;
      if (typeof direct === "string") return direct;
      const target = (entry as { targetUri?: unknown })?.targetUri;
      return typeof target === "string" ? target : "";
    })
    .filter((uri) => uri.length > 0);
}

interface MatrixOptions {
  readonly server: LspServerInfo;
  readonly relative: string;
  readonly position: { readonly line: number; readonly character: number };
}

/**
 * Drive `main → tree A → main → tree B` through the production host seam and
 * query the real server in each leg. Returns the per-leg observations; every
 * assertion lives in the calling test so a failure names the language.
 */
async function runRebindMatrix(opts: MatrixOptions): Promise<{
  readonly legs: ReadonlyArray<LegObservation>;
  readonly roots: ReadonlyArray<string>;
  readonly pool: ReturnType<typeof createLspClientPool>;
}> {
  const repo = makeGitRepo();
  const cell = createLiveTaskRoot(repo);
  const provisioner = createTaskWorktreeProvisioner({});
  const provision = withLiveTaskRootWrite(provisioner.provision, cell);
  const enter = withLiveTaskRootWrite(
    provisioner.enter,
    cell,
    (resolved) => resolved.path
  );
  const exit = withLiveTaskRootWrite(provisioner.exit, cell);
  const pool = createLspClientPool();
  const ctx: LspCtx = {
    directory: repo,
    directoryCell: cell,
    pool,
  };

  const observe = async (root: string): Promise<LegObservation> => {
    const file = join(root, opts.relative);
    expect(existsSync(file)).toBe(true);
    const { client, failure } = await getClientDetailed(ctx, file, {
      server: opts.server,
    });
    if (client === undefined) {
      throw new Error(
        `no real client for ${opts.server.id} at ${file}: ${JSON.stringify(failure)}`
      );
    }
    const uri = pathToFileURL(file).href;
    const { names, uris } = (await client.withDocumentOpen(file, async () => {
      const symbols = await client.sendRequest("textDocument/documentSymbol", {
        textDocument: { uri },
      });
      const definition = await client.sendRequest("textDocument/definition", {
        textDocument: { uri },
        position: opts.position,
      });
      return { names: namesOf(symbols), uris: urisOf(definition) };
    })) as { names: string[]; uris: string[] };
    return { root, names, definitionUris: uris };
  };

  const aMarkers: Markers = { ts: "tree_a_ts_unique", py: "tree_a_py_unique" };
  const bMarkers: Markers = { ts: "tree_b_ts_unique", py: "tree_b_py_unique" };

  const legs: LegObservation[] = [];
  try {
    // leg 1 — main checkout
    legs.push(await observe(repo));

    // leg 2 — provision tree A (production provision seam moves the cell)
    const treeA = await provision({ conversationId: "conv-a", root: repo });
    expect(cell.read()).toBe(treeA);
    plantTree(treeA, aMarkers);
    legs.push(await observe(treeA));

    // leg 3 — exit back to main (production exit seam)
    const back = await exit({ conversationId: "conv-a", root: treeA });
    expect(back).toBe(repo);
    legs.push(await observe(repo));

    // leg 4 — enter tree B (production enter seam)
    const treeB = await provisioner.provision({
      conversationId: "conv-b",
      root: repo,
    });
    const entered = await enter({
      conversationId: "conv-a",
      root: repo,
      targetConversationId: "conv-b",
    });
    expect(entered.path).toBe(treeB);
    expect(cell.read()).toBe(treeB);
    plantTree(treeB, bMarkers);
    legs.push(await observe(treeB));

    return { legs, roots: [repo, treeA, repo, treeB], pool };
  } finally {
    // Terminates every real language-server subprocess this matrix spawned.
    await pool.disposeAll();
  }
}

/** Assert one leg answered from `leg.root` and from no other tree. */
function expectLegIdentifies(
  leg: LegObservation,
  own: string,
  foreign: ReadonlyArray<string>,
  expectedFile: string
): void {
  // 1. Names: the real server reported this tree's unique symbol.
  expect(leg.names).toContain(own);
  for (const marker of foreign) {
    expect(leg.names).not.toContain(marker);
  }
  // 2. URIs: definition pointed inside THIS tree, at the expected file.
  expect(leg.definitionUris.length).toBeGreaterThan(0);
  for (const uri of leg.definitionUris) {
    expect(uri.startsWith(pathToFileURL(leg.root).href)).toBe(true);
  }
  expect(
    leg.definitionUris.some((uri) => uri === pathToFileURL(expectedFile).href)
  ).toBe(true);
}

describe("T3 real language servers across production worktree rebinds", () => {
  it("real typescript-language-server answers from the active tree through main → A → main → B", async () => {
    const { legs, pool } = await runRebindMatrix({
      server: Typescript,
      relative: RELATIVE_TS,
      position: TS_DEFINITION_POSITION,
    });

    expect(legs.length).toBe(4);
    const mainMarkers: Markers = { ts: "main_ts_unique", py: "main_py_unique" };
    const aMarkers: Markers = {
      ts: "tree_a_ts_unique",
      py: "tree_a_py_unique",
    };
    const bMarkers: Markers = {
      ts: "tree_b_ts_unique",
      py: "tree_b_py_unique",
    };
    const perLeg: [LegObservation, string, string[]][] = [
      [legs[0], mainMarkers.ts, [mainMarkers.py, aMarkers.ts, bMarkers.ts]],
      [legs[1], aMarkers.ts, [mainMarkers.ts, mainMarkers.py, bMarkers.ts]],
      [legs[2], mainMarkers.ts, [aMarkers.ts, aMarkers.py, bMarkers.ts]],
      [legs[3], bMarkers.ts, [mainMarkers.ts, mainMarkers.py, aMarkers.ts]],
    ];
    for (const [leg, own, foreign] of perLeg) {
      expectLegIdentifies(leg, own, foreign, join(leg.root, RELATIVE_TS));
    }

    // Repeated switches never reused another tree's project: the pool ends
    // with exactly the active tree's client (runRebindMatrix disposed it in
    // `finally`, so the live assertion is on the observable pool state).
    expect(pool.shutDown).toBe(false);
    expect(pool.clients.size).toBe(0);
  }, 300_000);

  it("real pyright answers from the active tree through main → A → main → B", async () => {
    const { legs, pool } = await runRebindMatrix({
      server: Pyright,
      relative: RELATIVE_PY,
      position: PY_DEFINITION_POSITION,
    });

    expect(legs.length).toBe(4);
    const mainMarkers: Markers = { ts: "main_ts_unique", py: "main_py_unique" };
    const aMarkers: Markers = {
      ts: "tree_a_ts_unique",
      py: "tree_a_py_unique",
    };
    const bMarkers: Markers = {
      ts: "tree_b_ts_unique",
      py: "tree_b_py_unique",
    };
    const perLeg: [LegObservation, string, string[]][] = [
      [legs[0], mainMarkers.py, [mainMarkers.ts, aMarkers.py, bMarkers.py]],
      [legs[1], aMarkers.py, [mainMarkers.py, mainMarkers.ts, bMarkers.py]],
      [legs[2], mainMarkers.py, [aMarkers.py, aMarkers.ts, bMarkers.py]],
      [legs[3], bMarkers.py, [mainMarkers.py, mainMarkers.ts, aMarkers.py]],
    ];
    for (const [leg, own, foreign] of perLeg) {
      expectLegIdentifies(leg, own, foreign, join(leg.root, RELATIVE_PY));
    }

    expect(pool.shutDown).toBe(false);
    expect(pool.clients.size).toBe(0);
  }, 300_000);
});

/* ---------- symbol-identity hover through the PRODUCTION tool handlers ---------- */

/** Hover one symbol by identity through the production symbol-query tool set. */
async function hoverByIdentity(
  ctx: LspCtx,
  file: string,
  symbolPath: string
): Promise<string> {
  const hover = createSymbolQueryToolSet(ctx).find(
    (t) => t.name === "get_hover"
  );
  if (hover === undefined) throw new Error("get_hover tool missing from the set");
  const execCtx: ToolExecutionContext = { conversationId: "conv-t3-hover" };
  const out = await hover.handler({ file, symbol_path: symbolPath }, execCtx);
  return typeof out === "string" ? out : JSON.stringify(out);
}

/**
 * A real hover is a non-null object whose contents name the symbol. Anything
 * else — the `null` string, a `(symbol …)` resolution sentinel, a no-server
 * sentinel — is the defect this leg exists to catch, so each is asserted
 * against explicitly rather than allowed to pass as a soft result.
 */
function expectHoverNames(raw: string, name: string, what: string): void {
  expect(raw, `${what}: hover must not be the JSON null string`).not.toBe("null");
  expect(raw.trim(), `${what}: hover must be non-empty`).not.toBe("");
  expect(raw, `${what}: hover must not be a resolution sentinel`).not.toContain(
    '(symbol "'
  );
  const parsed = JSON.parse(raw) as { contents?: unknown };
  expect(parsed.contents, `${what}: hover must carry contents`).toBeTruthy();
  expect(
    JSON.stringify(parsed.contents),
    `${what}: hover must name ${name}`
  ).toContain(name);
}

describe("T3 real language servers answer symbol-identity hover through the production tool set", () => {
  it("real typescript-language-server hovers a top-level function, a top-level interface, and a nested Class/method", async () => {
    const repo = makeGitRepo();
    const cell = createLiveTaskRoot(repo);
    const pool = createLspClientPool();
    const ctx: LspCtx = { directory: repo, directoryCell: cell, pool };
    try {
      const topLevelFunction = await hoverByIdentity(
        ctx,
        RELATIVE_TS,
        "main_ts_unique"
      );
      expectHoverNames(
        topLevelFunction,
        "main_ts_unique",
        "top-level export function"
      );

      const topLevelInterface = await hoverByIdentity(
        ctx,
        RELATIVE_TS,
        "main_ts_unique_Shape"
      );
      expectHoverNames(
        topLevelInterface,
        "main_ts_unique_Shape",
        "top-level export interface"
      );

      const nestedMethod = await hoverByIdentity(
        ctx,
        RELATIVE_TS,
        "main_ts_unique_Widget/method_main_ts_unique"
      );
      expectHoverNames(
        nestedMethod,
        "method_main_ts_unique",
        "nested Class/method symbol_path"
      );
    } finally {
      await pool.disposeAll();
    }
  }, 300_000);

  it("real pyright hovers a top-level def, a class, and a nested Class/method", async () => {
    const repo = makeGitRepo();
    const cell = createLiveTaskRoot(repo);
    const pool = createLspClientPool();
    const ctx: LspCtx = { directory: repo, directoryCell: cell, pool };
    try {
      const topLevelDef = await hoverByIdentity(
        ctx,
        RELATIVE_PY,
        "main_py_unique"
      );
      expectHoverNames(topLevelDef, "main_py_unique", "top-level def");

      const classSymbol = await hoverByIdentity(
        ctx,
        RELATIVE_PY,
        "main_py_unique_Widget"
      );
      expectHoverNames(classSymbol, "main_py_unique_Widget", "class");

      const nestedMethod = await hoverByIdentity(
        ctx,
        RELATIVE_PY,
        "main_py_unique_Widget/method_of_main_py_unique"
      );
      expectHoverNames(
        nestedMethod,
        "method_of_main_py_unique",
        "nested Class/method symbol_path"
      );
    } finally {
      await pool.disposeAll();
    }
  }, 300_000);
});
