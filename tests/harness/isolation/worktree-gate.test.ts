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

  // Invariant (spec casual-ask-context-hygiene Does/classifyCall): the gate
  // adjudicates "will this bash call write the workspace", NOT the readonly
  // bash-mode table. Read-only allowlisted segments compose freely through
  // pipes, `&&`, and stderr merges (`2>&1`); only workspace writes (file
  // redirects, mutating commands) or unknown commands fail closed to mutate.
  it("classifies bash by whether it writes the workspace", () => {
    const read = (command: string) =>
      classifyCall({ id: "r", name: "bash", input: { command } });
    const mutate = (command: string) =>
      classifyCall({ id: "m", name: "bash", input: { command } });

    // SC5 exact case: pipes + && + 2>&1 over read-only commands stay read.
    expect(read("date '+%Y-%m-%d' && ls -la /tmp 2>&1 | head -30")).toBe(
      "read"
    );
    expect(read("ls 2>&1")).toBe("read");
    expect(read("ls 2>/dev/null")).toBe("read");
    expect(read("ls &> /dev/null")).toBe("read");
    expect(read("cat a.txt | grep x")).toBe("read");
    expect(read("git status")).toBe("read");
    expect(read("git diff")).toBe("read");
    expect(read("ls -la src")).toBe("read");
    expect(read("cat a.txt")).toBe("read");
    expect(read("ls && cat b.txt; echo done")).toBe("read");
    // T3 (plans/tui-durable-open.md sentence 3): `cd` + a read-only rest is a
    // read. `cd` writes nothing itself, and every segment after it is still
    // adjudicated on its own first token, so a write behind the cd
    // (`cd <main> && rm -rf <main>`) stays a mutate. What a bare allow does
    // NOT prove is path CONFINEMENT — after `cd /elsewhere` a later relative
    // operand resolves outside the workspace. That is the bwrap fence's and
    // the permission layer's question, not this classifier's.
    expect(read("cd /main && head -5 README.md")).toBe("read");
    expect(read("cd /main && grep -n export README.md | head -3")).toBe("read");
    expect(read("cd .. && head -5 README.md")).toBe("read");
    expect(read("cd src && head -5 index.ts")).toBe("read");
    // `sed` read forms: a quiet-mode script made only of line-range print
    // items. The grammar is deliberately narrow — an unparsed sed script is
    // not provably non-writing, because `sed -n '1w out.txt' f` writes a file
    // with no `-i` in sight and `sed -n '1e cmd' f` spawns a command (both
    // verified against GNU sed 4.9). Pattern-addressed reads (`/re/p`) and
    // substitution previews are therefore mutate; `grep` / `head` remain the
    // read paths for those.
    expect(read("sed -n '1,20p' README.md")).toBe("read");
    expect(read("cd /main && sed -n '1,20p' README.md")).toBe("read");
    expect(read("cd /main && sed -n -e '1,20p' README.md")).toBe("read");
    expect(read("sed -n --expression=1,20p README.md")).toBe("read");
    expect(read("sed -n --expression 1,20p README.md")).toBe("read");
    expect(read("sed -n -e '1,20p' -e '2,3p' README.md")).toBe("read");
    expect(read("cd /main && sed -n '$p' README.md")).toBe("read");
    expect(read("cd /main && sed -n '2,$p' README.md")).toBe("read");
    expect(read("cd /main && sed -n '1,20p' README.md 2>/dev/null")).toBe(
      "read"
    );
    // KNOWN LIMITATION (pinned, not widened): `splitShellSegments` is not
    // quote-aware, so a `;` INSIDE a quoted sed script splits the segment and
    // the script's tail becomes an unknown command. `sed -n '1,20p;30,40p' f`
    // therefore fails closed to mutate. Deny-by-default direction, and the
    // model can split it into two `-e` scripts instead.
    expect(mutate("cd /main && sed -n '1,20p;30,40p' README.md")).toBe(
      "mutate"
    );

    // workspace writes → mutate
    expect(mutate("echo x > f.txt")).toBe("mutate");
    expect(mutate("echo x >> f.txt")).toBe("mutate");
    expect(mutate("ls >> f.txt")).toBe("mutate");
    expect(mutate("cat a.txt > b.txt")).toBe("mutate");
    expect(mutate("rm -rf build")).toBe("mutate");
    expect(mutate("mv a b")).toBe("mutate");
    expect(mutate("touch new.txt")).toBe("mutate");
    expect(mutate("mkdir d")).toBe("mutate");
    expect(mutate("npm install")).toBe("mutate");
    expect(mutate("git commit -m x")).toBe("mutate");
    // bare `&` background compound → mutate: splitShellSegments does NOT
    // split on bare `&`, so the second command would otherwise ride inside a
    // policy-passing first segment and dodge both checks (review High fix).
    expect(mutate("ls & touch new.txt")).toBe("mutate");
    expect(mutate("ls & git push")).toBe("mutate");
    expect(mutate("ls & npm install")).toBe("mutate");
    // unknown command → fail-closed mutate
    expect(mutate("somecustomtool --flag")).toBe("mutate");
    // T3 fail-closed arm: every in-place / file-writing sed form stays mutate.
    // `-i` is refused in all its spellings (glued `.bak` suffix included), and
    // a script carrying sed's `w` (write) / `e` (execute) commands is refused
    // even without `-i` — both were verified against GNU sed 4.9 to touch the
    // filesystem / spawn a command from a `-n` read form.
    expect(mutate("cd /main && sed -i 's/a/b/' README.md")).toBe("mutate");
    expect(mutate("cd /main && sed -i.bak 's/a/b/' README.md")).toBe("mutate");
    expect(mutate("sed --in-place 's/a/b/' README.md")).toBe("mutate");
    expect(mutate("sed --in-place=.bak 's/a/b/' README.md")).toBe("mutate");
    expect(mutate("sed -ni '1,2p' README.md")).toBe("mutate");
    expect(mutate("sed -in '1,2p' README.md")).toBe("mutate");
    expect(mutate("sed -n '1w out.txt' README.md")).toBe("mutate");
    expect(mutate("sed -n '1e echo pwned' README.md")).toBe("mutate");
    expect(mutate("sed -n 's/a/b/w out.txt' README.md")).toBe("mutate");
    expect(mutate("sed -n 's/a/b/e' README.md")).toBe("mutate");
    // Everything the narrow grammar cannot parse is denied, not guessed at:
    // pattern addressing, substitution previews, `-f` script files, `--version`
    // (prints usage without touching the operand), and a script token that is
    // really a typo'd command would all run with semantics this classifier
    // has not read.
    expect(mutate("cd /main && sed -n '/export/p' README.md")).toBe("mutate");
    expect(mutate("cd /main && sed 's/old/new/' README.md")).toBe("mutate");
    expect(mutate("cd /main && sed -n 's/old/new/p' README.md")).toBe("mutate");
    expect(mutate("sed -n 'gp' README.md")).toBe("mutate");
    expect(mutate("sed -n grep -n x README.md")).toBe("mutate");
    expect(mutate("sed -n -f script.sed README.md")).toBe("mutate");
    // Glued and stdin `-f` spellings are the same script-from-file: GNU sed
    // tolerates `-fFILE` and `-f-`, and a piped `w <path>` script reached
    // through them writes with no `-i` — reading them as a print grammar would
    // be the fail-open this clause exists to close.
    expect(mutate("sed -n -f- 1,2p README.md")).toBe("mutate");
    expect(mutate("sed -n -f/tmp/scr.sed 1,2p README.md")).toBe("mutate");
    expect(mutate("printf 'w /tmp/x' | sed -n -f- 1,2p README.md")).toBe(
      "mutate"
    );
    expect(mutate("sed --version")).toBe("mutate");
    expect(mutate("sed -n")).toBe("mutate");
    // `cd` changes the meaning of later RELATIVE operands, so it is a read
    // only when this classifier can still see the whole command; a redirect
    // on the cd segment itself, or a write in any later segment, fails closed.
    expect(mutate("cd /main > out.txt")).toBe("mutate");
    expect(mutate("cd /main && rm -rf /main")).toBe("mutate");
    expect(mutate("cd /main && tee out.txt")).toBe("mutate");
    expect(mutate("cd /main && npm install")).toBe("mutate");
    expect(mutate("cd /main && echo x > f.txt")).toBe("mutate");
    // `cd` without an operand is shell-noise, not a read: fail closed
    // (`cd; ls` gives an empty operand segment).
    expect(mutate("cd; ls")).toBe("mutate");
    expect(mutate("cd && ls")).toBe("mutate");
    // Fence identity markers are still unknown tokens → mutate.
    expect(mutate("cd -- /main && head -5 README.md")).toBe("mutate");
    expect(mutate("cd --help")).toBe("mutate");
    expect(mutate("cd -")).toBe("mutate");
    expect(mutate("cd ~ && head -5 README.md")).toBe("mutate");
    // Newlines are separators for this classifier (the same split the hard-wall
    // scan uses): `head a\nrm -rf b` is two segments, and the second one is an
    // unknown command, so the compound fails closed instead of riding out on
    // the first segment's read verdict.
    expect(mutate("head -5 README.md\nrm -rf /main")).toBe("mutate");
    expect(read("head -5 README.md\ncat package.json")).toBe("read");
    // empty / non-string command → fail-closed mutate
    expect(
      classifyCall({ id: "e", name: "bash", input: { command: "" } })
    ).toBe("mutate");
    expect(
      classifyCall({ id: "7", name: "bash", input: { command: 42 } })
    ).toBe("mutate");
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

  // T3 acceptance (plans/tui-durable-open.md, T1 sentence 3): with isolation
  // ON and the session still unbound, reading the main checkout through
  // `cd <main> && <read>` must reach the tool — ADR-0037 §1 keeps read paths
  // on the main checkout — while any write behind the same `cd`, and any
  // unknown first token, still hits the unbound-mutate notice verbatim.
  it("T3 acceptance — unbound session runs `cd <main> && head/sed -n …` but still blocks `cd <main> && sed -i …` and unknown tokens", async () => {
    const bashCall = (id: string, command: string): ToolCall => ({
      id,
      name: "bash",
      input: { command },
    });
    const { inner, calls } = fakeInner();
    const gate = createWorktreeIsolationExecutor({
      enabled: { get: () => true },
      liveTaskRoot: createLiveTaskRoot("/main"),
      provision: async () => {
        throw new Error("must not provision for reads");
      },
      inner,
    });

    const reads = await gate.executeAll([
      bashCall("r1", "cd /main && head -5 README.md"),
      bashCall("r2", "cd /main && sed -n '1,20p' README.md"),
    ]);
    expect(reads.map((r) => r.kind)).toEqual(["ok", "ok"]);
    // the read calls reached the tools — they are not isolation-blocked
    expect(calls.flatMap((c) => c.calls.map((x) => x.id))).toEqual([
      "r1",
      "r2",
    ]);

    const blocked = await gate.executeAll([
      bashCall("m1", "cd /main && sed -i 's/a/b/' README.md"),
      bashCall("m2", "cd /main && frobnicate --now"),
    ]);
    for (const result of blocked) {
      expect(result.kind).toBe("execution_failed");
    }
    // existing unbound-mutate notice, verbatim (pinned by the text test above)
    expect(blocked[0]!.message).toBe(unboundMutateNotice());
    expect(blocked[1]!.message).toBe(unboundMutateNotice());
    // no write behind the cd reached the tools
    expect(calls.flatMap((c) => c.calls.map((x) => x.id))).toEqual([
      "r1",
      "r2",
    ]);
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
