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

// -- T7: enter-task-worktree host seam -----------------------------------------

/**
 * T7 (plans/worktree-isolation-model-provision.md) — explicit enter: a
 * session anchored at the MAIN repo may adopt an EXISTING task worktree of
 * this repository (including another conversation's tree) through the enter
 * seam. The tree is never created/modified here; the only effect is the
 * caller's own rebind (store-mode persists workspaceRoot; hub-mode returns
 * the root for the dirty-root conditional-save protocol).
 *
 * Fail-closed boundaries: missing target (worktree_not_found), target that is
 * not a linked checkout / belongs to another repo (foreign_worktree), caller
 * already inside a worktree (must exit first), unsafe ids (rebind_failed
 * before any fs/git access).
 */
describe("T7 — enter: adopt an existing task worktree of this repo", () => {
  it("enters an existing task worktree: returns the target, rebinds ONLY the caller's session, creates no new tree", async () => {
    const repo = makeGitRepo();
    const { store } = await makeStoreWithSessions(repo, ["conv-a", "conv-b"]);
    const prov = createTaskWorktreeProvisioner({ store });
    // conv-a provisions its own tree (T4 flow)
    const wtA = await prov.provision({ conversationId: "conv-a", root: repo });
    const before = git(repo, "worktree", "list");

    // conv-b (anchored at the main repo) enters conv-a's tree
    const entered = await prov.enter({
      conversationId: "conv-b",
      root: repo,
      targetConversationId: "conv-a",
    });

    expect(entered).toBe(wtA);
    // no new tree was created
    expect(git(repo, "worktree", "list")).toBe(before);
    // conv-a's session is exactly where its own provision left it (untouched
    // by conv-b's enter); conv-b's session rebound to wtA (store mode)
    expect((await store.load("conv-a")).workspaceRoot).toBe(wtA);
    expect((await store.load("conv-b")).workspaceRoot).toBe(wtA);
  });

  it("is idempotent: re-enter returns the same target", async () => {
    const repo = makeGitRepo();
    const { store } = await makeStoreWithSessions(repo, ["conv-a", "conv-b"]);
    const prov = createTaskWorktreeProvisioner({ store });
    const wtA = await prov.provision({ conversationId: "conv-a", root: repo });
    const first = await prov.enter({
      conversationId: "conv-b",
      root: repo,
      targetConversationId: "conv-a",
    });
    const second = await prov.enter({
      conversationId: "conv-b",
      root: repo,
      targetConversationId: "conv-a",
    });
    expect(first).toBe(wtA);
    expect(second).toBe(wtA);
  });

  it("missing target → typed worktree_not_found, zero rebind writes", async () => {
    const repo = makeGitRepo();
    const { store } = await makeStoreWithSessions(repo, ["conv-b"]);
    const prov = createTaskWorktreeProvisioner({ store });

    await expect(
      prov.enter({
        conversationId: "conv-b",
        root: repo,
        targetConversationId: "conv-a",
      })
    ).rejects.toMatchObject({
      name: "WorktreeIsolationError",
      kind: "worktree_not_found",
    });
    expect((await store.load("conv-b")).workspaceRoot).toBe(repo);
  });

  it("target path exists but is not a linked git checkout → typed foreign_worktree", async () => {
    const repo = makeGitRepo();
    const { store } = await makeStoreWithSessions(repo, ["conv-b"]);
    const fakeTree = join(repo, ".iknow", "worktrees", "conv-a");
    await mkdir(fakeTree, { recursive: true });
    const prov = createTaskWorktreeProvisioner({ store });

    await expect(
      prov.enter({
        conversationId: "conv-b",
        root: repo,
        targetConversationId: "conv-a",
      })
    ).rejects.toMatchObject({
      name: "WorktreeIsolationError",
      kind: "foreign_worktree",
    });
    expect((await store.load("conv-b")).workspaceRoot).toBe(repo);
  });

  it("target is a linked worktree of ANOTHER repository → typed foreign_worktree", async () => {
    const repo = makeGitRepo();
    const otherRepo = makeGitRepo();
    const { store } = await makeStoreWithSessions(repo, ["conv-b"]);
    // a checkout of otherRepo planted at repo's task-worktree path shape
    const foreignTree = join(repo, ".iknow", "worktrees", "conv-x");
    roots.push(foreignTree);
    git(otherRepo, "worktree", "add", foreignTree, "-b", "foreign-branch");
    const prov = createTaskWorktreeProvisioner({ store });

    await expect(
      prov.enter({
        conversationId: "conv-b",
        root: repo,
        targetConversationId: "conv-x",
      })
    ).rejects.toMatchObject({
      name: "WorktreeIsolationError",
      kind: "foreign_worktree",
    });
    expect((await store.load("conv-b")).workspaceRoot).toBe(repo);
  });

  it("caller already inside a linked worktree → typed foreign_worktree (exit back to the main repo first)", async () => {
    const repo = makeGitRepo();
    const { store } = await makeStoreWithSessions(repo, ["conv-a", "conv-b"]);
    const prov = createTaskWorktreeProvisioner({ store });
    git(repo, "worktree", "add", join(repo, ".iknow", "worktrees", "conv-b"), "-b", "iknow/task-conv-b");
    const wtB = join(repo, ".iknow", "worktrees", "conv-b");

    await expect(
      prov.enter({
        conversationId: "conv-b",
        root: wtB,
        targetConversationId: "conv-a",
      })
    ).rejects.toMatchObject({
      name: "WorktreeIsolationError",
      kind: "foreign_worktree",
    });
    // no rebind happened: conv-b's session still points at the main repo
    expect((await store.load("conv-b")).workspaceRoot).toBe(repo);
  });

  it("unsafe caller id or target id → typed rebind_failed before any fs/git access", async () => {
    const repo = makeGitRepo();
    let fsOrGitTouched = false;
    const prov = createTaskWorktreeProvisioner({
      runGit: async () => {
        fsOrGitTouched = true;
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    for (const bad of ["../evil", "a/b", ""]) {
      await expect(
        prov.enter({
          conversationId: bad.length > 0 ? "conv-b" : bad,
          root: repo,
          targetConversationId: bad.length > 0 ? bad : "conv-a",
        })
      ).rejects.toMatchObject({ kind: "rebind_failed" });
    }
    expect(fsOrGitTouched).toBe(false);
  });
});

// -- T7: provision adoption (persistent anchor) --------------------------------

/**
 * T7 authorization anchor: after a successful enter, the session's PERSISTED
 * workspaceRoot is the entered tree (conditionalSave / store save). That
 * durable record — not an in-process latch — is what lets a mutate on the
 * entered tree's engine pass through after a restart: provision adopts the
 * session when its persisted workspaceRoot EQUALS this engine's root AND the
 * root is task-worktree-shaped. Non-shaped roots (manual worktrees) are never
 * adopted — fail-closed foreign_worktree stands.
 */
describe("T7 — provision adoption via the persistent workspaceRoot anchor", () => {
  it("session persisted at a foreign task worktree (enter + save, then fresh provisioner): provision is a passthrough — zero git calls, zero rebind writes", async () => {
    const repo = makeGitRepo();
    const { store } = await makeStoreWithSessions(repo, ["conv-a", "conv-b"]);
    const prov0 = createTaskWorktreeProvisioner({ store });
    const wtA = await prov0.provision({ conversationId: "conv-a", root: repo });
    await prov0.enter({
      conversationId: "conv-b",
      root: repo,
      targetConversationId: "conv-a",
    });
    // persisted: conv-b.workspaceRoot === wtA (store-mode enter saved it)

    // fresh provisioner = server restart
    const prov = createTaskWorktreeProvisioner({ store });
    const headA = git(wtA, "rev-parse", "HEAD").trim();
    const root = await prov.provision(
      { conversationId: "conv-b", root: wtA },
      { sessionWorkspaceRoot: wtA }
    );

    expect(root).toBe(wtA); // passthrough: mutates on the entered tree are admitted
    expect(git(wtA, "rev-parse", "HEAD").trim()).toBe(headA); // no HEAD move
    expect((await store.load("conv-b")).workspaceRoot).toBe(wtA); // no rewrite
  });

  it("WITHOUT the persisted anchor (fresh provisioner, session still on the main repo): foreign fail-closed stands", async () => {
    const repo = makeGitRepo();
    const { store } = await makeStoreWithSessions(repo, ["conv-a", "conv-b"]);
    const prov0 = createTaskWorktreeProvisioner({ store });
    const wtA = await prov0.provision({ conversationId: "conv-a", root: repo });

    const prov = createTaskWorktreeProvisioner({ store });
    await expect(
      prov.provision({ conversationId: "conv-b", root: wtA })
    ).rejects.toMatchObject({
      name: "WorktreeIsolationError",
      kind: "foreign_worktree",
    });
  });

  it("adoption is scoped to task-worktree-shaped roots: a persistently anchored manual worktree still fails closed", async () => {
    const repo = makeGitRepo();
    const manualWt = join(repo, "..", "iknow-wt-manual-t7");
    roots.push(manualWt);
    git(repo, "worktree", "add", manualWt, "-b", "manual-t7");
    const { store } = await makeStoreWithSessions(repo, ["conv-a"]);
    const prov = createTaskWorktreeProvisioner({ store });

    await expect(
      prov.provision(
        { conversationId: "conv-a", root: manualWt },
        { sessionWorkspaceRoot: manualWt }
      )
    ).rejects.toMatchObject({
      name: "WorktreeIsolationError",
      kind: "foreign_worktree",
    });
  });
});

// -- T8: exit-task-worktree host seam ------------------------------------------

/**
 * T8 (plans/worktree-isolation-model-provision.md) — symmetric exit: a
 * session currently rebound to a task worktree returns to the MAIN repo
 * root. No input, no deletion: the tree is preserved (orphan cleanup is an
 * explicit non-goal of the plan). The main repo root is derived from the
 * tree itself (`git rev-parse --path-format=absolute --git-common-dir`) —
 * restart-safe, no recorded state. Rebound detection = in-process bound
 * entry OR the durable workspaceRoot anchor OR a task-worktree-shaped
 * current root; anything else fails closed with typed rebind_failed.
 */
describe("T8 — exit: return to the main repo root, tree preserved", () => {
  it("exits after enter: returns the repo root, rebinds ONLY the caller's session, preserves the tree and its branch", async () => {
    const repo = makeGitRepo();
    const { store } = await makeStoreWithSessions(repo, ["conv-a", "conv-b"]);
    const prov = createTaskWorktreeProvisioner({ store });
    const wtA = await prov.provision({ conversationId: "conv-a", root: repo });
    await prov.enter({
      conversationId: "conv-b",
      root: repo,
      targetConversationId: "conv-a",
    });
    const before = git(repo, "worktree", "list");

    const repoRoot = await prov.exit({
      conversationId: "conv-b",
      root: wtA,
      sessionWorkspaceRoot: wtA,
    });

    expect(repoRoot).toBe(repo);
    // tree preserved: same worktree registration, branch still checked out
    expect(git(repo, "worktree", "list")).toBe(before);
    expect(git(wtA, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe(
      "iknow/task-conv-a"
    );
    // only the caller's session moved back; conv-a stays on its own tree
    expect((await store.load("conv-b")).workspaceRoot).toBe(repo);
    expect((await store.load("conv-a")).workspaceRoot).toBe(wtA);
  });

  it("exit is restart-safe: a fresh provisioner with no recorded state derives the repo root from the tree (durable anchor)", async () => {
    const repo = makeGitRepo();
    const { store } = await makeStoreWithSessions(repo, ["conv-a", "conv-b"]);
    const prov0 = createTaskWorktreeProvisioner({ store });
    const wtA = await prov0.provision({ conversationId: "conv-a", root: repo });
    await prov0.enter({
      conversationId: "conv-b",
      root: repo,
      targetConversationId: "conv-a",
    });

    // fresh provisioner = server restart; the durable anchor + shaped engine
    // root identify the rebound session
    const prov = createTaskWorktreeProvisioner({ store });
    const repoRoot = await prov.exit({
      conversationId: "conv-b",
      root: wtA,
      sessionWorkspaceRoot: wtA,
    });
    expect(repoRoot).toBe(repo);
    expect((await store.load("conv-b")).workspaceRoot).toBe(repo);
  });

  it("not currently rebound (no bound entry, anchor and current root not tree-shaped) → typed rebind_failed, session untouched", async () => {
    const repo = makeGitRepo();
    const { store } = await makeStoreWithSessions(repo, ["conv-b"]);
    const prov = createTaskWorktreeProvisioner({ store });

    await expect(
      prov.exit({
        conversationId: "conv-b",
        root: repo,
        sessionWorkspaceRoot: repo,
      })
    ).rejects.toMatchObject({
      name: "WorktreeIsolationError",
      kind: "rebind_failed",
    });
    expect((await store.load("conv-b")).workspaceRoot).toBe(repo);
  });

  it("unsafe conversation id → typed rebind_failed before any fs/git access", async () => {
    let fsOrGitTouched = false;
    const prov = createTaskWorktreeProvisioner({
      runGit: async () => {
        fsOrGitTouched = true;
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    await expect(
      prov.exit({ conversationId: "../evil", root: "/repo" })
    ).rejects.toMatchObject({ kind: "rebind_failed" });
    await expect(
      prov.exit({ conversationId: "", root: "/repo" })
    ).rejects.toMatchObject({ kind: "rebind_failed" });
    expect(fsOrGitTouched).toBe(false);
  });
});
