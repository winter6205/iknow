#!/usr/bin/env node
/**
 * Operator-only task-worktree garbage collector.
 *
 * The default is deliberately report-only. It reports local `iknow/task*`
 * branches that no longer have a linked worktree and whether their commits are
 * safe to delete. `--apply` is the only mode that runs `git branch -D`; this
 * script is not an ACI tool and never removes a linked worktree.
 *
 * Examples:
 *   npx tsx scripts/task-worktree-gc.ts
 *   npx tsx scripts/task-worktree-gc.ts --repo /path/to/repo --apply
 */
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { mainCheckoutOf } from "../src/harness/isolation/worktree-gate.js";

export interface TaskWorktreeGcEntry {
  readonly branch: string;
  readonly exclusiveCommits: number;
  readonly removable: boolean;
  readonly reason: string;
}

export interface TaskWorktreeGcReport {
  readonly repoRoot: string;
  readonly entries: ReadonlyArray<TaskWorktreeGcEntry>;
}

export interface TaskWorktreeGcApplyReport {
  readonly deleted: ReadonlyArray<string>;
  readonly failed: ReadonlyArray<{
    readonly branch: string;
    readonly error: string;
  }>;
}

export type SyncGitRunner = (
  args: ReadonlyArray<string>,
  cwd: string
) => string;

const defaultGitRunner: SyncGitRunner = (args, cwd) =>
  execFileSync("git", [...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

/**
 * Inspect stale task branches without mutating the repository.
 *
 * A branch is removable when it has no commits that are exclusive to it
 * relative to the current main checkout, or when all such commits are behind
 * its configured upstream. A branch with no usable upstream is conservatively
 * protected because its exclusive commits cannot be confirmed as pushed.
 */
export function planTaskWorktreeGc(
  root: string,
  runGit: SyncGitRunner = defaultGitRunner
): TaskWorktreeGcReport {
  const repoRoot = mainCheckoutOf(resolve(root));
  const linkedBranches = parseLinkedBranches(
    runGit(["worktree", "list", "--porcelain"], repoRoot)
  );
  const branches = parseTaskBranches(
    runGit(
      ["for-each-ref", "--format=%(refname:short)", "refs/heads/iknow/task*"],
      repoRoot
    )
  ).filter((branch) => !linkedBranches.has(branch));
  const mainHead = runGit(["rev-parse", "HEAD"], repoRoot).trim();

  const entries = branches.map((branch) =>
    inspectBranch(branch, repoRoot, mainHead, runGit)
  );
  return {
    repoRoot,
    entries: Object.freeze(entries),
  };
}

/** Delete only entries approved by `planTaskWorktreeGc`. */
export function applyTaskWorktreeGc(
  report: TaskWorktreeGcReport,
  runGit: SyncGitRunner = defaultGitRunner
): TaskWorktreeGcApplyReport {
  const deleted: string[] = [];
  const failed: Array<{ branch: string; error: string }> = [];
  for (const entry of report.entries) {
    if (!entry.removable) continue;
    try {
      runGit(["branch", "-D", entry.branch], report.repoRoot);
      deleted.push(entry.branch);
    } catch (err) {
      failed.push({
        branch: entry.branch,
        error: errorMessage(err),
      });
    }
  }
  return {
    deleted: Object.freeze(deleted),
    failed: Object.freeze(failed),
  };
}

function inspectBranch(
  branch: string,
  repoRoot: string,
  mainHead: string,
  runGit: SyncGitRunner
): TaskWorktreeGcEntry {
  const exclusiveCommits = parseCount(
    runGit(["rev-list", "--count", `${mainHead}..${branch}`], repoRoot),
    branch
  );
  if (exclusiveCommits === 0) {
    return {
      branch,
      exclusiveCommits,
      removable: true,
      reason: "no commits exclusive to this stale task branch",
    };
  }

  let upstream: string;
  try {
    upstream = runGit(
      [
        "rev-parse",
        "--abbrev-ref",
        "--symbolic-full-name",
        `${branch}@{upstream}`,
      ],
      repoRoot
    ).trim();
  } catch {
    // EXIT: a branch without a usable upstream cannot prove its exclusive
    // commits were pushed, so report it without making it removable.
    return {
      branch,
      exclusiveCommits,
      removable: false,
      reason: "exclusive commits have no usable upstream; push or merge first",
    };
  }
  if (upstream.length === 0) {
    // EXIT: an empty upstream result is the same conservative protection as a
    // missing upstream ref.
    return {
      branch,
      exclusiveCommits,
      removable: false,
      reason: "exclusive commits have no usable upstream; push or merge first",
    };
  }

  let ahead: number;
  try {
    ahead = parseCount(
      runGit(["rev-list", "--count", `${upstream}..${branch}`], repoRoot),
      branch
    );
  } catch {
    // EXIT: an unreadable upstream comparison must not turn into deletion.
    return {
      branch,
      exclusiveCommits,
      removable: false,
      reason: "could not compare the upstream; branch is protected",
    };
  }
  if (ahead > 0) {
    return {
      branch,
      exclusiveCommits,
      removable: false,
      reason: `${ahead} exclusive commit(s) are not confirmed pushed`,
    };
  }
  return {
    branch,
    exclusiveCommits,
    removable: true,
    reason: "exclusive commits are confirmed present on the upstream",
  };
}

function parseLinkedBranches(raw: string): Set<string> {
  const branches = new Set<string>();
  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith("branch refs/heads/")) {
      branches.add(line.slice("branch refs/heads/".length));
    }
  }
  return branches;
}

