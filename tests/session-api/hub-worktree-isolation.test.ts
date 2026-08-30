/**
 * T3 (plans/worktree-isolation-model-provision.md) — wiring test: hub →
 * buildHarnessEngine → worktree isolation gate (full chain, real git).
 *
 * Pins the end-to-end contract for the ON path under the ADR-0037 amendment
 * (model provision):
 *   - the first mutate through the session engine is blocked with the
 *     create-task-worktree ACI-tool notice and NEVER provisions — no
 *     `git worktree add` anywhere on the execution path, main repo zero-write,
 *     no session rebind;
 *   - creating the task worktree (`<root>/.iknow/worktrees/` +
 *     `iknow/task-<conversationId>`) and rebinding the session is the model's
 *     job via the create-worktree ACI tool (T4) — simulated here through the
 *     same host seam (`hub.provisionWorktree`);
 *   - after the rebind, the session's next turn runs on the worktree-rooted
 *     engine where mutates pass through (own tree) or fail closed (foreign);
 *   - switch OFF → today's behavior (mutate executes, no tree, no gate message).
 *
 * The test never runs the LLM loop: deps.executor is driven directly, the
 * same way the loop engine would call it (executeAll carries conversationId).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SessionHub } from "../../src/session-api/hub.ts";
import { SessionStore } from "../../src/session-api/store/index.ts";
import { createNoAskUser } from "../../src/harness/permission/ask-user.ts";
import type { LoopEngineDeps, ToolExecutionResult } from "../../src/harness/index.ts";
import { McpLifecycleError } from "../../src/harness/errors.ts";
import type {
  McpManager,
  McpServerStatus,
} from "../../src/harness/mcp/manager.ts";
import type { IknowSettings } from "../../src/config/settings.ts";
import { installTestSettingsSource } from "../_helpers/install-test-settings-source.ts";
import { readFile, writeFile } from "node:fs/promises";
import type { AnthropicNativeMessage } from "../../src/harness/index.ts";
import type { SessionFileV1 } from "../../src/session-api/store/index.ts";

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

async function persistDirtyRoot(
  hub: SessionHub,
  conversationId: string
): Promise<void> {
  const session = await store.load(conversationId);
  await privateHub(hub).conditionalSave({
    conversationId,
    session,
    result: completedResult(session.messages),
    priorMessages: session.messages,
  });
}

// -- switch ON -----------------------------------------------------------------

describe("worktree isolation wiring (switch ON)", () => {
  it("blocks the first mutate WITHOUT creating a worktree: no `git worktree add`, no rebind, main repo zero-write", async () => {
    await setSettingsIsolation(true);
    const repo = makeGitRepo();
    const { hub, conversationId } = await makeHubWithSession(repo);

    const deps = await ensure(hub, repo);
    const result = await runMutate(deps, conversationId);

    // visible, non-empty failure exit — the write never reached the tool
    expect(result.kind).toBe("execution_failed");
    expect(result.message).toMatch(/^\[worktree_isolation\] /);
    expect(result.message).toContain("create-task-worktree ACI tool");
    expect(result.message).not.toContain("end the turn");
    expect(result.message!.length).toBeGreaterThan(20);

    // physical proof that the gate never provisioned: no `git worktree add`
    // ran anywhere on the execution path — no worktree registered, no tree
    // directory, no branch
    expect(existsSync(join(repo, ".iknow", "worktrees"))).toBe(false);
    expect(git(repo, "worktree", "list")).not.toContain("worktrees");

    // main repo zero-write: target file absent, git status clean (.iknow ignored)
    expect(existsSync(join(repo, "hello.txt"))).toBe(false);
    expect(git(repo, "status", "--porcelain")).toBe("");

    // no rebind either: the session root still points at the main repo
    const file = await store.load(conversationId);
    expect(file.workspaceRoot).toBe(repo);
  });

  it("after the model calls the create-worktree tool (host provision seam), the next turn's mutate lands in the task worktree", async () => {
    await setSettingsIsolation(true);
    const repo = makeGitRepo();
    const { hub, conversationId } = await makeHubWithSession(repo);

    const firstDeps = await ensure(hub, repo);
    const blocked = await runMutate(firstDeps, conversationId);
    expect(blocked.kind).toBe("execution_failed"); // gate: no auto-provision

    // T4 simulation: the model calls the create-task-worktree ACI tool, which
    // goes through the same host provision seam (create + session rebind)
    const reboundRoot = await hub.provisionWorktree({ conversationId, root: repo });
    await persistDirtyRoot(hub, conversationId);
    expect(reboundRoot).toBe(join(repo, ".iknow", "worktrees", conversationId));
    expect(git(repo, "worktree", "list")).toContain(reboundRoot);
    expect(git(reboundRoot, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe(
      `iknow/task-${conversationId}`
    );

    // next turn: ensureDeps resolves the rebound root → engine rooted at the worktree
    const nextDeps = await ensure(hub, reboundRoot);
    const result = await runMutate(nextDeps, conversationId);

    // mutate reaches the tools (no gate interception) and lands in the worktree
    expect(result.kind).toBe("ok");
    expect(existsSync(join(reboundRoot, "hello.txt"))).toBe(true);
    // and the main repo still has zero write
    expect(existsSync(join(repo, "hello.txt"))).toBe(false);
    expect(git(repo, "status", "--porcelain")).toBe("");
  });

  it("second session on the same root provisions independently: own tree, own rebind (no cross-session checkout)", async () => {
    await setSettingsIsolation(true);
    const repo = makeGitRepo();
    const { hub, conversationId: c1 } = await makeHubWithSession(repo);
    const { conversationId: c2 } = await makeHubWithSession(repo);

    const deps = await ensure(hub, repo);
    // both sessions blocked on the main repo (no auto-provision)…
    expect((await runMutate(deps, c1)).kind).toBe("execution_failed");
    expect((await runMutate(deps, c2)).kind).toBe("execution_failed");
    // …then each model calls the create-worktree tool for its own conversation
    const wt1 = await hub.provisionWorktree({ conversationId: c1, root: repo });
    const wt2 = await hub.provisionWorktree({ conversationId: c2, root: repo });
    await persistDirtyRoot(hub, c1);
    await persistDirtyRoot(hub, c2);

    expect(existsSync(wt1)).toBe(true);
    expect(existsSync(wt2)).toBe(true);
    const f1 = await store.load(c1);
    const f2 = await store.load(c2);
    expect(f1.workspaceRoot).toBe(wt1);
    expect(f2.workspaceRoot).toBe(wt2);
  });
});

// -- T4: passthrough when already on the session's own task worktree -----------

describe("worktree isolation wiring (T4 — passthrough)", () => {
  it("session on its own task worktree (fresh hub = restarted server): mutate succeeds, no new worktree, no provision-side tree", async () => {
    await setSettingsIsolation(true);
    const repo = makeGitRepo();
    const { hub, conversationId } = await makeHubWithSession(repo);

    // T3/T4 flow: gate blocks on the main repo; the model calls the
    // create-task-worktree ACI tool → provision seam creates tree + rebind
    await ensure(hub, repo);
    const reboundRoot = await hub.provisionWorktree({ conversationId, root: repo });
    await persistDirtyRoot(hub, conversationId);
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
    // c1's model calls the create-worktree tool → wt1 + rebind
    const wt1 = await hub.provisionWorktree({ conversationId: c1, root: repo });
    await persistDirtyRoot(hub, c1);
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

  it("session on an unrelated (manual) git worktree: gate blocks without provisioning; the create-worktree tool fail-closed foreign_worktree", async () => {
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

    // T3: a non-task-worktree root is never provisioned by the gate — the
    // first mutate is blocked with the ACI-tool notice (no git call)
    expect(result.kind).toBe("execution_failed");
    expect(result.message).toContain("[worktree_isolation]");
    expect(result.message).toContain("create-task-worktree ACI tool");
    expect(readdirSync(manualWt)).toEqual(before); // zero pollution of the foreign checkout
    expect(git(repo, "status", "--porcelain")).toBe("");

    // and if the model calls the create-worktree tool there anyway, the host
    // provision seam still fails closed with the precise typed error
    await expect(
      hub.provisionWorktree({ conversationId, root: manualWt })
    ).rejects.toMatchObject({ kind: "foreign_worktree" });
    expect(readdirSync(manualWt)).toEqual(before);
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

// -- review High-2 (2026-08-29): startup settings pinned across rebind ---------

/**
 * Review High-2 (hard req 9): after a rebind the hub builds the follow-up
 * engine at the worktree root. `.iknow/` is gitignored, so project settings
 * are ABSENT inside the worktree — an implicit `loadIknowSettings({cwd:
 * worktreeRoot})` silently drops them. The hub must reuse the settings
 * object assembled at startup (constructor opt) for every engine it builds,
 * main-root or worktree-rooted alike.
 *
 * Discriminator: the on-disk settings say OFF; only the pinned object says
 * ON. If the hub (re)loads settings from disk anywhere, the gate disarms and
 * the mutate executes instead of failing closed.
 */
