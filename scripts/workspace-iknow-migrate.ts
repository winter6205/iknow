#!/usr/bin/env node
/**
 * One-off migration of leftover `.iknow` state out of a workspace — ADR-0087 / ADR-0088.
 *
 * Context: ADR-0019 briefly put the session pool and the background-task
 * registry under `<workspaceRoot>/.iknow/`. ADR-0087 pinned the session pool
 * back to home (unless `--data-dir` is explicit) and ADR-0088 moved tasks onto
 * the same home project tree, so workspaces may still hold three kinds of legacy drops:
 *
 *   - `<ws>/.iknow/projects/<slug>/<convId>/`  conversation folders mis-written into the workspace
 *   - `<ws>/.iknow/sessions/<proj>/<id>.jsonl` retired flat-jsonl tree
 *   - `<ws>/.iknow/tasks/<task_id>.{json,log}` background-task registry mis-written into the workspace
 *
 * Semantics = merge item-by-item into the matching pool location; conflicts are
 * skipped, never overwritten:
 *   - `projects/` → `<pool>/projects/<slug>/<convId>/` (ADR-0087: mis-written
 *     conversation folders go to `~/.iknow/projects/`; on a same-conversation
 *     leaf conflict the pool side is kept).
 *   - `sessions/` → `<pool>/sessions/` retired pool (ADR-0087: the product
 *     never writes here; flat jsonl merges shape-preserved into the same-shaped
 *     old tree, deliberately NOT converted into `projects/` leaves).
 *   - `tasks/` → `<pool>/projects/<identity-slug>/tasks/` (ADR-0088: registries
 *     move into the home project tree; existing targets are skipped).
 *
 * Behaviour contract:
 *   - merge only, never convert: flat jsonl under `sessions/` never becomes a
 *     conversation folder (ADR-0071 L3).
 *   - never overwrite: an existing target **item** (conversation leaf / jsonl /
 *     task file) is SKIPped and counted.
 *   - idempotent: missing or empty source → 0 items; source dirs emptied by the
 *     move (including intermediate slug / category dirs) are deleted when empty,
 *     kept when not — residue is either gone or only conflict-SKIPped leaves.
 *   - report-only by default; disk is touched only with `--apply` (same posture
 *     as scripts/task-worktree-gc.ts).
 *   - not a substitute for grep exclusions: this script only moves storage locations.
 *
 * Usage:
 *   npx tsx scripts/workspace-iknow-migrate.ts [--workspace <dir>] [--pool <dir>]
 *                                              [--identity-root <dir>] [--apply]
 *
 * Defaults: `--workspace` = repo root (walked up from import.meta.url);
 * `--pool` = `~/.iknow` (ADR-0087 formula; users with an explicit `--data-dir`
 * pass their own `--pool`); `--identity-root` =
 * `deriveProjectIdentityRoot({ cwd: workspaceRoot })` for the task destination
 * slug — same formula as product code, never a second slug scheme.
 */
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { resolveProjectSessionDir } from "../src/session-api/store/index.ts";
import { deriveProjectIdentityRoot } from "../src/harness/session-roots.ts";

/** One item-level move: a source path → its pool-side target path. */
export interface WorkspaceIknowMove {
  /** Category (for report grouping). */
  readonly category: "projects" | "sessions" | "tasks";
  /** Absolute source path. */
  readonly source: string;
  /** Absolute pool-side target path. */
  readonly target: string;
  /**
   * Why this entry was classified as a conflict (target already exists / source
   * is a symlink / hostile path name / …), decided by the plan; undefined for
   * non-conflicts. The apply phase never recomputes it (avoids a second walk) —
   * display only.
   */
  readonly reason?: string;
}

/** Plan: movable items plus items skipped (target exists / never-processable source kinds). */
export interface WorkspaceIknowPlan {
  /** Executable item-level moves. */
  readonly moves: ReadonlyArray<WorkspaceIknowMove>;
  /** Items never processed: target already exists, symlink source, hostile path name (source paths). */
  readonly conflicts: ReadonlyArray<WorkspaceIknowMove>;
}

