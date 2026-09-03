import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { afterAll, describe, it } from "vitest";

import {
  applyTaskWorktreeGc,
  planTaskWorktreeGc,
} from "../../scripts/task-worktree-gc.ts";

const roots: string[] = [];

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function makeGitRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "iknow-task-worktree-gc-"));
  roots.push(repo);
  git(repo, "init", "-q");
  git(
    repo,
    "-c",
    "user.email=t@t",
    "-c",
    "user.name=t",
    "commit",
    "--allow-empty",
    "-qm",
    "init"
  );
  return repo;
}

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe("task-worktree-gc", () => {
  it("reports only stale task branches and does not mutate in report-only mode", () => {
    const repo = makeGitRepo();
    const active = join(repo, "..", "iknow-gc-active");
    const protectedWorktree = join(repo, "..", "iknow-gc-protected");
    roots.push(active, protectedWorktree);
    git(repo, "worktree", "add", "-q", "-b", "iknow/task-active", active);
    git(
      repo,
      "worktree",
      "add",
      "-q",
      "-b",
      "iknow/task-protected",
      protectedWorktree
    );
    writeFileSync(join(protectedWorktree, "change.txt"), "unpublished\n");
    git(protectedWorktree, "add", "change.txt");
    git(
      protectedWorktree,
      "-c",
      "user.email=t@t",
      "-c",
      "user.name=t",
      "commit",
      "-qm",
      "unpublished"
    );
    git(repo, "worktree", "remove", protectedWorktree);
    git(repo, "branch", "iknow/task-removable");

    const before = git(repo, "for-each-ref", "--format=%(refname:short)");
    const report = planTaskWorktreeGc(repo);

    assert.ok(
      report.entries.some(
        (entry) =>
          entry.branch === "iknow/task-removable" &&
          entry.exclusiveCommits === 0 &&
          entry.removable === true
      ),
      `report should mark iknow/task-removable as removable; got: ${JSON.stringify(report.entries)}`
    );
    assert.ok(
      report.entries.some(
        (entry) =>
          entry.branch === "iknow/task-protected" &&
          entry.exclusiveCommits === 1 &&
          entry.removable === false
      ),
      `report should mark iknow/task-protected as protected; got: ${JSON.stringify(report.entries)}`
    );
    assert.ok(
      !report.entries.some((entry) => entry.branch === "iknow/task-active"),
      `report must not list the active branch; got: ${JSON.stringify(report.entries)}`
    );
    assert.equal(
      git(repo, "for-each-ref", "--format=%(refname:short)"),
      before
    );
  });

  it("apply deletes only the approved stale branches", () => {
    const repo = makeGitRepo();
    const protectedWorktree = join(repo, "..", "iknow-gc-protected-apply");
    roots.push(protectedWorktree);
    git(
      repo,
      "worktree",
      "add",
      "-q",
      "-b",
      "iknow/task-protected",
      protectedWorktree
    );
    writeFileSync(join(protectedWorktree, "change.txt"), "unpublished\n");
    git(protectedWorktree, "add", "change.txt");
    git(
      protectedWorktree,
      "-c",
      "user.email=t@t",
      "-c",
      "user.name=t",
      "commit",
      "-qm",
      "unpublished"
    );
    git(repo, "worktree", "remove", protectedWorktree);
    git(repo, "branch", "iknow/task-removable");
    const report = planTaskWorktreeGc(repo);

    const applied = applyTaskWorktreeGc(report);

    assert.deepEqual(applied.deleted, ["iknow/task-removable"]);
    assert.deepEqual(applied.failed, []);
    assert.equal(git(repo, "branch", "--list", "iknow/task-removable"), "");
    assert.ok(
      git(repo, "branch", "--list", "iknow/task-protected").includes(
        "iknow/task-protected"
      )
    );
  });
});