describe("review High-2 — hub reuses the startup settings object across rebind", () => {
  it("opts.settings arm the gate even when on-disk settings say OFF, and the rebuilt worktree-rooted engine stays armed", async () => {
    await setSettingsIsolation(false); // disk says OFF
    const repo = makeGitRepo();
    const hub = new SessionHub({
      store,
      askUser: createNoAskUser(),
      // startup-pinned settings (what serve.ts assembles at the load point)
      settings: { isolation: { worktreeOnMutate: true } } as IknowSettings,
    });
    await hub.bindWorkspace(repo);
    const { session: s1 } = await hub.createSession();
    const c1 = s1.conversation_id;

    // main-root engine: armed from the pinned object → intercept, no
    // auto-provision (the gate never creates)
    const deps = await ensure(hub, repo);
    const result = await runMutate(deps, c1);
    expect(result.kind).toBe("execution_failed");
    expect(result.message).toContain("[worktree_isolation]");
    expect(result.message).toContain("create-task-worktree ACI tool");
    expect(existsSync(join(repo, "hello.txt"))).toBe(false);
    expect(existsSync(join(repo, ".iknow", "worktrees"))).toBe(false);

    // the model calls the create-worktree tool (host provision seam) → wt1
    const wt1 = await hub.provisionWorktree({ conversationId: c1, root: repo });
    await persistDirtyRoot(hub, c1);
    expect(wt1).toBe(join(repo, ".iknow", "worktrees", c1));

    // rebuilt (worktree-rooted) engine: still armed — a foreign conversation
    // anchored at wt1 is fail-closed instead of silently written
    const { conversationId: c2 } = await makeHubWithSession(repo);
    const c2file = await store.load(c2);
    await store.save({ id: c2, file: { ...c2file, workspaceRoot: wt1 } });
    const wtDeps = await ensure(hub, wt1);
    const result2 = await runMutate(wtDeps, c2);
    expect(result2.kind).toBe("execution_failed");
    expect(result2.message).toContain("kind=foreign_worktree");
    expect(existsSync(join(wt1, "hello.txt"))).toBe(false);
  });
});

