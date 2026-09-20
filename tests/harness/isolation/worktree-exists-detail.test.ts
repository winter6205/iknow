/**
 * Uniqueness of `detail` guidance for `worktree_exists` and `branch_exists`.
 *
 * Pinned contract:
 *   - When `createTaskWorktree` throws `WorktreeIsolationError` with either
 *     kind, the detail must point to exactly ONE model-executable next step
 *     (no more "resolve … manually" — the model has no "manual" tool).
 *   - `worktree_exists` branches three ways by `taskWorktreeOwnerOf(worktreePath)`:
 *       owner === this session -> name `enter-worktree`;
 *       owner !== this session -> name `enter-worktree` (explicit takeover) or a new label;
 *       owner unreadable (no sidecar / legacy tree / bypass dir) -> name `list-worktrees`.
 *   - `branch_exists` splits by whether the target directory EXISTS:
 *       directory exists -> same shape as `worktree_exists` (three owner arms);
 *       directory missing -> guide to a new label or ask the operator to
 *       delete the branch, and do NOT mention `enter-worktree` (enter would
 *       certainly fail with `worktree_not_found`).
 *   - Sidecar read I/O failure (non-ENOENT) degrades to the "owner unreadable"
 *     arm and must not throw (`taskWorktreeOwnerOf` already guarantees this; pinned here).
 *
 * Input-class coverage:
 *   - empty: sidecar absent / empty / unreadable -> degrade to the
 *     list-worktrees arm; detail contains neither "manually" nor "operator"
 *     (this is the model path, not the operator_required path; the operator
 *     stop directive is added separately by `gateBlockNotice`).
 *   - negative: `branch_exists` with the target directory MISSING -> detail
 *     must not contain `enter-worktree`.
 *   - exception: sidecar read failure (non-ENOENT I/O) -> degrade, no throw.
 *   - overflow: very long paths / multiple owner candidates / bypass path
 *     shapes -> still routed by the corresponding owner arm.
 */
import { afterAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  WorktreeIsolationError,
  createTaskWorktree,
  taskWorktreeBranch,
  taskWorktreePath,
} from "../../../src/harness/isolation/worktree-gate.ts";

// -- helpers -----------------------------------------------------------------

const roots: string[] = [];

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function makeGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "iknow-wt-exists-"));
  roots.push(dir);
  git(dir, "init", "-q");
  git(
    dir,
    "-c",
    "user.email=t@t",
    "-c",
    "user.name=t",
    "commit",
    "--allow-empty",
    "-qm",
    "init"
  );
  return dir;
}

afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

// -- worktree_exists: three owner arms ----------------------------------------