/** Execution result. */
export interface WorkspaceIknowReport {
  readonly moved: ReadonlyArray<WorkspaceIknowMove>;
  readonly conflicts: ReadonlyArray<WorkspaceIknowMove>;
  /** Dirs deleted after being emptied (incl. intermediate slug / category dirs). */
  readonly removedDirs: ReadonlyArray<string>;
  /**
   * Items this pass could not move — non-EXDEV failures, hostile paths,
   * symlinks, etc. Errors are accumulated, not thrown, so remaining moves
   * still run; callers set exitCode=1 on `failed.length > 0`. Previously a
   * non-EXDEV error threw mid-loop: earlier moves had landed but later ones
   * were skipped, and a re-run just recomputed the plan (moved items vanish);
   * this field converges the semantics to "finish as much as possible +
   * report failures".
   */
  readonly failed: ReadonlyArray<{
    readonly category: "projects" | "sessions" | "tasks";
    readonly source: string;
    readonly error: string;
  }>;
}

/**
 * Hostile-name guard — a name containing `/`, `\` or NUL, or equal to `.` /
 * `..`, is unsafe: even if readdir bypasses it, it must never participate in a
 * join (it could escape the target dir or hit a NUL syscall rejection).
 * plan/apply classify hits as conflicts.
 *
 * readdirSync returns single-segment basenames, but real on-disk names may
 * contain these characters (rare but legal), so filtering must happen before
 * the join — a fail-closed guard, not a UX nicety.
 */
export function isHostileName(name: string): boolean {
  if (name === "." || name === "..") return true;
  if (name.includes("/") || name.includes("\\") || name.includes("\0")) {
    return true;
  }
  return false;
}

