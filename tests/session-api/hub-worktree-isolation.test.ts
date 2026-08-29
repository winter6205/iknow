/**
 * T3 (plans/worktree-isolation-on-mutate.md) — wiring test: hub →
 * buildHarnessEngine → worktree isolation gate (full chain, real git).
 *
 * Pins the end-to-end contract for the ON path:
 *   - first mutate through the session engine is intercepted with a visible
 *     typed error and never reaches the tool handler (main repo zero-write);
 *   - a per-conversation task worktree is created under `<root>/.iknow/worktrees/`
 *     with an `iknow/task-<conversationId>` branch;
 *   - ONLY the mutate-triggering session's workspaceRoot is rebound;
 *   - switch OFF → today's behavior (mutate executes, no tree, no gate message).
 *
 * The test never runs the LLM loop: deps.executor is driven directly, the
 * same way the loop engine would call it (executeAll carries conversationId).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SessionHub } from "../../src/session-api/hub.ts";
import { SessionStore } from "../../src/session-api/store/index.ts";
import { createNoAskUser } from "../../src/harness/permission/ask-user.ts";
import type { LoopEngineDeps, ToolExecutionResult } from "../../src/harness/index.ts";
import { installTestSettingsSource } from "../_helpers/install-test-settings-source.ts";
import { readFile, writeFile } from "node:fs/promises";

// -- helpers -----------------------------------------------------------------

const roots: string[] = [];

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function makeGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "iknow-wt-hub-"));
  roots.push(dir);
  git(dir, "init", "-q");
  // production parity: `.iknow/` (the per-root state anchor, incl. worktrees)
  // is gitignored, so the nested task checkout never pollutes git status.
  writeFileSync(join(dir, ".gitignore"), ".iknow/\n", "utf8");
  git(dir, "add", ".gitignore");
  git(dir, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-qm", "init");
  return dir;
}

async function setSettingsIsolation(enabled: boolean): Promise<void> {
  // installTestSettingsSource redirects HOME to a tmp .iknow; merge the
  // isolation switch into the same settings.json the startup load point reads.
  const settingsPath = join(settingsSource.home, ".iknow", "settings.json");
  const raw = JSON.parse(await readFile(settingsPath, "utf8")) as Record<string, unknown>;
  raw["isolation"] = { worktreeOnMutate: enabled };
  await writeFile(settingsPath, JSON.stringify(raw), "utf8");
}

let baseDir: string;
let store: SessionStore;
let settingsSource: ReturnType<typeof installTestSettingsSource>;

beforeAll(async () => {
  baseDir = mkdtempSync(join(tmpdir(), "iknow-wt-hub-store-"));
  roots.push(baseDir);
  store = new SessionStore(baseDir);
  settingsSource = installTestSettingsSource();
});

afterAll(async () => {
  settingsSource.restore();
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

async function makeHubWithSession(repo: string): Promise<{ hub: SessionHub; conversationId: string }> {
  const hub = new SessionHub({ store, askUser: createNoAskUser() });
  await hub.bindWorkspace(repo);
  const { session } = await hub.createSession();
  return { hub, conversationId: session.conversation_id };
}

function ensure(hub: SessionHub, root: string): Promise<LoopEngineDeps> {
  return (
    hub as unknown as {
      ensureDeps: (root?: string) => Promise<LoopEngineDeps>;
    }
  ).ensureDeps.bind(hub)(root);
}

const writeCall = {
  id: "mutate-1",
  name: "write_file",
  input: { path: "hello.txt", content: "should never land in the main repo" },
};

async function runMutate(
  deps: LoopEngineDeps,
  conversationId: string
): Promise<ToolExecutionResult> {
  const [result] = await deps.executor.executeAll([writeCall], undefined, undefined, conversationId);
  return result;
}

// -- switch ON -----------------------------------------------------------------

describe("worktree isolation wiring (switch ON)", () => {
  it("intercepts the first mutate, creates the task worktree, rebinds only that session, main repo zero-write", async () => {
    await setSettingsIsolation(true);
    const repo = makeGitRepo();
    const { hub, conversationId } = await makeHubWithSession(repo);

    const deps = await ensure(hub, repo);
    const result = await runMutate(deps, conversationId);

    // visible, typed, non-empty failure exit — the write never reached the tool
    expect(result.kind).toBe("execution_failed");
    expect(result.message).toMatch(/^\[worktree_isolation\] /);
    expect(result.message!.length).toBeGreaterThan(20);

    // task worktree created with the per-conversation branch
    const wtPath = join(repo, ".iknow", "worktrees", conversationId);
    expect(existsSync(wtPath)).toBe(true);
    expect(git(repo, "worktree", "list")).toContain(wtPath);
    expect(git(wtPath, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe(
      `iknow/task-${conversationId}`
    );

    // main repo zero-write: target file absent, git status clean (.iknow ignored)
    expect(existsSync(join(repo, "hello.txt"))).toBe(false);
    expect(git(repo, "status", "--porcelain")).toBe("");

    // rebind: this session's workspaceRoot now points at the task worktree
    const file = await store.load(conversationId);
    expect(file.workspaceRoot).toBe(wtPath);
  });

  it("second session on the same root mutates independently: own tree, own rebind (no cross-session checkout)", async () => {
    await setSettingsIsolation(true);
    const repo = makeGitRepo();
    const { hub, conversationId: c1 } = await makeHubWithSession(repo);
    const { conversationId: c2 } = await makeHubWithSession(repo);

    const deps = await ensure(hub, repo);
    await runMutate(deps, c1);
    await runMutate(deps, c2);

    const wt1 = join(repo, ".iknow", "worktrees", c1);
    const wt2 = join(repo, ".iknow", "worktrees", c2);
    expect(existsSync(wt1)).toBe(true);
    expect(existsSync(wt2)).toBe(true);
    const f1 = await store.load(c1);
    const f2 = await store.load(c2);
    expect(f1.workspaceRoot).toBe(wt1);
    expect(f2.workspaceRoot).toBe(wt2);
  });

  it("after the rebind, the session's next turn runs on the worktree-rooted engine and the mutate lands in the tree", async () => {
    await setSettingsIsolation(true);
    const repo = makeGitRepo();
    const { hub, conversationId } = await makeHubWithSession(repo);

    const firstDeps = await ensure(hub, repo);
    await runMutate(firstDeps, conversationId); // intercepted + rebind

    // next turn: ensureDeps resolves the rebound root → engine rooted at the worktree
    const file = await store.load(conversationId);
    const reboundRoot = file.workspaceRoot!;
    const nextDeps = await ensure(hub, reboundRoot);
    const result = await runMutate(nextDeps, conversationId);

    // mutate reaches the tools (no gate interception) and lands in the worktree
    expect(result.kind).toBe("ok");
    expect(existsSync(join(reboundRoot, "hello.txt"))).toBe(true);
    // and the main repo still has zero write
    expect(existsSync(join(repo, "hello.txt"))).toBe(false);
    expect(git(repo, "status", "--porcelain")).toBe("");
  });
});

// -- T4: passthrough when already on the session's own task worktree -----------

describe("worktree isolation wiring (T4 — passthrough)", () => {
  it("session on its own task worktree (fresh hub = restarted server): mutate succeeds, no new worktree, no provision-side tree", async () => {
    await setSettingsIsolation(true);
    const repo = makeGitRepo();
    const { hub, conversationId } = await makeHubWithSession(repo);

    // T3 flow: first mutate on the main repo → tree + rebind
    const firstDeps = await ensure(hub, repo);
    await runMutate(firstDeps, conversationId);
    const file = await store.load(conversationId);
    const reboundRoot = file.workspaceRoot!;
    const worktreesBefore = git(repo, "worktree", "list");

    // fresh hub = fresh provisioner state (server restart between turns)
    const hub2 = new SessionHub({ store, askUser: createNoAskUser() });
    await hub2.bindWorkspace(repo);
    const nextDeps = await ensure(hub2, reboundRoot);
    const result = await runMutate(nextDeps, conversationId);

    // passthrough: the mutate reached the tools and landed in the own tree
    // (writeCall targets hello.txt; the first, intercepted call never wrote it)
    expect(result.kind).toBe("ok");
    expect(existsSync(join(reboundRoot, "hello.txt"))).toBe(true);
    // no second worktree, no stray provision artifacts
    expect(git(repo, "worktree", "list")).toBe(worktreesBefore);
    // main repo still zero-write
    expect(git(repo, "status", "--porcelain")).toBe("");
  });

  it("session on ANOTHER conversation's task worktree: fail-closed typed block, foreign tree untouched, no new worktree", async () => {
    await setSettingsIsolation(true);
    const repo = makeGitRepo();
    const { hub, conversationId: c1 } = await makeHubWithSession(repo);
    const { conversationId: c2 } = await makeHubWithSession(repo);

    const deps = await ensure(hub, repo);
    await runMutate(deps, c1); // creates wt1 and rebinds c1
    const wt1 = (await store.load(c1)).workspaceRoot!;
    const worktreesBefore = git(repo, "worktree", "list");
    const head1 = git(wt1, "rev-parse", "HEAD").trim();

    // c2's root anchored at c1's tree (foreign task worktree)
    const c2file = await store.load(c2);
    await store.save({ id: c2, file: { ...c2file, workspaceRoot: wt1 } });

    const foreignDeps = await ensure(hub, wt1);
    const result = await runMutate(foreignDeps, c2);

    expect(result.kind).toBe("execution_failed");
    expect(result.message).toContain("[worktree_isolation]");
    expect(result.message).toContain("kind=foreign_worktree");
    // foreign tree untouched: no write landed, no HEAD move, no nested tree
    expect(existsSync(join(wt1, "hello.txt"))).toBe(false);
    expect(git(wt1, "rev-parse", "HEAD").trim()).toBe(head1);
    expect(git(repo, "worktree", "list")).toBe(worktreesBefore);
    // c2's session file untouched (no rebind of a foreign root)
    expect((await store.load(c2)).workspaceRoot).toBe(wt1);
  });

  it("session on an unrelated (manual) git worktree: fail-closed typed block, nothing created inside it", async () => {
    await setSettingsIsolation(true);
    const repo = makeGitRepo();
    const manualWt = join(repo, "..", "iknow-wt-hub-manual");
    roots.push(manualWt);
    git(repo, "worktree", "add", manualWt, "-b", "manual-hub-x");
    const { hub, conversationId } = await makeHubWithSession(repo);
    const file = await store.load(conversationId);
    await store.save({ id: conversationId, file: { ...file, workspaceRoot: manualWt } });
    const before = readdirSync(manualWt);

    const deps = await ensure(hub, manualWt);
    const result = await runMutate(deps, conversationId);

    expect(result.kind).toBe("execution_failed");
    expect(result.message).toContain("kind=foreign_worktree");
    expect(readdirSync(manualWt)).toEqual(before); // zero pollution of the foreign checkout
    expect(git(repo, "status", "--porcelain")).toBe("");
  });
});

// -- switch OFF (boundary d) ---------------------------------------------------

describe("worktree isolation wiring (switch OFF)", () => {
  it("behaves exactly like today: mutate executes, no tree, no gate messages", async () => {
    await setSettingsIsolation(false);
    const repo = makeGitRepo();
    const { hub, conversationId } = await makeHubWithSession(repo);

    const deps = await ensure(hub, repo);
    const result = await runMutate(deps, conversationId);

    expect(result.message ?? "").not.toContain("[worktree_isolation]");
    expect(existsSync(join(repo, ".iknow", "worktrees"))).toBe(false);
    // the write went through the normal pipeline (noAskUser → allowed)
    expect(result.kind).toBe("ok");
    expect(existsSync(join(repo, "hello.txt"))).toBe(true);

    const file = await store.load(conversationId);
    expect(file.workspaceRoot).toBe(repo); // no rebind
  });

  it("T4 boundary — switch OFF: a session on a foreign/unrelated worktree mutates exactly like today (no gate, no block)", async () => {
    await setSettingsIsolation(false);
    const repo = makeGitRepo();
    const manualWt = join(repo, "..", "iknow-wt-hub-off");
    roots.push(manualWt);
    git(repo, "worktree", "add", manualWt, "-b", "manual-hub-off");
    const { hub, conversationId } = await makeHubWithSession(repo);
    const file = await store.load(conversationId);
    await store.save({ id: conversationId, file: { ...file, workspaceRoot: manualWt } });

    const deps = await ensure(hub, manualWt);
    const result = await runMutate(deps, conversationId);

    expect(result.message ?? "").not.toContain("[worktree_isolation]");
    expect(result.kind).toBe("ok");
    expect(existsSync(join(manualWt, "hello.txt"))).toBe(true);
  });
});
