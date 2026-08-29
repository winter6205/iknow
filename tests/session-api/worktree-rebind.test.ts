/**
 * T3 (plans/worktree-isolation-on-mutate.md) — session-api host seam:
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
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { readdir, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  SessionStore,
  CURRENT_SCHEMA_VERSION,
} from "../../src/session-api/store/index.ts";
import type { SessionFileV1 } from "../../src/session-api/store/index.ts";
import {
  createTaskWorktreeProvisioner,
} from "../../src/session-api/worktree-rebind.ts";
import { WorktreeIsolationError } from "../../src/harness/isolation/worktree-gate.ts";

// -- helpers -----------------------------------------------------------------

const roots: string[] = [];

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function makeGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "iknow-wt-rebind-"));
  roots.push(dir);
  git(dir, "init", "-q");
  git(dir, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-qm", "init");
  return dir;
}

function makeSessionFile(id: string, workspaceRoot: string): SessionFileV1 {
  const now = new Date().toISOString();
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    conversation_id: id,
    messages: [],
    jsonMode: true,
    turnCount: 0,
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

    const first = await prov.provision({ conversationId: "conv-a", root: repo });
    const second = await prov.provision({ conversationId: "conv-a", root: repo });
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
    ).rejects.toMatchObject({ name: "WorktreeIsolationError", kind: "not_a_git_repo" });

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
    await mkdir(join(repo, ".iknow", "worktrees", "conv-a"), { recursive: true });
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
    await expect(prov.provision({ conversationId: undefined, root: repo })).rejects.toMatchObject(
      { kind: "rebind_failed" }
    );
    await expect(prov.provision({ conversationId: "", root: repo })).rejects.toMatchObject({
      kind: "rebind_failed",
    });
  });

  it("store load failure (unknown conversation) → typed rebind_failed carrying the cause", async () => {
    const repo = makeGitRepo();
    const { store } = await makeStoreWithSessions(repo, []);
    const prov = createTaskWorktreeProvisioner({ store });
    await expect(
      prov.provision({ conversationId: "missing-conv", root: repo })
    ).rejects.toMatchObject({ kind: "rebind_failed", message: expect.stringContaining("missing-conv") });
  });

  // -- T4: passthrough anchored to THIS conversation's task worktree -------------

  describe("T4 — passthrough anchored to the session's own task worktree", () => {
    it("session already on its own task worktree (fresh provisioner = server restart): provision is a no-op passthrough — zero git calls, zero rebind writes", async () => {
      const repo = makeGitRepo();
      const { store } = await makeStoreWithSessions(repo, ["conv-a"]);
      // first provision on the main repo (the T3 flow)
      const baseProv = createTaskWorktreeProvisioner({ store });
      const wt = await baseProv.provision({ conversationId: "conv-a", root: repo });

      // fresh provisioner = fresh process: the bound map is empty, but the
      // session root is already conv-a's own task worktree
      let gitCalls = 0;
      const prov = createTaskWorktreeProvisioner({
        store,
        runGit: async (args, cwd) => {
          gitCalls += 1;
          return (await import("../../src/harness/isolation/worktree-gate.ts")).defaultGitRunner(args, cwd);
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
      const wtA = await prov.provision({ conversationId: "conv-a", root: repo });
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
      ).rejects.toMatchObject({ name: "WorktreeIsolationError", kind: "foreign_worktree" });
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
        if (args[1] === "--is-inside-work-tree") {
          return { code: 0, stdout: "true\n", stderr: "" };
        }
        // branch verify probe: branch does not exist
        return { code: 1, stdout: "", stderr: "" };
      },
    });
    await expect(
      prov.provision({ conversationId: "conv-a", root: repo })
    ).rejects.toMatchObject({ kind: "worktree_add_failed", message: expect.stringContaining("disk full") });
    const file = await store.load("conv-a");
    expect(file.workspaceRoot).toBe(repo);
  });
});