function parseTaskBranches(raw: string): string[] {
  return raw
    .split(/\r?\n/)
    .filter((branch) => branch.length > 0 && branch.startsWith("iknow/task"));
}

function parseCount(raw: string, branch: string): number {
  const normalized = raw.trim();
  const count = Number(normalized);
  if (!/^\d+$/.test(normalized) || !Number.isSafeInteger(count) || count < 0) {
    throw new Error(`invalid commit count for ${branch}`);
  }
  return count;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function printReport(report: TaskWorktreeGcReport): void {
  console.log(`task-worktree-gc: ${report.repoRoot}`);
  if (report.entries.length === 0) {
    console.log("  no stale task branches");
    return;
  }
  for (const entry of report.entries) {
    const state = entry.removable ? "removable" : "protected";
    console.log(
      `  ${state} ${entry.branch} (${entry.exclusiveCommits} exclusive): ${entry.reason}`
    );
  }
}

function parseArgs(argv: ReadonlyArray<string>): {
  readonly repoRoot: string;
  readonly apply: boolean;
} {
  let repoRoot = process.cwd();
  let apply = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--apply") {
      apply = true;
      continue;
    }
    if (arg === "--repo") {
      const value = argv[index + 1];
      if (value === undefined || value.length === 0) {
        throw new Error("--repo requires a path");
      }
      repoRoot = value;
      index += 1;
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }
  return { repoRoot: resolve(repoRoot), apply };
}

function main(): void {
  try {
    const args = parseArgs(process.argv.slice(2));
    const report = planTaskWorktreeGc(args.repoRoot);
    printReport(report);
    if (!args.apply) {
      console.log("  report-only: pass --apply to delete removable branches");
      return;
    }
    const applied = applyTaskWorktreeGc(report);
    for (const branch of applied.deleted) {
      console.log(`  deleted ${branch}`);
    }
    for (const failure of applied.failed) {
      console.error(`  failed ${failure.branch}: ${failure.error}`);
    }
    if (applied.failed.length > 0) process.exitCode = 1;
  } catch (err) {
    console.error(`task-worktree-gc failed: ${errorMessage(err)}`);
    process.exitCode = 1;
  }
}

const isDirectRun =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) ===
    fileURLToPath(pathToFileURL(process.argv[1]));

if (isDirectRun) {
  main();
}
