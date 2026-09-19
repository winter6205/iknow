/**
 * T3 (plans/worktree-isolation-model-provision.md) — mutate gate at the
 * harness seam, model-provision contract (ADR-0037 amendment 2026-08-30):
 *
 *   - ON + session NOT yet bound (main-repo root): the mutate is BLOCKED and
 *     the gate NEVER provisions — no `provision()` call, hence no
 *     `git worktree add` on the execution path, main repo zero-write. The
 *     block message points the model at the create-worktree ACI tool
 *     (not an auto-provision "end the turn and retry" protocol).
 *   - ON + engine rooted at a task-worktree-shaped root (post-rebind): the
 *     per-conversation passthrough adjudication via `provision` still holds
 *     (own tree → same-root no-op passthrough; concurrent mutates coalesce
 *     onto one adjudication; failures stay typed and fail-closed).
 *   - OFF → byte-identical to today (gate transparent).
 *
 * issue 1059 / ADR-0109: bash left the gate's enforcement surface — in the
 * unbound state every string bash command passes and the main checkout is
 * protected physically by the fence's `--ro-bind` (argv + EROFS reflow are
 * pinned in tests/harness/sandbox/ and tests/harness/aci/). The clauses
 * above apply to the remaining FILE_WRITE-class / root_flip semantics.
 *
 * The git layer (`createTaskWorktree`) is unchanged and stays covered with
 * real git — it serves the session-api provisioner and the T4 ACI tool.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";

import {
  CREATE_WORKTREE_TOOL_HINT,
  WorktreeIsolationError,
  classifyCall,
  createTaskWorktree,
  createWorktreeIsolationExecutor,
  createWorktreeOnMutateHolder,
  isTaskWorktreePath,
  mainCheckoutOf,
  resolveTaskWorktreeLabel,
  taskWorktreeBranch,
  taskWorktreeLabelOf,
  taskWorktreePath,
  taskWorktreeOwnerOf,
  unboundFenceErofsGuidance,
  unboundFenceBackgroundNotice,
  unboundFenceMainCheckout,
  unboundMutateNotice,
  WORKTREE_ISOLATION_PREFIX,
} from "../../../src/harness/isolation/worktree-gate.ts";
import type { GitRunner } from "../../../src/harness/isolation/worktree-gate.ts";
// SC6 guard: the readonly-mode SSOT must stay untouched by the gate split.
import {
  ReadonlyViolationError,
  validateReadonlyCommand,
} from "../../../src/harness/aci/tools/bash-readonly.ts";
import { createLiveTaskRoot } from "../../../src/harness/session-roots.ts";
// issue 1059: the EROFS guidance reuses the violation-prefix SSOT — pin it
// from the same source, never a drifted literal.
import { VIOLATION_PREFIXES } from "../../../src/harness/permission/prefixes.ts";
import type {
  Executor,
  ToolCall,
  ToolExecutionResult,
} from "../../../src/harness/tools/types.ts";

// -- helpers -----------------------------------------------------------------

let roots: string[] = [];

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

/** Real git repo with one commit (HEAD must exist for `worktree add -b`). */
function makeGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "iknow-wt-gate-"));
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

/**
 * git runner that tolerates non-zero exits (an empty bare repo has no HEAD,
 * so `rev-parse HEAD` legitimately fails there) — returns stdout/stderr text
 * instead of throwing like the strict `git` helper.
 */
function gitAllowFail(cwd: string, ...args: string[]): string {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8" });
  } catch (err) {
    const e = err as { stdout?: unknown; stderr?: unknown };
    return `${String(e.stdout ?? "")}${String(e.stderr ?? "")}`;
  }
}

afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

/** Fake inner executor: records executeAll invocations; optional canned results. */
function fakeInner(result?: Partial<ToolExecutionResult>) {
  const invocations: {
    calls: ReadonlyArray<ToolCall>;
    args: unknown[];
  }[] = [];
  const inner: Executor = {
    executeAll: async (
      batch,
      signal,
      timeoutMs,
      conversationId,
      onSettled,
      turnId,
      onStream
    ) => {
      invocations.push({
        calls: batch,
        args: [signal, timeoutMs, conversationId, onSettled, turnId, onStream],
      });
      const out: ToolExecutionResult[] = batch.map((c) => ({
        kind: "ok",
        toolUseId: c.id,
        payload: { wrote: true },
        ...(result ?? {}),
      }));
      for (const [i, r] of out.entries()) await onSettled?.(r, i);
      return out;
    },
  };
  return { inner, calls: invocations };
}

const writeCall = (id = "c1"): ToolCall => ({
  id,
  name: "write_file",
  input: { path: "hello.txt", content: "hi" },
});

// -- createTaskWorktree (git layer, real git) --------------------------------