// -- review High-1 (2026-08-29): injected-deps hosts (TUI) rebuild per root ----

/**
 * Review High-1: TUI injects its startup deps into the hub; the injected
 * branch of ensureDeps short-circuited per-root resolution, so a rebound
 * session stayed on the stale main-root engine and its mutates were blocked
 * forever. With `injectedEngineRoot` + `buildEngine` the hub rebuilds at the
 * rebound root (TUI passes a buildTuiDeps-based seam), matching the two hub
 * production assembly paths.
 */
describe("review High-1 — injected deps rebuild at the rebound root (TUI seam)", () => {
  const stubDeps = {
    executor: {
      executeAll: async () => [],
    },
  } as unknown as LoopEngineDeps;

  it("ensureDeps at the injected engine's own root returns the injected deps; at a rebound task-worktree root returns the seam-built deps", async () => {
    const repo = makeGitRepo();
    const wtRoot = join(repo, ".iknow", "worktrees", "conv-tui");
    const rebuilt: LoopEngineDeps = {
      ...stubDeps,
      maxTurns: 7,
    } as LoopEngineDeps;
    const builtAt: string[] = [];
    const hub = new SessionHub({
      store,
      askUser: createNoAskUser(),
      deps: stubDeps,
      injectedEngineRoot: repo,
      buildEngine: async (root) => {
        builtAt.push(root);
        return { deps: rebuilt };
      },
    });

    // initial root: injected deps win (byte-identical to today)
    const initial = await ensure(hub, repo);
    expect(initial).toBe(stubDeps);
    expect(builtAt).toEqual([]);

    // rebound root: per-root rebuild via the seam (not the stale injection)
    const rebound = await ensure(hub, wtRoot);
    expect(rebound).toBe(rebuilt);
    expect(builtAt).toEqual([wtRoot]);

    // and the rebuild is cached per root
    const again = await ensure(hub, wtRoot);
    expect(again).toBe(rebuilt);
    expect(builtAt).toEqual([wtRoot]);
  });

  it("without injectedEngineRoot the injected branch keeps today's behavior (no rebuild)", async () => {
    const repo = makeGitRepo();
    const wtRoot = join(repo, ".iknow", "worktrees", "conv-legacy");
    const builtAt: string[] = [];
    const hub = new SessionHub({
      store,
      askUser: createNoAskUser(),
      deps: stubDeps,
      buildEngine: async (root) => {
        builtAt.push(root);
        return { deps: stubDeps };
      },
    });
    const deps = await ensure(hub, wtRoot);
    expect(deps).toBe(stubDeps);
    expect(builtAt).toEqual([]);
  });
});