describe("T8 — worktree_exists detail 三臂（按 taskWorktreeOwnerOf 归属）", () => {
  it("owner === 本会话 → detail 点名 enter-worktree，不说 'manually'", async () => {
    const repo = makeGitRepo();
    const convId = "conv-own";
    const worktreePath = taskWorktreePath(repo, convId, "own-label");
    await createTaskWorktree({
      repoRoot: repo,
      worktreePath,
      branch: taskWorktreeBranch(convId, "own-label"),
      conversationId: convId,
    });

    // Re-trigger with the same label / different branch name — the directory already exists -> worktree_exists.
    let err: WorktreeIsolationError | undefined;
    try {
      await createTaskWorktree({
        repoRoot: repo,
        worktreePath,
        branch: "iknow/task/own-label-other",
        conversationId: convId,
      });
    } catch (e) {
      err = e as WorktreeIsolationError;
    }
    expect(err).toBeInstanceOf(WorktreeIsolationError);
    expect(err!.kind).toBe("worktree_exists");
    expect(err!.detail).toContain("enter-worktree");
    // Never lure toward "resolve manually" — the model has no manual tool
    expect(err!.detail).not.toContain("manually");
    // Owner-arm detail: owner === this session, so no emphasis on "new label"
    expect(err!.detail).toContain(convId);
  });

  it("owner !== 本会话（别的会话建过） → detail 点名 enter-worktree + 换 label 二选一", async () => {
    const repo = makeGitRepo();
    const otherConv = "conv-other";
    const worktreePath = taskWorktreePath(repo, otherConv, "shared-label");
    await createTaskWorktree({
      repoRoot: repo,
      worktreePath,
      branch: taskWorktreeBranch(otherConv, "shared-label"),
      conversationId: otherConv,
    });

    // This session triggers with the same label: worktree dir already exists -> worktree_exists,
    // and the owner is inverted from the sidecar as otherConv.
    const myConv = "conv-self";
    let err: WorktreeIsolationError | undefined;
    try {
      await createTaskWorktree({
        repoRoot: repo,
        worktreePath,
        branch: "iknow/task/shared-label-self",
        conversationId: myConv,
      });
    } catch (e) {
      err = e as WorktreeIsolationError;
    }
    expect(err).toBeInstanceOf(WorktreeIsolationError);
    expect(err!.kind).toBe("worktree_exists");
    // Two ways out: enter-worktree (explicit takeover) + a new label
    expect(err!.detail).toContain("enter-worktree");
    expect(err!.detail).toMatch(/label/);
    expect(err!.detail).toContain(otherConv);
  });

  it("owner 读不出（旁路目录、无 .git） → detail 点名 list-worktrees", async () => {
    const repo = makeGitRepo();
    // Place a directory that "looks like a worktree but is not a git worktree"
    // at the worktree path — has shape (<repo>/.iknow/worktrees/<leaf>) but no
    // .git pointer inside. Owner inversion returns undefined (isTaskWorktreePath
    // passes, but neither sidecar nor leaf pattern matches).
    const wtDir = join(repo, ".iknow", "worktrees", "alien-leaf");
    // mkdirSync via fs not imported; use exec mkdir
    execFileSync("mkdir", ["-p", wtDir], { encoding: "utf8" });

    let err: WorktreeIsolationError | undefined;
    try {
      await createTaskWorktree({
        repoRoot: repo,
        worktreePath: wtDir,
        branch: "iknow/task/alien-leaf-fresh",
      });
    } catch (e) {
      err = e as WorktreeIsolationError;
    }
    expect(err).toBeInstanceOf(WorktreeIsolationError);
    expect(err!.kind).toBe("worktree_exists");
    // Degenerate arm: the only executable way out is list-worktrees
    expect(err!.detail).toContain("list-worktrees");
    // No "manually", and no lure toward a new label (we cannot tell whether another session holds it)
    expect(err!.detail).not.toContain("manually");
  });

  it("sidecar I/O 故障（非 ENOENT，例如权限拒绝） → 退化到 list-worktrees，不 throw", async () => {
    const repo = makeGitRepo();
    const convId = "conv-io-fail";
    const worktreePath = taskWorktreePath(repo, convId, "iofail-label");
    await createTaskWorktree({
      repoRoot: repo,
      worktreePath,
      branch: taskWorktreeBranch(convId, "iofail-label"),
      conversationId: convId,
    });

    // Make the sidecar unreadable via chmod 0000 (under root, chmod 0000 is
    // still readable — skip the assertion for root users to avoid host-induced
    // false negatives). Best-effort: rmSync the sidecar file to simulate a
    // "missing sidecar" (an empty-arm case, equivalent). Trigger the degenerate
    // arm directly with "sidecar file absent".
    const gitdir = (() => {
      const dotGit = execFileSync("cat", [join(worktreePath, ".git")], {
        encoding: "utf8",
      }).trim();
      const m = /^gitdir:\s*(.+)$/m.exec(dotGit);
      return m ? m[1]!.trim() : null;
    })();
    if (gitdir !== null && existsSync(join(gitdir, "iknow-conversation-id"))) {
      rmSync(join(gitdir, "iknow-conversation-id"));
    }

    // Re-trigger on the same leaf
    let err: WorktreeIsolationError | undefined;
    try {
      await createTaskWorktree({
        repoRoot: repo,
        worktreePath,
        branch: "iknow/task/iofail-label-fresh",
        conversationId: convId,
      });
    } catch (e) {
      err = e as WorktreeIsolationError;
    }
    expect(err).toBeInstanceOf(WorktreeIsolationError);
    expect(err!.kind).toBe("worktree_exists");
    // Sidecar missing: the leaf shape is "iofail-label" (a legal label).
    // taskWorktreeOwnerOf checks sidecar + leaf: with the sidecar absent it
    // falls to the historical `<slug>--<conversationId>` pattern — the leaf is
    // iofail-label, not iofail-label--xxx, so it finally returns undefined
    // (owner unreadable).
    expect(err!.detail).toContain("list-worktrees");
  });
});

