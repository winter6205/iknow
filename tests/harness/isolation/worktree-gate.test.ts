/**
 * T3 (plans/worktree-isolation-on-mutate.md) — mutate gate + task worktree
 * creation at the harness seam.
 *
 * Covers ADR-0037 boundary classes:
 *   a. non-git repo / git unavailable → fail-closed typed error, zero writes
 *   b. task branch / worktree path already exists → deterministic typed
 *      error, no silent overwrite (ADR-0037 §3)
 *   c. concurrent first mutate in the same session → idempotent provisioning
 *      (one worktree, both calls bound to the same tree)
 *   d. switch OFF → byte-identical to today (gate transparent)
 *
 * Plus hard requirements: create-without-rebind is invalid (gate blocks the
 * intercepted call — a stale-root engine must never write the main repo),
 * failures surface as typed, non-empty, visible errors.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  WorktreeIsolationError,
  classifyCall,
  createTaskWorktree,
  createWorktreeIsolationExecutor,
  WORKTREE_ISOLATION_PREFIX,
} from "../../../src/harness/isolation/worktree-gate.ts";
import type { GitRunner } from "../../../src/harness/isolation/worktree-gate.ts";
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

  it("classifies bash by readonly command validation (SSOT validateReadonlyCommand)", () => {
    expect(
      classifyCall({ id: "3", name: "bash", input: { command: "ls -la src" } })
    ).toBe("read");
    expect(
      classifyCall({ id: "4", name: "bash", input: { command: "cat a.txt" } })
    ).toBe("read");
    expect(
      classifyCall({
        id: "5",
        name: "bash",
        input: { command: "rm -rf build" },
      })
    ).toBe("mutate");
    expect(
      classifyCall({
        id: "6",
        name: "bash",
        input: { command: "echo x > f.txt" },
      })
    ).toBe("mutate");
    // non-string command → fail-closed mutate
    expect(
      classifyCall({ id: "7", name: "bash", input: { command: 42 } })
    ).toBe("mutate");
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
});

// -- gate executor ------------------------------------------------------------

describe("createWorktreeIsolationExecutor", () => {
  it("boundary d — switch OFF passes everything through, provision never called", async () => {
    const { inner, calls } = fakeInner();
    let provisioned = 0;
    const gate = createWorktreeIsolationExecutor({
      enabled: false,
      root: "/main",
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
      root: "/main",
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

  it("first mutate is intercepted (zero inner calls = zero main-repo writes), then rebind notice; provision runs once", async () => {
    const { inner, calls } = fakeInner();
    let provisioned = 0;
    const gate = createWorktreeIsolationExecutor({
      enabled: true,
      root: "/main",
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
    expect(first[0]!.message).toContain("/wt");
    expect(first[0]!.message!.length).toBeGreaterThan(20);
    expect(calls).toHaveLength(0); // inner never reached → main repo zero-write

    // subsequent mutate on the same (stale-root) engine: still blocked, no re-provision
    const second = await gate.executeAll([writeCall("c2")]);
    expect(second[0]!.kind).toBe("execution_failed");
    expect(provisioned).toBe(1);
    expect(calls).toHaveLength(0);
  });

  it("boundary c — concurrent first mutates in the same session provision exactly once and bind to the same tree", async () => {
    const { inner, calls } = fakeInner();
    let provisioned = 0;
    let resolveProvision!: (root: string) => void;
    const gate = createWorktreeIsolationExecutor({
      enabled: true,
      root: "/main",
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

    expect(provisioned).toBe(1); // one worktree, one branch
    expect(calls).toHaveLength(0);
    for (const batch of [r1, r2]) {
      expect(batch[0]!.kind).toBe("execution_failed");
      expect(batch[0]!.message).toContain("/wt"); // both bound to the same tree
    }
  });

  it("per-session state: different conversationIds provision independently (rebind must not leak across sessions)", async () => {
    const { inner, calls } = fakeInner();
    const provisionedFor: (string | undefined)[] = [];
    const gate = createWorktreeIsolationExecutor({
      enabled: true,
      root: "/main",
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

  it("mutate passes through when the engine root already is the bound task worktree (provision no-op / initiallyBound)", async () => {
    const { inner, calls } = fakeInner();
    let provisioned = 0;
    const gate = createWorktreeIsolationExecutor({
      enabled: true,
      root: "/wt",
      provision: async () => {
        provisioned += 1;
        return "/wt"; // host: session already rebound to this very root
      },
      inner,
    });
    const out = await gate.executeAll([writeCall()]);
    expect(provisioned).toBe(1);
    expect(calls).toHaveLength(1); // reached the tools → mutates land in the worktree
    expect(out[0]!.kind).toBe("ok");

    const gate2 = createWorktreeIsolationExecutor({
      enabled: true,
      root: "/wt",
      initiallyBound: true,
      provision: async () => {
        throw new Error("must not provision");
      },
      inner: fakeInner().inner,
    });
    const out2 = await gate2.executeAll([writeCall("c9")]);
    expect(out2[0]!.kind).toBe("ok");
  });

  it("boundary a/failure — provision failure is fail-closed: typed visible error, inner never called, retry allowed", async () => {
    const { inner, calls } = fakeInner();
    let attempts = 0;
    const observed: WorktreeIsolationError[] = [];
    const gate = createWorktreeIsolationExecutor({
      enabled: true,
      root: "/main",
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

    // next mutate retries provisioning (still fail-closed while it fails)
    const out2 = await gate.executeAll([writeCall("c2")]);
    expect(out2[0]!.kind).toBe("execution_failed");
    expect(attempts).toBe(2);
    expect(calls).toHaveLength(0);
  });

  it("non-Error provision throw is wrapped into a typed rebind_failed error", async () => {
    const { inner } = fakeInner();
    const gate = createWorktreeIsolationExecutor({
      enabled: true,
      root: "/main",
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
      root: "/wt",
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
