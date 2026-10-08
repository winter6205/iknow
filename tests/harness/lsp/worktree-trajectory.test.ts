/**
 * T4 (plans/lsp-worktree-paths.md) — the OFFLINE HALF of the worktree-path
 * trajectory golden set: the fixed cases from
 * `worktree-trajectory.fixtures.ts` driven headlessly against the REAL
 * production tool layer.
 *
 * What is real here (nothing about the seam under test is faked):
 *   - a disposable temp Git repository with real `git worktree add` / `remove`
 *     operations driven by `createTaskWorktreeProvisioner`;
 *   - the production seam wrapper (`withLiveTaskRootWrite` around provision /
 *     enter / exit) exactly as `build-engine.ts` wires it, so every successful
 *     transition moves the live `taskRoot` cell;
 *   - the real ACI tool handlers (`createLspToolSet` / `createSymbolQueryToolSet`
 *     / `createSymbolMutateToolSet` / the three worktree tools) over a real
 *     `LspCtx` whose `directoryCell` is that live cell;
 *   - a REAL `typescript-language-server` (through the production
 *     `LspClientPool` + `getClientDetailed` + `NearestRoot`), so hover and
 *     call-hierarchy results are genuinely non-null, not a stub echo.
 *
 * The offline half proves the TOOL-LEVEL trajectory: each fixed case becomes a
 * recorded production tool invocation, and the gates inspect (a) the recorded
 * tool trace, (b) the tool RESULTS, (c) the final filesystem bytes of BOTH the
 * worktree and the main checkout, and (d) the result URIs. A silent tool
 * success or a sentinel never substitutes for those checks.
 *
 * Cleanup: the pool is `disposeAll()`ed in `finally` (no language-server
 * subprocess outlives the case) and every temp Git repository — main checkout
 * plus the `.iknow/worktrees/*` checkouts inside it — is removed in `afterAll`.
 */
import { afterAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
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
import { createLspClientPool } from "../../../src/harness/lsp/client.ts";
import type { LspCtx } from "../../../src/harness/lsp/types.ts";
import type { AciToolDef } from "../../../src/harness/aci/types.ts";
import type { ToolExecutionContext } from "../../../src/harness/tools/types.ts";
import { createLspToolSet } from "../../../src/harness/aci/tools/lsp.ts";
import { createSymbolQueryToolSet } from "../../../src/harness/aci/tools/symbol.ts";
import { createSymbolMutateToolSet } from "../../../src/harness/aci/tools/symbol-mutate.ts";
import { createCreateWorktreeTool } from "../../../src/harness/aci/tools/create-worktree.ts";
import { createEnterWorktreeTool } from "../../../src/harness/aci/tools/enter-worktree.ts";
import { createExitWorktreeTool } from "../../../src/harness/aci/tools/exit-worktree.ts";
import {
  CALLER_SYMBOL,
  NESTED_METHOD_PATH,
  NO_PROJECT_ANCHOR_PREFIX,
  NO_ROOT_SENTINEL_PREFIX,
  OWNER_RELATIVE_TS,
  OWNER_SYMBOL,
  RELATIVE_TS,
  RENAMED_SYMBOL,
  RENAME_TOOL_NAME,
  UNSAFE_ESCAPE_RELATIVE,
  UNIQUE_SYMBOL,
  WORKSPACE_QUERY_SYMBOL,
  WORKTREE_SUBDIR,
  declaresSymbol,
  fileUrisIn,
  seedOwnerTree,
  seedRepoTree,
} from "./worktree-trajectory.fixtures.ts";

const tmpRoots: string[] = [];

afterAll(() => {
  for (const dir of tmpRoots.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

/** A real, seeded, committed temp Git repository (the main checkout). */
function makeGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "iknow-t4-offline-"));
  tmpRoots.push(dir);
  git(dir, "init", "-q");
  writeFileSync(join(dir, ".gitignore"), ".iknow/\n", "utf8");
  seedRepoTree(dir);
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

/** One recorded production tool invocation. */
interface Step {
  readonly name: string;
  readonly input: unknown;
  readonly kind: "ok" | "failed";
  readonly text: string;
}

function pick(tools: ReadonlyArray<AciToolDef>, name: string): AciToolDef {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`tool not found: ${name}`);
  return tool;
}

/**
 * Invoke one production ACI tool handler and record its real result. A thrown
 * failure is recorded too (never swallowed): the trace is the ground truth the
 * gates read, so a failure must remain visible as `kind: "failed"`.
 */
async function invoke(
  trace: Step[],
  tool: AciToolDef,
  input: unknown,
  execCtx: ToolExecutionContext
): Promise<string> {
  try {
    const out = await tool.handler(input, execCtx);
    const text = typeof out === "string" ? out : JSON.stringify(out);
    trace.push({ name: tool.name, input, kind: "ok", text });
    return text;
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err);
    trace.push({ name: tool.name, input, kind: "failed", text });
    return text;
  }
}