describe("createTaskWorktree", () => {
  it("creates a linked worktree on a new branch without moving the main repo HEAD or branch", async () => {
    const repo = makeGitRepo();
    const branchBefore = git(repo, "rev-parse", "--abbrev-ref", "HEAD").trim();
    const headBefore = git(repo, "rev-parse", "HEAD").trim();
    const wtPath = join(repo, "..", "wt-a");
    roots.push(wtPath);

    const res = await createTaskWorktree({
      repoRoot: repo,
      worktreePath: wtPath,
      branch: "iknow/task-x",
    });

    expect(res.worktreePath).toBe(wtPath);
    expect(res.branch).toBe("iknow/task-x");
    expect(existsSync(wtPath)).toBe(true);
    // worktree registered with the repo
    expect(git(repo, "worktree", "list")).toContain(wtPath);
    // new branch exists and is checked out in the worktree, not the main repo
    expect(
      git(repo, "rev-parse", "--verify", "refs/heads/iknow/task-x")
    ).toContain(headBefore);
    expect(git(wtPath, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe(
      "iknow/task-x"
    );
    // main repo untouched (hard req ①/③: no HEAD move, no branch drag)
    expect(git(repo, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe(
      branchBefore
    );
    expect(git(repo, "rev-parse", "HEAD").trim()).toBe(headBefore);
  });

  it("fails typed not_a_git_repo on a plain directory and writes nothing", async () => {
    const plain = await mkdtemp(join(tmpdir(), "iknow-wt-plain-"));
    roots.push(plain);
    const before = await readdir(plain);
    const wtPath = join(plain, "wt");

    await expect(
      createTaskWorktree({
        repoRoot: plain,
        worktreePath: wtPath,
        branch: "iknow/task-x",
      })
    ).rejects.toMatchObject({
      name: "WorktreeIsolationError",
      kind: "not_a_git_repo",
      message: expect.stringMatching(/^WorktreeIsolationError: /),
    });
    // fail-closed: nothing appeared in the main root, no worktree dir
    expect(existsSync(wtPath)).toBe(false);
    expect(await readdir(plain)).toEqual(before);
  });

  // ADR-0037 §6 amendment 2026-09-07 (plans/bare-repo-create-worktree.md):
  // a bare gitdir is a USABLE git repo — the probe is `rev-parse
  // --git-common-dir`, not `--is-inside-work-tree`, so `git worktree add` runs
  // and succeeds. The old "bare → not_a_git_repo" classification was narrower
  // than the ADR (a gitdir with at least one commit CAN branch and host a
  // linked worktree).
  it("creates a worktree from a bare gitdir with at least one commit, leaving the bare repo untouched", async () => {
    const parent = mkdtempSync(join(tmpdir(), "iknow-wt-bare-"));
    roots.push(parent);
    const bare = join(parent, "repo.git");
    git(parent, "init", "-q", "--bare", bare);
    // seed one commit (bare repos have no worktree to commit in)
    const seed = mkdtempSync(join(tmpdir(), "iknow-wt-seed-"));
    roots.push(seed);
    git(seed, "init", "-q");
    git(seed, "remote", "add", "origin", bare);
    git(
      seed,
      "-c",
      "user.email=t@t",
      "-c",
      "user.name=t",
      "commit",
      "--allow-empty",
      "-qm",
      "init"
    );
    git(seed, "push", "-q", "origin", "HEAD");
    const bareHead = git(bare, "rev-parse", "HEAD").trim();
    const wtPath = join(parent, "wt");

    const res = await createTaskWorktree({
      repoRoot: bare,
      worktreePath: wtPath,
      branch: "iknow/task-x",
    });

    expect(res.worktreePath).toBe(wtPath);
    expect(existsSync(wtPath)).toBe(true);
    expect(git(wtPath, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe(
      "iknow/task-x"
    );
    // the bare repo itself is untouched: HEAD unmoved, still core.bare
    expect(git(bare, "rev-parse", "HEAD").trim()).toBe(bareHead);
    expect(git(bare, "config", "--get", "core.bare").trim()).toBe("true");
  });

  // Same amendment: the operator layout where the gitdir and working files
  // share one root with `core.bare=true` (is-inside-work-tree = false) is a
  // usable repo — `git worktree add -b` works from it.
  it("creates a worktree from a core.bare=true checkout whose root also holds the working files", async () => {
    const repo = makeGitRepo();
    git(repo, "config", "core.bare", "true");
    expect(git(repo, "rev-parse", "--is-inside-work-tree").trim()).toBe(
      "false"
    );
    const headBefore = git(repo, "rev-parse", "HEAD").trim();
    const branchBefore = git(repo, "rev-parse", "--abbrev-ref", "HEAD").trim();
    const wtPath = join(repo, ".iknow", "worktrees", "conv-bare");

    const res = await createTaskWorktree({
      repoRoot: repo,
      worktreePath: wtPath,
      branch: "iknow/task-y",
    });

    expect(res.worktreePath).toBe(wtPath);
    expect(existsSync(join(wtPath, ".git"))).toBe(true);
    expect(git(wtPath, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe(
      "iknow/task-y"
    );
    // source repo HEAD / branch untouched (hard req ①/③)
    expect(git(repo, "rev-parse", "HEAD").trim()).toBe(headBefore);
    expect(git(repo, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe(
      branchBefore
    );
    // the operator's core.bare is never changed by the probe or the add
    expect(git(repo, "config", "--get", "core.bare").trim()).toBe("true");
  });

  // A gitdir with NO commit is still a gitdir: never not_a_git_repo. The
  // outcome belongs to `git worktree add` itself and is version-dependent —
  // older git fails (no HEAD to branch from → worktree_add_failed), git ≥2.53
  // infers `--orphan` and succeeds. This test pins only the version-stable
  // invariant: the probe never misclassifies an empty bare repo, and whatever
  // the add decides, the bare repo layout is not silently rewritten.
  it("never classifies an empty bare repo as not_a_git_repo; the add decides the outcome", async () => {
    const parent = mkdtempSync(join(tmpdir(), "iknow-wt-bare-empty-"));
    roots.push(parent);
    const bare = join(parent, "repo.git");
    git(parent, "init", "-q", "--bare", bare);
    const wtPath = join(parent, "wt");
    const bareHeadBefore = gitAllowFail(bare, "rev-parse", "HEAD").trim();

    let err: unknown;
    try {
      await createTaskWorktree({
        repoRoot: bare,
        worktreePath: wtPath,
        branch: "iknow/task-x",
      });
    } catch (e) {
      err = e;
    }

    // version-dependent exit, but never the "no gitdir" kind (evidence:
    // git 2.53 infers --orphan and succeeds; older git fails the add)
    if (existsSync(wtPath)) {
      // orphan path: the branch exists but is UNBORN (no commit), so HEAD
      // resolves only via symbolic-ref — the bare HEAD is still unmoved
      expect(err).toBeUndefined();
      expect(git(wtPath, "symbolic-ref", "--short", "HEAD").trim()).toBe(
        "iknow/task-x"
      );
      expect(gitAllowFail(bare, "rev-parse", "HEAD").trim()).toBe(
        bareHeadBefore
      );
    } else {
      expect(err).toMatchObject({
        name: "WorktreeIsolationError",
        kind: "worktree_add_failed",
        message: expect.stringContaining("worktree add failed"),
      });
    }
  });

  it("fails typed not_a_git_repo on a plain directory and writes nothing", async () => {
    const plain = await mkdtemp(join(tmpdir(), "iknow-wt-plain-"));
    roots.push(plain);
    const before = await readdir(plain);
    const wtPath = join(plain, "wt");

    await expect(
      createTaskWorktree({
        repoRoot: plain,
        worktreePath: wtPath,
        branch: "iknow/task-x",
      })
    ).rejects.toMatchObject({
      name: "WorktreeIsolationError",
      kind: "not_a_git_repo",
      message: expect.stringMatching(/^WorktreeIsolationError: /),
    });
    // fail-closed: nothing appeared in the main root, no worktree dir
    expect(existsSync(wtPath)).toBe(false);
    expect(await readdir(plain)).toEqual(before);
  });

  it("fails typed git_unavailable when the git binary cannot be spawned", async () => {
    const repo = makeGitRepo();
    const runner: GitRunner = async () => {
      const err = new Error("spawn git ENOENT") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    };
    await expect(
      createTaskWorktree({
        repoRoot: repo,
        worktreePath: join(repo, "wt"),
        branch: "iknow/task-x",
        runGit: runner,
      })
    ).rejects.toMatchObject({ kind: "git_unavailable" });
  });

  it("maps a branch-probe spawn failure to typed git_unavailable", async () => {
    const repo = makeGitRepo();
    let calls = 0;
    const runner: GitRunner = async () => {
      calls += 1;
      if (calls === 1) return { code: 0, stdout: "true\n", stderr: "" };
      throw new Error("spawn git ENOENT during branch probe");
    };

    await expect(
      createTaskWorktree({
        repoRoot: repo,
        worktreePath: join(repo, "wt"),
        branch: "iknow/task-x",
        runGit: runner,
      })
    ).rejects.toMatchObject({ kind: "git_unavailable" });
  });

  it("fails typed branch_exists when the task branch already exists (no silent overwrite)", async () => {
    const repo = makeGitRepo();
    git(repo, "branch", "iknow/task-x");
    const branchSha = git(repo, "rev-parse", "iknow/task-x").trim();
    const wtPath = join(repo, "wt");

    await expect(
      createTaskWorktree({
        repoRoot: repo,
        worktreePath: wtPath,
        branch: "iknow/task-x",
      })
    ).rejects.toMatchObject({ kind: "branch_exists" });
    expect(existsSync(wtPath)).toBe(false);
    // the existing branch is untouched (not repointed, not overwritten)
    expect(git(repo, "rev-parse", "iknow/task-x").trim()).toBe(branchSha);
  });

  it("fails typed worktree_exists when the target path already exists, and creates no branch", async () => {
    const repo = makeGitRepo();
    const wtPath = join(repo, "wt");
    writeFileSync(wtPath, "occupied");
    await expect(
      createTaskWorktree({
        repoRoot: repo,
        worktreePath: wtPath,
        branch: "iknow/task-fresh",
      })
    ).rejects.toMatchObject({ kind: "worktree_exists" });
    let branchCreated = true;
    try {
      git(
        repo,
        "rev-parse",
        "--verify",
        "--quiet",
        "refs/heads/iknow/task-fresh"
      );
    } catch {
      branchCreated = false;
    }
    expect(branchCreated).toBe(false);
  });

  it("fails typed worktree_add_failed when git worktree add exits non-zero", async () => {
    const repo = makeGitRepo();
    const runner: GitRunner = async (args) => {
      if (args[0] === "worktree") {
        return { code: 128, stdout: "", stderr: "fatal: fake add failure" };
      }
      if (args[1] === "--git-common-dir") {
        return { code: 0, stdout: ".git\n", stderr: "" };
      }
      // branch verify probe: branch does not exist
      return { code: 1, stdout: "", stderr: "" };
    };
    await expect(
      createTaskWorktree({
        repoRoot: repo,
        worktreePath: join(repo, "wt"),
        branch: "iknow/task-x",
        runGit: runner,
      })
    ).rejects.toMatchObject({
      kind: "worktree_add_failed",
      message: expect.stringContaining("fake add failure"),
    });
  });

  // Version-independent determinism for the empty-bare failure path: real git
  // only reaches this exit on older versions (git >= 2.53 infers --orphan),
  // so the stub pins what the live-git case cannot — a gitdir that probes
  // clean but whose `worktree add` fails maps to worktree_add_failed, never
  // not_a_git_repo (plans/bare-repo-create-worktree.md T2 acceptance).
  it("empty bare whose worktree add fails maps to worktree_add_failed (stubbed, version-independent)", async () => {
    const runner: GitRunner = async (args) => {
      if (args[0] === "worktree") {
        return {
          code: 129,
          stdout: "",
          stderr:
            "fatal: not a valid object name: 'HEAD' (no commits to branch from)",
        };
      }
      if (args[1] === "--git-common-dir") {
        return { code: 0, stdout: "repo.git\n", stderr: "" };
      }
      return { code: 1, stdout: "", stderr: "" };
    };
    await expect(
      createTaskWorktree({
        repoRoot: "/bare/repo.git",
        worktreePath: "/bare/wt",
        branch: "iknow/task-x",
        runGit: runner,
      })
    ).rejects.toMatchObject({
      kind: "worktree_add_failed",
      message: expect.stringContaining("no commits to branch from"),
    });
  });

  it("maps a worktree-add spawn failure to typed git_unavailable", async () => {
    const repo = makeGitRepo();
    const runner: GitRunner = async (args) => {
      if (args[1] === "--git-common-dir") {
        return { code: 0, stdout: ".git\n", stderr: "" };
      }
      if (args[0] === "worktree") {
        throw new Error("spawn git ENOENT during worktree add");
      }
      return { code: 1, stdout: "", stderr: "" };
    };

    await expect(
      createTaskWorktree({
        repoRoot: repo,
        worktreePath: join(repo, "wt"),
        branch: "iknow/task-x",
        runGit: runner,
      })
    ).rejects.toMatchObject({ kind: "git_unavailable" });
  });
});

// -- classifyCall (mutate vs read) --------------------------------------------

describe("classifyCall", () => {
  it("classifies write_file / edit_file as mutate", () => {
    expect(classifyCall({ id: "1", name: "write_file", input: {} })).toBe(
      "mutate"
    );
    expect(classifyCall({ id: "2", name: "edit_file", input: {} })).toBe(
      "mutate"
    );
  });

  // issue 1059 / ADR-0109 FLIP: the gate no longer prediction-blocks bash in
  // the unbound state. Write protection moved to the physical `--ro-bind`
  // fence (argv assembly pinned in tests/harness/sandbox/bwrap.test.ts and
  // tests/harness/aci/bash-unbound-fence.test.ts), so as far as classifyCall
  // is concerned EVERY string command — writes, redirects, bare `&`,
  // `sed -i`, unknown commands — classifies `read`. Only a blank or
  // non-string command fails closed to `mutate`: it carries no provable
  // intent to reason about at all. The old per-segment prediction table
  // (classifyBashWorkspaceWrite) and its cd/sed read-arm tests were deleted
  // here: the invariant they certified ("a predicted-write bash never
  // executes") no longer exists — the filesystem fence answers that now.
  it("classifies every string bash command as read; blank / non-string fail closed (issue 1059 flip)", () => {
    const read = (command: string) =>
      classifyCall({ id: "r", name: "bash", input: { command } });
    const mutate = (input: unknown) =>
      classifyCall({ id: "m", name: "bash", input: input as never });

    // Former fail-closed prediction samples — ALL pass now (the main
    // checkout is physically read-only inside the fence; real writes die
    // with EROFS and get the guidance reflow instead).
    expect(read("echo x > f.txt")).toBe("read");
    expect(read("echo x >> f.txt")).toBe("read");
    expect(read("touch new.txt")).toBe("read");
    expect(read("mkdir d")).toBe("read");
    expect(read("rm -rf build")).toBe("read");
    expect(read("mv a b")).toBe("read");
    expect(read("npm install")).toBe("read");
    expect(read("git commit -m x")).toBe("read");
    // unknown command → prediction-based fail-closed is retired
    expect(read("somecustomtool --flag")).toBe("read");
    // bare `&` background compound → retired too
    expect(read("ls & touch new.txt")).toBe("read");
    expect(read("ls & git push")).toBe("read");
    expect(read("cd /main && sed -i 's/a/b/' README.md")).toBe("read");
    expect(read("cd /main && echo x > f.txt")).toBe("read");
    expect(read("date '+%Y-%m-%d' && ls -la /tmp 2>&1 | head -30")).toBe(
      "read"
    );
    // the issue #1059 misfire cohort (cd / curl / gh / sleep) must never
    // receive a gate notice again
    expect(read("curl -s https://example.invalid")).toBe("read");
    expect(read("gh pr list")).toBe("read");
    expect(read("sleep 3")).toBe("read");
    expect(read("cd /main && head -5 README.md")).toBe("read");

    // fail-closed residue: blank and non-string commands
    expect(mutate({ command: "" })).toBe("mutate");
    expect(mutate({ command: "   " })).toBe("mutate");
    expect(mutate({ command: 42 })).toBe("mutate");
    expect(mutate({ command: null })).toBe("mutate");
    expect(mutate({})).toBe("mutate");
  });

  // ADR-0109 sub-decision 5: the flip is bash-only. root_flip and the
  // FILE_WRITE family keep their pre-execution classification.
  it("root_flip tools stay root_flip; create-worktree stays a control read (ADR-0109 sub-decision 5)", () => {
    expect(classifyCall({ id: "f1", name: "enter-worktree", input: {} })).toBe(
      "root_flip"
    );
    expect(classifyCall({ id: "f2", name: "exit-worktree", input: {} })).toBe(
      "root_flip"
    );
    expect(classifyCall({ id: "f3", name: "create-worktree", input: {} })).toBe(
      "read"
    );
  });

  // SC6 guard: the readonly bash-mode SSOT is a separate consumer with
  // deliberately stricter semantics (no `>` at all, no background `&`). The
  // gate's workspace-write classifier must not relax that table.
  it("validateReadonlyCommand still rejects 'ls 2>&1' (bash readonly mode unchanged)", () => {
    expect(() => validateReadonlyCommand("ls 2>&1")).toThrow();
  });

  // The gate reuses `validateSegmentPolicy` (the shared allowlist + flag
  // tables) but NOT `validateReadonlyCommand`. Widening the gate's own
  // read-classification must therefore leave readonly MODE's stricter
  // semantics — no `>` at all, no bare `&`, no `cd` — byte-identical.
  it("readonly mode is not widened by the gate's cd/sed read forms", () => {
    for (const command of [
      "cd /main && head -5 README.md",
      "cd /main && sed -n '1,20p' README.md",
      "cd ..; pwd",
    ]) {
      expect(() => validateReadonlyCommand(command)).toThrow(
        ReadonlyViolationError
      );
    }
  });

  it("classifies other tools (read_file / grep / glob / web_fetch …) as read", () => {
    for (const name of [
      "read_file",
      "grep",
      "glob",
      "web_fetch",
      "memory_recall",
    ]) {
      expect(classifyCall({ id: "8", name, input: {} })).toBe("read");
    }
  });

  // T1 (plans/worktree-live-task-root.md §6 T1) — fail-open closure: the
  // 5 symbol-mutate tools in `aci/tools/symbol-mutate.ts` write to disk via
  // `writeFile` (lsp/applyWorkspaceEdit, see symbol-mutate.ts:333) but are
  // NOT in the legacy `ALWAYS_MUTATE_TOOLS` 2-name set, so before T1 they
  // slipped past the isolation gate and edited the main repo directly.
  // After T1 the classifier SSOT is `FILE_WRITE_TOOL_NAMES` from
  // `symbol-mutate.ts` (the single source of truth for "writes the workspace");
  // the gate routes on that, so each name below must be a mutate.
  it("T1 fail-open closure — every symbol-mutate tool is classified mutate (each name has its own assert)", () => {
    const symbolMutateNames = [
      "rename_symbol",
      "replace_symbol_body",
      "insert_before_symbol",
      "insert_after_symbol",
      "safe_delete_symbol",
    ];
    for (const name of symbolMutateNames) {
      expect(
        classifyCall({
          id: `sym-${name}`,
          name,
          input: { file: "a.ts", symbol_path: "Foo" },
        })
      ).toBe("mutate");
    }
  });

  // T1 fail-closed: the classifier's bash branch already fails closed to
  // mutate on a non-string command (see the bash test above). The T1
  // surface also adds `spawn_subagent`'s role metadata — a missing /
  // unknown role must default to mutate (mirroring
  // `__invalid_subagent_type__` in build-engine.ts:855-858). The
  // gate-installed classifier (`classifyWithSubagentIsolation`) is the
  // seam that owns that decision; here we pin the discipline so a future
  // refactor that strips the fail-closed default turns red.
  it("T1 fail-closed — bash with non-string / missing command defaults to mutate (registry-metadata-missing path)", () => {
    expect(
      classifyCall({ id: "bash-ns", name: "bash", input: { command: null } })
    ).toBe("mutate");
    expect(classifyCall({ id: "bash-undef", name: "bash", input: {} })).toBe(
      "mutate"
    );
  });
});

// -- unbound fence helpers (issue 1059 / ADR-0109) ----------------------------

describe("unboundFenceMainCheckout — UNBOUND_FENCE state predicate", () => {
  it("gate OFF → undefined (fence shape byte-identical to pre-flip)", () => {
    expect(
      unboundFenceMainCheckout({ gateOn: false, root: "/main" })
    ).toBeUndefined();
  });

  it("gate ON + main-checkout root → the root itself (fence must ro-bind it)", () => {
    expect(unboundFenceMainCheckout({ gateOn: true, root: "/main" })).toBe(
      "/main"
    );
  });

  it("gate ON + task-worktree-shaped root → undefined (bound session stays byte-identical)", () => {
    expect(
      unboundFenceMainCheckout({
        gateOn: true,
        root: "/main/.iknow/worktrees/conv-1",
      })
    ).toBeUndefined();
  });
});

describe("unboundFenceErofsGuidance — EROFS reflow builder (ADR-0109)", () => {
  it("stderr without an EROFS line → undefined (caller keeps the result byte-identical)", () => {
    expect(
      unboundFenceErofsGuidance("bash: line 1: frobnicate: not found\n")
    ).toBeUndefined();
    expect(unboundFenceErofsGuidance("")).toBeUndefined();
  });

  it("typed [fs_denied] prefix + create-worktree + re-issue-this-call semantics + attempted paths", () => {
    const guidance = unboundFenceErofsGuidance(
      "touch: cannot touch '/repo/f.txt': Read-only file system\n"
    );
    expect(guidance).toBeDefined();
    // prefix comes from the VIOLATION_PREFIXES SSOT, never a drifted literal
    expect(guidance!.startsWith(`${VIOLATION_PREFIXES.fsDenied} `)).toBe(true);
    expect(guidance).toContain("create-worktree");
    expect(guidance).toContain(CREATE_WORKTREE_TOOL_HINT);
    expect(guidance).toContain("re-issue this same command");
    expect(guidance).toContain("next wave of tool calls in this run");
    // the attempted path rides verbatim — the model sees WHICH path was hit
    expect(guidance).toContain("/repo/f.txt");
    // ADR-0037 §7.5 wording discipline
    expect(guidance!.toLowerCase()).not.toContain("next turn");
  });

  it(".git-targeted EROFS gets the distinct git-metadata wording (ADR-0109 子决策 4)", () => {
    const guidance = unboundFenceErofsGuidance(
      "fatal: Unable to create '/repo/.git/index.lock': Read-only file system\n"
    );
    // path clue rides verbatim
    expect(guidance).toContain("/repo/.git/index.lock");
    // 文案区分:gitdir 命中给专属指引(先建树、在 task 树提交),
    // 不与普通文件写共用含糊文案。
    expect(guidance).toContain("git metadata");
    expect(guidance).toContain("git command from inside the task tree");
    expect(guidance).not.toContain("re-issue this same command");
  });

  it("relative `.git/...` paths are detected; `.gitignore` / `.github` are not", () => {
    expect(
      unboundFenceErofsGuidance(
        "fatal: could not lock .git/HEAD: Read-only file system"
      )
    ).toContain("git metadata");
    expect(
      unboundFenceErofsGuidance(
        "touch: cannot touch '/repo/.gitignore': Read-only file system"
      )
    ).not.toContain("git metadata");
    expect(
      unboundFenceErofsGuidance(
        "touch: cannot touch '/repo/.github/workflows': Read-only file system"
      )
    ).not.toContain("git metadata");
  });

  it("caps the attempted-path lines at 5 and reports the remainder count", () => {
    const lines = Array.from(
      { length: 7 },
      (_, i) => `touch '/repo/f${i}.txt': Read-only file system`
    );
    const guidance = unboundFenceErofsGuidance(lines.join("\n"));
    expect(guidance).toContain("f4.txt");
    expect(guidance).not.toContain("f5.txt");
    expect(guidance).not.toContain("f6.txt");
    expect(guidance).toContain("(+2 more EROFS lines)");
  });

  it("non-EROFS lines in mixed stderr are not echoed as attempted paths", () => {
    const guidance = unboundFenceErofsGuidance(
      "some unrelated noise\nls: cannot open '/repo/x': Permission denied\ntouch '/repo/y': Read-only file system"
    );
    expect(guidance).toContain("/repo/y");
    expect(guidance).not.toContain("Permission denied");
  });
});

describe("unboundFenceBackgroundNotice — background preflight notice (ADR-0109)", () => {
  it("[fs_denied]-prefixed, names create-worktree, English-only copy", () => {
    const notice = unboundFenceBackgroundNotice();
    expect(notice.startsWith(`${VIOLATION_PREFIXES.fsDenied} `)).toBe(true);
    expect(notice).toContain("create-worktree");
    expect(notice).toContain("Read-only file system");
    expect(notice.toLowerCase()).not.toContain("next turn");
  });
});

// -- taskWorktreeOwnerOf (deterministic task-worktree path shape) -------------

describe("taskWorktreeOwnerOf", () => {
  it("decomposes `<any>/.iknow/worktrees/<conversationId>` into its owner", () => {
    expect(taskWorktreeOwnerOf("/repo/.iknow/worktrees/conv-1")).toBe("conv-1");
    expect(
      taskWorktreeOwnerOf("/deep/nest/repo/.iknow/worktrees/abc-123")
    ).toBe("abc-123");
  });

  it("returns undefined for main roots and non-task shapes", () => {
    expect(taskWorktreeOwnerOf("/repo")).toBeUndefined();
    expect(taskWorktreeOwnerOf("/repo/.iknow")).toBeUndefined();
    expect(taskWorktreeOwnerOf("/repo/.iknow/worktrees")).toBeUndefined();
    expect(taskWorktreeOwnerOf("/repo/.iknow/other/conv-1")).toBeUndefined();
    expect(taskWorktreeOwnerOf("")).toBeUndefined();
  });
});

describe("task worktree naming", () => {
  it("uses the label as the leaf and keeps conversation id off the folder name", () => {
    const root = taskWorktreePath(
      "/repo",
      "d52e0f28-703c-439a-bce4-3a3ae1017139",
      "fix-648"
    );

    expect(root).toBe("/repo/.iknow/worktrees/fix-648");
    expect(isTaskWorktreePath(root)).toBe(true);
    expect(mainCheckoutOf(root)).toBe("/repo");
    expect(
      taskWorktreeOwnerOf(
        "/repo/.iknow/worktrees/fix-648--d52e0f28-703c-439a-bce4-3a3ae1017139"
      )
    ).toBe("d52e0f28-703c-439a-bce4-3a3ae1017139");
    expect(
      taskWorktreeLabelOf(
        "/repo/.iknow/worktrees/fix-648--d52e0f28-703c-439a-bce4-3a3ae1017139"
      )
    ).toBe("fix-648");
    expect(
      taskWorktreeBranch("d52e0f28-703c-439a-bce4-3a3ae1017139", "fix-648")
    ).toBe("iknow/task/fix-648-d52e0f28");
  });

  it("inverts owner from the gitdir sidecar on a real labeled worktree", async () => {
    const repo = makeGitRepo();
    const conversationId = "d52e0f28-703c-439a-bce4-3a3ae1017139";
    const worktreePath = taskWorktreePath(repo, conversationId, "fix-648");
    await createTaskWorktree({
      repoRoot: repo,
      worktreePath,
      branch: taskWorktreeBranch(conversationId, "fix-648"),
      conversationId,
    });
    expect(basename(worktreePath)).toBe("fix-648");
    expect(taskWorktreeOwnerOf(worktreePath)).toBe(conversationId);
    expect(taskWorktreeLabelOf(worktreePath)).toBe("fix-648");
  });

  it("falls back to the historical UUID-only leaf for invalid labels", () => {
    for (const name of [
      undefined,
      "",
      "a",
      "Bad-name",
      "bad--name",
      "x".repeat(41),
    ]) {
      expect(resolveTaskWorktreeLabel(name).label).toBeUndefined();
      const root = taskWorktreePath("/repo", "conv-1", name);
      expect(root).toBe("/repo/.iknow/worktrees/conv-1");
      expect(taskWorktreeOwnerOf(root)).toBe("conv-1");
      expect(taskWorktreeLabelOf(root)).toBeUndefined();
    }
  });
});

// -- mainCheckoutOf (T6 productRoot derivation from a session root) ------------

describe("mainCheckoutOf", () => {
  it("strips the task-worktree suffix to the owning main checkout", () => {
    expect(mainCheckoutOf("/repo/.iknow/worktrees/conv-1")).toBe("/repo");
    expect(mainCheckoutOf("/deep/nest/repo/.iknow/worktrees/abc-123")).toBe(
      "/deep/nest/repo"
    );
    expect(mainCheckoutOf("/repo/.iknow/worktrees/fix-648")).toBe("/repo");
  });

  it("is identity on roots that are not task-worktree-shaped", () => {
    // 未改绑的会话根、主仓下的普通目录、手工建的无关 worktree —— 都原样返回，
    // 不猜、不上溯、不回退 process.cwd()。
    expect(mainCheckoutOf("/repo")).toBe("/repo");
    expect(mainCheckoutOf("/repo/.iknow")).toBe("/repo/.iknow");
    expect(mainCheckoutOf("/repo/.iknow/worktrees")).toBe(
      "/repo/.iknow/worktrees"
    );
    expect(mainCheckoutOf("/elsewhere/manual-tree")).toBe(
      "/elsewhere/manual-tree"
    );
    expect(mainCheckoutOf("")).toBe("");
  });

  it("is idempotent: applying it to its own output changes nothing", () => {
    const once = mainCheckoutOf("/repo/.iknow/worktrees/conv-1");
    expect(mainCheckoutOf(once)).toBe(once);
  });
});

// -- gate executor ------------------------------------------------------------

describe("createWorktreeIsolationExecutor", () => {
  it("boundary d — switch OFF passes everything through, provision never called", async () => {
    const { inner, calls } = fakeInner();
    let provisioned = 0;
    const gate = createWorktreeIsolationExecutor({
      enabled: { get: () => false },
      liveTaskRoot: createLiveTaskRoot("/main"),
      provision: async () => {
        provisioned += 1;
        return "/wt";
      },
      inner,
    });
    const out = await gate.executeAll([writeCall()]);
    expect(provisioned).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.calls.map((c) => c.id)).toEqual(["c1"]);
    expect(out[0]!.kind).toBe("ok");
  });

  it("read calls pass through without provisioning", async () => {
    const { inner, calls } = fakeInner();
    const gate = createWorktreeIsolationExecutor({
      enabled: { get: () => true },
      liveTaskRoot: createLiveTaskRoot("/main"),
      provision: async () => {
        throw new Error("must not provision");
      },
      inner,
    });
    const out = await gate.executeAll([
      { id: "r1", name: "read_file", input: { path: "a" } },
    ]);
    expect(calls).toHaveLength(1);
    expect(out[0]!.kind).toBe("ok");
  });

  it("T3 model-provision contract — unbound mutate on a main-repo root is blocked WITHOUT provisioning (no git worktree add, main repo zero-write)", async () => {
    const { inner, calls } = fakeInner();
    let provisioned = 0;
    const gate = createWorktreeIsolationExecutor({
      enabled: { get: () => true },
      liveTaskRoot: createLiveTaskRoot("/main"),
      provision: async () => {
        provisioned += 1;
        return "/wt";
      },
      inner,
    });

    const first = await gate.executeAll([writeCall()]);
    expect(first[0]!.kind).toBe("execution_failed");
    expect(first[0]!.message!.startsWith(`${WORKTREE_ISOLATION_PREFIX} `)).toBe(
      true
    );
    // the message points the model at the create-worktree ACI tool, NOT at an
    // auto-provision "end the turn and retry" protocol
    expect(first[0]!.message).toContain(CREATE_WORKTREE_TOOL_HINT);
    expect(first[0]!.message).not.toContain("end the turn");
    expect(first[0]!.message!.length).toBeGreaterThan(20);
    // the gate NEVER provisions on the blocked path: no provision() call means
    // no `git worktree add` anywhere on the execution path; inner never
    // reached → main repo zero-write
    expect(provisioned).toBe(0);
    expect(calls).toHaveLength(0);

    // subsequent mutates keep blocking with zero side effects (still fail-closed)
    const second = await gate.executeAll([writeCall("c2")]);
    expect(second[0]!.kind).toBe("execution_failed");
    expect(second[0]!.message).toContain(CREATE_WORKTREE_TOOL_HINT);
    expect(provisioned).toBe(0);
    expect(calls).toHaveLength(0);
  });

  // issue 1059 / ADR-0109 — the executor-face counterpart of the flip: in
  // the unbound state the gate does NOT prediction-block any bash call (the
  // write question moved to the physical `--ro-bind` fence; argv-level
  // coverage lives in tests/harness/sandbox/bwrap.test.ts and
  // tests/harness/aci/bash-unbound-fence.test.ts). The gate's remaining
  // enforcement here is FILE_WRITE-class blocking with the verbatim
  // unboundMutateNotice, control tools (create-worktree) passing through,
  // and zero provisioning on the blocked path.
  it("issue 1059 acceptance — unbound session passes ALL bash through (writes included) but still blocks write_file without provisioning", async () => {
    const bashCall = (id: string, command: string): ToolCall => ({
      id,
      name: "bash",
      input: { command },
    });
    const { inner, calls } = fakeInner();
    let provisioned = 0;
    const gate = createWorktreeIsolationExecutor({
      enabled: { get: () => true },
      liveTaskRoot: createLiveTaskRoot("/main"),
      provision: async () => {
        provisioned += 1;
        return "/wt";
      },
      inner,
    });

    // write forms, sed -i, unknown tokens, bare `&` — none are blocked any
    // more; every one reaches the tool (the fence, not the gate, owns the
    // write answer)
    const passed = await gate.executeAll([
      bashCall("b1", "cd /main && head -5 README.md"),
      bashCall("b2", "echo x > f.txt"),
      bashCall("b3", "sed -i 's/a/b/' README.md"),
      bashCall("b4", "frobnicate --now"),
      bashCall("b5", "ls & touch new.txt"),
    ]);
    expect(passed.map((r) => r.kind)).toEqual(["ok", "ok", "ok", "ok", "ok"]);
    expect(calls.flatMap((c) => c.calls.map((x) => x.id))).toEqual([
      "b1",
      "b2",
      "b3",
      "b4",
      "b5",
    ]);

    // the control tool of the unbind path stays reachable (create-worktree
    // is how the session gets a writable root — the gate must never eat it)
    const control = await gate.executeAll([
      { id: "cw", name: "create-worktree", input: { name: "task-x" } },
    ]);
    expect(control[0]!.kind).toBe("ok");

    // FILE_WRITE-class mutates keep the pre-execution block, verbatim
    // notice, zero provisioning, inner never reached for them
    const before = calls.length;
    const blocked = await gate.executeAll([writeCall("m1")]);
    expect(blocked[0]!.kind).toBe("execution_failed");
    expect(blocked[0]!.message).toBe(unboundMutateNotice());
    expect(provisioned).toBe(0);
    expect(calls).toHaveLength(before); // the write_file call never reached inner
  });

  it("unboundMutateNotice is actionable: conditional + re-issue-this-call semantics, plus the SC7 substring bans (spec casual-ask-context-hygiene SC7, amended 2026-09-08)", () => {
    const message = unboundMutateNotice();
    // visible gate prefix invariant (same as the executor-level assertions)
    expect(message.startsWith(`${WORKTREE_ISOLATION_PREFIX} `)).toBe(true);
    // substring ban (c): genuine mutations still get pointed at the tool
    // (literal name, not only via the hint constant)
    expect(message).toContain("create-worktree");
    expect(message).toContain(CREATE_WORKTREE_TOOL_HINT);
    // substring ban (d): no imperative framing that turns the next model move
    // into "go build a tree" — the notice never prescribes building a
    // per-conversation worktree by name
    expect(message).not.toContain("this conversation's task worktree");
    expect(message).not.toContain("end the turn");
    // substring ban (e): factual semantics locked — the call WOULD write, and
    // was NOT executed
    expect(message).toContain("This call would write");
    // semantic (a): conditional framing — the notice states WHEN the tool
    // applies ("To write, ..."), not just that the tool exists. This is the
    // assertion that catches the 2026-09-08 semantic hollowing: the old text
    // passed every substring ban above while only saying "the tool exists".
    expect(message).toContain("To write, ");
    // semantic (b): re-issue guidance — the same call, retried after binding,
    // is the way forward (spec锁定语义「再重试这一次调用」)
    expect(message).toContain("re-issue this same call");
    // ADR-0037 §7.5 wording discipline: next-WAVE-of-tool-calls-in-this-run,
    // never "next turn"
    expect(message).toContain("next wave of tool calls in this run");
    expect(message.toLowerCase()).not.toContain("next turn");
    // full-text pin: wording changes must be deliberate test changes, not
    // drift
    expect(message).toBe(
      `${WORKTREE_ISOLATION_PREFIX} This call would write the workspace, and it was not executed: ` +
        `worktree isolation is ON and this session is not yet bound to a task worktree. ` +
        `The main repo stays read-only. To write, call the ${CREATE_WORKTREE_TOOL_HINT} ` +
        `to put this session on a writable root, then re-issue this same call — it ` +
        `will land in the new root on the next wave of tool calls in this run ` +
        `(no auto-provisioning).`
    );
  });

  it("passthrough adjudication survives on a task-worktree-rooted engine: own tree → same-root no-op, provision runs once", async () => {
    const { inner, calls } = fakeInner();
    let provisioned = 0;
    const ownTreeRoot = "/repo/.iknow/worktrees/conv-1";
    const gate = createWorktreeIsolationExecutor({
      enabled: { get: () => true },
      liveTaskRoot: createLiveTaskRoot(ownTreeRoot),
      provision: async () => {
        provisioned += 1;
        return ownTreeRoot; // host: session already rebound to this very root
      },
      inner,
    });
    const out = await gate.executeAll([writeCall()]);
    expect(provisioned).toBe(1);
    expect(calls).toHaveLength(1); // reached the tools → mutates land in the worktree
    expect(out[0]!.kind).toBe("ok");

    const gate2 = createWorktreeIsolationExecutor({
      enabled: { get: () => true },
      liveTaskRoot: createLiveTaskRoot("/wt"),
      initiallyBound: true,
      provision: async () => {
        throw new Error("must not provision");
      },
      inner: fakeInner().inner,
    });
    const out2 = await gate2.executeAll([writeCall("c9")]);
    expect(out2[0]!.kind).toBe("ok");
  });

  it("stale-root defensive branch — provision resolving elsewhere still blocks with the rebind notice", async () => {
    const { inner, calls } = fakeInner();
    const gate = createWorktreeIsolationExecutor({
      enabled: { get: () => true },
      liveTaskRoot: createLiveTaskRoot("/repo/.iknow/worktrees/conv-1"),
      provision: async () => "/other-wt",
      inner,
    });
    const out = await gate.executeAll([writeCall()]);
    expect(out[0]!.kind).toBe("execution_failed");
    expect(out[0]!.message).toContain("/other-wt");
    expect(calls).toHaveLength(0);
  });

  it("boundary c — concurrent first mutates on a task-worktree-rooted engine coalesce onto one adjudication", async () => {
    const { inner, calls } = fakeInner();
    let provisioned = 0;
    let resolveProvision!: (root: string) => void;
    const gate = createWorktreeIsolationExecutor({
      enabled: { get: () => true },
      liveTaskRoot: createLiveTaskRoot("/repo/.iknow/worktrees/conv-1"),
      provision: async () => {
        provisioned += 1;
        await new Promise<void>((r) => (resolveProvision = r));
        return "/wt";
      },
      inner,
    });

    const p1 = gate.executeAll([writeCall("a")]);
    const p2 = gate.executeAll([writeCall("b")]);
    await Promise.resolve();
    resolveProvision("/wt");
    const [r1, r2] = await Promise.all([p1, p2]);

    expect(provisioned).toBe(1); // one adjudication, one tree
    expect(calls).toHaveLength(0);
    for (const batch of [r1, r2]) {
      expect(batch[0]!.kind).toBe("execution_failed");
      expect(batch[0]!.message).toContain("/wt"); // both bound to the same tree
    }
  });

  it("per-session state: different conversationIds adjudicate independently (rebind must not leak across sessions)", async () => {
    const { inner, calls } = fakeInner();
    const provisionedFor: (string | undefined)[] = [];
    const gate = createWorktreeIsolationExecutor({
      enabled: { get: () => true },
      liveTaskRoot: createLiveTaskRoot("/repo/.iknow/worktrees/conv-1"),
      provision: async ({ conversationId }) => {
        provisionedFor.push(conversationId);
        return `/wt-${conversationId}`;
      },
      inner,
    });

    const [r1, r2] = await Promise.all([
      gate.executeAll([writeCall("a")], undefined, undefined, "conv-1"),
      gate.executeAll([writeCall("b")], undefined, undefined, "conv-2"),
    ]);
    expect(provisionedFor.sort()).toEqual(["conv-1", "conv-2"]);
    expect(r1[0]!.message).toContain("/wt-conv-1");
    expect(r2[0]!.message).toContain("/wt-conv-2");
    expect(calls).toHaveLength(0);
  });

  it("boundary a/failure — adjudication failure is fail-closed: typed visible error, inner never called, retry allowed", async () => {
    const { inner, calls } = fakeInner();
    let attempts = 0;
    const observed: WorktreeIsolationError[] = [];
    const gate = createWorktreeIsolationExecutor({
      enabled: { get: () => true },
      liveTaskRoot: createLiveTaskRoot("/repo/.iknow/worktrees/conv-1"),
      provision: async () => {
        attempts += 1;
        throw new WorktreeIsolationError(
          "not_a_git_repo",
          "not a git repository: /main"
        );
      },
      onError: (e) => observed.push(e),
      inner,
    });

    const out = await gate.executeAll([writeCall()]);
    expect(out[0]!.kind).toBe("execution_failed");
    expect(out[0]!.message).toContain("kind=not_a_git_repo");
    expect(out[0]!.message).toContain("not a git repository");
    expect(out[0]!.message!.length).toBeGreaterThan(20);
    expect(calls).toHaveLength(0); // zero main-repo write on failure
    expect(observed).toHaveLength(1);
    expect(observed[0]!.kind).toBe("not_a_git_repo");

    // next mutate retries the adjudication (still fail-closed while it fails)
    const out2 = await gate.executeAll([writeCall("c2")]);
    expect(out2[0]!.kind).toBe("execution_failed");
    expect(attempts).toBe(2);
    expect(calls).toHaveLength(0);
  });

  it("non-Error adjudication throw is wrapped into a typed rebind_failed error", async () => {
    const { inner } = fakeInner();
    const gate = createWorktreeIsolationExecutor({
      enabled: { get: () => true },
      liveTaskRoot: createLiveTaskRoot("/repo/.iknow/worktrees/conv-1"),
      provision: async () => {
        throw "boom"; // eslint-disable-line no-throw-literal
      },
      inner,
    });
    const out = await gate.executeAll([writeCall()]);
    expect(out[0]!.message).toContain("kind=rebind_failed");
    expect(out[0]!.message).toContain("boom");
  });

  it("forwards executor args (signal/timeout/conversationId/turnId/onStream/onSettled) to inner on passthrough", async () => {
    const { inner, calls } = fakeInner();
    const gate = createWorktreeIsolationExecutor({
      enabled: { get: () => true },
      liveTaskRoot: createLiveTaskRoot("/wt"),
      initiallyBound: true,
      provision: async () => "/wt",
      inner,
    });
    const controller = new AbortController();
    const settled: unknown[] = [];
    await gate.executeAll(
      [writeCall()],
      controller.signal,
      1234,
      "conv-7",
      (r, i) => settled.push([r, i]),
      "turn-9",
      () => {}
    );
    expect(calls[0]!.args[0]).toBe(controller.signal);
    expect(calls[0]!.args[1]).toBe(1234);
    expect(calls[0]!.args[2]).toBe("conv-7");
    expect(calls[0]!.args[4]).toBe("turn-9");
    expect(calls[0]!.args[5]).toBeTypeOf("function");
    expect(settled).toHaveLength(1);
  });
});

// -- ADR-0096 T3 — live switch holder -----------------------------------------

describe("createWorktreeOnMutateHolder (ADR-0096 T3)", () => {
  it("get() returns the injected initial value", () => {
    expect(createWorktreeOnMutateHolder(true).get()).toBe(true);
    expect(createWorktreeOnMutateHolder(false).get()).toBe(false);
  });

  it("defaults to OFF when constructed without an initial value", () => {
    expect(createWorktreeOnMutateHolder().get()).toBe(false);
  });

  it("set() flips the value ON → OFF → ON", () => {
    const holder = createWorktreeOnMutateHolder(false);
    holder.set(true);
    expect(holder.get()).toBe(true);
    holder.set(false);
    expect(holder.get()).toBe(false);
    holder.set(true);
    expect(holder.get()).toBe(true);
  });

  it("set() is fail-closed for non-boolean input (value unchanged, no throw)", () => {
    const holder = createWorktreeOnMutateHolder(true);
    for (const bad of [undefined, null, 0, 1, "", "ON", {}, []]) {
      expect(() => (holder.set as (v: unknown) => void)(bad)).not.toThrow();
      expect(holder.get()).toBe(true);
    }
  });

  it("is frozen — no instance property can be reassigned", () => {
    const holder = createWorktreeOnMutateHolder(false);
    expect(Object.isFrozen(holder)).toBe(true);
  });
});

describe("createWorktreeIsolationExecutor — live switch holder", () => {
  it("flip OFF → ON blocks the next wave's unbound mutate WITHOUT provisioning", async () => {
    const { inner, calls } = fakeInner();
    let provisioned = 0;
    const holder = createWorktreeOnMutateHolder(false);
    const gate = createWorktreeIsolationExecutor({
      enabled: holder,
      liveTaskRoot: createLiveTaskRoot("/main"),
      provision: async () => {
        provisioned += 1;
        return "/wt";
      },
      inner,
    });

    // OFF: main repo writable, gate transparent
    const before = await gate.executeAll([writeCall("c0")]);
    expect(before[0]!.kind).toBe("ok");
    expect(calls).toHaveLength(1);

    holder.set(true); // the /config panel flip

    const after = await gate.executeAll([writeCall("c1")]);
    expect(after[0]!.kind).toBe("execution_failed");
    expect(after[0]!.message).toContain(CREATE_WORKTREE_TOOL_HINT);
    // never auto-provision (ADR-0037 §1 preserved): no provision(), no write
    expect(provisioned).toBe(0);
    expect(calls).toHaveLength(1);
  });

  it("flip ON → OFF restores main-repo writes on the next wave", async () => {
    const { inner, calls } = fakeInner();
    let provisioned = 0;
    const holder = createWorktreeOnMutateHolder(true);
    const gate = createWorktreeIsolationExecutor({
      enabled: holder,
      liveTaskRoot: createLiveTaskRoot("/main"),
      provision: async () => {
        provisioned += 1;
        return "/wt";
      },
      inner,
    });

    const blocked = await gate.executeAll([writeCall("c1")]);
    expect(blocked[0]!.kind).toBe("execution_failed");

    holder.set(false); // the /config panel flip

    const through = await gate.executeAll([writeCall("c2")]);
    expect(through[0]!.kind).toBe("ok");
    expect(calls.map((c) => c.calls.map((x) => x.id))).toEqual([["c2"]]);
    expect(provisioned).toBe(0);
  });

  it("D2 — the switch is read exactly ONCE per wave (mid-wave flip cannot split a wave)", async () => {
    const { inner } = fakeInner();
    let value = false;
    let reads = 0;
    const holder = {
      get: () => {
        reads += 1;
        return value;
      },
    };
    const gate = createWorktreeIsolationExecutor({
      enabled: holder,
      liveTaskRoot: createLiveTaskRoot("/main"),
      provision: async () => "/wt",
      inner,
    });

    await gate.executeAll([writeCall("c1")]);
    expect(reads).toBe(1);

    value = true;
    await gate.executeAll([writeCall("c2")]);
    expect(reads).toBe(2);

    // a wave containing several calls still costs exactly one read
    await gate.executeAll([writeCall("c3"), writeCall("c4"), writeCall("c5")]);
    expect(reads).toBe(3);
  });

  it("flip ON does not disturb an already-bound session's passthrough", async () => {
    const { inner, calls } = fakeInner();
    const holder = createWorktreeOnMutateHolder(false);
    const gate = createWorktreeIsolationExecutor({
      enabled: holder,
      liveTaskRoot: createLiveTaskRoot("/repo/.iknow/worktrees/conv-1"),
      initiallyBound: true,
      provision: async () => "/repo/.iknow/worktrees/conv-1",
      inner,
    });
    holder.set(true);
    const out = await gate.executeAll([writeCall("c1")]);
    expect(out[0]!.kind).toBe("ok");
    expect(calls).toHaveLength(1);
  });
});