// -- T6: stable productRoot through serve hub production assembly --------------

describe("T6 — hub productRoot stable across per-root rebuild", () => {
  it("buildProductionEngine keeps productRoot as mcpConfigRoot while workspaceRoot follows task root", async () => {
    const { mkdir, writeFile } = await import("node:fs/promises");
    const productRoot = makeGitRepo();
    const wtRoot = join(productRoot, ".iknow", "worktrees", "conv-t6");
    await mkdir(wtRoot, { recursive: true });
    await mkdir(join(productRoot, ".iknow"), { recursive: true });
    await writeFile(
      join(productRoot, ".iknow", "mcp.json"),
      JSON.stringify({
        mcpServers: {
          "from-product": { type: "stdio", command: "node" },
        },
      }),
      "utf8"
    );
    await mkdir(join(wtRoot, ".iknow"), { recursive: true });
    await writeFile(
      join(wtRoot, ".iknow", "mcp.json"),
      JSON.stringify({
        mcpServers: {
          "from-task": { type: "stdio", command: "node" },
        },
      }),
      "utf8"
    );

    const hub = new SessionHub({
      store,
      askUser: createNoAskUser(),
      surface: "serve",
      workspaceRoot: productRoot,
      productRoot,
    });
    await hub.bindWorkspace(productRoot);

    type EngineEntry = {
      mcpRoots?: { workspaceRoot: string; mcpConfigRoot: string };
    };
    const priv = hub as unknown as {
      getOrBuildEngine: (root: string) => Promise<EngineEntry>;
      mcpManager?: { status: () => ReadonlyArray<{ name: string }> };
      shutdown: () => Promise<void>;
    };

    try {
      const mainEntry = await priv.getOrBuildEngine(productRoot);
      expect(mainEntry.mcpRoots).toEqual({
        workspaceRoot: productRoot,
        mcpConfigRoot: productRoot,
      });

      const wtEntry = await priv.getOrBuildEngine(wtRoot);
      expect(wtEntry.mcpRoots).toEqual({
        workspaceRoot: wtRoot,
        mcpConfigRoot: productRoot,
      });

      // Active manager after worktree build still only sees product config.
      const names = (priv.mcpManager?.status() ?? []).map((s) => s.name);
      expect(names).toContain("from-product");
      expect(names).not.toContain("from-task");
    } finally {
      await priv.shutdown();
    }
  });

  it("serve.ts / hub.ts：productRoot 字段贯通，reload 不读 process.cwd() 作 config root", () => {
    const serveSrc = readFileSync(
      join(import.meta.dirname, "..", "..", "src", "session-api", "serve.ts"),
      "utf8"
    );
    const hubSrc = readFileSync(
      join(import.meta.dirname, "..", "..", "src", "session-api", "hub.ts"),
      "utf8"
    );
    expect(serveSrc).toMatch(/productRoot/);
    expect(hubSrc).toMatch(/readonly productRoot\?/);
    expect(hubSrc).toMatch(/productRoot:/);
    // reloadMcp 不得再用 process.cwd() 当 mcpConfigRoot 求值（注释提及可）
    const reloadIdx = hubSrc.indexOf("async reloadMcp");
    assert.ok(reloadIdx >= 0);
    // T7:公开 reloadMcp 串行入口 + private reloadMcpTransaction 同属 reload 面
    const reloadBlock = hubSrc.slice(reloadIdx, reloadIdx + 2800);
    expect(reloadBlock).not.toMatch(
      /mcpConfigRoot[^\n]*=[^\n]*process\.cwd\(\)|process\.cwd\(\)\s*[;,]|mcpConfigRoot:\s*process\.cwd\(\)/
    );
    expect(reloadBlock).not.toMatch(/\?\?\s*process\.cwd\(\)/);
    expect(reloadBlock).toMatch(/mcpConfigRoot/);
    expect(reloadBlock).toMatch(/reloadMcpTransaction/);
  });
});