function listEntries(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/**
 * List one directory level, splitting hostile names and symlinks out:
 *
 *   - `safe`: ordinary entries eligible for join (regular files / dirs with a
 *     single-segment, separator-free name);
 *   - `rejected`: names containing `/` / `\` / NUL or equal to `.` / `..` —
 *     never joined into a target path (escape or syscall-rejection risk);
 *   - `symlinks`: entries whose lstat says symbolic link — never moved through
 *     (renameSync would follow the link target, while cpSync's verbatimSymlinks
 *     would preserve the link; two mutually exclusive semantics on one field,
 *     so refusing outright is safest).
 *
 * Returns a struct, not a bare array: callers classify by (a, b) level, so the
 * level information cannot be lost.
 */
function scanLevel(dir: string): {
  readonly safe: string[];
  readonly rejected: Array<{ readonly name: string; readonly reason: string }>;
  readonly symlinks: Array<{ readonly name: string; readonly reason: string }>;
} {
  const safe: string[] = [];
  const rejected: Array<{ name: string; reason: string }> = [];
  const symlinks: Array<{ name: string; reason: string }> = [];
  for (const name of listEntries(dir)) {
    if (isHostileName(name)) {
      rejected.push({ name, reason: "路径敌意名（含分隔符 / NUL / . / ..）" });
      continue;
    }
    try {
      if (lstatSync(join(dir, name)).isSymbolicLink()) {
        symlinks.push({ name, reason: "符号链接（不穿过链接移动）" });
        continue;
      }
    } catch {
      continue;
    }
    safe.push(name);
  }
  return { safe, rejected, symlinks };
}

/**
 * Depth-2 enumeration of `<base>/<a>/<b>` (b is file or dir); both levels must exist.
 * Each level's scanLevel output folds rejected / symlinks back in as reasoned
 * conflicts, so the plan phase counts them (nonzero exit code) instead of
 * skipping them silently.
 */
function listTwoLevel(base: string): {
  readonly items: Array<{ readonly a: string; readonly b: string }>;
  readonly rejected: ReadonlyArray<{
    readonly path: string;
    readonly reason: string;
  }>;
} {
  const items: Array<{ a: string; b: string }> = [];
  const rejected: Array<{ path: string; reason: string }> = [];
  const levelA = scanLevel(base);
  for (const r of [...levelA.rejected, ...levelA.symlinks]) {
    rejected.push({ path: join(base, r.name), reason: r.reason });
  }
  for (const a of levelA.safe) {
    const aPath = join(base, a);
    const levelB = scanLevel(aPath);
    for (const r of [...levelB.rejected, ...levelB.symlinks]) {
      rejected.push({ path: join(aPath, r.name), reason: r.reason });
    }
    for (const b of levelB.safe) items.push({ a, b });
  }
  return { items, rejected };
}

/**
 * Depth-1 enumeration of `<base>/<a>` (a is file or dir), same conflict
 * classification as listTwoLevel.
 */
function listOneLevel(base: string): {
  readonly items: readonly string[];
  readonly rejected: ReadonlyArray<{
    readonly path: string;
    readonly reason: string;
  }>;
} {
  const level = scanLevel(base);
  return {
    items: level.safe,
    rejected: [...level.rejected, ...level.symlinks].map((r) => ({
      path: join(base, r.name),
      reason: r.reason,
    })),
  };
}

/**
 * Read-only plan: every mergeable item under the three legacy dirs, plus
 * conflicts whose target already exists.
 *
 * Pure query (creates no dirs, moves nothing). Stable lexicographic order so
 * reports and tests are reproducible.
 *
 * scanLevel rejections fold into `conflicts` too — they are "source type / name
 * not migratable" rather than "target exists", but share the same semantics
 * (never overwrite, never continue); the CLI reports all of them as conflicts
 * and forces exit code 1.
 */
export function planWorkspaceIknowMigrate(opts: {
  readonly workspaceRoot: string;
  readonly poolRoot: string;
  readonly projectIdentityRoot: string;
}): WorkspaceIknowPlan {
  const wsRoot = resolve(opts.workspaceRoot);
  const poolRoot = resolve(opts.poolRoot);
  const identityRoot = resolve(opts.projectIdentityRoot);
  const legacyRoot = join(wsRoot, ".iknow");
  const targetTaskDir = join(
    resolveProjectSessionDir(poolRoot, identityRoot),
    "tasks"
  );

  const candidates: WorkspaceIknowMove[] = [];
  const rejected: WorkspaceIknowMove[] = [];

  // projects/<slug>/<convId> → <pool>/projects/<slug>/<convId> (per conversation leaf)
  {
    const { items, rejected: bad } = listTwoLevel(join(legacyRoot, "projects"));
    for (const r of bad) {
      rejected.push({
        category: "projects",
        source: r.path,
        target: r.path,
        reason: r.reason,
      });
    }
    for (const { a, b } of items) {
      candidates.push({
        category: "projects",
        source: join(legacyRoot, "projects", a, b),
        target: join(poolRoot, "projects", a, b),
      });
    }
  }
  // sessions/<proj>/<item> → <pool>/sessions/<proj>/<item> (shape preserved; never converted to conversation folders)
  {
    const { items, rejected: bad } = listTwoLevel(join(legacyRoot, "sessions"));
    for (const r of bad) {
      rejected.push({
        category: "sessions",
        source: r.path,
        target: r.path,
        reason: r.reason,
      });
    }
    for (const { a, b } of items) {
      candidates.push({
        category: "sessions",
        source: join(legacyRoot, "sessions", a, b),
        target: join(poolRoot, "sessions", a, b),
      });
    }
  }
  // tasks/<item> → <pool>/projects/<identity-slug>/tasks/<item>
  {
    const { items, rejected: bad } = listOneLevel(join(legacyRoot, "tasks"));
    for (const r of bad) {
      rejected.push({
        category: "tasks",
        source: r.path,
        target: r.path,
        reason: r.reason,
      });
    }
    for (const a of items) {
      candidates.push({
        category: "tasks",
        source: join(legacyRoot, "tasks", a),
        target: join(targetTaskDir, a),
      });
    }
  }

  candidates.sort((x, y) =>
    x.source < y.source ? -1 : x.source > y.source ? 1 : 0
  );
  const moves: WorkspaceIknowMove[] = [];
  const conflicts: WorkspaceIknowMove[] = [];
  for (const c of candidates) {
    if (existsSync(c.target)) {
      conflicts.push({ ...c, reason: "目标已存在（不覆盖）" });
    } else moves.push(c);
  }
  // Source-only conflicts (symlink / hostile name) have no comparable target —
  // they carry an explicit reason, never enter moves, and are never joined into a target path.
  conflicts.push(...rejected);
  conflicts.sort((x, y) =>
    x.source < y.source ? -1 : x.source > y.source ? 1 : 0
  );
  return { moves, conflicts };
}

/**
 * Execute the plan: same-device `rename` first (atomic, zero-copy); on EXDEV
 * fall back to recursive copy + source delete. Source dirs (and their
 * intermediate slug / category dirs) emptied by the moves are deleted when empty.
 *
 * Failure semantics: **no single failure throws** — previously a non-EXDEV
 * error aborted the loop, so completed moves had landed but the remaining ones
 * were skipped and one dry-run report looked incomplete. Now a failure
 * accumulates into `failed`, remaining moves continue, and the CLI entry sets
 * exitCode=1 on `failed.length > 0`. The report prints the failed list too.
 */
export function applyWorkspaceIknowMigrate(
  plan: WorkspaceIknowPlan,
  opts: { readonly workspaceRoot: string }
): WorkspaceIknowReport {
  const moved: WorkspaceIknowMove[] = [];
  const failed: Array<{
    readonly category: "projects" | "sessions" | "tasks";
    readonly source: string;
    readonly error: string;
  }> = [];
  for (const move of plan.moves) {
    try {
      mkdirSync(dirname(move.target), { recursive: true });
      try {
        renameSync(move.source, move.target);
      } catch (err) {
        if (!isExdev(err)) throw err;
        cpSync(move.source, move.target, {
          recursive: true,
          verbatimSymlinks: true,
        });
        rmSync(move.source, { recursive: true, force: true });
      }
      moved.push(move);
    } catch (err) {
      failed.push({
        category: move.category,
        source: move.source,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  const removedDirs = pruneEmptyLegacyDirs(resolve(opts.workspaceRoot), moved);
  return {
    moved,
    conflicts: plan.conflicts,
    removedDirs,
    failed,
  };
}

/** Walk up from moved items and delete emptied dirs: category/<slug> and the category dir itself. */
function pruneEmptyLegacyDirs(
  wsRoot: string,
  moved: ReadonlyArray<WorkspaceIknowMove>
): string[] {
  const removed: string[] = [];
  const candidates = new Set<string>();
  for (const m of moved) {
    let dir = join(m.source, "..");
    const stop = join(wsRoot, ".iknow");
    // collect only the category level and one below (sessions/<proj>, projects/<slug>, tasks itself)
    while (dir.startsWith(stop) && dir !== stop) {
      candidates.add(dir);
      const parent = join(dir, "..");
      if (parent === stop) break;
      dir = parent;
    }
  }
  // delete deepest first so parents can become empty afterwards
  const ordered = [...candidates].sort((x, y) => y.length - x.length);
  for (const dir of ordered) {
    try {
      if (readdirSync(dir).length === 0) {
        rmSync(dir, { recursive: true, force: true });
        removed.push(dir);
      }
    } catch (err) {
      // Explicitly ENOENT-tolerant: dir already gone = the "empty / deleted"
      // contract is met. Any other readdir error is a real read failure and is
      // rethrown, never swallowed silently, so callers / operators see fs faults
      // in the logs (avoids masking broken filesystems).
      if (!isEnoent(err)) {
        throw err;
      }
    }
  }
  return removed.sort();
}

function isExdev(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === "EXDEV"
  );
}

function isEnoent(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === "ENOENT"
  );
}

// -- CLI main -----------------------------------------------------------------

const DEFAULT_WORKSPACE = resolve(
  fileURLToPath(new URL("..", import.meta.url))
);

interface CliArgs {
  readonly workspaceRoot: string;
  readonly poolRoot: string;
  readonly identityRoot: string;
  readonly apply: boolean;
}

function parseArgs(argv: ReadonlyArray<string>): CliArgs {
  let workspaceRoot = DEFAULT_WORKSPACE;
  let poolRoot = join(homedir(), ".iknow");
  let identityRoot: string | undefined;
  let apply = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") {
      apply = true;
    } else if (
      a === "--workspace" ||
      a === "--pool" ||
      a === "--identity-root"
    ) {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`missing value for ${a}`);
      if (a === "--workspace") workspaceRoot = resolve(value);
      else if (a === "--pool") poolRoot = resolve(value);
      else identityRoot = resolve(value);
      i += 1;
    } else {
      throw new Error(`unknown argument: ${a}`);
    }
  }
  return {
    workspaceRoot,
    poolRoot,
    identityRoot:
      identityRoot ?? deriveProjectIdentityRoot({ cwd: workspaceRoot }),
    apply,
  };
}

