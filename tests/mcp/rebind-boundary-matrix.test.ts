/**
 * T8 (plans/worktree-mcp-rebind-lifecycle.md) — MCP × rebind five-boundary matrix.
 *
 * Asserts for every class: typed kind / non-empty visible message / no secret
 * leak / promise does not hang; on failure also no tool exec on bad root and
 * no dual-register / split-brain success face.
 *
 * Gap-focused: fills empty / negative / overflow / concurrent / exception
 * cases not already locked by T1–T7 suites.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import {
  McpLifecycleError,
  type McpLifecycleErrorKind,
} from "../../src/harness/errors.ts";
import { resolveMcpRoots } from "../../src/harness/mcp/roots.ts";
import {
  loadMcpConfig,
  type McpServerConfig,
} from "../../src/harness/mcp/config.ts";
import {
  createMcpManager,
  createRealClient,
  type McpClientHandle,
  type McpManager,
} from "../../src/harness/mcp/manager.ts";
import type { Tool as McpTool } from "@modelcontextprotocol/client";
import { SessionHub } from "../../src/session-api/hub.ts";
import { SessionStore } from "../../src/session-api/store/index.ts";
import { createNoAskUser } from "../../src/harness/permission/ask-user.ts";
import type { LoopEngineDeps } from "../../src/harness/index.ts";
import { createWorktreeIsolationExecutor } from "../../src/harness/isolation/worktree-gate.ts";
import type {
  Executor,
  ToolCall,
  ToolExecutionResult,
} from "../../src/harness/tools/types.ts";

const TEST_WORKSPACE_ROOT = "/tmp/iknow-mcp-t8-matrix-workspace";
const PRODUCT_ROOT = "/repo/iknow";
const TASK_WORKTREE = "/repo/iknow/.iknow/worktrees/conv-t8";

const tmpRoots: string[] = [];

async function mkTemp(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tmpRoots.push(dir);
  return dir;
}

async function writeJson(path: string, body: unknown): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, JSON.stringify(body), "utf8");
}

function makeStdio(name: string): McpServerConfig {
  return {
    name,
    kind: "stdio",
    source: "user",
    status: "enabled",
    entry: { command: "node", args: ["./fake-mcp.js"] },
  };
}

function sampleTool(name: string): McpTool {
  return {
    name,
    description: `${name} description`,
    inputSchema: { type: "object", properties: {} },
  };
}

function makeStubClient(opts: {
  connectDelayMs?: number;
  rejectConnect?: boolean;
  initialTools?: McpTool[];
  hangConnect?: boolean;
}): McpClientHandle & {
  _triggerListChanged: (tools: McpTool[]) => void;
  _resolveConnect?: () => void;
} {
  const listChangedHandlers: Array<(tools: McpTool[]) => void> = [];
  let connected = false;
  let resolveConnect: (() => void) | undefined;

  const handle = {
    connect: async () => {
      if (opts.hangConnect) {
        await new Promise<void>((res) => {
          resolveConnect = res;
        });
      } else if ((opts.connectDelayMs ?? 0) > 0) {
        await new Promise((r) => setTimeout(r, opts.connectDelayMs));
      }
      if (opts.rejectConnect) throw new Error("stub: connect rejected");
      connected = true;
    },
    listTools: async () => {
      if (!connected) throw new Error("stub: not connected");
      return opts.initialTools ?? [];
    },
    callTool: async () => ({ content: [{ type: "text", text: "ok" }] }),
    close: async () => {
      connected = false;
    },
    onListChanged: (cb: (tools: McpTool[]) => void) => {
      listChangedHandlers.push(cb);
    },
    onClose: () => {},
    _triggerListChanged: (tools: McpTool[]) => {
      for (const cb of listChangedHandlers) cb(tools);
    },
    get _resolveConnect() {
      return resolveConnect;
    },
  };
  return handle as McpClientHandle & {
    _triggerListChanged: (tools: McpTool[]) => void;
    _resolveConnect?: () => void;
  };
}

async function waitForStatus(
  mgr: McpManager,
  name: string,
  state: "connected" | "failed" | "pending",
  timeoutMs = 3000
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const s = mgr.status().find((x) => x.name === name);
    if (s?.state === state) return;
    await new Promise((r) => setTimeout(r, 15));
  }
  const got = mgr.status().find((x) => x.name === name)?.state;
  throw new Error(
    `waitForStatus: name=${name} wanted=${state} got=${got} after ${timeoutMs}ms`
  );
}

function expectLifecycleKind(
  err: unknown,
  kind: McpLifecycleErrorKind
): McpLifecycleError {
  expect(err).toBeInstanceOf(McpLifecycleError);
  const e = err as McpLifecycleError;
  expect(e.kind).toBe(kind);
  expect(e.message.trim()).not.toBe("");
  expect(e.detail.trim()).not.toBe("");
  expect(e.message).not.toMatch(/sk-[a-zA-Z0-9]{10,}|API_KEY=\S+/);
  expect(e.detail).not.toMatch(/sk-[a-zA-Z0-9]{10,}|API_KEY=\S+/);
  return e;
}

let warnCalls: string[] = [];
let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  warnCalls = [];
  warnSpy = vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
    warnCalls.push(args.map(String).join(" "));
  });
});

afterEach(() => {
  warnSpy.mockRestore();
});

afterAll(async () => {
  await Promise.all(
    tmpRoots.splice(0).map((r) => rm(r, { recursive: true, force: true }))
  );
});

// ---------------------------------------------------------------------------
// empty
// ---------------------------------------------------------------------------

describe("T8 matrix — empty", () => {
  it("missing project mcp.json at mcpConfigRoot → empty project level, never reads task root", async () => {
    const home = await mkTemp("iknow-t8-empty-home-");
    const mcpConfigRoot = await mkTemp("iknow-t8-empty-product-");
    const taskRoot = await mkTemp("iknow-t8-empty-task-");
    await writeJson(join(taskRoot, ".iknow", "mcp.json"), {
      mcpServers: {
        fromTask: { type: "stdio", command: "task-only-cmd" },
      },
    });
    // No project file at mcpConfigRoot; user empty too.

    const result = await loadMcpConfig({ home, mcpConfigRoot });

    expect(result.servers).toEqual([]);
    expect(warnCalls).toEqual([]);
    // Task decoy must remain unread: loading again with only product still empty.
    const again = await loadMcpConfig({ home, mcpConfigRoot });
    expect(again.servers.map((s) => s.name)).not.toContain("fromTask");
  });

  it("empty servers → no slots; start/reload/shutdown idempotent and never spawn", async () => {
    let spawnCount = 0;
    const mgr = createMcpManager({
      workspaceRoot: TEST_WORKSPACE_ROOT,
      config: [],
      registerExternal: () => {},
      createClient: () => {
        spawnCount += 1;
        return makeStubClient({});
      },
    });

    await mgr.start();
    expect(mgr.status()).toEqual([]);
    expect(spawnCount).toBe(0);

    await mgr.reload([]);
    expect(mgr.status()).toEqual([]);
    expect(spawnCount).toBe(0);

    await mgr.shutdown();
    await mgr.shutdown();
    await mgr.reload([]);
    expect(mgr.status()).toEqual([]);
    expect(spawnCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// negative
// ---------------------------------------------------------------------------

describe("T8 matrix — negative", () => {
  it("relative command succeeds only with correct workspaceRoot cwd", async () => {
    const goodRoot = await mkTemp("iknow-t8-cwd-good-");
    const badRoot = await mkTemp("iknow-t8-cwd-bad-");
    const goodMarker = join(goodRoot, "child-cwd.txt");
    const badMarker = join(badRoot, "child-cwd.txt");
    const script = [
      "import { writeFileSync } from 'node:fs';",
      "import { join } from 'node:path';",
      "writeFileSync(join(process.cwd(), 'child-cwd.txt'), process.cwd());",
      "setInterval(() => {}, 1000);",
    ].join("\n");
    await writeFile(join(goodRoot, "print-cwd.mjs"), script, "utf8");
    // badRoot intentionally has no print-cwd.mjs

    const server = {
      name: "cwd-probe",
      kind: "stdio" as const,
      source: "user" as const,
      status: "enabled" as const,
      entry: {
        command: process.execPath,
        args: ["./print-cwd.mjs"],
      },
    };

    const good = createRealClient(server, { cwd: goodRoot });
    await Promise.race([
      good.connect().catch(() => undefined),
      new Promise<void>((r) => setTimeout(r, 800)),
    ]);
    const deadline = Date.now() + 3000;
    let written = "";
    while (Date.now() < deadline) {
      try {
        written = (await readFile(goodMarker, "utf8")).trim();
        if (written) break;
      } catch {
        /* not yet */
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(written).toBe(goodRoot);
    await good.close().catch(() => undefined);

    const bad = createRealClient(server, { cwd: badRoot });
    let badErr: unknown;
    await Promise.race([
      bad.connect().catch((e) => {
        badErr = e;
      }),
      new Promise<void>((r) => setTimeout(r, 800)),
    ]);
    await bad.close().catch(() => undefined);

    // Wrong cwd: relative script unresolved → connect fails; marker never written.
    let badWritten = "";
    try {
      badWritten = (await readFile(badMarker, "utf8")).trim();
    } catch {
      badWritten = "";
    }
    expect(badWritten).toBe("");
    expect(badErr).toBeDefined();
  }, 15_000);

  it("invalid / foreign roots are typed before any spawn", () => {
    try {
      resolveMcpRoots({
        workspaceRoot: "relative/task",
        productRoot: PRODUCT_ROOT,
      });
      expect.fail("expected throw");
    } catch (err) {
      expectLifecycleKind(err, "invalid_cwd");
    }
    try {
      resolveMcpRoots({
        workspaceRoot: PRODUCT_ROOT,
        productRoot: "relative/product",
      });
      expect.fail("expected throw");
    } catch (err) {
      expectLifecycleKind(err, "invalid_config_root");
    }
    try {
      resolveMcpRoots({
        workspaceRoot: TASK_WORKTREE,
        productRoot: PRODUCT_ROOT,
        expectedWorkspaceRoot: "/foreign/checkout",
      });
      expect.fail("expected throw");
    } catch (err) {
      expectLifecycleKind(err, "root_mismatch");
    }
  });
});