describe("T4 worktree-path trajectory — offline half (real tool layer + real tsserver)", () => {
  it("locks main → create → query/rename → file-omitted query → hover/hierarchy → exit → enter-owner, with both trees' bytes and result URIs", async () => {
    const repo = makeGitRepo();

    // Production host seam, wired exactly like build-engine: a live taskRoot
    // cell + the three wrapped seams.
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

    const createWorktree = createCreateWorktreeTool({ provision, root: cell });
    const enterWorktree = createEnterWorktreeTool({
      worktreeEnter: enter,
      root: cell,
    });
    const exitWorktree = createExitWorktreeTool({
      worktreeExit: exit,
      root: cell,
    });
    const queryTools = createSymbolQueryToolSet(ctx);
    const mutateTools = createSymbolMutateToolSet({ ctx });
    const lspTools = createLspToolSet(ctx);

    const trace: Step[] = [];
    const execCtx: ToolExecutionContext = { conversationId: "conv-t4-main" };
    const mainFile = join(repo, RELATIVE_TS);
    const mainBytesBefore = readFileSync(mainFile, "utf8");

    try {
      // ── case 1: create the worktree ──────────────────────────────────────
      const createOut = await invoke(trace, createWorktree, {}, execCtx);
      const treeW = cell.read();
      expect(createOut, "create-worktree result names the new tree").toContain(
        treeW
      );
      expect(
        treeW.startsWith(join(repo, WORKTREE_SUBDIR)),
        "the tree is a per-conversation task worktree"
      ).toBe(true);
      const wtFile = join(treeW, RELATIVE_TS);
      expect(existsSync(wtFile), "the worktree inherits the seeded file").toBe(
        true
      );

      // ── case 1: query the unique symbol in the active (worktree) tree ────
      const declOut = await invoke(
        trace,
        pick(queryTools, "find_declaration"),
        { file: RELATIVE_TS, symbol_path: UNIQUE_SYMBOL },
        execCtx
      );
      expect(
        fileUrisIn(declOut),
        "find_declaration points into the ACTIVE worktree"
      ).toContain(pathToFileURL(wtFile).href);

      // ── hover: a meaningful non-null result ──────────────────────────────
      const hoverOut = await invoke(
        trace,
        pick(queryTools, "get_hover"),
        { file: RELATIVE_TS, symbol_path: UNIQUE_SYMBOL },
        execCtx
      );
      const hover = JSON.parse(hoverOut) as { contents?: unknown };
      expect(
        hover,
        `hover is a non-null object (raw=${hoverOut})`
      ).toBeTruthy();
      expect(hover.contents, "hover carries contents").toBeTruthy();
      expect(
        JSON.stringify(hover.contents),
        "hover content names the symbol"
      ).toContain(UNIQUE_SYMBOL);

      // ── call-hierarchy: a meaningful non-empty result ────────────────────
      const hierOut = await invoke(
        trace,
        pick(queryTools, "list_incoming_calls"),
        { file: RELATIVE_TS, symbol_path: UNIQUE_SYMBOL },
        execCtx
      );
      const hier = JSON.parse(hierOut) as unknown[];
      expect(Array.isArray(hier), "call-hierarchy returns an array").toBe(true);
      expect(hier.length, "call-hierarchy is non-empty").toBeGreaterThan(0);
      expect(JSON.stringify(hier), "call-hierarchy names the caller").toContain(
        CALLER_SYMBOL
      );

      // ── case 1: rename the unique symbol (mutation stays in the tree) ────
      const renameOut = await invoke(
        trace,
        pick(mutateTools, RENAME_TOOL_NAME),
        {
          file: RELATIVE_TS,
          symbol_path: UNIQUE_SYMBOL,
          new_name: RENAMED_SYMBOL,
        },
        execCtx
      );
      const rename = JSON.parse(renameOut) as {
        renamed?: unknown;
        files?: unknown;
      };
      expect(rename.renamed, "rename reported success").toBe(true);
      expect(
        Array.isArray(rename.files) ? rename.files : [],
        "the rename wrote the active worktree file"
      ).toContain(wtFile);
      // The worktree file now declares the new name; the main checkout is
      // byte-identical (never touched).
      const wtBytesAfterRename = readFileSync(wtFile, "utf8");
      expect(declaresSymbol(wtBytesAfterRename, RENAMED_SYMBOL)).toBe(true);
      expect(declaresSymbol(wtBytesAfterRename, UNIQUE_SYMBOL)).toBe(false);
      expect(readFileSync(mainFile, "utf8")).toBe(mainBytesBefore);

      // ── case 3: a file-omitted workspace query selects the ACTIVE root ───
      // (a) file-Omitted: with no document anchor, the real
      //     typescript-language-server (TSLS) cannot resolve a project for
      //     `navto`, so the query returns its DOCUMENTED no-anchor sentinel.
      //     That sentinel interpolates the LIVE root — so it is decidable
      //     evidence that the file-less query read the ACTIVE taskRoot and
      //     not the stale one. (Deviation from the plan's "returns a symbol
      //     from a file-omitted query": TSLS `workspace/symbol` needs an open
      //     document to load a project, so the file-less path can only ever
      //     answer with the sentinel here — the symbol-returning half is
      //     asserted on the anchored query in (b).)
      const wsOut = await invoke(
        trace,
        pick(queryTools, "find_symbol"),
        { query: WORKSPACE_QUERY_SYMBOL },
        execCtx
      );
      expect(
        wsOut,
        "file-omitted workspace query returns the documented no-anchor sentinel"
      ).toContain(NO_PROJECT_ANCHOR_PREFIX);
      expect(
        wsOut,
        "the sentinel names the LIVE worktree root (active-root selection)"
      ).toContain(`under ${treeW}`);
      // (b) anchored: the same workspace query with a file anchor opens the
      //     active tree's document, so the server loads the project and
      //     returns the ACTIVE tree's known symbol — every result URI sits
      //     under the worktree.
      const wsAnchoredOut = await invoke(
        trace,
        pick(lspTools, "lsp_workspace_symbol"),
        { file: RELATIVE_TS, query: WORKSPACE_QUERY_SYMBOL },
        execCtx
      );
      const wsPayload = JSON.parse(wsAnchoredOut) as unknown;
      expect(
        Array.isArray(wsPayload) && (wsPayload as unknown[]).length > 0,
        `anchored workspace query returns the worktree's symbol (raw=${wsAnchoredOut})`
      ).toBe(true);
      const wsUris = fileUrisIn(wsAnchoredOut);
      expect(wsUris.length, "workspace result names URIs").toBeGreaterThan(0);
      for (const uri of wsUris) {
        expect(
          uri.startsWith(pathToFileURL(treeW).href),
          `workspace result URI ${uri} is under the active worktree`
        ).toBe(true);
      }

      // ── case 5: an unsafe escaping path is refused, no side effects ──────
      const unsafeOut = await invoke(
        trace,
        pick(queryTools, "get_symbols_overview"),
        { file: UNSAFE_ESCAPE_RELATIVE },
        execCtx
      );
      expect(
        unsafeOut,
        "the escaping path is refused with a no-root sentinel"
      ).toContain(NO_ROOT_SENTINEL_PREFIX);
      expect(
        unsafeOut,
        "the refusal names the LIVE worktree root, not a stale tree"
      ).toContain(treeW);
      // No side effect: nothing was created at the escaped target.
      expect(
        existsSync(join(repo, "outside-project.ts")),
        "the escaping path created no file"
      ).toBe(false);
      expect(readFileSync(mainFile, "utf8")).toBe(mainBytesBefore);

      // ── case 4: exit and confirm the original tree's symbol + bytes ──────
      const exitOut = await invoke(trace, exitWorktree, {}, execCtx);
      expect(exitOut, "exit-worktree names the main repo").toContain(repo);
      expect(cell.read(), "the live root is back on the main checkout").toBe(
        repo
      );
      const mainDeclOut = await invoke(
        trace,
        pick(queryTools, "find_declaration"),
        { file: RELATIVE_TS, symbol_path: UNIQUE_SYMBOL },
        execCtx
      );
      expect(
        fileUrisIn(mainDeclOut),
        "find_declaration points back into the MAIN checkout"
      ).toContain(pathToFileURL(mainFile).href);
      expect(readFileSync(mainFile, "utf8")).toBe(mainBytesBefore);
      expect(
        declaresSymbol(readFileSync(wtFile, "utf8"), RENAMED_SYMBOL),
        "the worktree keeps its renamed symbol after exit"
      ).toBe(true);

      // ── case 2: enter an EXISTING worktree and query its unique symbol ───
      // The owner tree is created by a DIFFERENT conversation via the bare
      // provisioner (this session's cell must not move); this session then
      // ENTERS it through the production enter seam.
      const treeO = await provisioner.provision({
        conversationId: "conv-t4-owner",
        root: repo,
      });
      expect(cell.read(), "the bare provision did not move this session").toBe(
        repo
      );
      seedOwnerTree(treeO);
      const enterOut = await invoke(
        trace,
        enterWorktree,
        { conversationId: "conv-t4-owner" },
        execCtx
      );
      expect(enterOut, "enter-worktree names the entered tree").toContain(
        treeO
      );
      expect(cell.read(), "the live root moved to the entered tree").toBe(
        treeO
      );
      const ownerDeclOut = await invoke(
        trace,
        pick(queryTools, "find_declaration"),
        { file: OWNER_RELATIVE_TS, symbol_path: OWNER_SYMBOL },
        execCtx
      );
      expect(
        fileUrisIn(ownerDeclOut),
        "the entered tree's EXCLUSIVE symbol was served"
      ).toContain(pathToFileURL(join(treeO, OWNER_RELATIVE_TS)).href);

      // ── the recorded production tool trace (ordered) ─────────────────────
      expect(
        trace.map((step) => step.name),
        "the production tool trace is the fixed lifecycle, in order"
      ).toEqual([
        "create-worktree",
        "find_declaration",
        "get_hover",
        "list_incoming_calls",
        "rename_symbol",
        "find_symbol",
        "lsp_workspace_symbol",
        "get_symbols_overview",
        "exit-worktree",
        "find_declaration",
        "enter-worktree",
        "find_declaration",
      ]);
      // Every recorded step succeeded; no silent tool failure rode along.
      expect(trace.filter((step) => step.kind === "failed")).toEqual([]);

      // The LSP tool set was exercised as the production surface (sanity that
      // the same ctx backs both families).
      expect(lspTools.map((t) => t.name)).toContain("lsp_document_symbol");
    } finally {
      await pool.disposeAll();
    }
  }, 300_000);

  it("locks hover on a top-level symbol and a nested Class/method in the active worktree", async () => {
    const repo = makeGitRepo();

    const cell = createLiveTaskRoot(repo);
    const provisioner = createTaskWorktreeProvisioner({});
    const provision = withLiveTaskRootWrite(provisioner.provision, cell);
    const pool = createLspClientPool();
    const ctx: LspCtx = {
      directory: repo,
      directoryCell: cell,
      pool,
    };

    const createWorktree = createCreateWorktreeTool({ provision, root: cell });
    const queryTools = createSymbolQueryToolSet(ctx);
    const trace: Step[] = [];
    const execCtx: ToolExecutionContext = { conversationId: "conv-t4-hover" };

    try {
      const createOut = await invoke(trace, createWorktree, {}, execCtx);
      const treeW = cell.read();
      expect(createOut, "create-worktree result names the new tree").toContain(
        treeW
      );

      // A bare TOP-LEVEL symbol_path: hover must land on the identifier, not
      // on the `export` keyword a line-start range would give, so neither the
      // null string nor a not-found sentinel may pass.
      const topOut = await invoke(
        trace,
        pick(queryTools, "get_hover"),
        { file: RELATIVE_TS, symbol_path: WORKSPACE_QUERY_SYMBOL },
        execCtx
      );
      expect(
        topOut,
        "top-level hover is not the null string"
      ).not.toBe("null");
      expect(
        topOut,
        "top-level hover is not a resolution sentinel"
      ).not.toContain('(symbol "');
      const top = JSON.parse(topOut) as { contents?: unknown };
      expect(
        top.contents,
        `top-level hover carries contents (raw=${topOut})`
      ).toBeTruthy();
      expect(
        JSON.stringify(top.contents),
        "top-level hover names the symbol"
      ).toContain(WORKSPACE_QUERY_SYMBOL);

      // A NESTED `Class/method` path resolves only when the response carries
      // `children`; a sentinel here means the tree was not a tree.
      const nestedOut = await invoke(
        trace,
        pick(queryTools, "get_hover"),
        { file: RELATIVE_TS, symbol_path: NESTED_METHOD_PATH },
        execCtx
      );
      expect(
        nestedOut,
        "nested hover is not the null string"
      ).not.toBe("null");
      expect(
        nestedOut,
        "nested hover is not a resolution sentinel"
      ).not.toContain('(symbol "');
      const nested = JSON.parse(nestedOut) as { contents?: unknown };
      expect(
        nested.contents,
        `nested hover carries contents (raw=${nestedOut})`
      ).toBeTruthy();
      expect(
        JSON.stringify(nested.contents),
        "nested hover names the method"
      ).toContain(UNIQUE_SYMBOL);

      expect(trace.filter((step) => step.kind === "failed")).toEqual([]);
    } finally {
      await pool.disposeAll();
    }
  }, 300_000);
});