function printPlan(plan: WorkspaceIknowPlan, apply: boolean): void {
  console.log("workspace-iknow-migrate（ADR-0087 / ADR-0088，plan T3）");
  console.log(`  模式: ${apply ? "apply" : "report-only（--apply 才动盘）"}`);
  if (plan.moves.length === 0 && plan.conflicts.length === 0) {
    console.log("  无工作区遗留项可迁移（源不存在或已空）。");
  }
  for (const m of plan.moves) {
    console.log(`  MOVE  [${m.category}] ${m.source}\n          → ${m.target}`);
  }
  for (const c of plan.conflicts) {
    const why = c.reason ?? "目标已存在（不覆盖）";
    console.log(`  SKIP  [${c.category}] ${c.source} — ${why}`);
  }
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const plan = planWorkspaceIknowMigrate({
    workspaceRoot: args.workspaceRoot,
    poolRoot: args.poolRoot,
    projectIdentityRoot: args.identityRoot,
  });
  let failedCount = 0;
  if (args.apply) {
    const report = applyWorkspaceIknowMigrate(plan, {
      workspaceRoot: args.workspaceRoot,
    });
    printPlan({ moves: report.moved, conflicts: report.conflicts }, true);
    console.log(
      `  已移走 ${report.moved.length} 项；跳过 ${report.conflicts.length} 项。`
    );
    if (report.removedDirs.length > 0) {
      console.log(`  收空目录 ${report.removedDirs.length} 个：`);
      for (const d of report.removedDirs) console.log(`    - ${d}`);
    }
    // Non-EXDEV failures no longer throw; they accumulate per item here and
    // are listed one by one with exit code forced to 1. Previously the first
    // failure aborted the run, so operators could not see the completed / pending split.
    failedCount = report.failed.length;
    if (report.failed.length > 0) {
      console.log(`  失败 ${report.failed.length} 项（继续跑完剩余项）：`);
      for (const f of report.failed) {
        console.log(`    ! [${f.category}] ${f.source} — ${f.error}`);
      }
    }
  } else {
    printPlan(plan, false);
  }
  // Nonzero exit: any conflict (incl. hostile name / symlink) or any apply-stage failure.
  process.exitCode = plan.conflicts.length > 0 || failedCount > 0 ? 1 : 0;
}

/**
 * Run the CLI only when invoked directly
 * (`npx tsx scripts/workspace-iknow-migrate.ts`); importing as a test module never triggers it.
 */
const isDirectRun =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) ===
    fileURLToPath(pathToFileURL(process.argv[1]));

if (isDirectRun) {
  main();
}