// ---------------------------------------------------------------------------
// overflow
// ---------------------------------------------------------------------------

describe("T8 matrix — overflow", () => {
  it("many servers + long paths keep deterministic sort and bounded diagnostics", async () => {
    const home = await mkTemp("iknow-t8-ov-home-");
    const mcpConfigRoot = await mkTemp("iknow-t8-ov-root-");
    const longSeg = "p".repeat(400);
    const servers: Record<string, { type: string; command: string }> = {};
    // Insert out of order; load must emit alphabetical order.
    for (const n of ["zulu", "alpha", "mike", "bravo", "yankee"]) {
      servers[n] = { type: "stdio", command: `cmd-${n}` };
    }
    // One bad entry with secret-looking long payload → warn bounded, skip.
    servers["bad"] = "not-an-object" as unknown as {
      type: string;
      command: string;
    };
    await writeJson(join(home, ".iknow", "mcp.json"), { mcpServers: servers });

    const result = await loadMcpConfig({ home, mcpConfigRoot });
    expect(result.servers.map((s) => s.name)).toEqual([
      "alpha",
      "bravo",
      "mike",
      "yankee",
      "zulu",
    ]);
    expect(warnCalls).toHaveLength(1);
    expect(warnCalls[0]!.length).toBeLessThanOrEqual(512);
    expect(warnCalls[0]).not.toMatch(/sk-[a-zA-Z0-9]{20,}/);

    // Long absolute path still resolves; diagnostics on invalid stay bounded.
    const longRoot = `/${longSeg}/workspace`;
    const roots = resolveMcpRoots({
      workspaceRoot: longRoot,
      productRoot: `/${longSeg}/product`,
    });
    expect(roots.workspaceRoot).toBe(longRoot);
    expect(roots.mcpConfigRoot).toBe(`/${longSeg}/product`);

    const overlongRel = `${"x".repeat(6000)}/ANTHROPIC_API_KEY=super-secret`;
    try {
      resolveMcpRoots({
        workspaceRoot: overlongRel,
        productRoot: PRODUCT_ROOT,
      });
      expect.fail("expected throw");
    } catch (err) {
      const e = expectLifecycleKind(err, "invalid_cwd");
      expect(e.detail.length).toBeLessThanOrEqual(256);
      expect(e.detail).not.toContain("super-secret");
    }
  });

  it("timeout during rebind overlap → failed, not hang; late old connect stays failed", async () => {
    let connectResolve!: () => void;
    const registered: string[] = [];
    const oldMgr = createMcpManager({
      workspaceRoot: TEST_WORKSPACE_ROOT,
      config: [makeStdio("old")],
      registerExternal: (defs) => {
        for (const d of defs) registered.push(d.name);
      },
      timeoutMsOverride: 60,
      createClient: () => {
        const handle = makeStubClient({
          hangConnect: true,
          initialTools: [sampleTool("echo")],
        });
        (handle as { connect: () => Promise<void> }).connect = () =>
          new Promise<void>((res) => {
            connectResolve = res;
          });
        return handle;
      },
    });

    await oldMgr.start();
    expect(oldMgr.status().find((s) => s.name === "old")?.state).toBe(
      "pending"
    );

    // Rebind overlap: shutdown old (generation bump) while connect hangs,
    // then start a new manager for the task root.
    const shutdownP = oldMgr.shutdown();
    const newRegistered: string[] = [];
    const newMgr = createMcpManager({
      workspaceRoot: `${TEST_WORKSPACE_ROOT}/task`,
      config: [makeStdio("new")],
      registerExternal: (defs) => {
        for (const d of defs) newRegistered.push(d.name);
      },
      timeoutMsOverride: 80,
      createClient: () =>
        makeStubClient({
          connectDelayMs: 200,
          initialTools: [sampleTool("tool")],
        }),
    });
    await newMgr.start();

    // Old shutdown must terminate; timeout path on new → failed (not hang).
    await expect(shutdownP).resolves.toBeUndefined();
    expect(oldMgr.status().find((s) => s.name === "old")?.state).toBe(
      "failed"
    );
    await waitForStatus(newMgr, "new", "failed", 2000);
    expect(newMgr.status().find((s) => s.name === "new")?.error).toContain(
      "connect timeout"
    );

    // Late old connect must not register onto either face.
    connectResolve();
    await new Promise((r) => setTimeout(r, 80));
    expect(registered).toEqual([]);
    expect(oldMgr.status().find((s) => s.name === "old")?.state).toBe(
      "failed"
    );

    await newMgr.shutdown();
  });
});