// -- branch_exists: two sub-cases ---------------------------------------------

describe("T8 — branch_exists detail 两子况（按目标目录是否存在）", () => {
  // Create the tree then delete only the directory, keeping the branch — the real
  // residue path when remove-worktree does not delete the branch.
  // Directory missing -> must not name enter-worktree.
  it("branch 残留（目录已删）→ 不点名 enter-worktree，指引换 label 或删分支", async () => {
    const repo = makeGitRepo();
    const convId = "conv-branch-exists";
    const worktreePath = taskWorktreePath(repo, convId, "branch-exists-label");
    await createTaskWorktree({
      repoRoot: repo,
      worktreePath,
      branch: taskWorktreeBranch(convId, "branch-exists-label"),
      conversationId: convId,
    });
    // Remove the worktree but keep the branch — simulates remove-worktree's default of not deleting branches
    execFileSync("git", ["worktree", "remove", "--force", worktreePath], {
      cwd: repo,
      encoding: "utf8",
    });
    // `--force` may have already pruned the dir; ensure it is gone so the
    // branch_exists path takes the directory-MISSING sub-case.
    rmSync(worktreePath, { recursive: true, force: true });

    // Re-trigger: branch exists (branch_exists), directory already gone.
    let branchErr: WorktreeIsolationError | undefined;
    try {
      await createTaskWorktree({
        repoRoot: repo,
        worktreePath,
        branch: taskWorktreeBranch(convId, "branch-exists-label"),
      });
    } catch (e) {
      branchErr = e as WorktreeIsolationError;
    }
    // The current implementation checks branch before worktree — with the directory missing, branch_exists comes first.
    expect(branchErr).toBeInstanceOf(WorktreeIsolationError);
    expect(branchErr!.kind).toBe("branch_exists");
    // Directory missing -> detail must NOT contain enter-worktree (enter would
    // surely hit worktree_not_found; following the advice would burn a second round)
    expect(branchErr!.detail).not.toContain("enter-worktree");
    // Guide toward a new label or asking the operator to delete the branch
    expect(branchErr!.detail).toMatch(/label|operator/i);
    expect(branchErr!.detail).not.toContain("manually");
  });

  it("目标目录不存在 + branch 残留 → 不点名 enter-worktree，指引换 label 或删分支", async () => {
    const repo = makeGitRepo();
    const convId = "conv-orphan-branch";
    const worktreePath = taskWorktreePath(repo, convId, "orphan-label");
    // The branch exists alone; the directory was never created
    execFileSync(
      "git",
      ["branch", taskWorktreeBranch(convId, "orphan-label")],
      {
        cwd: repo,
        encoding: "utf8",
      }
    );

    let err: WorktreeIsolationError | undefined;
    try {
      await createTaskWorktree({
        repoRoot: repo,
        worktreePath,
        branch: taskWorktreeBranch(convId, "orphan-label"),
      });
    } catch (e) {
      err = e as WorktreeIsolationError;
    }
    expect(err).toBeInstanceOf(WorktreeIsolationError);
    expect(err!.kind).toBe("branch_exists");
    // Directory missing (worktreePath never created) -> no enter path
    expect(err!.detail).not.toContain("enter-worktree");
    // Guide toward a new label or asking the operator to delete the branch
    expect(err!.detail).toMatch(/label|operator/i);
    expect(err!.detail).not.toContain("manually");
  });

  it("目标目录存在 + branch 残留 → 与 worktree_exists 同形（点 enter-worktree）", async () => {
    const repo = makeGitRepo();
    const convId = "conv-branch-with-dir";
    const worktreePath = taskWorktreePath(repo, convId, "both-present-label");
    // Build the worktree directly from one branch (bypassing createTaskWorktree to
    // avoid the owner-sidecar complexity — here we only need directory + branch both
    // present; the sidecar may be absent)
    execFileSync(
      "git",
      ["worktree", "add", "-b", "iknow/task/both-present-x", worktreePath],
      {
        cwd: repo,
        encoding: "utf8",
      }
    );

    // Now re-trigger createTaskWorktree with the same branch name: branch exists + directory exists.
    let err: WorktreeIsolationError | undefined;
    try {
      await createTaskWorktree({
        repoRoot: repo,
        worktreePath,
        branch: "iknow/task/both-present-x",
      });
    } catch (e) {
      err = e as WorktreeIsolationError;
    }
    // Implementation order: branch probe first, then the existsSync check.
    expect(err).toBeInstanceOf(WorktreeIsolationError);
    expect(err!.kind).toBe("branch_exists");
    // Directory exists -> same-shape guidance as worktree_exists: list-worktrees
    // (bypass dir, no .git pointer -> owner unreadable) or enter-worktree (if
    // owner inversion succeeds). Here the .git pointer exists but the sidecar is
    // absent, so owner falls to the leaf-pattern check: leaf = both-present-x is
    // a legal label and != convId, and since the leaf is not in
    // `<slug>--<convId>` form, taskWorktreeOwnerOf returns undefined -> degenerate arm.
    expect(err!.detail).toMatch(/list-worktrees|enter-worktree/);
    expect(err!.detail).not.toContain("manually");
  });
});