// -- T7: hub active-root MCP reload transaction -------------------------------

function makeTrackingManager(name: string): McpManager & {
  readonly shutDown: () => boolean;
  readonly reloadCalls: () => number;
  readonly reloadGate: {
    wait: Promise<void>;
    release: () => void;
  };
} {
  let shutDown = false;
  let reloadCalls = 0;
  let releaseReload: (() => void) | undefined;
  const wait = new Promise<void>((resolve) => {
    releaseReload = resolve;
  });
  const servers: McpServerStatus[] = [
    { name, state: "connected", source: "project" },
  ];
  return {
    start: async () => {},
    reload: async () => {
      reloadCalls += 1;
      await wait;
      if (shutDown) {
        throw new Error("reload after prior manager shutdown");
      }
    },
    shutdown: async () => {
      shutDown = true;
      servers[0] = { name, state: "failed", source: "project" };
    },
    status: () =>
      servers.map((s) =>
        shutDown ? { ...s, state: "failed" as const } : { ...s }
      ),
    listResources: async () => ({ resources: [], perServer: [] }),
    readResource: async () => ({ contents: [] }),
    shutDown: () => shutDown,
    reloadCalls: () => reloadCalls,
    reloadGate: {
      wait,
      release: () => releaseReload?.(),
    },
  };
}