// ---------------------------------------------------------------------------
// concurrent
// ---------------------------------------------------------------------------

describe("T8 matrix — concurrent", () => {
  it("late old manager cannot register after rebind face switch", async () => {
    let oldConnectResolve!: () => void;
    const oldRegistered: string[] = [];
    const newRegistered: string[] = [];

    const oldMgr = createMcpManager({
      workspaceRoot: TEST_WORKSPACE_ROOT,
      config: [makeStdio("old")],
      registerExternal: (defs) => {
        for (const d of defs) oldRegistered.push(d.name);
      },
      createClient: () => {
        const handle = makeStubClient({
          initialTools: [sampleTool("stale")],
        });
        (handle as { connect: () => Promise<void> }).connect = () =>
          new Promise<void>((res) => {
            oldConnectResolve = res;
          }).then(() => undefined);
        return handle;
      },
    });
    await oldMgr.start();

    const newMgr = createMcpManager({
      workspaceRoot: `${TEST_WORKSPACE_ROOT}/rebound`,
      config: [makeStdio("new")],
      registerExternal: (defs) => {
        for (const d of defs) newRegistered.push(d.name);
      },
      createClient: () =>
        makeStubClient({
          initialTools: [sampleTool("fresh")],
        }),
    });
    await newMgr.start();
    await waitForStatus(newMgr, "new", "connected", 2000);

    // Rebind: shut down old before publishing new (hub activateMcpFace order).
    await oldMgr.shutdown();
    oldConnectResolve();
    await new Promise((r) => setTimeout(r, 80));

    expect(oldRegistered).toEqual([]);
    expect(oldMgr.status().find((s) => s.name === "old")?.state).toBe(
      "failed"
    );
    expect(newRegistered).toEqual(["mcp__new__fresh"]);
    expect(newMgr.status().map((s) => s.name)).toEqual(["new"]);

    await newMgr.shutdown();
  });

  it("mutate coalesce: concurrent first mutates provision one tree / one lifecycle", async () => {
    const invocations: ToolCall[][] = [];
    let provisioned = 0;
    let resolveProvision!: () => void;
    const inner: Executor = {
      executeAll: async (batch) => {
        invocations.push([...batch]);
        return batch.map(
          (c): ToolExecutionResult => ({
            kind: "ok",
            toolUseId: c.id,
            payload: { wrote: true },
          })
        );
      },
    };
    const gate = createWorktreeIsolationExecutor({
      enabled: true,
      // T3 model-provision 合同：provision 裁决只在 task-worktree 形状的根上
      // 触发（改绑后 per-root 重建引擎的形态）；主仓根一律拦下不建树。
      root: TASK_WORKTREE,
      provision: async () => {
        provisioned += 1;
        await new Promise<void>((r) => {
          resolveProvision = r;
        });
        return "/wt-coalesce";
      },
      inner,
    });

    const writeCall = (id: string): ToolCall => ({
      id,
      name: "write_file",
      input: { path: "x.txt", content: id },
    });

    const p1 = gate.executeAll([writeCall("a")]);
    const p2 = gate.executeAll([writeCall("b")]);
    await Promise.resolve();
    resolveProvision();
    const [r1, r2] = await Promise.all([p1, p2]);

    expect(provisioned).toBe(1);
    expect(invocations).toHaveLength(0);
    for (const batch of [r1, r2]) {
      expect(batch[0]!.kind).toBe("execution_failed");
      expect(batch[0]!.message).toContain("/wt-coalesce");
    }
  });

  it("list_changed / shutdown overlap converges: no post-shutdown registration", async () => {
    const registered: string[] = [];
    const mgr = createMcpManager({
      workspaceRoot: TEST_WORKSPACE_ROOT,
      config: [makeStdio("svc")],
      registerExternal: (defs) => {
        for (const d of defs) registered.push(d.name);
      },
      createClient: () =>
        makeStubClient({
          initialTools: [sampleTool("alpha")],
        }),
    });
    await mgr.start();
    await waitForStatus(mgr, "svc", "connected", 2000);
    registered.length = 0;

    const handle = (mgr as unknown as { _handles: Array<
      McpClientHandle & { _triggerListChanged: (t: McpTool[]) => void }
    > })._handles[0]!;

    const shutdownP = mgr.shutdown();
    handle._triggerListChanged([sampleTool("alpha"), sampleTool("beta")]);
    await shutdownP;
    handle._triggerListChanged([sampleTool("gamma")]);
    await new Promise((r) => setTimeout(r, 40));

    expect(registered).toEqual([]);
    expect(mgr.status().find((s) => s.name === "svc")?.state).toBe("failed");
  });
});

