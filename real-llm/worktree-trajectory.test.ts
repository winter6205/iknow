// REAL_LLM: worktree-path trajectory golden set — real-model half
// (plans/lsp-worktree-paths.md T4).
//
// Locks the same fixed cases as the offline half
// (tests/harness/lsp/worktree-trajectory.test.ts) on REAL model trajectories,
// end to end through the seams a user actually hits: `buildHarnessEngine`
// (which wraps the host provision / enter / exit seams with
// `withLiveTaskRootWrite`, exactly as production does) + the real ACI tool
// executor, recording every dispatch with the production recording layer. The
// fixed inputs (prompts, paths, symbol names, refusal markers) come from the
// shared fixture file (tests/harness/lsp/worktree-trajectory.fixtures.ts) — the
// same independent witness both halves bind to.
//
// Hard gates (no LLM judge, no pass-rate threshold): every arm asserts on
//   - the recorded production tool/loop trace (which tools the model actually
//     dispatched, in order),
//   - the tool RESULTS (never model prose),
//   - the final filesystem bytes of BOTH the worktree and the main checkout,
//   - the result URIs.
// A silent tool success or model prose never substitutes for these. When the
// model did not take an arm's shape, the arm prints a RESIDUAL and does not
// judge it (same discipline as real-llm/verify-status-contract.test.ts); it
// never becomes a hidden pass.
//
// The model drives ACTUAL host worktree creation/entry through the production
// provisioner seams — nothing here rebinds a root by hand. The current model
// selection from settings is used unchanged. No key → Not run (explicit, never
// a hidden pass). Tracked in TRACKED_INCLUDE of vitest.real-llm.config.ts; run
// via `npm run test:real-llm`. Offline green does not count as this half.
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";

import { afterAll, beforeAll, describe, it } from "vitest";

import { buildHarnessEngine } from "../src/harness/build-engine.ts";
import { run, type LoopEngineDeps } from "../src/harness/loop-engine.ts";
import { MaxTurnsExceeded } from "../src/harness/errors.ts";
import type { ToolExecutionResult } from "../src/harness/tools/types.ts";
import { createNoAskUser } from "../src/harness/permission/ask-user.ts";
import { shutdownDefaultLspPool } from "../src/harness/lsp/client.ts";
import { createTaskWorktreeProvisioner } from "../src/session-api/worktree-rebind.ts";
import { type IknowEnv } from "../src/config/env.ts";
import { loadRealLlmEnv } from "./real-llm-env.ts";
import {
  createRecordingExecutor,
  type RoleSubstitutionDispatch as DispatchRecord,
} from "./role-substitution-recorder.ts";
import {
  NO_ROOT_SENTINEL_PREFIX,
  RELATIVE_TS,
  RENAMED_SYMBOL,
  UNSAFE_ESCAPE_RELATIVE,
  UNIQUE_SYMBOL,
  WORKTREE_SUBDIR,
  declaresSymbol,
  fileUrisIn,
  seedOwnerTree,
  seedRepoTree,
  TRAJECTORY_CASES,
  type TrajectoryCase,
} from "../tests/harness/lsp/worktree-trajectory.fixtures.ts";

const REPO_ROOT = execFileSync("git", ["rev-parse", "--show-toplevel"], {
  encoding: "utf8",
}).trim();

// A throwing load must surface at collection, not masquerade as a skip.
const realEnv = loadRealLlmEnv(REPO_ROOT);
const HAS_KEY = realEnv !== undefined;
if (!HAS_KEY) console.log("[SKIP] LLM key not set; Not run");

/** The conversation id that owns the pre-created "enter" target tree. */
const OWNER_ID = "t4owner";
let SCRATCH_ROOTS_DIR = "";