describe("T7 — hub active-root MCP reload transaction", () => {
  it("reloadMcp validates active engine mcpRoots before touching the manager", async () => {
    const productRoot = makeGitRepo();
    const hub = new SessionHub({
      store,
      askUser: createNoAskUser(),
      surface: "serve",
      workspaceRoot: productRoot,
      productRoot,
    });
    await hub.bindWorkspace(productRoot);

    const priv = hub as unknown as {
      getOrBuildEngine: (root: string) => Promise<unknown>;
      activeMcpRoots?: { workspaceRoot: string; mcpConfigRoot: string };
      mcpManager?: McpManager;
      shutdown: () => Promise<void>;
    };

    try {
      await priv.getOrBuildEngine(productRoot);
      const before = await hub.listMcpServers();
      expect(priv.activeMcpRoots).toEqual({
        workspaceRoot: productRoot,
        mcpConfigRoot: productRoot,
      });

      // Corrupt workspaceRoot — must reject BEFORE manager.reload/shutdown.
      priv.activeMcpRoots = {
        workspaceRoot: "relative-not-absolute",
        mcpConfigRoot: productRoot,
      };

      await expect(hub.reloadMcp()).rejects.toMatchObject({
        name: "McpLifecycleError",
        kind: "invalid_cwd",
      });

      // Good manager still the visible face (not shut down / not mixed).
      const after = await hub.listMcpServers();
      expect(after).toEqual(before);
      expect(priv.mcpManager).toBeDefined();
    } finally {
      await priv.shutdown();
    }
  });

  it("activating a new engine MCP face shuts down the previous manager first", async () => {
    const { mkdir } = await import("node:fs/promises");
    const productRoot = makeGitRepo();
    const wtRoot = join(productRoot, ".iknow", "worktrees", "conv-t7");
    await mkdir(wtRoot, { recursive: true });

    const mainMgr = makeTrackingManager("main-face");
    const wtMgr = makeTrackingManager("wt-face");
    // Release gates so any accidental reload doesn't hang the test.
    mainMgr.reloadGate.release();
    wtMgr.reloadGate.release();

    const hub = new SessionHub({
      store,
      askUser: createNoAskUser(),
      surface: "serve",
      workspaceRoot: productRoot,
      productRoot,
      buildEngine: async (root) => {
        const isWt = root === wtRoot;
        return {
          deps: {
            adapter: { complete: async () => ({}) },
            registry: { list: () => [], get: () => undefined },
            executor: { executeAll: async () => [] },
            maxTurns: 1,
          } as unknown as LoopEngineDeps,
          mcpManager: isWt ? wtMgr : mainMgr,
          mcpRoots: {
            workspaceRoot: root,
            mcpConfigRoot: productRoot,
          },
        };
      },
    });
    await hub.bindWorkspace(productRoot);

    const priv = hub as unknown as {
      getOrBuildEngine: (root: string) => Promise<{
        mcpRoots?: { workspaceRoot: string; mcpConfigRoot: string };
        mcpManager?: McpManager;
      }>;
      mcpManager?: McpManager;
      activeMcpRoots?: { workspaceRoot: string; mcpConfigRoot: string };
      shutdown: () => Promise<void>;
    };

    try {
      await priv.getOrBuildEngine(productRoot);
      expect(priv.mcpManager).toBe(mainMgr);
      expect(mainMgr.shutDown()).toBe(false);

      await priv.getOrBuildEngine(wtRoot);
      // Old manager closed (or failed) before new is the visible success face.
      expect(mainMgr.shutDown()).toBe(true);
      expect(priv.mcpManager).toBe(wtMgr);
      expect(wtMgr.shutDown()).toBe(false);
      expect(priv.activeMcpRoots).toEqual({
        workspaceRoot: wtRoot,
        mcpConfigRoot: productRoot,
      });

      const names = (await hub.listMcpServers()).map((s) => s.name);
      expect(names).toEqual(["wt-face"]);
      expect(names).not.toContain("main-face");
    } finally {
      await priv.shutdown();
    }
  });

  it("concurrent reloadMcp calls serialize; each promise ends without hang", async () => {
    const productRoot = makeGitRepo();
    let reloadStarted = 0;
    let maxConcurrent = 0;
    let inFlight = 0;
    const order: string[] = [];

    const mgr: McpManager = {
      start: async () => {},
      reload: async () => {
        reloadStarted += 1;
        inFlight += 1;
        maxConcurrent = Math.max(maxConcurrent, inFlight);
        order.push(`start-${reloadStarted}`);
        await new Promise((r) => setTimeout(r, 30));
        order.push(`end-${reloadStarted}`);
        inFlight -= 1;
      },
      shutdown: async () => {},
      status: () => [
        { name: "s", state: "connected", source: "project" },
      ],
      listResources: async () => ({ resources: [], perServer: [] }),
      readResource: async () => ({ contents: [] }),
    };

    const hub = new SessionHub({
      store,
      askUser: createNoAskUser(),
      surface: "serve",
      workspaceRoot: productRoot,
      productRoot,
      buildEngine: async (root) => ({
        deps: {
          adapter: { complete: async () => ({}) },
          registry: { list: () => [], get: () => undefined },
          executor: { executeAll: async () => [] },
          maxTurns: 1,
        } as unknown as LoopEngineDeps,
        mcpManager: mgr,
        mcpRoots: {
          workspaceRoot: root,
          mcpConfigRoot: productRoot,
        },
      }),
    });
    await hub.bindWorkspace(productRoot);

    const priv = hub as unknown as {
      getOrBuildEngine: (root: string) => Promise<unknown>;
      shutdown: () => Promise<void>;
    };

    try {
      await priv.getOrBuildEngine(productRoot);
      const [a, b] = await Promise.all([hub.reloadMcp(), hub.reloadMcp()]);
      expect(a).toEqual([{ name: "s", state: "connected", source: "project" }]);
      expect(b).toEqual([{ name: "s", state: "connected", source: "project" }]);
      expect(maxConcurrent).toBe(1);
      expect(order).toEqual(["start-1", "end-1", "start-2", "end-2"]);
    } finally {
      await priv.shutdown();
    }
  });

  it("reload failure surfaces reload_failed and keeps one coherent visible face", async () => {
    const productRoot = makeGitRepo();
    const mgr: McpManager = {
      start: async () => {},
      reload: async () => {
        throw new Error("boom mid reload");
      },
      shutdown: async () => {},
      status: () => [
        { name: "only", state: "connected", source: "project" },
      ],
      listResources: async () => ({ resources: [], perServer: [] }),
      readResource: async () => ({ contents: [] }),
    };

    const hub = new SessionHub({
      store,
      askUser: createNoAskUser(),
      surface: "serve",
      workspaceRoot: productRoot,
      productRoot,
      buildEngine: async (root) => ({
        deps: {
          adapter: { complete: async () => ({}) },
          registry: { list: () => [], get: () => undefined },
          executor: { executeAll: async () => [] },
          maxTurns: 1,
        } as unknown as LoopEngineDeps,
        mcpManager: mgr,
        mcpRoots: {
          workspaceRoot: root,
          mcpConfigRoot: productRoot,
        },
      }),
    });
    await hub.bindWorkspace(productRoot);

    const priv = hub as unknown as {
      getOrBuildEngine: (root: string) => Promise<unknown>;
      mcpManager?: McpManager;
      shutdown: () => Promise<void>;
    };

    try {
      await priv.getOrBuildEngine(productRoot);
      await expect(hub.reloadMcp()).rejects.toBeInstanceOf(McpLifecycleError);
      await expect(hub.reloadMcp()).rejects.toMatchObject({
        kind: "reload_failed",
      });

      // Still exactly one visible manager face (no second success manager).
      expect(priv.mcpManager).toBe(mgr);
      const servers = await hub.listMcpServers();
      expect(servers.map((s) => s.name)).toEqual(["only"]);
    } finally {
      await priv.shutdown();
    }
  });

  it("reloadMcp reads mcpConfigRoot from active mcpRoots (not process.cwd())", async () => {
    const productRoot = makeGitRepo();
    const wtRoot = join(productRoot, ".iknow", "worktrees", "conv-t7-reload");
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(wtRoot, { recursive: true });
    await mkdir(join(productRoot, ".iknow"), { recursive: true });
    await writeFile(
      join(productRoot, ".iknow", "mcp.json"),
      JSON.stringify({
        mcpServers: {
          "from-product": { type: "stdio", command: "true" },
        },
      }),
      "utf8"
    );

    let seenConfigRoot: string | undefined;
    const mgr: McpManager = {
      start: async () => {},
      reload: async (servers) => {
        // Capture that reload received product-level server, not task-root junk.
        expect(servers.map((s) => s.name)).toContain("from-product");
      },
      shutdown: async () => {},
      status: () => [
        { name: "from-product", state: "connected", source: "project" },
      ],
      listResources: async () => ({ resources: [], perServer: [] }),
      readResource: async () => ({ contents: [] }),
    };

    // Spy via monkey-patching load path is heavy; instead assert active roots
    // drive reload by installing a thin wrapper on the private roots field
    // after engine activate, and verifying reload succeeds with wt workspace
    // + product config root.
    const hub = new SessionHub({
      store,
      askUser: createNoAskUser(),
      surface: "serve",
      workspaceRoot: productRoot,
      productRoot,
      buildEngine: async (root) => {
        seenConfigRoot = productRoot;
        return {
          deps: {
            adapter: { complete: async () => ({}) },
            registry: { list: () => [], get: () => undefined },
            executor: { executeAll: async () => [] },
            maxTurns: 1,
          } as unknown as LoopEngineDeps,
          mcpManager: mgr,
          mcpRoots: {
            workspaceRoot: root,
            mcpConfigRoot: productRoot,
          },
        };
      },
    });
    await hub.bindWorkspace(productRoot);

    const priv = hub as unknown as {
      getOrBuildEngine: (root: string) => Promise<unknown>;
      activeMcpRoots?: { workspaceRoot: string; mcpConfigRoot: string };
      shutdown: () => Promise<void>;
    };

    try {
      await priv.getOrBuildEngine(wtRoot);
      expect(priv.activeMcpRoots).toEqual({
        workspaceRoot: wtRoot,
        mcpConfigRoot: productRoot,
      });
      expect(seenConfigRoot).toBe(productRoot);
      expect(priv.activeMcpRoots?.mcpConfigRoot).not.toBe(process.cwd());

      const servers = await hub.reloadMcp();
      expect(servers.map((s) => s.name)).toContain("from-product");
    } finally {
      await priv.shutdown();
    }
  });
});