// ---------------------------------------------------------------------------
// exception
// ---------------------------------------------------------------------------

describe("T8 matrix — exception", () => {
  it("createClient / spawn throw mid-flight → typed failed, no hang", async () => {
    const mgr = createMcpManager({
      workspaceRoot: TEST_WORKSPACE_ROOT,
      config: [makeStdio("boom"), makeStdio("ok")],
      registerExternal: () => {},
      createClient: (server) => {
        if (server.name === "boom") {
          throw new Error("stub: spawn failed ENOENT");
        }
        return makeStubClient({
          initialTools: [sampleTool("echo")],
        });
      },
    });

    // start must not throw / hang even when one factory throws.
    await expect(mgr.start()).resolves.toBeUndefined();
    await waitForStatus(mgr, "boom", "failed", 2000);
    await waitForStatus(mgr, "ok", "connected", 2000);

    const boom = mgr.status().find((s) => s.name === "boom");
    expect(boom?.state).toBe("failed");
    expect(boom?.error?.trim()).not.toBe("");
    expect(boom?.error).toMatch(/spawn failed|ENOENT/i);

    await mgr.shutdown();
  });

  it("connect throw → failed with non-empty error; other servers still connect", async () => {
    const mgr = createMcpManager({
      workspaceRoot: TEST_WORKSPACE_ROOT,
      config: [makeStdio("bad"), makeStdio("good")],
      registerExternal: () => {},
      createClient: (server) =>
        makeStubClient({
          rejectConnect: server.name === "bad",
          initialTools: [sampleTool("t")],
        }),
    });

    await mgr.start();
    await waitForStatus(mgr, "bad", "failed", 2000);
    await waitForStatus(mgr, "good", "connected", 2000);
    expect(mgr.status().find((s) => s.name === "bad")?.error).toMatch(
      /connect rejected/
    );
    await mgr.shutdown();
  });
});