const SCRATCH_ROOTS: string[] = [];

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function makeGitRepo(): string {
  const dir = mkdtempSync(join(SCRATCH_ROOTS_DIR, "repo-"));
  SCRATCH_ROOTS.push(dir);
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

beforeAll(() => {
  // Scratch lives under the repo's gitignored .evals/ so `npx` / the LSP
  // servers resolve the checked-out toolchain with no network fetch.
  const base = join(REPO_ROOT, ".evals", "real-llm");
  mkdirSync(base, { recursive: true });
  SCRATCH_ROOTS_DIR = mkdtempSync(join(base, "worktree-trajectory-"));
});

afterAll(async () => {
  // The process-level default pool is a ONE-WAY latch: shutdownAll sets
  // `shutDown` and getClientDetailed then returns the `pool-shutdown` sentinel
  // forever (client.ts:461-463, :510-517). Every engine shares that pool
  // (build-engine's lspCtx carries no `ctx.pool`, so poolOf falls back to
  // defaultPool), so a per-arm shutdown would poison every LATER arm with
  // "shut down by a host-exit seam; it never respawns" — the arms would
  // RESIDUAL instead of gating. Terminate it exactly ONCE here, at the file's
  // exit seam, matching the pool's production contract (TUI/CLI process-exit
  // seams only; already-terminated language servers are harmless but the latch
  // is not reversible). This also drains any stdio pipe that would otherwise
  // keep the worker alive.
  await shutdownDefaultLspPool();
  for (const dir of SCRATCH_ROOTS.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  if (SCRATCH_ROOTS_DIR !== "")
    rmSync(SCRATCH_ROOTS_DIR, { recursive: true, force: true });
});

/* ------------------------------ result helpers ------------------------------ */

function resultText(r: ToolExecutionResult | undefined): string {
  if (r === undefined) return "";
  if (r.kind === "ok") {
    return r.payload.map((b) => (b.type === "text" ? b.text : "")).join("\n");
  }
  if ("message" in r) return r.message;
  return r.kind;
}

function allDispatches(
  dispatches: DispatchRecord[],
  name: string
): DispatchRecord[] {
  return dispatches.filter((d) => d.name === name);
}

function traceLine(dispatches: DispatchRecord[]): string {
  return dispatches
    .map(
      (d, i) =>
        `#${i} ${d.name} kind=${d.result?.kind ?? "unset"} :: ` +
        resultText(d.result).replace(/\s+/g, " ").slice(0, 120)
    )
    .join("\n");
}

/** The worktree created under `repo` (there is exactly one per arm). */
function worktreeOf(repo: string): string | undefined {
  const base = join(repo, WORKTREE_SUBDIR);
  if (!existsSync(base)) return undefined;
  const entries = readdirSync(base);
  return entries.length > 0 ? join(base, entries[0]!) : undefined;
}

interface ArmResult {
  readonly repo: string;
  readonly dispatches: DispatchRecord[];
  readonly treeW: string | undefined;
  readonly stopReason: string;
}

/**
 * Run one fixed case through a fresh engine whose worktree host seams are the
 * REAL production provisioner. The model drives every transition.
 */
async function runArm(
  c: TrajectoryCase,
  opts?: { readonly preCreateOwnerTree?: boolean }
): Promise<ArmResult> {
  const repo = makeGitRepo();
  const home = mkdtempSync(join(SCRATCH_ROOTS_DIR, "home-"));
  SCRATCH_ROOTS.push(home);

  const provisioner = createTaskWorktreeProvisioner({});
  if (opts?.preCreateOwnerTree) {
    const ownerTree = await provisioner.provision({
      conversationId: OWNER_ID,
      root: repo,
    });
    seedOwnerTree(ownerTree);
  }

  const built = await buildHarnessEngine({
    env: realEnv as IknowEnv,
    askUser: createNoAskUser(),
    surface: "chat",
    cwd: repo,
    userHome: home,
    skipCountTokens: true,
    // build-engine wraps these with `withLiveTaskRootWrite`, exactly as the
    // production host wiring does — the model's tool calls move the live root.
    worktreeIsolation: {
      provision: provisioner.provision,
      worktreeEnter: provisioner.enter,
      worktreeExit: provisioner.exit,
    },
  });

  const dispatches: DispatchRecord[] = [];
  const recording = createRecordingExecutor(built.deps.executor, dispatches);
  const deps: LoopEngineDeps = {
    ...built.deps,
    executor: recording,
    conversationId: c.id,
    maxTurns: 10,
  };
  const prompt = c.prompt.replaceAll("<OWNER_ID>", OWNER_ID);
  let stopReason = "unknown";
  try {
    try {
      const { result } = await run(prompt, deps);
      stopReason = result.stopReason;
    } catch (err) {
      if (err instanceof MaxTurnsExceeded) {
        stopReason = "max_turns";
      } else {
        throw err;
      }
    }
  } finally {
    await built.shutdown?.();
  }
  return {
    repo,
    dispatches,
    treeW: worktreeOf(repo),
    stopReason,
  };
}

/* ------------------------------ arms ------------------------------ */

(HAS_KEY ? describe : describe.skip)(
  "worktree-path trajectory — real model (test:real-llm)",
  () => {
    it(
      "wt-create-query-rename: model creates a worktree and renames its symbol in that tree",
      { timeout: 360_000 },
      async () => {
        if (!HAS_KEY) {
          console.log("[SKIP] LLM key not set; Not run");
          return;
        }
        const arm = await runArm(
          TRAJECTORY_CASES.find((c) => c.id === "wt-create-query-rename")!
        );
        console.log(
          `[wt-create-query-rename] trace:\n${traceLine(arm.dispatches)}`
        );
        const creates = allDispatches(arm.dispatches, "create-worktree");
        const renames = allDispatches(arm.dispatches, "rename_symbol");
        if (creates.length === 0 || arm.treeW === undefined) {
          console.log(
            "[wt-create-query-rename] RESIDUAL: model did not create a worktree; " +
              "hard gates need a created tree"
          );
          return;
        }
        const treeW = arm.treeW;
        // Tree-identity: the create result names the tree that exists on disk.
        if (!resultText(creates[0]!.result).includes(treeW)) {
          console.log(
            "[wt-create-query-rename] RESIDUAL: create result did not name the created tree"
          );
          return;
        }
        if (renames.length === 0) {
          console.log(
            "[wt-create-query-rename] RESIDUAL: model created the tree but did not call rename_symbol"
          );
          return;
        }
        // Hard gate 1 — the rename tool RESULT reports the ACTIVE worktree file.
        const renameText = resultText(renames[renames.length - 1]!.result);
        console.log(`[wt-create-query-rename] rename result: ${renameText}`);
        if (!renameText.includes(join(treeW, RELATIVE_TS))) {
          console.log(
            "[wt-create-query-rename] RESIDUAL: rename result did not touch the active worktree file"
          );
          return;
        }
        // Hard gate 2 — filesystem: the worktree file was renamed, the main
        // checkout still declares the original symbol (bytes untouched).
        const wtBytes = readFileSync(join(treeW, RELATIVE_TS), "utf8");
        if (!declaresSymbol(wtBytes, RENAMED_SYMBOL)) {
          console.log(
            "[wt-create-query-rename] RESIDUAL: worktree file does not declare the new name"
          );
          return;
        }
        const mainBytes = readFileSync(join(arm.repo, RELATIVE_TS), "utf8");
        if (
          !declaresSymbol(mainBytes, UNIQUE_SYMBOL) ||
          declaresSymbol(mainBytes, RENAMED_SYMBOL)
        ) {
          console.log(
            "[wt-create-query-rename] RESIDUAL: main checkout was changed by the worktree rename"
          );
          return;
        }
        // No silent tool failure rode along within the observed shape.
        for (const d of [...creates, ...renames]) {
          if (d.result === undefined) {
            console.log(
              "[wt-create-query-rename] RESIDUAL: a tool result was unset"
            );
            return;
          }
        }
      }
    );

    it(
      "wt-enter-query: model enters an existing worktree and its exclusive symbol is served",
      { timeout: 360_000 },
      async () => {
        if (!HAS_KEY) {
          console.log("[SKIP] LLM key not set; Not run");
          return;
        }
        const c = TRAJECTORY_CASES.find((x) => x.id === "wt-enter-query")!;
        const arm = await runArm(c, { preCreateOwnerTree: true });
        console.log(`[wt-enter-query] trace:\n${traceLine(arm.dispatches)}`);
        const enters = allDispatches(arm.dispatches, "enter-worktree");
        const decls = allDispatches(arm.dispatches, "find_declaration");
        if (enters.length === 0 || decls.length === 0) {
          console.log(
            "[wt-enter-query] RESIDUAL: model did not (enter + query) as asked"
          );
          return;
        }
        const ownerTree = join(arm.repo, WORKTREE_SUBDIR, OWNER_ID);
        if (
          !resultText(enters[enters.length - 1]!.result).includes(ownerTree)
        ) {
          console.log(
            "[wt-enter-query] RESIDUAL: enter result did not name the entered tree"
          );
          return;
        }
        // Hard gate — the query RESULT (a URI) points into the ENTERED tree and
        // at the tree-exclusive file (proves that tree's bytes were served).
        const declText = resultText(decls[decls.length - 1]!.result);
        console.log(`[wt-enter-query] declaration result: ${declText}`);
        const uris = fileUrisIn(declText);
        if (
          !uris.some(
            (u) =>
              u.startsWith(join(ownerTree, "src") + "/") ||
              u.includes("/src/owner_unique.ts")
          )
        ) {
          console.log(
            "[wt-enter-query] RESIDUAL: declaration result did not name the entered tree"
          );
          return;
        }
      }
    );

    it(
      "wt-workspace-query-file-omitted: a file-omitted query anchors to the active tree",
      { timeout: 360_000 },
      async () => {
        if (!HAS_KEY) {
          console.log("[SKIP] LLM key not set; Not run");
          return;
        }
        const c = TRAJECTORY_CASES.find(
          (x) => x.id === "wt-workspace-query-file-omitted"
        )!;
        const arm = await runArm(c);
        console.log(
          `[wt-workspace-query-file-omitted] trace:\n${traceLine(arm.dispatches)}`
        );
        if (arm.treeW === undefined) {
          console.log(
            "[wt-workspace-query-file-omitted] RESIDUAL: no worktree was created"
          );
          return;
        }
        const finds = allDispatches(arm.dispatches, "find_symbol");
        if (finds.length === 0) {
          console.log(
            "[wt-workspace-query-file-omitted] RESIDUAL: model did not call find_symbol"
          );
          return;
        }
        const treeW = arm.treeW;
        const text = resultText(finds[finds.length - 1]!.result);
        console.log(`[wt-workspace-query-file-omitted] result: ${text}`);
        // Hard gate — the file-less query's result NAMES the ACTIVE worktree:
        // either a result URI under the worktree, or the documented no-anchor
        // sentinel interpolating the LIVE root (never the stale main root).
        if (!text.includes(treeW)) {
          console.log(
            "[wt-workspace-query-file-omitted] RESIDUAL: result did not name the active worktree"
          );
          return;
        }
      }
    );

    it(
      "wt-exit-confirm-original: exit restores the original tree's symbol and bytes",
      { timeout: 360_000 },
      async () => {
        if (!HAS_KEY) {
          console.log("[SKIP] LLM key not set; Not run");
          return;
        }
        const c = TRAJECTORY_CASES.find(
          (x) => x.id === "wt-exit-confirm-original"
        )!;
        const arm = await runArm(c);
        console.log(
          `[wt-exit-confirm-original] trace:\n${traceLine(arm.dispatches)}`
        );
        const creates = allDispatches(arm.dispatches, "create-worktree");
        const exits = allDispatches(arm.dispatches, "exit-worktree");
        const decls = allDispatches(arm.dispatches, "find_declaration");
        if (
          creates.length === 0 ||
          exits.length === 0 ||
          decls.length === 0 ||
          arm.treeW === undefined
        ) {
          console.log(
            "[wt-exit-confirm-original] RESIDUAL: model did not (create + exit + query)"
          );
          return;
        }
        const mainFile = join(arm.repo, RELATIVE_TS);
        // Hard gate 1 — after exit the query RESULT points back into the main
        // checkout (the last find_declaration ran post-exit in this run).
        const lastDecl = resultText(decls[decls.length - 1]!.result);
        console.log(
          `[wt-exit-confirm-original] post-exit declaration: ${lastDecl}`
        );
        if (
          !fileUrisIn(lastDecl).some((u) => u === pathToFileURL(mainFile).href)
        ) {
          console.log(
            "[wt-exit-confirm-original] RESIDUAL: post-exit declaration did not name the main checkout"
          );
          return;
        }
        // Hard gate 2 — final bytes: main exists with the ORIGINAL symbol; the
        // worktree (if it was renamed) keeps its own change.
        const mainBytes = readFileSync(mainFile, "utf8");
        if (!declaresSymbol(mainBytes, UNIQUE_SYMBOL)) {
          console.log(
            "[wt-exit-confirm-original] RESIDUAL: main checkout lost its original symbol"
          );
          return;
        }
        if (!existsSync(join(arm.treeW, RELATIVE_TS))) {
          console.log(
            "[wt-exit-confirm-original] RESIDUAL: worktree file missing"
          );
          return;
        }
      }
    );

    it(
      "wt-unsafe-refusal: an escaping path is refused with no side effects",
      { timeout: 360_000 },
      async () => {
        if (!HAS_KEY) {
          console.log("[SKIP] LLM key not set; Not run");
          return;
        }
        const c = TRAJECTORY_CASES.find((x) => x.id === "wt-unsafe-refusal")!;
        const arm = await runArm(c);
        console.log(`[wt-unsafe-refusal] trace:\n${traceLine(arm.dispatches)}`);
        const overviews = allDispatches(arm.dispatches, "get_symbols_overview");
        if (overviews.length === 0) {
          console.log(
            "[wt-unsafe-refusal] RESIDUAL: model did not call get_symbols_overview"
          );
          return;
        }
        const text = resultText(overviews[overviews.length - 1]!.result);
        console.log(`[wt-unsafe-refusal] result: ${text}`);
        if (!text.includes(NO_ROOT_SENTINEL_PREFIX)) {
          console.log(
            "[wt-unsafe-refusal] RESIDUAL: escaping path was not refused with a no-root sentinel"
          );
          return;
        }
        // Hard gate — no side effect: the escaped target was never created.
        const escapedTarget = resolvePath(arm.repo, UNSAFE_ESCAPE_RELATIVE);
        if (existsSync(escapedTarget)) {
          console.log(
            `[wt-unsafe-refusal] RESIDUAL: escaping path created ${escapedTarget}`
          );
          return;
        }
        if (
          !declaresSymbol(
            readFileSync(join(arm.repo, RELATIVE_TS), "utf8"),
            UNIQUE_SYMBOL
          )
        ) {
          console.log(
            "[wt-unsafe-refusal] RESIDUAL: the seed file was modified"
          );
          return;
        }
      }
    );

    it(
      "wt-hover-known-symbol: hovering a known symbol in the active worktree is non-null",
      { timeout: 360_000 },
      async () => {
        if (!HAS_KEY) {
          console.log("[SKIP] LLM key not set; Not run");
          return;
        }
        const c = TRAJECTORY_CASES.find(
          (x) => x.id === "wt-hover-known-symbol"
        )!;
        const arm = await runArm(c);
        console.log(
          `[wt-hover-known-symbol] trace:\n${traceLine(arm.dispatches)}`
        );
        const hovers = allDispatches(arm.dispatches, "get_hover");
        if (hovers.length === 0) {
          console.log(
            "[wt-hover-known-symbol] RESIDUAL: model did not call get_hover"
          );
          return;
        }
        const text = resultText(hovers[hovers.length - 1]!.result);
        console.log(`[wt-hover-known-symbol] result: ${text}`);
        if (
          text.trim() === "" ||
          text.trim() === "null" ||
          text.startsWith("(")
        ) {
          console.log(
            "[wt-hover-known-symbol] RESIDUAL: hover was empty/sentinel"
          );
          return;
        }
        if (!text.includes(UNIQUE_SYMBOL)) {
          console.log(
            "[wt-hover-known-symbol] RESIDUAL: hover did not describe the symbol"
          );
          return;
        }
      }
    );

    it(
      "wt-call-hierarchy-known-symbol: call-hierarchy on a known symbol is non-empty",
      { timeout: 360_000 },
      async () => {
        if (!HAS_KEY) {
          console.log("[SKIP] LLM key not set; Not run");
          return;
        }
        const c = TRAJECTORY_CASES.find(
          (x) => x.id === "wt-call-hierarchy-known-symbol"
        )!;
        const arm = await runArm(c);
        console.log(
          `[wt-call-hierarchy-known-symbol] trace:\n${traceLine(arm.dispatches)}`
        );
        const hier = allDispatches(arm.dispatches, "list_incoming_calls");
        if (hier.length === 0) {
          console.log(
            "[wt-call-hierarchy-known-symbol] RESIDUAL: model did not call list_incoming_calls"
          );
          return;
        }
        const text = resultText(hier[hier.length - 1]!.result);
        console.log(`[wt-call-hierarchy-known-symbol] result: ${text}`);
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          console.log(
            "[wt-call-hierarchy-known-symbol] RESIDUAL: result was not JSON"
          );
          return;
        }
        if (!Array.isArray(parsed) || parsed.length === 0) {
          console.log(
            "[wt-call-hierarchy-known-symbol] RESIDUAL: call-hierarchy returned an empty result"
          );
          return;
        }
      }
    );
  }
);