// -- workspace-root-required T3: Hub-owned dirty-root persistence ------------

type HubPrivate = {
  provisionWorktree: (ctx: {
    conversationId: string;
    root: string;
  }) => Promise<string>;
  markWorktreeRootDirty: (opts: {
    conversationId: string;
    currentRoot: string;
    provisionedRoot: string;
  }) => void;
  conditionalSave: (opts: {
    conversationId: string;
    session: SessionFileV1;
    result: {
      finalText: string | null;
      messages: ReadonlyArray<AnthropicNativeMessage>;
      turnCount: number;
      stopReason: string;
      lastUsage: null;
    };
    priorMessages: ReadonlyArray<AnthropicNativeMessage>;
  }) => Promise<boolean>;
};

function privateHub(hub: SessionHub): HubPrivate {
  return hub as unknown as HubPrivate;
}

function completedResult(
  messages: ReadonlyArray<AnthropicNativeMessage> = []
): HubPrivate["conditionalSave"] extends (
  opts: infer T
) => Promise<boolean>
  ? T extends { result: infer R }
    ? R
    : never
  : never {
  return {
    finalText: "done",
    messages,
    turnCount: 1,
    stopReason: "completed",
    lastUsage: null,
  } as never;
}

describe("workspace-root-required T3 — Hub dirty-root conditional save", () => {
  it("provision marks a changed root without writing the session until conditional save", async () => {
    await setSettingsIsolation(true);
    const repo = makeGitRepo();
    const { hub, conversationId } = await makeHubWithSession(repo);

    const reboundRoot = await privateHub(hub).provisionWorktree({
      conversationId,
      root: repo,
    });

    expect(reboundRoot).toBe(join(repo, ".iknow", "worktrees", conversationId));
    expect((await store.load(conversationId)).workspaceRoot).toBe(repo);

    const session = await store.load(conversationId);
    await privateHub(hub).conditionalSave({
      conversationId,
      session,
      result: completedResult(),
      priorMessages: session.messages,
    });

    expect((await store.load(conversationId)).workspaceRoot).toBe(reboundRoot);
  });

  it("unchanged provision does not create dirty work, and provision failure leaves the root unchanged", async () => {
    await setSettingsIsolation(true);
    const repo = makeGitRepo();
    const { hub, conversationId } = await makeHubWithSession(repo);
    const privateApi = privateHub(hub);

    const saveSpy = vi.spyOn(store, "save");
    privateApi.markWorktreeRootDirty({
      conversationId,
      currentRoot: repo,
      provisionedRoot: repo,
    });
    const session = await store.load(conversationId);
    const result = {
      ...completedResult(session.messages),
      turnCount: 0,
      stopReason: "cancelled",
      finalText: null,
    };
    expect(
      await privateApi.conditionalSave({
        conversationId,
        session,
        result,
        priorMessages: session.messages,
      })
    ).toBe(false);
    expect(saveSpy).not.toHaveBeenCalled();
    saveSpy.mockRestore();

    const plain = mkdtempSync(join(tmpdir(), "iknow-wt-hub-t3-plain-"));
    roots.push(plain);
    await expect(
      privateApi.provisionWorktree({ conversationId, root: plain })
    ).rejects.toMatchObject({ kind: "not_a_git_repo" });
    expect((await store.load(conversationId)).workspaceRoot).toBe(repo);
  });

  it("retains a dirty root when conditional save fails, then consumes it after retry succeeds", async () => {
    await setSettingsIsolation(true);
    const repo = makeGitRepo();
    const { hub, conversationId } = await makeHubWithSession(repo);
    const privateApi = privateHub(hub);
    const reboundRoot = join(repo, ".iknow", "worktrees", conversationId);
    privateApi.markWorktreeRootDirty({
      conversationId,
      currentRoot: repo,
      provisionedRoot: reboundRoot,
    });
    const session = await store.load(conversationId);
    const failedSave = vi
      .spyOn(store, "save")
      .mockRejectedValueOnce({
        kind: "write_failed",
        conversation_id: conversationId,
      });

    await expect(
      privateApi.conditionalSave({
        conversationId,
        session,
        result: completedResult(),
        priorMessages: session.messages,
      })
    ).rejects.toMatchObject({ kind: "write_failed" });
    failedSave.mockRestore();

    await privateApi.conditionalSave({
      conversationId,
      session,
      result: completedResult(),
      priorMessages: session.messages,
    });
    expect((await store.load(conversationId)).workspaceRoot).toBe(reboundRoot);
  });
});