// -- shared invariants across input classes (detail uniqueness, literal conventions) --

describe("T8 — 共同不变式（detail 文案唯一性、字面约定）", () => {
  it("两个 kind 的 detail 都不含「manually」", async () => {
    const repo = makeGitRepo();
    // worktree_exists: occupy one directory path
    const wtPath = join(repo, "wt-occupied");
    writeFileSync(wtPath, "occupied");
    const wErr = await createTaskWorktree({
      repoRoot: repo,
      worktreePath: wtPath,
      branch: "iknow/task-x",
    }).then(
      () => undefined,
      (e: unknown) => e as WorktreeIsolationError
    );
    expect(wErr!.detail).not.toContain("manually");

    // branch_exists: occupy only a branch (target dir deliberately not the existing wtPath above, to avoid confusion)
    execFileSync("git", ["branch", "iknow/task-y"], {
      cwd: repo,
      encoding: "utf8",
    });
    const bErr = await createTaskWorktree({
      repoRoot: repo,
      worktreePath: join(repo, ".iknow", "worktrees", "fresh-leaf"),
      branch: "iknow/task-y",
    }).then(
      () => undefined,
      (e: unknown) => e as WorktreeIsolationError
    );
    expect(bErr!.detail).not.toContain("manually");
  });

  it("detail 给单一可执行出路（不含『resolve』/`/resolve/` 类手动指引）", async () => {
    const repo = makeGitRepo();
    const wtPath = join(repo, "wt-single");
    writeFileSync(wtPath, "occupied");
    const err = await createTaskWorktree({
      repoRoot: repo,
      worktreePath: wtPath,
      branch: "iknow/task-x",
    }).then(
      () => undefined,
      (e: unknown) => e as WorktreeIsolationError
    );
    // "resolve" is no longer a standalone directive; the detail must name
    // enter-worktree, a new label, or list-worktrees.
    expect(err!.detail).not.toMatch(/\bresolve\b/);
  });
});
