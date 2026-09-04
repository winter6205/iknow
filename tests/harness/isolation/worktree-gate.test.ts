/**
 * T3 (plans/worktree-isolation-model-provision.md) — mutate gate at the
 * harness seam, model-provision contract (ADR-0037 amendment 2026-08-30):
 *
 *   - ON + session NOT yet bound (main-repo root): the mutate is BLOCKED and
 *     the gate NEVER provisions — no `provision()` call, hence no
 *     `git worktree add` on the execution path, main repo zero-write. The
 *     block message points the model at the create-task-worktree ACI tool
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
import { join } from "node:path";

import {
  CREATE_TASK_WORKTREE_TOOL_HINT,
  WorktreeIsolationError,
  classifyCall,
  createTaskWorktree,
  createWorktreeIsolationExecutor,
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
import { validateReadonlyCommand } from "../../../src/harness/aci/tools/bash-readonly.ts";
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

  it("fails typed not_a_git_repo on a bare repo", async () => {
    const bare = mkdtempSync(join(tmpdir(), "iknow-wt-bare-"));
    roots.push(bare);
    git(bare, "init", "-q", "--bare", join(bare, "repo.git"));
    await expect(
      createTaskWorktree({
        repoRoot: join(bare, "repo.git"),
        worktreePath: join(bare, "wt"),
        branch: "iknow/task-x",
      })
    ).rejects.toMatchObject({ kind: "not_a_git_repo" });
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
      if (args[1] === "--is-inside-work-tree") {
        return { code: 0, stdout: "true\n", stderr: "" };
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

  it("maps a worktree-add spawn failure to typed git_unavailable", async () => {
    const repo = makeGitRepo();
    const runner: GitRunner = async (args) => {
      if (args[1] === "--is-inside-work-tree") {
        return { code: 0, stdout: "true\n", stderr: "" };
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
  it("round-trips a valid label through path, owner, and label inversion", () => {
    const root = taskWorktreePath(
      "/repo",
      "d52e0f28-703c-439a-bce4-3a3ae1017139",
      "fix-648"
    );

    expect(root).toBe(
      "/repo/.iknow/worktrees/fix-648--d52e0f28-703c-439a-bce4-3a3ae1017139"
    );
    expect(taskWorktreeOwnerOf(root)).toBe(
      "d52e0f28-703c-439a-bce4-3a3ae1017139"
    );
    expect(taskWorktreeLabelOf(root)).toBe("fix-648");
    expect(
      taskWorktreeBranch("d52e0f28-703c-439a-bce4-3a3ae1017139", "fix-648")
    ).toBe("iknow/task/fix-648-d52e0f28");
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
      enabled: false,
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
      enabled: true,
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
      enabled: true,
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
    expect(first[0]!.message).toContain(CREATE_TASK_WORKTREE_TOOL_HINT);
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
    expect(second[0]!.message).toContain(CREATE_TASK_WORKTREE_TOOL_HINT);
    expect(provisioned).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it("unboundMutateNotice is a factual block: names the tool, no imperative 'create this conversation's worktree' framing (spec casual-ask-context-hygiene SC7)", () => {
    const message = unboundMutateNotice();
    // visible gate prefix invariant (same as the executor-level assertions)
    expect(message.startsWith(`${WORKTREE_ISOLATION_PREFIX} `)).toBe(true);
    // genuine mutations still get pointed at the tool (literal name, not
    // only via the hint constant)
    expect(message).toContain("create-task-worktree");
    expect(message).toContain(CREATE_TASK_WORKTREE_TOOL_HINT);
    // no imperative framing that turns the next model move into "go build a
    // tree" — the notice states facts, the tool's existence, and the
    // read-only main repo; it does not prescribe building a per-conversation
    // worktree
    expect(message).not.toContain("this conversation's task worktree");
    expect(message).not.toContain("end the turn");
    // factual semantics locked: the call WOULD write, and was NOT executed
    expect(message).toContain("This call would write");
    // full-text pin (spec 「vitest 全文锁定」): wording changes must be
    // deliberate test changes, not drift
    expect(message).toBe(
      `${WORKTREE_ISOLATION_PREFIX} This call would write the workspace, and it was not executed: ` +
        `worktree isolation is ON and this session is not yet bound to a task worktree. ` +
        `The main repo stays read-only. The ${CREATE_TASK_WORKTREE_TOOL_HINT} exists for ` +
        `sessions that need a writable root (no auto-provisioning).`
    );
  });

  it("passthrough adjudication survives on a task-worktree-rooted engine: own tree → same-root no-op, provision runs once", async () => {
    const { inner, calls } = fakeInner();
    let provisioned = 0;
    const ownTreeRoot = "/repo/.iknow/worktrees/conv-1";
    const gate = createWorktreeIsolationExecutor({
      enabled: true,
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
      enabled: true,
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
      enabled: true,
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
      enabled: true,
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
      enabled: true,
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
      enabled: true,
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
      enabled: true,
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
      enabled: true,
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