// ---------------------------------------------------------------------------
// hub-level: bad-root reload + reload mid-flight (negative + exception)
// ---------------------------------------------------------------------------

describe("T8 matrix — hub reload seams (negative + exception)", () => {
  const roots: string[] = [];
  let store: SessionStore;

  function git(cwd: string, ...args: string[]): string {
    return execFileSync("git", args, { cwd, encoding: "utf8" });
  }

  function makeGitRepo(): string {
    const dir = mkdtempSync(join(tmpdir(), "iknow-t8-hub-"));
    roots.push(dir);
    git(dir, "init", "-q");
    writeFileSync(join(dir, ".gitignore"), ".iknow/\n", "utf8");
    git(dir, "add", ".gitignore");
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

  beforeAll(() => {
    const base = mkdtempSync(join(tmpdir(), "iknow-t8-hub-store-"));
    roots.push(base);
    store = new SessionStore(base);
  });

  afterAll(() => {
    for (const r of roots) rmSync(r, { recursive: true, force: true });
  });

  function stubDeps(): LoopEngineDeps {
    return {
      adapter: { complete: async () => ({}) },
      registry: { list: () => [], get: () => undefined },
      executor: { executeAll: async () => [] },
      maxTurns: 1,
    } as unknown as LoopEngineDeps;
  }

  it("bad-root reload rejected before split-brain (manager untouched)", async () => {
    const productRoot = makeGitRepo();
    const mgr: McpManager = {
      start: async () => {},
      reload: async () => {
        throw new Error("reload must not be reached on bad root");
      },
      shutdown: async () => {
        throw new Error("shutdown must not run on bad-root reject");
      },
      status: () => [
        { name: "keep", state: "connected", source: "project" },
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
        deps: stubDeps(),
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
      activeMcpRoots?: { workspaceRoot: string; mcpConfigRoot: string };
      mcpManager?: McpManager;
      shutdown: () => Promise<void>;
    };

    try {
      await priv.getOrBuildEngine(productRoot);
      const before = await hub.listMcpServers();
      priv.activeMcpRoots = {
        workspaceRoot: "relative-bad",
        mcpConfigRoot: productRoot,
      };

      await expect(hub.reloadMcp()).rejects.toMatchObject({
        name: "McpLifecycleError",
        kind: "invalid_cwd",
      });

      expect(await hub.listMcpServers()).toEqual(before);
      expect(priv.mcpManager).toBe(mgr);
    } finally {
      // Restore valid roots so hub.shutdown does not trip on corrupt state.
      priv.activeMcpRoots = {
        workspaceRoot: productRoot,
        mcpConfigRoot: productRoot,
      };
      await priv.shutdown();
    }
  });

  it("reload mid-flight throw → reload_failed; single coherent face; promise ends", async () => {
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
        deps: stubDeps(),
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
      let caught: unknown;
      try {
        await hub.reloadMcp();
      } catch (err) {
        caught = err;
      }
      expectLifecycleKind(caught, "reload_failed");
      expect(priv.mcpManager).toBe(mgr);
      expect((await hub.listMcpServers()).map((s) => s.name)).toEqual([
        "only",
      ]);
    } finally {
      await priv.shutdown();
    }
  });
});
