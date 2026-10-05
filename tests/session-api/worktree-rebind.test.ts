/**
 * Session-api host seam:
 * task worktree provisioning + session-root rebind.
 *
 * The provisioner owns the "create → rebind" pipeline on the host side:
 *   1. `git worktree add` a per-conversation task worktree (via the harness
 *      git layer — no harness-internal imports beyond that module);
 *   2. rebind ONLY the current session's workspaceRoot to the new tree
 *      (hard req ①: other sessions' files are untouched);
 *   3. remember the tree so the per-root engine cache marks it initiallyBound.
 *
 * Boundary classes pinned here: non-git root (a), existing branch/worktree
 * name (b, ADR-0037 §3 fail-closed), missing conversation id, store failure.
 */
import { afterAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  SessionStore,
  CURRENT_SCHEMA_VERSION,
} from "../../src/session-api/store/index.ts";
import type { SessionFileV1 } from "../../src/session-api/store/index.ts";
import { createTaskWorktreeProvisioner } from "../../src/session-api/worktree-rebind.ts";
import {
  createTaskWorktree,
  mainCheckoutOf,
  taskWorktreeBranch,
  taskWorktreeOwnerOf,
  WorktreeIsolationError,
} from "../../src/harness/isolation/worktree-gate.ts";

// -- helpers -----------------------------------------------------------------

const roots: string[] = [];

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function makeGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "iknow-wt-rebind-"));
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

function makeSessionFile(id: string, workspaceRoot: string): SessionFileV1 {
  // T3 / worktreeExclusive: the occupancy check reads `store.listWorkspaceClaims()`
  // (ADR-0070), which still applies the #96 no-assistant-text filter but NOT
  // the #1197 blank-title filter — so a claim is visible to occupancy even with
  // a blank title. The assistant stub below is what makes these fixtures
  // claim-visible; `title: ""` is left deliberate to prove title-independence
  // of the claim. Existing tests are unaffected (they read via `store.load()`).
  const stubMessage = {
    role: "assistant" as const,
    content: [{ type: "text" as const, text: "stub" }],
  };
  const now = new Date().toISOString();
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    conversation_id: id,
    messages: [stubMessage],
    jsonMode: true,
    turnCount: 1,
    updatedAt: now,
    title: "",
    cwd: workspaceRoot,
    sanitized_at: now,
    checkpoints: [],
    workspaceRoot,
  };
}

async function makeStoreWithSessions(repo: string, ids: string[]) {
  const baseDir = mkdtempSync(join(tmpdir(), "iknow-wt-store-"));
  roots.push(baseDir);
  const store = new SessionStore(baseDir, repo);
  for (const id of ids) {
    await store.save({ id, file: makeSessionFile(id, repo) });
  }
  return { store, baseDir };
}

afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

// -- provisioning + rebind -----------------------------------------------------

/**
 * Review Medium-1 (2026-08-29): conversationId is concatenated into the
 * worktree path (`<repoRoot>/.iknow/worktrees/<id>`) and the branch name
 * (`iknow/task-<id>`). The store layer carries no id-shape contract (ids are
 * host-generated UUIDs, joined verbatim into file paths), so the provisioner
 * itself must fail closed on non-segment-safe ids BEFORE any git call or
 * path/branch construction — a malicious/corrupt id (`../x`, `a/b`, leading
 * `-`, whitespace, `.`, ...) must never reach `git worktree add` nor a
 * session-file write.
 */
describe("provision rejects non-segment-safe conversation ids (fail-closed, review Medium-1)", () => {
  const unsafeIds = [
    "../evil",
    "a/b",
    "a\\b",
    ".hidden",
    "..",
    "-leading-dash",
    "white space",
    "id;rm -rf",
    "id\nnewline",
  ];

  for (const id of unsafeIds) {
    it(`rejects conversationId '${JSON.stringify(id)}' with typed rebind_failed, zero git calls, zero store writes`, async () => {
      let gitCalls = 0;
      let loads = 0;
      let saves = 0;
      const prov = createTaskWorktreeProvisioner({
        store: {
          load: async () => {
            loads += 1;
            throw new Error("store must not be reached for an unsafe id");
          },
          save: async () => {
            saves += 1;
          },
        },
        runGit: async () => {
          gitCalls += 1;
          return { code: 0, stdout: "true\n", stderr: "" };
        },
      });

      await expect(
        prov.provision({ conversationId: id, root: "/repo" })
      ).rejects.toMatchObject({
        name: "WorktreeIsolationError",
        kind: "rebind_failed",
      });

      // fail-closed: nothing was probed, nothing was built, nothing rebound
      expect(gitCalls).toBe(0);
      expect(loads).toBe(0);
      expect(saves).toBe(0);
    });
  }

  it("accepts segment-safe ids (alphanumeric + inner - / _)", async () => {
    const repo = makeGitRepo();
    const { store } = await makeStoreWithSessions(repo, ["A9-x_Y"]);
    const prov = createTaskWorktreeProvisioner({ store });
    const root = await prov.provision({ conversationId: "A9-x_Y", root: repo });
    expect(root).toBe(join(repo, ".iknow", "worktrees", "A9-x_Y"));
  });
});

describe("createTaskWorktreeProvisioner", () => {
  it("creates the per-conversation task worktree and rebinds ONLY that session's workspaceRoot", async () => {
    const repo = makeGitRepo();
    const { store } = await makeStoreWithSessions(repo, ["conv-a", "conv-b"]);
    const prov = createTaskWorktreeProvisioner({ store });

    const root = await prov.provision({ conversationId: "conv-a", root: repo });

    // tree created at the deterministic per-conversation path, branch checked out
    const expectedPath = join(repo, ".iknow", "worktrees", "conv-a");
    expect(root).toBe(expectedPath);
    expect(existsSync(expectedPath)).toBe(true);
    expect(git(repo, "worktree", "list")).toContain(expectedPath);
    expect(git(expectedPath, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe(
      `iknow/task-conv-a`
    );
    // main repo HEAD untouched
    const mainBranch = git(repo, "rev-parse", "--abbrev-ref", "HEAD").trim();
    expect(mainBranch).not.toBe("iknow/task-conv-a");

    // rebind: only conv-a's session file moved to the worktree
    const a = await store.load("conv-a");
    const b = await store.load("conv-b");
    expect(a.workspaceRoot).toBe(expectedPath);
    expect(b.workspaceRoot).toBe(repo); // hard req ①: other sessions untouched
    expect(prov.isTaskWorktreeRoot(root)).toBe(true);
    expect(prov.isTaskWorktreeRoot(repo)).toBe(false);
  });

  it("is idempotent per conversation: the second provision returns the same tree without running git worktree add again", async () => {
    const repo = makeGitRepo();
    const { store } = await makeStoreWithSessions(repo, ["conv-a"]);
    let addRuns = 0;
    const baseRunner = (
      await import("../../src/harness/isolation/worktree-gate.ts")
    ).defaultGitRunner;
    const runGit = async (args: readonly string[], cwd: string) => {
      if (args[0] === "worktree" && args[1] === "add") addRuns += 1;
      return baseRunner(args, cwd);
    };
    const prov = createTaskWorktreeProvisioner({ store, runGit });

    const first = await prov.provision({
      conversationId: "conv-a",
      root: repo,
    });
    const second = await prov.provision({
      conversationId: "conv-a",
      root: repo,
    });
    expect(second).toBe(first);
    expect(addRuns).toBe(1);
  });

  it("boundary a — non-git root: typed not_a_git_repo, session file untouched, nothing created under the root", async () => {
    const plain = mkdtempSync(join(tmpdir(), "iknow-wt-plain2-"));
    roots.push(plain);
    const { store } = await makeStoreWithSessions(plain, ["conv-a"]);
    const prov = createTaskWorktreeProvisioner({ store });
    const before = await readdir(plain);

    await expect(
      prov.provision({ conversationId: "conv-a", root: plain })
    ).rejects.toMatchObject({
      name: "WorktreeIsolationError",
      kind: "not_a_git_repo",
    });

    expect(await readdir(plain)).toEqual(before); // zero writes to the main root
    const file = await store.load("conv-a");
    expect(file.workspaceRoot).toBe(plain); // no rebind on failure
    expect(prov.isTaskWorktreeRoot(plain)).toBe(false);
  });

  it("boundary b — existing task branch: typed branch_exists, no silent overwrite, no rebind", async () => {
    const repo = makeGitRepo();
    git(repo, "branch", "iknow/task-conv-a");
    const { store } = await makeStoreWithSessions(repo, ["conv-a"]);
    const prov = createTaskWorktreeProvisioner({ store });

    await expect(
      prov.provision({ conversationId: "conv-a", root: repo })
    ).rejects.toMatchObject({ kind: "branch_exists" });

    const file = await store.load("conv-a");
    expect(file.workspaceRoot).toBe(repo);
    expect(existsSync(join(repo, ".iknow", "worktrees", "conv-a"))).toBe(false);
  });

  it("boundary b — occupied worktree path: typed worktree_exists, no rebind", async () => {
    const repo = makeGitRepo();
    await mkdir(join(repo, ".iknow", "worktrees", "conv-a"), {
      recursive: true,
    });
    const { store } = await makeStoreWithSessions(repo, ["conv-a"]);
    const prov = createTaskWorktreeProvisioner({ store });

    await expect(
      prov.provision({ conversationId: "conv-a", root: repo })
    ).rejects.toMatchObject({ kind: "worktree_exists" });
    const file = await store.load("conv-a");
    expect(file.workspaceRoot).toBe(repo);
  });

  it("missing conversation id → typed rebind_failed (nothing to rebind is fail-closed, not a silent no-op)", async () => {
    const repo = makeGitRepo();
    const { store } = await makeStoreWithSessions(repo, ["conv-a"]);
    const prov = createTaskWorktreeProvisioner({ store });
    await expect(
      prov.provision({ conversationId: undefined, root: repo })
    ).rejects.toMatchObject({ kind: "rebind_failed" });
    await expect(
      prov.provision({ conversationId: "", root: repo })
    ).rejects.toMatchObject({
      kind: "rebind_failed",
    });
  });

  it("store load failure (unknown conversation) → typed rebind_failed carrying the cause", async () => {
    const repo = makeGitRepo();
    const { store } = await makeStoreWithSessions(repo, []);
    const prov = createTaskWorktreeProvisioner({ store });
    await expect(
      prov.provision({ conversationId: "missing-conv", root: repo })
    ).rejects.toMatchObject({
      kind: "rebind_failed",
      message: expect.stringContaining("missing-conv"),
    });
  });

  // -- T4: passthrough anchored to THIS conversation's task worktree -------------

  describe("T4 — passthrough anchored to the session's own task worktree", () => {
    it("session already on its own task worktree (fresh provisioner = server restart): provision is a no-op passthrough — zero git calls, zero rebind writes", async () => {
      const repo = makeGitRepo();
      const { store } = await makeStoreWithSessions(repo, ["conv-a"]);
      // first provision on the main repo (the T3 flow)
      const baseProv = createTaskWorktreeProvisioner({ store });
      const wt = await baseProv.provision({
        conversationId: "conv-a",
        root: repo,
      });

      // fresh provisioner = fresh process: the bound map is empty, but the
      // session root is already conv-a's own task worktree
      let gitCalls = 0;
      const prov = createTaskWorktreeProvisioner({
        store,
        runGit: async (args, cwd) => {
          gitCalls += 1;
          return (
            await import("../../src/harness/isolation/worktree-gate.ts")
          ).defaultGitRunner(args, cwd);
        },
      });
      const root = await prov.provision({ conversationId: "conv-a", root: wt });

      expect(root).toBe(wt); // same tree, no second worktree
      expect(gitCalls).toBe(0); // no `worktree add`, not even a probe
      // no rebind write: the session file's workspaceRoot was already the tree
      const file = await store.load("conv-a");
      expect(file.workspaceRoot).toBe(wt);
      // the passthrough registers the tree so introspection stays truthful
      expect(prov.isTaskWorktreeRoot(wt)).toBe(true);
    });

    it("session on ANOTHER conversation's task worktree: typed foreign_worktree, nothing created, foreign tree untouched", async () => {
      const repo = makeGitRepo();
      const { store } = await makeStoreWithSessions(repo, ["conv-a", "conv-b"]);
      const prov = createTaskWorktreeProvisioner({ store });
      const wtA = await prov.provision({
        conversationId: "conv-a",
        root: repo,
      });
      const headA = git(wtA, "rev-parse", "HEAD").trim();
      const before = await readdir(wtA);

      await expect(
        prov.provision({ conversationId: "conv-b", root: wtA })
      ).rejects.toMatchObject({
        name: "WorktreeIsolationError",
        kind: "foreign_worktree",
        message: expect.stringContaining("conv-a"),
      });
      // foreign tree untouched (no nested task tree, no HEAD move, no writes)
      expect(await readdir(wtA)).toEqual(before);
      expect(git(wtA, "rev-parse", "HEAD").trim()).toBe(headA);
      // conv-b's session file untouched
      const b = await store.load("conv-b");
      expect(b.workspaceRoot).toBe(repo);
    });

    it("session on an unrelated (manual) git worktree: typed foreign_worktree fail-closed, nothing created inside it", async () => {
      const repo = makeGitRepo();
      const manualWt = join(repo, "..", "iknow-wt-manual");
      roots.push(manualWt);
      git(repo, "worktree", "add", manualWt, "-b", "manual-x");
      const { store } = await makeStoreWithSessions(repo, ["conv-a"]);
      const prov = createTaskWorktreeProvisioner({ store });
      const before = await readdir(manualWt);

      await expect(
        prov.provision({ conversationId: "conv-a", root: manualWt })
      ).rejects.toMatchObject({
        name: "WorktreeIsolationError",
        kind: "foreign_worktree",
      });
      expect(await readdir(manualWt)).toEqual(before); // zero pollution
    });
  });

  it("worktree add failure → typed worktree_add_failed, session file untouched (zero rebind on failure)", async () => {
    const repo = makeGitRepo();
    const { store } = await makeStoreWithSessions(repo, ["conv-a"]);
    const prov = createTaskWorktreeProvisioner({
      store,
      runGit: async (args) => {
        if (args[0] === "worktree") {
          return { code: 128, stdout: "", stderr: "fatal: disk full" };
        }
        if (args[1] === "--git-common-dir") {
          return { code: 0, stdout: ".git\n", stderr: "" };
        }
        // branch verify probe: branch does not exist
        return { code: 1, stdout: "", stderr: "" };
      },
    });
    await expect(
      prov.provision({ conversationId: "conv-a", root: repo })
    ).rejects.toMatchObject({
      kind: "worktree_add_failed",
      message: expect.stringContaining("disk full"),
    });
    const file = await store.load("conv-a");
    expect(file.workspaceRoot).toBe(repo);
  });

  it("creates a labeled worktree as a name-only leaf and keeps conversation id as ownership", async () => {
    const repo = makeGitRepo();
    const { store } = await makeStoreWithSessions(repo, ["conv-a"]);
    const prov = createTaskWorktreeProvisioner({ store });

    const root = await prov.provision({
      conversationId: "conv-a",
      root: repo,
      name: "fix-648",
    });

    expect(root).toBe(join(repo, ".iknow", "worktrees", "fix-648"));
    expect(taskWorktreeOwnerOf(root)).toBe("conv-a");
    expect(mainCheckoutOf(root)).toBe(repo);
    expect(git(root, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe(
      taskWorktreeBranch("conv-a", "fix-648")
    );
  });

  it("discards empty, unsafe, and overlong labels without rejecting the provision", async () => {
    const repo = makeGitRepo();
    const names = ["", "a/b", "Bad-name", "bad--name", "x".repeat(41)];
    const ids = names.map((_, index) => `invalid-${index}`);
    const { store } = await makeStoreWithSessions(repo, ids);
    const prov = createTaskWorktreeProvisioner({ store });

    for (const [index, name] of names.entries()) {
      const id = ids[index]!;
      const root = await prov.provision({
        conversationId: id,
        root: repo,
        name,
      });
      expect(root).toBe(join(repo, ".iknow", "worktrees", id));
      expect(taskWorktreeOwnerOf(root)).toBe(id);
      expect(root).not.toContain("--");
    }
  });

  it("coalesces concurrent first provisions and runs git worktree add once", async () => {
    const repo = makeGitRepo();
    const { store } = await makeStoreWithSessions(repo, ["conv-a"]);
    const baseRunner = (
      await import("../../src/harness/isolation/worktree-gate.ts")
    ).defaultGitRunner;
    let addRuns = 0;
    const runGit = async (args: readonly string[], cwd: string) => {
      if (args[0] === "worktree" && args[1] === "add") {
        addRuns += 1;
        await Promise.resolve();
      }
      return baseRunner(args, cwd);
    };
    const prov = createTaskWorktreeProvisioner({ store, runGit });

    const [first, second] = await Promise.all([
      prov.provision({
        conversationId: "conv-a",
        root: repo,
        name: "fix-648",
      }),
      prov.provision({
        conversationId: "conv-a",
        root: repo,
        name: "fix-648",
      }),
    ]);

    expect(first).toBe(second);
    expect(addRuns).toBe(1);
  });

  it("reports active labeled trees and stale task branches without changing git", async () => {
    const repo = makeGitRepo();
    const { store } = await makeStoreWithSessions(repo, ["conv-a"]);
    const prov = createTaskWorktreeProvisioner({ store });
    const active = await prov.provision({
      conversationId: "conv-a",
      root: repo,
      name: "fix-648",
    });
    git(repo, "branch", "iknow/task-stale");

    const activeEntries = await prov.list({ root: repo });
    expect(activeEntries).toEqual([
      {
        label: "fix-648",
        conversationId: "conv-a",
        path: active,
        branch: "iknow/task/fix-648-conv-a",
        head: git(active, "rev-parse", "HEAD").trim(),
        dirty: false,
      },
    ]);

    const withStale = await prov.list({ root: repo, includeStale: true });
    expect(withStale).toHaveLength(2);
    expect(withStale.find((entry) => entry.stale)).toMatchObject({
      conversationId: "stale",
      path: "",
      branch: "iknow/task-stale",
      stale: true,
    });
  });

  it("enters a unique label and rejects an ambiguous label with both owners", async () => {
    const repo = makeGitRepo();
    const { store } = await makeStoreWithSessions(repo, [
      "conv-a",
      "conv-b",
      "conv-c",
    ]);
    const prov = createTaskWorktreeProvisioner({ store });
    const first = await prov.provision({
      conversationId: "conv-a",
      root: repo,
      name: "fix-648",
    });
    const second = await prov.provision({
      conversationId: "conv-b",
      root: repo,
      name: "review",
    });

    const entered = await prov.enter({
      conversationId: "conv-c",
      root: repo,
      targetConversationId: "fix-648",
    });
    expect(entered.path).toBe(first);
    expect((await store.load("conv-c")).workspaceRoot).toBe(first);
    expect(second).toBe(join(repo, ".iknow", "worktrees", "review"));

    const ambiguousRepo = makeGitRepo();
    const { store: ambiguousStore } = await makeStoreWithSessions(
      ambiguousRepo,
      ["conv-a", "conv-b", "conv-c"]
    );
    const ambiguous = createTaskWorktreeProvisioner({
      store: ambiguousStore,
    });
    mkdirSync(join(ambiguousRepo, ".iknow", "worktrees"), { recursive: true });
    await createTaskWorktree({
      repoRoot: ambiguousRepo,
      worktreePath: join(ambiguousRepo, ".iknow", "worktrees", "same--conv-a"),
      branch: "iknow/task/same-conv-a",
      conversationId: "conv-a",
    });
    await createTaskWorktree({
      repoRoot: ambiguousRepo,
      worktreePath: join(ambiguousRepo, ".iknow", "worktrees", "same--conv-b"),
      branch: "iknow/task/same-conv-b",
      conversationId: "conv-b",
    });

    await expect(
      ambiguous.enter({
        conversationId: "conv-c",
        root: ambiguousRepo,
        targetConversationId: "same",
      })
    ).rejects.toMatchObject({
      kind: "ambiguous_worktree",
      message: expect.stringContaining("conv-a"),
    });
    await expect(
      ambiguous.enter({
        conversationId: "conv-c",
        root: ambiguousRepo,
        targetConversationId: "same",
      })
    ).rejects.toMatchObject({
      message: expect.stringContaining("conv-b"),
    });
  });

  it("rejects unsafe label branch collisions instead of extending the branch name", async () => {
    const repo = makeGitRepo();
    const { store } = await makeStoreWithSessions(repo, [
      "12345678-a",
      "12345678-b",
    ]);
    const prov = createTaskWorktreeProvisioner({ store });
    await prov.provision({
      conversationId: "12345678-a",
      root: repo,
      name: "fix-648",
    });

    await expect(
      prov.provision({
        conversationId: "12345678-b",
        root: repo,
        name: "fix-648",
      })
    ).rejects.toMatchObject({ kind: "branch_exists" });
    expect(
      existsSync(join(repo, ".iknow", "worktrees", "fix-648--12345678-b"))
    ).toBe(false);
    expect(existsSync(join(repo, ".iknow", "worktrees", "fix-648"))).toBe(true);
  });

  it("rejects a second conversation that reuses the same label", async () => {
    const repo = makeGitRepo();
    const { store } = await makeStoreWithSessions(repo, ["conv-a", "conv-b"]);
    const prov = createTaskWorktreeProvisioner({ store });
    await prov.provision({
      conversationId: "conv-a",
      root: repo,
      name: "fix-648",
    });
    await expect(
      prov.provision({
        conversationId: "conv-b",
        root: repo,
        name: "fix-648",
      })
    ).rejects.toMatchObject({ kind: "worktree_exists" });
  });

  it("removes only safe clean trees, preserves branches by default, and blocks dirty or unpublished trees", async () => {
    const repo = makeGitRepo();
    const { store } = await makeStoreWithSessions(repo, [
      "conv-clean",
      "conv-dirty",
      "conv-unpublished",
      "conv-default",
    ]);
    const prov = createTaskWorktreeProvisioner({ store });
    const clean = await prov.provision({
      conversationId: "conv-clean",
      root: repo,
      name: "fix-648",
    });
    const dirty = await prov.provision({
      conversationId: "conv-dirty",
      root: repo,
    });
    const unpublished = await prov.provision({
      conversationId: "conv-unpublished",
      root: repo,
    });
    const defaultRemoval = await prov.provision({
      conversationId: "conv-default",
      root: repo,
    });
    await writeFile(join(dirty, "dirty.txt"), "uncommitted\n", "utf8");
    await writeFile(join(unpublished, "committed.txt"), "committed\n", "utf8");
    git(unpublished, "add", "committed.txt");
    git(
      unpublished,
      "-c",
      "user.email=t@t",
      "-c",
      "user.name=t",
      "commit",
      "-qm",
      "task work"
    );

    await expect(
      prov.remove({
        root: clean,
        targetConversationId: "fix-648",
      })
    ).rejects.toMatchObject({ kind: "current_worktree" });
    await expect(
      prov.remove({
        root: repo,
        targetConversationId: "conv-dirty",
      })
    ).rejects.toMatchObject({ kind: "worktree_dirty" });
    await expect(
      prov.remove({
        root: repo,
        targetConversationId: "conv-unpublished",
      })
    ).rejects.toMatchObject({ kind: "unpublished_commits" });

    const receipt = await prov.remove({
      root: repo,
      targetConversationId: "fix-648",
      deleteBranch: true,
    });
    expect(receipt).toMatchObject({
      label: "fix-648",
      conversationId: "conv-clean",
      path: clean,
      branchDeleted: true,
    });
    expect(existsSync(clean)).toBe(false);
    expect(git(repo, "branch", "--list", receipt.branch)).toBe("");

    const defaultReceipt = await prov.remove({
      root: repo,
      targetConversationId: "conv-default",
    });
    expect(defaultReceipt.branchDeleted).toBe(false);
    expect(git(repo, "branch", "--list", defaultReceipt.branch)).toContain(
      defaultReceipt.branch
    );
  });

  it("copies only matching ignored files from worktreeinclude after creating the tree", async () => {
    const repo = makeGitRepo();
    await writeFile(join(repo, ".gitignore"), ".env\n", "utf8");
    git(repo, "add", ".gitignore");
    git(
      repo,
      "-c",
      "user.email=t@t",
      "-c",
      "user.name=t",
      "commit",
      "-qm",
      "ignore env"
    );
    await writeFile(join(repo, ".env"), "TOKEN=secret\n", "utf8");
    await mkdir(join(repo, ".iknow"), { recursive: true });
    await writeFile(
      join(repo, ".iknow", "worktreeinclude"),
      ".env\nnot-ignored.txt\n",
      "utf8"
    );
    await writeFile(join(repo, "not-ignored.txt"), "do not copy\n", "utf8");

    const { store } = await makeStoreWithSessions(repo, ["conv-a"]);
    const prov = createTaskWorktreeProvisioner({
      store,
      projectIdentityRoot: repo,
    });
    const worktree = await prov.provision({
      conversationId: "conv-a",
      root: repo,
    });

    expect(await readFile(join(worktree, ".env"), "utf8")).toBe(
      "TOKEN=secret\n"
    );
    expect(existsSync(join(worktree, "not-ignored.txt"))).toBe(false);
  });

  // Layer 1 (specs/subagent-layers-worktree-deps.md items 2–3): the new tree
  // is deprecated into a worktree whose project deps are resolvable without
  // the model running an install. The runner is injected — these cases never
  // shell out to a real installer; the REAL argv/cwd wiring is asserted on
  // the runner seam (`worktree-deps.test.ts` owns the argv table).
  it("runs the injected project-dep installer in the new tree and reports it in the provision result", async () => {
    const repo = makeGitRepo();
    await writeFile(join(repo, "package.json"), "{}", "utf8");
    await writeFile(join(repo, "package-lock.json"), "{}\n", "utf8");
    git(repo, "add", "package.json", "package-lock.json");
    git(
      repo,
      "-c",
      "user.email=t@t",
      "-c",
      "user.name=t",
      "commit",
      "-qm",
      "lockfile"
    );

    const { store } = await makeStoreWithSessions(repo, ["conv-a"]);
    const installed: string[] = [];
    const prov = createTaskWorktreeProvisioner({
      store,
      projectDepProvisioner: async (worktreePath) => {
        installed.push(worktreePath);
        return {
          status: "installed",
          manager: "npm",
          line: "project deps installed with `npm ci` in the worktree",
        };
      },
    });
    const worktree = await prov.provision({
      conversationId: "conv-a",
      root: repo,
    });

    // the installer ran on the NEW tree, not on the main checkout
    expect(installed).toEqual([worktree]);
    expect(worktree).not.toBe(repo);
  });

  it("a failing project-dep installer is fail-open: the tree still exists and the session was rebound", async () => {
    const repo = makeGitRepo();
    await writeFile(join(repo, "package.json"), "{}", "utf8");
    await writeFile(join(repo, "bun.lock"), "\n", "utf8");
    git(repo, "add", "package.json", "bun.lock");
    git(
      repo,
      "-c",
      "user.email=t@t",
      "-c",
      "user.name=t",
      "commit",
      "-qm",
      "lockfile"
    );

    const { store } = await makeStoreWithSessions(repo, ["conv-a"]);
    const prov = createTaskWorktreeProvisioner({
      store,
      projectDepProvisioner: async () => ({
        status: "failed",
        manager: "bun",
        line: "project deps install failed: `bun install --frozen-lockfile` could not run (spawn bun ENOENT)",
      }),
    });

    const worktree = await prov.provision({
      conversationId: "conv-a",
      root: repo,
    });

    // fail-open: no rollback of the git worktree, no rollback of the rebind
    expect(existsSync(worktree)).toBe(true);
    expect(git(repo, "worktree", "list")).toContain(worktree);
    expect((await store.load("conv-a")).workspaceRoot).toBe(worktree);
  });

  it("a project-dep installer that throws is swallowed: git worktree and rebind survive", async () => {
    const repo = makeGitRepo();
    await writeFile(join(repo, "package.json"), "{}", "utf8");
    await writeFile(
      join(repo, "pnpm-lock.yaml"),
      "lockfileVersion: 9\n",
      "utf8"
    );
    git(repo, "add", "package.json", "pnpm-lock.yaml");
    git(
      repo,
      "-c",
      "user.email=t@t",
      "-c",
      "user.name=t",
      "commit",
      "-qm",
      "lockfile"
    );

    const { store } = await makeStoreWithSessions(repo, ["conv-a"]);
    const prov = createTaskWorktreeProvisioner({
      store,
      projectDepProvisioner: async () => {
        throw new Error("boom: installer exploded");
      },
    });

    const worktree = await prov.provision({
      conversationId: "conv-a",
      root: repo,
    });

    expect(existsSync(worktree)).toBe(true);
    expect((await store.load("conv-a")).workspaceRoot).toBe(worktree);
  });

  it("second provision of the same conversation does not run the installer twice", async () => {
    const repo = makeGitRepo();
    const { store } = await makeStoreWithSessions(repo, ["conv-a"]);
    let installs = 0;
    const prov = createTaskWorktreeProvisioner({
      store,
      projectDepProvisioner: async () => {
        installs += 1;
        return { status: "skipped", line: "project deps skipped: test" };
      },
    });

    const first = await prov.provision({
      conversationId: "conv-a",
      root: repo,
    });
    const second = await prov.provision({
      conversationId: "conv-a",
      root: repo,
    });

    expect(second).toBe(first);
    expect(installs).toBe(1);
  });

  // Review Medium: a leading `/` anchors the pattern to the include root.
  // Before the fix, `/.env` was stripped to `env`-anywhere matching, so a
  // nested `sub/.env` was mirrored into the new tree as well.
  it("anchors a leading-/ include pattern to the include root (sub/.env not copied)", async () => {
    const repo = makeGitRepo();
    await writeFile(join(repo, ".gitignore"), ".env\n", "utf8");
    git(repo, "add", ".gitignore");
    git(
      repo,
      "-c",
      "user.email=t@t",
      "-c",
      "user.name=t",
      "commit",
      "-qm",
      "ignore env"
    );
    await writeFile(join(repo, ".env"), "ROOT_TOKEN=secret\n", "utf8");
    await mkdir(join(repo, "sub"), { recursive: true });
    await writeFile(join(repo, "sub", ".env"), "SUB_TOKEN=leak\n", "utf8");
    await mkdir(join(repo, ".iknow"), { recursive: true });
    await writeFile(join(repo, ".iknow", "worktreeinclude"), "/.env\n", "utf8");

    const { store } = await makeStoreWithSessions(repo, ["conv-anchor"]);
    const prov = createTaskWorktreeProvisioner({
      store,
      projectIdentityRoot: repo,
    });
    const worktree = await prov.provision({
      conversationId: "conv-anchor",
      root: repo,
    });

    expect(await readFile(join(worktree, ".env"), "utf8")).toBe(
      "ROOT_TOKEN=secret\n"
    );
    expect(existsSync(join(worktree, "sub", ".env"))).toBe(false);
  });

  // write-situation-disclosure T9 / SC10 — the enter success receipt tells the
  // model WHO created the tree it just entered (sidecar = disclosure, never
  // authorization). Constant-on: the receipt path reads no setting
  // at all (specs/worktree-exclusive-lock.md SC10 keeps the two features
  // independent). Read failure degrades to sentence omission — never a throw,
  // never a placeholder (typed catch: missing/unreadable sidecar is a legal
  // state for legacy trees, not a fault).
  describe("enter success receipt discloses the tree creator (T9, constant-on)", () => {
    it("entering a foreign tree appends the creator's conversation id from the sidecar and keeps the path as the rebind anchor", async () => {
      const repo = makeGitRepo();
      const { store } = await makeStoreWithSessions(repo, [
        "conv-owner",
        "conv-guest",
      ]);
      const prov = createTaskWorktreeProvisioner({ store });
      const tree = await prov.provision({
        conversationId: "conv-owner",
        root: repo,
        name: "fix-648",
      });

      const entered = await prov.enter({
        conversationId: "conv-guest",
        root: repo,
        targetConversationId: "fix-648",
      });

      expect(entered.path).toBe(tree);
      expect(entered.receipt).toContain(`entered task worktree: ${tree}`);
      expect(entered.receipt).toContain("conv-owner");
      expect((await store.load("conv-guest")).workspaceRoot).toBe(tree);
    });

    it("omits the creator sentence when the sidecar cannot be read (legacy tree) — enter still succeeds", async () => {
      const repo = makeGitRepo();
      const { store } = await makeStoreWithSessions(repo, ["conv-guest"]);
      const prov = createTaskWorktreeProvisioner({ store });
      // Legacy UUID-only leaf: pre-sidecar naming, so the owner is recovered
      // from the leaf — still disclosed via the historical ownership anchor.
      // For a TRUE no-ownership tree, strip the leaf-derived owner too: a
      // foreign label-only tree whose sidecar file was removed must degrade
      // to sentence omission, not to a placeholder or a crash.
      const legacyTree = join(repo, ".iknow", "worktrees", "orphan-tree");
      mkdirSync(join(repo, ".iknow", "worktrees"), { recursive: true });
      await createTaskWorktree({
        repoRoot: repo,
        worktreePath: legacyTree,
        branch: "iknow/task/orphan-tree",
        conversationId: "conv-owner",
      });
      // Simulate an unreadable owner record: the sidecar's gitdir pointer
      // resolves, but the sidecar file itself is removed afterwards.
      const gitdirPointer = readFileSync(join(legacyTree, ".git"), "utf8");
      const gitdir = /^gitdir:\s*(.+)$/m.exec(gitdirPointer)?.[1]?.trim();
      expect(gitdir).toBeDefined();
      rmSync(join(gitdir!, "iknow-conversation-id"));

      const entered = await prov.enter({
        conversationId: "conv-guest",
        root: repo,
        targetConversationId: "orphan-tree",
      });

      expect(entered.path).toBe(legacyTree);
      // Enter itself is unaffected — success path stays success.
      expect((await store.load("conv-guest")).workspaceRoot).toBe(legacyTree);
      // The ownership sentence is absent; the historical UUID-derived owner
      // (the leaf has no `--<id>` suffix either) contributes nothing.
      expect(entered.receipt).toContain(`entered task worktree: ${legacyTree}`);
      expect(entered.receipt).not.toContain("conv-owner");
    });
  });

  // Layer 1 (specs/subagent-layers-worktree-deps.md items 2–3) — the enter
  // path carries the same idempotent ensure: entering a tree whose project
  // deps are not resolvable yet installs them, and the receipt says so. The
  // ensure must never touch a real destination directory the tree already has
  // (no removal, no relink) — the installer's own resolved-marker skip is what
  // makes a second enter a no-op, not a destructive "reset" here.
  describe("enter project-dep ensure (Layer 1)", () => {
    it("runs the injected installer when entering a tree without node_modules and reports it in the receipt", async () => {
      const repo = makeGitRepo();
      const { store } = await makeStoreWithSessions(repo, ["conv-owner"]);
      const ownerProv = createTaskWorktreeProvisioner({ store });
      const tree = await ownerProv.provision({
        conversationId: "conv-owner",
        root: repo,
      });

      const ensured: string[] = [];
      const guestProv = createTaskWorktreeProvisioner({
        store,
        projectDepProvisioner: async (worktreePath) => {
          ensured.push(worktreePath);
          return {
            status: "installed",
            manager: "npm",
            line: "project deps installed with `npm ci` in the worktree",
          };
        },
      });
      const entered = await guestProv.enter({
        conversationId: "conv-owner",
        root: repo,
        targetConversationId: "conv-owner",
      });

      expect(ensured).toEqual([tree]);
      expect(entered.path).toBe(tree);
      expect(entered.receipt).toContain("npm ci");
    });

    it("keeps the enter receipt free of an install line when the tree is already resolvable", async () => {
      const repo = makeGitRepo();
      const { store } = await makeStoreWithSessions(repo, ["conv-owner"]);
      const ownerProv = createTaskWorktreeProvisioner({ store });
      const tree = await ownerProv.provision({
        conversationId: "conv-owner",
        root: repo,
      });
      await mkdir(join(tree, "node_modules"), { recursive: true });

      const guestProv = createTaskWorktreeProvisioner({
        store,
        projectDepProvisioner: async () => ({
          status: "skipped",
          reason: "already_resolved",
          manager: "npm",
          line: "project deps already resolvable in the worktree (node_modules present) — skipped `npm ci`",
        }),
      });
      const entered = await guestProv.enter({
        conversationId: "conv-owner",
        root: repo,
        targetConversationId: "conv-owner",
      });

      expect(entered.path).toBe(tree);
      // A no-op ensure contributes no install sentence to the receipt.
      expect(entered.receipt).not.toContain("npm ci");
      // The installer did not remove the destination directory the tree had.
      expect(existsSync(join(tree, "node_modules"))).toBe(true);
    });

    it("an idempotent re-enter (same session, same tree) keeps the receipt free of placeholder text", async () => {
      // The receipt is built by a shared formatter; its optional dep suffix
      // must stay absent (not stringify) when there is nothing to report —
      // `"...disclosure" + undefined` would render the literal "undefined".
      const repo = makeGitRepo();
      const { store } = await makeStoreWithSessions(repo, ["conv-owner"]);
      const prov = createTaskWorktreeProvisioner({ store });
      const tree = await prov.provision({
        conversationId: "conv-owner",
        root: repo,
      });

      const entered = await prov.enter({
        conversationId: "conv-owner",
        root: repo,
        targetConversationId: "conv-owner",
      });

      expect(entered.path).toBe(tree);
      expect(entered.receipt).not.toContain("undefined");
    });

    // D4 — the enter receipt and the provision report are the SAME rendering
    // path (`collectProjectDepsLine`), so the skip/failure wording the model
    // sees cannot drift between the two seams. These cases pin the enter-side
    // receipt for the two actionable SKIP reasons, which had zero coverage.
    it("puts the no_package_json skip line in the enter receipt", async () => {
      const repo = makeGitRepo();
      const { store } = await makeStoreWithSessions(repo, ["conv-owner"]);
      const ownerProv = createTaskWorktreeProvisioner({ store });
      const tree = await ownerProv.provision({
        conversationId: "conv-owner",
        root: repo,
      });

      const guestProv = createTaskWorktreeProvisioner({
        store,
        projectDepProvisioner: async () => ({
          status: "skipped",
          reason: "no_package_json",
          line: "project deps skipped: no package.json in the worktree (nothing to install)",
        }),
      });
      const entered = await guestProv.enter({
        conversationId: "conv-owner",
        root: repo,
        targetConversationId: "conv-owner",
      });

      expect(entered.path).toBe(tree);
      // verbatim: the same `line` the provision path would hand to ctx.report
      expect(entered.receipt).toContain(
        "project deps skipped: no package.json in the worktree (nothing to install)"
      );
    });

    it("puts the no_lockfile skip line in the enter receipt", async () => {
      const repo = makeGitRepo();
      const { store } = await makeStoreWithSessions(repo, ["conv-owner"]);
      const ownerProv = createTaskWorktreeProvisioner({ store });
      const tree = await ownerProv.provision({
        conversationId: "conv-owner",
        root: repo,
      });

      const line =
        "project deps skipped: package.json present but no supported lockfile (pnpm-lock.yaml / bun.lock / bun.lockb / package-lock.json)";
      const guestProv = createTaskWorktreeProvisioner({
        store,
        projectDepProvisioner: async () => ({
          status: "skipped",
          reason: "no_lockfile",
          line,
        }),
      });
      const entered = await guestProv.enter({
        conversationId: "conv-owner",
        root: repo,
        targetConversationId: "conv-owner",
      });

      expect(entered.path).toBe(tree);
      expect(entered.receipt).toContain(line);
    });

    it("puts a failed-install line in the enter receipt (fail-open, rebind still happens)", async () => {
      const repo = makeGitRepo();
      const { store } = await makeStoreWithSessions(repo, ["conv-owner"]);
      const ownerProv = createTaskWorktreeProvisioner({ store });
      const tree = await ownerProv.provision({
        conversationId: "conv-owner",
        root: repo,
      });

      const line =
        "project deps install failed: `npm ci` timed out after 120s (killed) — the worktree still exists; install manually in it if the task needs node_modules";
      const guestProv = createTaskWorktreeProvisioner({
        store,
        projectDepProvisioner: async () => ({
          status: "failed",
          manager: "npm",
          line,
        }),
      });
      const entered = await guestProv.enter({
        conversationId: "conv-owner",
        root: repo,
        targetConversationId: "conv-owner",
      });

      expect(entered.path).toBe(tree);
      expect(entered.receipt).toContain(line);
      expect((await store.load("conv-owner")).workspaceRoot).toBe(tree);
    });

    // D5 — `enter` registers the boundary BEFORE running the ensure, so a
    // concurrent / repeated enter cannot race a second installer into the same
    // tree. Before the fix the guard (`bound.get(...) === target`) sat behind
    // the install, so both callers missed it and both installed.
    it("coalesces concurrent enters of the same tree into one install (boundary registered before ensure)", async () => {
      const repo = makeGitRepo();
      const { store } = await makeStoreWithSessions(repo, ["conv-owner"]);
      const ownerProv = createTaskWorktreeProvisioner({ store });
      const tree = await ownerProv.provision({
        conversationId: "conv-owner",
        root: repo,
      });

      let installs = 0;
      let releaseFirstInstall: () => void = () => undefined;
      const holdFirstInstall = new Promise<void>((resolve) => {
        releaseFirstInstall = resolve;
      });
      // Resolves once the FIRST install is actually running, so the second
      // enter provably arrives while the first is still in flight.
      let noteFirstInstall: () => void = () => undefined;
      const firstInstallRunning = new Promise<void>((resolve) => {
        noteFirstInstall = resolve;
      });
      const guestProv = createTaskWorktreeProvisioner({
        store,
        projectDepProvisioner: async () => {
          installs += 1;
          if (installs === 1) {
            noteFirstInstall();
            await holdFirstInstall;
          }
          return { status: "installed", manager: "npm", line: "deps" };
        },
      });

      const first = guestProv.enter({
        conversationId: "conv-owner",
        root: repo,
        targetConversationId: "conv-owner",
      });
      await firstInstallRunning;
      const second = await guestProv.enter({
        conversationId: "conv-owner",
        root: repo,
        targetConversationId: "conv-owner",
      });
      releaseFirstInstall();
      const firstEntered = await first;

      expect(second.path).toBe(tree);
      expect(firstEntered.path).toBe(tree);
      // exactly ONE install reached the seam: the second call took the
      // idempotent re-enter early return instead of racing a second install
      expect(installs).toBe(1);
    });

    it("re-entering the same tree does not install twice across sequential calls", async () => {
      const repo = makeGitRepo();
      const { store } = await makeStoreWithSessions(repo, ["conv-owner"]);
      const ownerProv = createTaskWorktreeProvisioner({ store });
      const tree = await ownerProv.provision({
        conversationId: "conv-owner",
        root: repo,
      });

      let installs = 0;
      const guestProv = createTaskWorktreeProvisioner({
        store,
        projectDepProvisioner: async () => {
          installs += 1;
          return { status: "installed", manager: "npm", line: "deps" };
        },
      });
      await guestProv.enter({
        conversationId: "conv-owner",
        root: repo,
        targetConversationId: "conv-owner",
      });
      await guestProv.enter({
        conversationId: "conv-owner",
        root: repo,
        targetConversationId: "conv-owner",
      });

      expect(installs).toBe(1);
      expect(tree).toBe((await store.load("conv-owner")).workspaceRoot);
    });

    it("a throwing installer does not fail the enter: rebind still happens", async () => {
      const repo = makeGitRepo();
      const { store } = await makeStoreWithSessions(repo, ["conv-owner"]);
      const ownerProv = createTaskWorktreeProvisioner({ store });
      const tree = await ownerProv.provision({
        conversationId: "conv-owner",
        root: repo,
      });

      const guestProv = createTaskWorktreeProvisioner({
        store,
        projectDepProvisioner: async () => {
          throw new Error("installer exploded");
        },
      });
      const entered = await guestProv.enter({
        conversationId: "conv-owner",
        root: repo,
        targetConversationId: "conv-owner",
      });

      expect(entered.path).toBe(tree);
      expect((await store.load("conv-owner")).workspaceRoot).toBe(tree);
    });
  });
});

// -- enter pre-check occupancy + `worktree_claimed` --------------------------------------
//
// ADR-0070: enter runs an occupancy pre-check. Default (OFF) behavior is unchanged;
// ON + occupied -> typed rejection carrying the occupying session id + the release path.
//
// Five input classes:
//   - empty          -> list() empty / record lacks workspaceRoot / empty-string fields -> pass through;
//   - negative       -> OFF mode + occupancy -> pass through (zero regression for OFF);
//   - overflow       -> path normalization (trailing separator / long absolute path);
//   - concurrent     -> TOCTOU double-success — not tested here, left to the pinning test below;
//   - exception      -> listSessions throws non-ENOENT -> rethrow as-is or typed
//                       fail-closed (**never** silently pass).
//
// Self-occupancy is not occupancy: skip records where `conversation_id === self`
// (idempotent re-enter takes the `bound.get(self) === target` early return and never
// reaches here; but self enumerated explicitly via store.list() must still be
// excluded — especially important when a fresh process has an empty bound Map).
//
// No disk writes: the occupancy check is purely a read of store.list(); it must never
// call store.save / mkdir / writeFile or any other write (review constraint).
describe("worktreeExclusive — T3 / ADR-0070 enter 前置占用检查 + worktree_claimed", () => {
  it("ON档 + 目标树被别的现存会话记录占用 → typed worktree_claimed 含占用者会话 id + 释放路径", async () => {
    const repo = makeGitRepo();
    const { store } = await makeStoreWithSessions(repo, [
      "conv-owner",
      "conv-guest",
    ]);

    // Owner provisions its tree first — the provisioner with `store` persists
    // the rebind, so store.list() will see owner.workspaceRoot === tree.
    const ownerProv = createTaskWorktreeProvisioner({ store });
    const tree = await ownerProv.provision({
      conversationId: "conv-owner",
      root: repo,
    });
    expect((await store.load("conv-owner")).workspaceRoot).toBe(tree);

    // Guest enters with worktreeExclusive = ON — must reject with the
    // occupier's session id AND a release-path sentence (resume + exit, or
    // delete the session record). SC3 / SC9.
    const guestProv = createTaskWorktreeProvisioner({
      store,
      worktreeExclusive: true,
      listSessions: () => store.listWorkspaceClaims(),
    });

    await expect(
      guestProv.enter({
        conversationId: "conv-guest",
        root: repo,
        targetConversationId: "conv-owner",
      })
    ).rejects.toMatchObject({
      name: "WorktreeIsolationError",
      kind: "worktree_claimed",
      message: expect.stringContaining("conv-owner"),
    });
    // Release path sentence — one of the two reachable moves must appear
    // verbatim (resume + exit-worktree OR delete the session record).
    await expect(
      guestProv.enter({
        conversationId: "conv-guest",
        root: repo,
        targetConversationId: "conv-owner",
      })
    ).rejects.toMatchObject({
      message: expect.stringMatching(/exit-worktree|delete the session record/),
    });
    // Weak-mode disclosure pinning (receipt point of the three mandatory disclosures): the
    // receipt must explicitly state "occupancy is visible only within the current process" —
    // so operators do not mistake it for cross-process exclusivity (strong mode would have
    // to scan every project namespace under <dataDir>/sessions/*, which is out of scope here).
    await expect(
      guestProv.enter({
        conversationId: "conv-guest",
        root: repo,
        targetConversationId: "conv-owner",
      })
    ).rejects.toMatchObject({
      message: expect.stringContaining(
        "occupancy is visible only within the current process"
      ),
    });

    // SC7 + zero new writes on rejection: guest session file untouched,
    // guest is NOT bound to anything.
    const guestFile = await store.load("conv-guest");
    expect(guestFile.workspaceRoot).toBe(repo);
    expect(guestProv.isTaskWorktreeRoot(tree)).toBe(false);
  });

  it("ON档 + 无占用 → enter 照常成功（与 OFF 档一致）", async () => {
    const repo = makeGitRepo();
    const { store } = await makeStoreWithSessions(repo, [
      "conv-owner",
      "conv-guest",
    ]);
    const ownerProv = createTaskWorktreeProvisioner({ store });
    const tree = await ownerProv.provision({
      conversationId: "conv-owner",
      root: repo,
    });
    // Owner EXIT its tree — record's workspaceRoot flips back to repo, so
    // the tree is no longer occupied. Then a fresh guest enters it.
    await ownerProv.exit({
      conversationId: "conv-owner",
      root: tree,
    });
    expect((await store.load("conv-owner")).workspaceRoot).toBe(repo);

    const guestProv = createTaskWorktreeProvisioner({
      store,
      worktreeExclusive: true,
      listSessions: () => store.listWorkspaceClaims(),
    });
    const entered = await guestProv.enter({
      conversationId: "conv-guest",
      root: repo,
      targetConversationId: "conv-owner",
    });
    expect(entered.path).toBe(tree);
    expect((await store.load("conv-guest")).workspaceRoot).toBe(tree);
  });

  it("自占用不算占用：幂等 re-enter 返回同一根，零 list 调用（OFF 行为保留；SC5）", async () => {
    const repo = makeGitRepo();
    const { store } = await makeStoreWithSessions(repo, ["conv-a"]);
    const ownerProv = createTaskWorktreeProvisioner({ store });
    const tree = await ownerProv.provision({
      conversationId: "conv-a",
      root: repo,
    });

    // Same process — bound Map already has self → tree. Re-enter: skip
    // list() entirely (zero occupancy check overhead).
    let listCalls = 0;
    const guestProv = createTaskWorktreeProvisioner({
      store,
      worktreeExclusive: true,
      listSessions: () => {
        listCalls += 1;
        return store.list();
      },
    });
    const first = await guestProv.enter({
      conversationId: "conv-a",
      root: repo,
      targetConversationId: "conv-a",
    });
    const callsAfterFirst = listCalls;
    const second = await guestProv.enter({
      conversationId: "conv-a",
      root: repo,
      targetConversationId: "conv-a",
    });
    expect(second.path).toBe(first.path);
    expect(second.path).toBe(tree);
    // First call exercises the occupancy check and self-skips; the idempotent
    // re-enter path (second call) skips list entirely (bound Map already has
    // self → tree, early-return before the check).
    expect(second.path).toBe(tree);
    expect(listCalls).toBe(callsAfterFirst);
  });

  it("自占用不算占用：fresh process bound Map 为空、list 含 self → 跳过（不 throw）", async () => {
    const repo = makeGitRepo();
    const { store } = await makeStoreWithSessions(repo, ["conv-a"]);
    const ownerProv = createTaskWorktreeProvisioner({ store });
    const tree = await ownerProv.provision({
      conversationId: "conv-a",
      root: repo,
    });
    expect((await store.load("conv-a")).workspaceRoot).toBe(tree);

    // Fresh provisioner = fresh process. bound Map is empty. Re-enter:
    // the occupancy check runs and sees self in the list — must skip self.
    let listCalled = false;
    const guestProv = createTaskWorktreeProvisioner({
      store,
      worktreeExclusive: true,
      listSessions: () => {
        listCalled = true;
        return store.list();
      },
    });
    const entered = await guestProv.enter({
      conversationId: "conv-a",
      root: repo,
      targetConversationId: "conv-a",
    });
    expect(entered.path).toBe(tree);
    expect(listCalled).toBe(true); // check ran (and passed for self)
  });

  it("记录缺 workspaceRoot 字段 / 字段空串 → 视为无占用放行（不 throw；empty 臂）", async () => {
    const repo = makeGitRepo();
    let listCalled = 0;
    const listSessions = async () => {
      listCalled += 1;
      // Mix in three shapes: missing field, empty string, valid unbound entry.
      return [
        { conversation_id: "ghost-1", workspaceRoot: undefined } as {
          conversation_id: string;
          workspaceRoot?: string;
        },
        { conversation_id: "ghost-2", workspaceRoot: "" } as {
          conversation_id: string;
          workspaceRoot?: string;
        },
        {
          conversation_id: "ghost-3",
          workspaceRoot: "/some/other/path",
        } as { conversation_id: string; workspaceRoot?: string },
      ];
    };

    // Owner provisions without store — the empty-records semantics under
    // test live in `listSessions`, not in `store.list()`. We don't need a
    // real store here.
    const ownerProv = createTaskWorktreeProvisioner({});
    const tree = await ownerProv.provision({
      conversationId: "conv-a",
      root: repo,
    });

    const guestProv = createTaskWorktreeProvisioner({
      worktreeExclusive: true,
      listSessions,
    });
    const entered = await guestProv.enter({
      conversationId: "conv-b",
      root: repo,
      targetConversationId: "conv-a",
    });
    expect(entered.path).toBe(tree);
    expect(listCalled).toBeGreaterThan(0);
  });

  it("listSessions 抛非 ENOENT I/O → typed rebind_failed（绝不静默放行；exception 臂）", async () => {
    const repo = makeGitRepo();
    const ownerProv = createTaskWorktreeProvisioner({});
    await ownerProv.provision({ conversationId: "conv-a", root: repo });

    const listSessions = async (): Promise<
      ReadonlyArray<{ conversation_id: string; workspaceRoot?: string }>
    > => {
      throw {
        kind: "io_error",
        conversation_id: "",
        cause: "EACCES: permission denied",
      };
    };

    const guestProv = createTaskWorktreeProvisioner({
      worktreeExclusive: true,
      listSessions,
    });
    await expect(
      guestProv.enter({
        conversationId: "conv-b",
        root: repo,
        targetConversationId: "conv-a",
      })
    ).rejects.toMatchObject({
      name: "WorktreeIsolationError",
      kind: "rebind_failed",
      message: expect.stringMatching(/EACCES|permission denied/),
    });
  });

  it("路径归一化：占用者记录里的 workspaceRoot 带尾随分隔符仍被识别（overflow 臂）", async () => {
    const repo = makeGitRepo();
    const ownerProv = createTaskWorktreeProvisioner({});
    const tree = await ownerProv.provision({
      conversationId: "conv-a",
      root: repo,
    });

    // Pretend an external record wrote the workspaceRoot with a trailing
    // separator. path.resolve() normalizes both sides — must compare equal.
    const listSessions = async () => [
      { conversation_id: "conv-a", workspaceRoot: `${tree}/` },
    ];

    const guestProv = createTaskWorktreeProvisioner({
      worktreeExclusive: true,
      listSessions,
    });
    await expect(
      guestProv.enter({
        conversationId: "conv-b",
        root: repo,
        targetConversationId: "conv-a",
      })
    ).rejects.toMatchObject({
      kind: "worktree_claimed",
      message: expect.stringContaining("conv-a"),
    });
  });

  it("OFF档零回归：worktreeExclusive 缺席 / false → 占用检查完全跳过（SC2）", async () => {
    const repo = makeGitRepo();
    const ownerProv = createTaskWorktreeProvisioner({});
    await ownerProv.provision({ conversationId: "conv-a", root: repo });

    // Injecting a listSessions that would refuse to be called. If the
    // provisioner calls it under OFF mode, the test fails fast.
    let listCalls = 0;
    const listSessions = () => {
      listCalls += 1;
      throw new Error("listSessions must not be called when OFF");
    };

    // Case 1: opt omitted entirely
    const off1 = createTaskWorktreeProvisioner({ listSessions });
    await off1.enter({
      conversationId: "conv-b",
      root: repo,
      targetConversationId: "conv-a",
    });
    expect(listCalls).toBe(0);

    // Case 2: opt explicitly false
    const off2 = createTaskWorktreeProvisioner({
      worktreeExclusive: false,
      listSessions,
    });
    await off2.enter({
      conversationId: "conv-c",
      root: repo,
      targetConversationId: "conv-a",
    });
    expect(listCalls).toBe(0);

    // Case 3: opt truthy-but-not-true → also OFF (fail-closed)
    const off3 = createTaskWorktreeProvisioner({
      worktreeExclusive: "yes" as unknown as boolean,
      listSessions,
    });
    await off3.enter({
      conversationId: "conv-d",
      root: repo,
      targetConversationId: "conv-a",
    });
    expect(listCalls).toBe(0);
  });

  it("恢复路径：删除占用记录后另一会话 enter 成功（SC9）", async () => {
    const repo = makeGitRepo();
    const { store } = await makeStoreWithSessions(repo, [
      "conv-owner",
      "conv-guest",
    ]);
    const ownerProv = createTaskWorktreeProvisioner({ store });
    const tree = await ownerProv.provision({
      conversationId: "conv-owner",
      root: repo,
    });

    // First attempt blocked.
    const guestBlocked = createTaskWorktreeProvisioner({
      store,
      worktreeExclusive: true,
      listSessions: () => store.listWorkspaceClaims(),
    });
    await expect(
      guestBlocked.enter({
        conversationId: "conv-guest",
        root: repo,
        targetConversationId: "conv-owner",
      })
    ).rejects.toMatchObject({ kind: "worktree_claimed" });

    // Delete the occupier's session record → release path.
    await store.delete("conv-owner");

    // Second attempt on a FRESH provisioner succeeds.
    const guestOk = createTaskWorktreeProvisioner({
      store,
      worktreeExclusive: true,
      listSessions: () => store.listWorkspaceClaims(),
    });
    const entered = await guestOk.enter({
      conversationId: "conv-guest",
      root: repo,
      targetConversationId: "conv-owner",
    });
    expect(entered.path).toBe(tree);
    expect((await store.load("conv-guest")).workspaceRoot).toBe(tree);
  });

  it("listSessions 返回极多条目（>10）也不退化为笼统拒绝——按逐条 verdict 裁决（overflow 臂）", async () => {
    const repo = makeGitRepo();
    // Create the target tree without store plumbing (store not needed for
    // occupancy check semantics here).
    const ownerProv = createTaskWorktreeProvisioner({});
    const tree = await ownerProv.provision({
      conversationId: "conv-target",
      root: repo,
    });

    // 50 unrelated entries + 1 real claim at the end. Verdict must hit the
    // right one without short-circuiting on the long list.
    const listSessions = async () => {
      const entries: Array<{
        conversation_id: string;
        workspaceRoot?: string;
      }> = [];
      for (let i = 0; i < 50; i += 1) {
        entries.push({
          conversation_id: `noise-${i}`,
          workspaceRoot: `/elsewhere/worktree-${i}`,
        });
      }
      entries.push({ conversation_id: "conv-claimant", workspaceRoot: tree });
      return entries;
    };

    const guestProv = createTaskWorktreeProvisioner({
      worktreeExclusive: true,
      listSessions,
    });
    await expect(
      guestProv.enter({
        conversationId: "conv-guest",
        root: repo,
        targetConversationId: "conv-target",
      })
    ).rejects.toMatchObject({
      kind: "worktree_claimed",
      message: expect.stringContaining("conv-claimant"),
    });
  });

  // TOCTOU behavior pinning.
  //
  // Known behavior (ADR-0070 known limitation; concurrent arm of the five input classes):
  // occupancy comes from persisted records, written only on "tool success + session save".
  // Two sessions entering the same never-recorded tree within one time window may both
  // read "unclaimed" and both succeed. This is deliberately not solved (solving would need
  // a lock file or a registry — explicitly ruled out with the human); the requirement is
  // to **pin the behavior** — no fake mutual exclusion, no hiding the window.
  //
  // Construction: two independent provisioner instances, each stubbing a listSessions that
  // always returns []. This simulates the real timing where "neither session's persistent
  // record is written yet" — equivalent to the view SessionStore.list() gives inside the
  // time window between assertNotClaimed and persistWorkspaceRoot at the enter seam.
  // Comments and the test name state this is known behavior, not a defect.
  it("L2 TOCTOU 行为钉住：两会话同窗 enter 同一棵无记录树 → 双双成功（已知行为，spec 不假装互斥）", async () => {
    const repo = makeGitRepo();
    // A bare-bones owner provisions the target tree (no occupancy check, no
    // store plumbing — this just gives us a real linked worktree on disk so
    // the two guests' enter() pass the four target-validation checks).
    const ownerProv = createTaskWorktreeProvisioner({});
    const tree = await ownerProv.provision({
      conversationId: "conv-owner",
      root: repo,
    });

    // Two fresh guests, each with its own provisioner (= its own process-
    // equivalent `bound` Map) and its own stub listSessions. The stub
    // freezes the "no record points at `tree` yet" timeline; in production
    // that window is the span from assertNotClaimed's read up to
    // persistWorkspaceRoot's write inside the same process, and across
    // processes it's the same window crossed by two independent CLI runs.
    const guest1 = createTaskWorktreeProvisioner({
      worktreeExclusive: true,
      listSessions: async () => [],
    });
    const guest2 = createTaskWorktreeProvisioner({
      worktreeExclusive: true,
      listSessions: async () => [],
    });

    const r1 = await guest1.enter({
      conversationId: "conv-guest-1",
      root: repo,
      targetConversationId: "conv-owner",
    });
    const r2 = await guest2.enter({
      conversationId: "conv-guest-2",
      root: repo,
      targetConversationId: "conv-owner",
    });

    // Pinning: both succeed with the same path. This is known behavior, not a bug — do not
    // fail this test to "fix" it into mutual exclusion; a fix would break the zero-new-disk-writes
    // constraint and the human-confirmed "no lock file / no occupancy registry".
    expect(r1.path).toBe(tree);
    expect(r2.path).toBe(tree);
    // Each bound Map claims for itself — the de-facto state after the TOCTOU window.
    expect(guest1.isTaskWorktreeRoot(tree)).toBe(true);
    expect(guest2.isTaskWorktreeRoot(tree)).toBe(true);
  });
});
