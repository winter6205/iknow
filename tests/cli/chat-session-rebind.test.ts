/**
 * Per-turn engine-rebuild seam for the CLI chat entry point.
 *
 * chat REPL assembles deps once in runChatSession; after the permission gate
 * rebinds, the session file's workspaceRoot points at the task worktree, so the
 * next turn must rebuild deps from that root (the rebuildDeps seam, supplied by
 * cli.ts) —— otherwise mutate stays blocked by the stale engine forever. Pinned:
 *   1. changed workspaceRoot in the session file → rebuild with the new root and
 *      re-wrap before a query line runs (violation executor + conversationId +
 *      commitMessages semantics preserved);
 *   2. unchanged root / no workspaceRoot / missing file → no rebuild (zero extra
 *      behaviour);
 *   3. rebuild failure → visible stderr plus the old deps kept (mutate stays
 *      fail-closed).
 *
 * Follow-up fix: rebuildDeps returns the full handle bundle (matching the TUI
 * buildEngine seam and the hub's per-root shape); after a successful refresh the
 * ctx handles subagentManager / graphAssembly / autoMemory /
 * overlayMemoryPrefetch are rewired (split-brain fix: drain consumes the new
 * manager, /graph snapshots reflect the new assembly), the old engine's shutdown
 * is closed out first, and the new shutdown is registered into
 * engineShutdown.current (cli.ts's registerShutdown closure reads current).
 */
import { describe, expect, it } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { processChatLine } from "../../src/cli/chat-session.ts";
import {
  SessionStore,
  CURRENT_SCHEMA_VERSION,
} from "../../src/session-api/store/index.ts";
import type { SessionFileV1 } from "../../src/session-api/store/index.ts";
import type { SubAgentManager } from "../../src/harness/subagent/manager.ts";
import type { SubAgentEnvelope } from "../../src/harness/subagent/envelope.ts";
import type { GraphAssembly } from "../../src/harness/graph/assembly.ts";
import type {
  AutoMemoryHook,
  OverlayPrefetchFn,
} from "../../src/harness/memory/index.ts";
import { assistantResult, makeCtx, makeDeps } from "./_fixtures.ts";
import { captureStderrOf } from "../_helpers/capture-stderr.ts";
import { writeRootSegment } from "../../src/harness/skill/body.ts";

const roots: string[] = [];

function makeStoreDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "iknow-chat-rebind-"));
  roots.push(dir);
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

afterEachCleanup();
function afterEachCleanup(): void {
  process.on("exit", () => {
    for (const r of roots) rmSync(r, { recursive: true, force: true });
  });
}

// stderr interception goes through the shared helper captureStderrOf (writeErr
// SSOT), so visible-degradation and silence assertions share one suppress path.

function makeManagerStub(
  opts: {
    readonly drain?: Array<{ taskId: string; envelope: SubAgentEnvelope }>;
  } = {}
): SubAgentManager {
  return {
    spawn: () => ({ taskId: "t-1" }),
    queryBuffer: () => ({ status: "completed" }),
    waitFor: async () =>
      ({
        status: "ok",
        summary: "stub",
        result: "stub",
      }) satisfies SubAgentEnvelope,
    shutdown: async () => {},
    drainCompleted: () => opts.drain ?? [],
    listActive: () => [],
    abortTask: () => false,
    getCapacity: () => 15,
    listSubagents: () => [],
  };
}

describe("chat-session rebind 重建缝（review High-1）", () => {
  it("会话文件 workspaceRoot 变化 → 查询行开跑前以新根重建 deps 并保持包装语义", async () => {
    const dir = makeStoreDir();
    const store = new SessionStore(dir, process.cwd());
    const conversationId = "conv-rebind-1";
    const mainRoot = join(dir, "main");
    const wtRoot = join(mainRoot, ".iknow", "worktrees", conversationId);
    await store.save({
      id: conversationId,
      file: makeSessionFile(conversationId, mainRoot),
    });

    const ctx = makeCtx({
      responses: [assistantResult({ texts: ["turn-1"] })],
      stateOverrides: { conversationId },
    });
    ctx.checkpointStore = store;
    ctx.engineRoot = mainRoot;
    const rebuiltDeps = makeDeps([assistantResult({ texts: ["rebuilt"] })]);
    const rebuilds: string[] = [];
    ctx.rebuildDeps = async (root) => {
      rebuilds.push(root);
      return { deps: rebuiltDeps };
    };

    // Simulate the gate rebind already on disk (previous turn blocked by the
    // permission gate + store.save wrote the new workspaceRoot)
    const file = await store.load(conversationId);
    await store.save({
      id: conversationId,
      file: { ...file, workspaceRoot: wtRoot },
    });

    const r = await processChatLine({ line: "q", ctx });
    assert.equal(r.quit, false);
    assert.equal(r.ranQuery, true);

    assert.deepEqual(rebuilds, [wtRoot]);
    assert.equal(ctx.engineRoot, wtRoot);
    // Re-wrap semantics: not rebuiltDeps verbatim (conversationId converged /
    // wrapping layer applied)
    assert.notEqual(ctx.deps, rebuiltDeps);
    assert.equal(ctx.deps.conversationId, conversationId);
    assert.equal(ctx.deps.adapter, rebuiltDeps.adapter);
  });

  it("runChatSession 为重建装配 wrapRebuiltDeps（violation/commit 包装与初始装配同源）", () => {
    // Structural pin: assembly must use the **same** wrapChatDeps for both the
    // initial deps and the rebuild seam (rebuildDeps.wrapRebuiltDeps); otherwise
    // the rebuilt engine loses the violation counter and the commitMessages hook,
    // or drifts into two competing wrapping semantics.
    // Since assembly was extracted into assembleChatSessionContext the wiring
    // lives in the helper, so both halves are asserted separately: the call site
    // passes the closure into assembly, and assembly binds it to the rebuild seam.
    const src = readFileSync(
      join(import.meta.dirname, "..", "..", "src", "cli", "chat-session.ts"),
      "utf8"
    );
    expect(src.includes("wrappedDeps,\n    wrapChatDeps,")).toBe(true);
    expect(src.includes("wrapRebuiltDeps: input.wrapChatDeps")).toBe(true);
  });

  it("根未变化 / 无 workspaceRoot / 会话文件缺席 → 不重建（not_found 保持静默）", async () => {
    const dir = makeStoreDir();
    const store = new SessionStore(dir, process.cwd());
    const conversationId = "conv-rebind-2";
    const mainRoot = join(dir, "main");
    await store.save({
      id: conversationId,
      file: makeSessionFile(conversationId, mainRoot),
    });

    const ctx = makeCtx({
      responses: [assistantResult({ texts: ["turn-1"] })],
      stateOverrides: { conversationId },
    });
    ctx.checkpointStore = store;
    ctx.engineRoot = mainRoot;
    let rebuilds = 0;
    ctx.rebuildDeps = async () => {
      rebuilds += 1;
      return { deps: ctx.deps };
    };

    // workspaceRoot equals engineRoot (the shape serve writes when bound to the
    // main root)
    await processChatLine({ line: "q", ctx });
    assert.equal(rebuilds, 0);

    // Missing session file (not_found) → stay silent: typed not_found is the
    // normal "no rebind signal" shape, not an error
    ctx.state.conversationId = "conv-unknown";
    const stderr = await captureStderrOf(async () => {
      await processChatLine({ line: "q2", ctx });
    });
    assert.equal(rebuilds, 0);
    assert.equal(stderr, "", "not_found 必须保持静默（正常无会话形态）");
  });

  it("重建失败 → 可见 stderr，保持旧 deps，回合仍完成", async () => {
    const dir = makeStoreDir();
    const store = new SessionStore(dir, process.cwd());
    const conversationId = "conv-rebind-3";
    const mainRoot = join(dir, "main");
    const wtRoot = join(mainRoot, ".iknow", "worktrees", conversationId);
    await store.save({
      id: conversationId,
      file: makeSessionFile(conversationId, mainRoot),
    });

    const ctx = makeCtx({
      responses: [assistantResult({ texts: ["turn-1"] })],
      stateOverrides: { conversationId },
    });
    ctx.checkpointStore = store;
    ctx.engineRoot = mainRoot;
    ctx.rebuildDeps = async () => {
      throw new Error("rebuild exploded");
    };
    const file = await store.load(conversationId);
    await store.save({
      id: conversationId,
      file: { ...file, workspaceRoot: wtRoot },
    });

    // The refresh's visible degradation goes to process.stderr (writeErr SSOT),
    // so capture it here
    let r;
    const stderr = await captureStderrOf(async () => {
      r = await processChatLine({ line: "q", ctx });
    });
    assert.equal(r.ranQuery, true);
    assert.equal(ctx.engineRoot, mainRoot); // root not switched
    assert.ok(stderr.includes("引擎重建失败"), "重建失败必须可见（stderr）");
  });
});

describe("chat-session rebind 句柄换血（2026-08-29 收敛修复）", () => {
  it("rebind 前已完成的 wait:false 结果在旧 manager shutdown 前 drain 并交付主模型（plan Goal #2）", async () => {
    const dir = makeStoreDir();
    const store = new SessionStore(dir, process.cwd());
    const conversationId = "conv-rebind-closeout";
    const mainRoot = join(dir, "main");
    const wtRoot = join(mainRoot, ".iknow", "worktrees", conversationId);
    await store.save({
      id: conversationId,
      file: makeSessionFile(conversationId, mainRoot),
    });

    const closeoutEvents: string[] = [];
    const oldManager = makeManagerStub({
      drain: [
        {
          taskId: "old-task",
          envelope: {
            status: "ok",
            summary: "old wait:false result",
            result: "old manager completed body",
          },
        },
      ],
    });
    oldManager.drainCompleted = () => {
      closeoutEvents.push("drain");
      return [
        {
          taskId: "old-task",
          envelope: {
            status: "ok",
            summary: "old wait:false result",
            result: "old manager completed body",
          },
        },
      ];
    };
    oldManager.shutdown = async () => {
      closeoutEvents.push("shutdown");
    };
    const rebuiltDeps = makeDeps([assistantResult({ texts: ["rebuilt"] })]);
    let modelMessages = "";
    const rebuiltAdapter = rebuiltDeps.adapter;
    rebuiltDeps.adapter = {
      ...rebuiltAdapter,
      step: async (state, request, signal) => {
        modelMessages = JSON.stringify(state.messages);
        return rebuiltAdapter.step(state, request, signal);
      },
    };

    const ctx = makeCtx({
      responses: [assistantResult({ texts: ["turn-1"] })],
      stateOverrides: { conversationId },
    });
    ctx.checkpointStore = store;
    ctx.engineRoot = mainRoot;
    ctx.subagentManager = oldManager;
    ctx.engineShutdown = { current: oldManager.shutdown.bind(oldManager) };
    ctx.rebuildDeps = async () => ({
      deps: rebuiltDeps,
      subagentManager: makeManagerStub(),
    });

    const file = await store.load(conversationId);
    await store.save({
      id: conversationId,
      file: { ...file, workspaceRoot: wtRoot },
    });

    const result = await processChatLine({ line: "q", ctx });

    assert.equal(result.ranQuery, true);
    assert.match(
      modelMessages,
      /old wait:false result/,
      "the completed result must reach the next primary-model run"
    );
    assert.deepEqual(
      closeoutEvents,
      ["drain", "shutdown"],
      "rebind must drain completed old-manager results before shutdown"
    );
  });

  it("rebind 等待旧 manager 的 running wait:false 任务完成后再 shutdown，并交付结果", async () => {
    const dir = makeStoreDir();
    const store = new SessionStore(dir, process.cwd());
    const conversationId = "conv-rebind-running-closeout";
    const mainRoot = join(dir, "main");
    const wtRoot = join(mainRoot, ".iknow", "worktrees", conversationId);
    await store.save({
      id: conversationId,
      file: makeSessionFile(conversationId, mainRoot),
    });

    const closeoutEvents: string[] = [];
    let running = true;
    const oldManager = makeManagerStub();
    const completed = {
      taskId: "running-old-task",
      envelope: {
        status: "ok" as const,
        summary: "old running manager completed",
        result: "old running wait:false result",
      },
    };
    oldManager.listActive = () => (running ? [completed.taskId] : []);
    oldManager.drainCompleted = () => {
      closeoutEvents.push("drain");
      return running ? [] : [completed];
    };
    oldManager.waitFor = async (taskId) => {
      closeoutEvents.push(`wait:${taskId}`);
      running = false;
      return completed.envelope;
    };
    oldManager.shutdown = async () => {
      closeoutEvents.push("shutdown");
    };
    const rebuiltDeps = makeDeps([assistantResult({ texts: ["rebuilt"] })]);
    let modelMessages = "";
    const rebuiltAdapter = rebuiltDeps.adapter;
    rebuiltDeps.adapter = {
      ...rebuiltAdapter,
      step: async (state, request, signal) => {
        modelMessages = JSON.stringify(state.messages);
        return rebuiltAdapter.step(state, request, signal);
      },
    };

    const ctx = makeCtx({
      responses: [assistantResult({ texts: ["turn-1"] })],
      stateOverrides: { conversationId },
    });
    ctx.checkpointStore = store;
    ctx.engineRoot = mainRoot;
    ctx.subagentManager = oldManager;
    ctx.engineShutdown = { current: oldManager.shutdown.bind(oldManager) };
    ctx.rebuildDeps = async () => ({
      deps: rebuiltDeps,
      subagentManager: makeManagerStub(),
    });

    const file = await store.load(conversationId);
    await store.save({
      id: conversationId,
      file: { ...file, workspaceRoot: wtRoot },
    });

    const stderr = await captureStderrOf(async () => {
      const result = await processChatLine({ line: "q", ctx });
      assert.equal(result.ranQuery, true);
    });

    assert.deepEqual(
      closeoutEvents,
      ["wait:running-old-task", "drain", "shutdown"],
      "rebind must wait for running old-manager work before shutdown"
    );
    assert.match(modelMessages, /old running manager completed/);
    assert.equal(
      stderr,
      "",
      "a task that reaches terminal state before shutdown needs no warning"
    );
  });

  it("旧 manager 的 running 任务无法完成时，shutdown 前明确告知结果未交付", async () => {
    const dir = makeStoreDir();
    const store = new SessionStore(dir, process.cwd());
    const conversationId = "conv-rebind-running-failed";
    const mainRoot = join(dir, "main");
    const wtRoot = join(mainRoot, ".iknow", "worktrees", conversationId);
    await store.save({
      id: conversationId,
      file: makeSessionFile(conversationId, mainRoot),
    });

    const closeoutEvents: string[] = [];
    const oldManager = makeManagerStub();
    oldManager.listActive = () => ["undelivered-old-task"];
    oldManager.drainCompleted = () => {
      closeoutEvents.push("drain");
      return [];
    };
    oldManager.waitFor = async () => {
      closeoutEvents.push("wait");
      throw new Error("old task wait failed");
    };
    oldManager.shutdown = async () => {
      closeoutEvents.push("shutdown");
    };
    const rebuiltDeps = makeDeps([assistantResult({ texts: ["rebuilt"] })]);
    const ctx = makeCtx({
      responses: [assistantResult({ texts: ["turn-1"] })],
      stateOverrides: { conversationId },
    });
    ctx.checkpointStore = store;
    ctx.engineRoot = mainRoot;
    ctx.subagentManager = oldManager;
    ctx.engineShutdown = { current: oldManager.shutdown.bind(oldManager) };
    ctx.rebuildDeps = async () => ({
      deps: rebuiltDeps,
      subagentManager: makeManagerStub(),
    });

    const file = await store.load(conversationId);
    await store.save({
      id: conversationId,
      file: { ...file, workspaceRoot: wtRoot },
    });

    const stderr = await captureStderrOf(async () => {
      const result = await processChatLine({ line: "q", ctx });
      assert.equal(result.ranQuery, true);
    });

    assert.deepEqual(closeoutEvents, ["wait", "drain", "shutdown"]);
    assert.match(stderr, /old task wait failed/);
    assert.match(stderr, /结果未交付/);
    assert.match(stderr, /undelivered-old-task/);
  });

  it("rebind 重建后 ctx 句柄切到重建引擎；旧引擎 shutdown 先收口、新 shutdown 注册进 engineShutdown.current", async () => {
    const dir = makeStoreDir();
    const store = new SessionStore(dir, process.cwd());
    const conversationId = "conv-rebind-handles";
    const mainRoot = join(dir, "main");
    const wtRoot = join(mainRoot, ".iknow", "worktrees", conversationId);
    await store.save({
      id: conversationId,
      file: makeSessionFile(conversationId, mainRoot),
    });

    let oldShutdownCalls = 0;
    const shutdownOrder: string[] = [];
    const oldManager = makeManagerStub();
    oldManager.shutdown = async () => {
      oldShutdownCalls += 1;
      shutdownOrder.push("old");
    };
    const oldShutdown = oldManager.shutdown.bind(oldManager);
    const newManager = makeManagerStub();
    let rebuiltShutdownCalls = 0;
    const ga1 = { beginRound: () => {} } as unknown as GraphAssembly;
    const ga2 = { beginRound: () => {} } as unknown as GraphAssembly;
    const am1 = {
      onTurnComplete: () => {},
      drain: async () => {},
    } satisfies AutoMemoryHook;
    const am2 = {
      onTurnComplete: () => {},
      drain: async () => {},
    } satisfies AutoMemoryHook;
    const om1: OverlayPrefetchFn = async () => null;
    const om2: OverlayPrefetchFn = async () => null;
    const rebuiltDeps = makeDeps([assistantResult({ texts: ["rebuilt"] })]);

    const ctx = makeCtx({
      responses: [assistantResult({ texts: ["turn-1"] })],
      stateOverrides: { conversationId },
    });
    ctx.checkpointStore = store;
    ctx.engineRoot = mainRoot;
    ctx.subagentManager = oldManager;
    ctx.graphAssembly = ga1;
    ctx.autoMemory = am1;
    ctx.overlayMemoryPrefetch = om1;
    ctx.engineShutdown = { current: oldShutdown };
    ctx.rebuildDeps = async () => ({
      deps: rebuiltDeps,
      shutdown: async () => {
        rebuiltShutdownCalls += 1;
        shutdownOrder.push("rebuilt");
      },
      subagentManager: newManager,
      graphAssembly: ga2,
      autoMemory: am2,
      overlayMemoryPrefetch: om2,
    });

    const file = await store.load(conversationId);
    await store.save({
      id: conversationId,
      file: { ...file, workspaceRoot: wtRoot },
    });

    const r = await processChatLine({ line: "q", ctx });
    assert.equal(r.ranQuery, true);

    // split-brain fix: all four ctx handles point at the rebuilt engine
    assert.equal(ctx.subagentManager, newManager);
    assert.equal(ctx.graphAssembly, ga2);
    assert.equal(ctx.autoMemory, am2);
    assert.equal(ctx.overlayMemoryPrefetch, om2);
    // Shutdown handle swapped: the old engine is closed out exactly once (first),
    // then the new shutdown is registered
    assert.equal(oldShutdownCalls, 1, "旧引擎 shutdown 必须在切换点收口");
    assert.equal(ctx.engineShutdown?.current === undefined, false);
    // The signal path now reaches the rebuilt engine's shutdown (cli.ts
    // registerShutdown reads current through a closure)
    await ctx.engineShutdown?.current?.();
    assert.equal(rebuiltShutdownCalls, 1);
    assert.deepEqual(
      shutdownOrder,
      ["old", "rebuilt"],
      "旧引擎先收口，重建引擎 shutdown 只经注册句柄触发"
    );
  });

  it("rebind 重建后 drain 消费新 manager（split-brain 修复：旧 manager 不再被 drain）", async () => {
    const dir = makeStoreDir();
    const store = new SessionStore(dir, process.cwd());
    const conversationId = "conv-rebind-drain";
    const mainRoot = join(dir, "main");
    const wtRoot = join(mainRoot, ".iknow", "worktrees", conversationId);
    await store.save({
      id: conversationId,
      file: makeSessionFile(conversationId, mainRoot),
    });

    let oldDrainCalls = 0;
    const oldManager = makeManagerStub();
    oldManager.drainCompleted = () => {
      oldDrainCalls += 1;
      return [];
    };
    let newDrainCalls = 0;
    const newManager = makeManagerStub();
    newManager.drainCompleted = () => {
      newDrainCalls += 1;
      return [
        {
          taskId: "task-1",
          envelope: {
            status: "ok",
            summary: "done",
            result: "subagent result",
          },
        },
      ];
    };

    const ctx = makeCtx({
      responses: [assistantResult({ texts: ["turn-1"] })],
      stateOverrides: { conversationId },
    });
    ctx.checkpointStore = store;
    ctx.engineRoot = mainRoot;
    ctx.subagentManager = oldManager;
    ctx.rebuildDeps = async () => ({
      deps: makeDeps([assistantResult({ texts: ["rebuilt"] })]),
      subagentManager: newManager,
    });

    const file = await store.load(conversationId);
    await store.save({
      id: conversationId,
      file: { ...file, workspaceRoot: wtRoot },
    });

    await processChatLine({ line: "q", ctx });
    assert.equal(ctx.subagentManager, newManager);
    assert.equal(newDrainCalls, 1, "rebind 后当回合 drain 必须消费新 manager");
    assert.equal(
      oldDrainCalls,
      1,
      "plan Goal #2：旧 manager 仅在 shutdown 前收口一次，切换后不再 drain"
    );
  });

  it("store.load 非 not_found 错误（io_error 等）→ stderr 可见降级，不重建", async () => {
    const dir = makeStoreDir();
    const store = new SessionStore(dir, process.cwd());
    const conversationId = "conv-rebind-ioerr";
    const mainRoot = join(dir, "main");
    await store.save({
      id: conversationId,
      file: makeSessionFile(conversationId, mainRoot),
    });

    const ctx = makeCtx({
      responses: [assistantResult({ texts: ["turn-1"] })],
      stateOverrides: { conversationId },
    });
    ctx.checkpointStore = store;
    ctx.engineRoot = mainRoot;
    let rebuilds = 0;
    ctx.rebuildDeps = async () => {
      rebuilds += 1;
      return { deps: ctx.deps };
    };
    // Inject io_error (the shape of a real failure such as a disk read error).
    (store as { load: unknown }).load = async () => {
      throw {
        kind: "io_error",
        conversation_id: conversationId,
        cause: "EACCES",
      };
    };

    let r;
    const stderr = await captureStderrOf(async () => {
      r = await processChatLine({ line: "q", ctx });
    });
    assert.equal(r.ranQuery, true);
    assert.equal(rebuilds, 0, "IO 错误不得触发重建");
    assert.equal(ctx.engineRoot, mainRoot);
    assert.ok(
      stderr.includes("rebind 检测"),
      "非 not_found 错误必须可见（stderr），不得无声吞掉"
    );
  });

  it("slash 行跳过 rebind 检测（省掉每行 store.load IO），查询行仍检测", async () => {
    const dir = makeStoreDir();
    const store = new SessionStore(dir, process.cwd());
    const conversationId = "conv-rebind-slash";
    const mainRoot = join(dir, "main");
    const wtRoot = join(mainRoot, ".iknow", "worktrees", conversationId);
    await store.save({
      id: conversationId,
      file: makeSessionFile(conversationId, mainRoot),
    });
    const file = await store.load(conversationId);
    await store.save({
      id: conversationId,
      file: { ...file, workspaceRoot: wtRoot },
    });

    const ctx = makeCtx({
      responses: [assistantResult({ texts: ["turn-1"] })],
      stateOverrides: { conversationId },
    });
    ctx.checkpointStore = store;
    ctx.engineRoot = mainRoot;
    const rebuilds: string[] = [];
    ctx.rebuildDeps = async (root) => {
      rebuilds.push(root);
      return { deps: makeDeps([assistantResult({ texts: ["rebuilt"] })]) };
    };

    // slash line: no engine run → no rebind check (no rebuild even though the
    // session file already diverged)
    await processChatLine({ line: "/help", ctx });
    assert.deepEqual(rebuilds, [], "slash 行不得触发 rebind 检测");

    // query line: checked and rebuilt as usual
    await processChatLine({ line: "q", ctx });
    assert.deepEqual(rebuilds, [wtRoot]);
    assert.equal(ctx.engineRoot, wtRoot);
  });

  it("cli.ts 装配钉：registerShutdown 经 activeEngineShutdown 盒读最新引擎 + engineShutdown 透传 ctx", () => {
    // Structural pin: the rebuilt engine's shutdown must stay wired into the
    // process signal path —— registerShutdown hooks once and the signal
    // close-out reads activeEngineShutdown.current; after the refresh swaps
    // handles, current points at the rebuilt engine.
    const src = readFileSync(
      join(import.meta.dirname, "..", "..", "src", "cli.ts"),
      "utf8"
    );
    expect(src.includes("activeEngineShutdown.current")).toBe(true);
    expect(src.includes("engineShutdown: activeEngineShutdown")).toBe(true);
    const sessionSrc = readFileSync(
      join(import.meta.dirname, "..", "..", "src", "cli", "chat-session.ts"),
      "utf8"
    );
    expect(sessionSrc.includes("engineShutdown: opts.engineShutdown")).toBe(
      true
    );
  });
});

describe("T6 — chat stable productRoot threading (worktree-mcp-rebind-lifecycle)", () => {
  it("cli.ts：初次装配捕获 productRoot；rebuildDeps 只换 workspaceRoot/cwd，保留 productRoot", () => {
    const src = readFileSync(
      join(import.meta.dirname, "..", "..", "src", "cli.ts"),
      "utf8"
    );
    // The startup workspace is the stable productRoot (= workspaceRoot at first
    // assembly)
    expect(src).toMatch(/productRoot\s*=\s*workspaceRoot/);
    expect(src).toMatch(/productRoot(?:\s*,|\s*:)/);
    // The rebuild closure must not repoint productRoot at the task root
    const rebuildIdx = src.indexOf("rebuildDeps:");
    assert.ok(rebuildIdx >= 0, "rebuildDeps 缝必须存在");
    const rebuildBlock = src.slice(rebuildIdx, rebuildIdx + 900);
    expect(rebuildBlock).toMatch(/workspaceRoot:\s*root/);
    expect(rebuildBlock).toMatch(/cwd:\s*root/);
    // productRoot is forwarded as-is (variable reference), never productRoot: root
    expect(rebuildBlock).not.toMatch(/productRoot:\s*root\b/);
    expect(rebuildBlock).toMatch(/productRoot(?:\s*,|\s*\})/);
    // engineRoot aligns with the startup product/workspace, not bare process.cwd()
    expect(src).toMatch(/engineRoot:\s*(?:productRoot|workspaceRoot)\b/);
  });

  it("cli/runtime.ts：productRoot 单向透传到 buildHarnessEngine，不从 process.cwd() 重算", () => {
    const src = readFileSync(
      join(import.meta.dirname, "..", "..", "src", "cli", "runtime.ts"),
      "utf8"
    );
    expect(src).toMatch(/productRoot\?:\s*string/);
    // The wrapper must not derive productRoot from process.cwd()
    expect(src).not.toMatch(/productRoot:\s*process\.cwd\(\)/);
    // "it really got forwarded" is guarded by a real-run test asserting every
    // root reaches the build-engine opts, so this no longer pins the forwarding
    // *style*: the wrapper passes the rest object through wholesale instead of
    // hand-writing a whitelist, which would only catch one direction (a host
    // field absent from the interface) while silently missing the other.
    expect(src).toMatch(/withoutUndefined\(passthrough\)/);
  });
});

// Write-root trailer: after a successful rebind the main session hands the model
// one write-root segment (same wording as writeRootSegment) on the next query
// line, exactly once; no rebind adds no segment; a failed rebuild injects
// nothing. The text never enters system / env_snapshot.
describe("rebind 后主会话写根段（specs/skill-load-write-root.md T5）", () => {
  async function userTextsOf(
    messages: ReadonlyArray<{
      role: string;
      content: ReadonlyArray<{ type: string; text?: string }>;
    }>
  ): Promise<string[]> {
    return messages.flatMap((m) =>
      m.role === "user"
        ? m.content
            .filter(
              (b): b is { type: "text"; text: string } =>
                b.type === "text" && typeof b.text === "string"
            )
            .map((b) => b.text)
        : []
    );
  }

  const WRT_MARK =
    "current write root (for write_file / edit_file / bash cwd):";

  it("改绑成功 → 下一次查询行 messages 出现一次 writeRootSegment 文案；再下一行不再有", async () => {
    const dir = makeStoreDir();
    const store = new SessionStore(dir, process.cwd());
    const conversationId = "conv-wrt";
    const mainRoot = join(dir, "main");
    const wtRoot = join(mainRoot, ".iknow", "worktrees", conversationId);
    await store.save({
      id: conversationId,
      file: makeSessionFile(conversationId, mainRoot),
    });
    const file = await store.load(conversationId);
    await store.save({
      id: conversationId,
      file: { ...file, workspaceRoot: wtRoot },
    });

    const ctx = makeCtx({
      responses: [
        assistantResult({ texts: ["turn-1"] }),
        assistantResult({ texts: ["turn-2"] }),
      ],
      stateOverrides: { conversationId },
    });
    ctx.checkpointStore = store;
    ctx.engineRoot = mainRoot;
    ctx.rebuildDeps = async () => ({
      deps: makeDeps([assistantResult({ texts: ["rebuilt"] })]),
    });

    await processChatLine({ line: "q1", ctx });
    // After turn-1, result.messages feed ctx.state.messages —— the model-facing
    // surface must show the write-root segment exactly once (byte-identical to the
    // writeRootSegment helper).
    const segments1 = (await userTextsOf(ctx.state.messages)).filter((t) =>
      t.includes(WRT_MARK)
    );
    assert.equal(segments1.length, 1, "改绑后第一次查询行恰好注入一次");
    // The rebind notice is driven by the write-situation enum. This test leaves
    // isolationOn unset → false → `writable_main`; wtRoot is a tree shape, but
    // `writable_main` and `writable_tree` render byte-identically (hard
    // constraint).
    assert.equal(
      segments1[0],
      writeRootSegment("writable_main", wtRoot),
      "文案必须与 writeRootSegment helper 字节一致"
    );

    // The second line injects nothing (not per user message).
    await processChatLine({ line: "q2", ctx });
    const segments2 = (await userTextsOf(ctx.state.messages)).filter((t) =>
      t.includes(WRT_MARK)
    );
    assert.equal(segments2.length, 1, "仍只有 rebind 后那一次");
  });

  it("根未变化 → 不注入写根段（未改绑不多段）", async () => {
    const dir = makeStoreDir();
    const store = new SessionStore(dir, process.cwd());
    const conversationId = "conv-wrt-norebind";
    const mainRoot = join(dir, "main");
    await store.save({
      id: conversationId,
      file: makeSessionFile(conversationId, mainRoot),
    });

    const ctx = makeCtx({
      responses: [assistantResult({ texts: ["turn-1"] })],
      stateOverrides: { conversationId },
    });
    ctx.checkpointStore = store;
    ctx.engineRoot = mainRoot;
    ctx.rebuildDeps = async () => ({ deps: makeDeps([]) });

    await processChatLine({ line: "q", ctx });
    const segments = (await userTextsOf(ctx.state.messages)).filter((t) =>
      t.includes("current write root")
    );
    assert.equal(segments.length, 0, "未改绑不得出现写根段");
  });

  it("重建失败 → 可见降级且不注入写根段（改绑失败不插入）", async () => {
    const dir = makeStoreDir();
    const store = new SessionStore(dir, process.cwd());
    const conversationId = "conv-wrt-fail";
    const mainRoot = join(dir, "main");
    const wtRoot = join(mainRoot, ".iknow", "worktrees", conversationId);
    await store.save({
      id: conversationId,
      file: makeSessionFile(conversationId, mainRoot),
    });
    const file = await store.load(conversationId);
    await store.save({
      id: conversationId,
      file: { ...file, workspaceRoot: wtRoot },
    });

    const ctx = makeCtx({
      responses: [assistantResult({ texts: ["turn-1"] })],
      stateOverrides: { conversationId },
    });
    ctx.checkpointStore = store;
    ctx.engineRoot = mainRoot;
    ctx.rebuildDeps = async () => {
      throw new Error("boom");
    };

    const { captureStderrOf } = await import("../_helpers/capture-stderr.ts");
    await captureStderrOf(async () => {
      await processChatLine({ line: "q", ctx });
    });
    const segments = (await userTextsOf(ctx.state.messages)).filter((t) =>
      t.includes("current write root")
    );
    assert.equal(segments.length, 0, "重建失败不得注入写根段");
  });

  it("exit-worktree 回主仓（活写根 = 身份根）→ 不注入写根段（spec 合同 7：仅当写根 ≠ 身份根）", async () => {
    // The session already sits in the task worktree (engineRoot = wtRoot) and the
    // previous turn's /exit rebound workspaceRoot back to the main repo → rebuild
    // fires. Here newRoot = mainRoot = mainCheckoutOf(newRoot), so injecting the
    // write-root text would contradict "Project path is read-only" → it must not
    // be placed.
    const dir = makeStoreDir();
    const store = new SessionStore(dir, process.cwd());
    const conversationId = "conv-wrt-exit";
    const mainRoot = join(dir, "main");
    const wtRoot = join(mainRoot, ".iknow", "worktrees", conversationId);
    await store.save({
      id: conversationId,
      file: makeSessionFile(conversationId, wtRoot),
    });
    const file = await store.load(conversationId);
    await store.save({
      id: conversationId,
      file: { ...file, workspaceRoot: mainRoot },
    });

    const ctx = makeCtx({
      responses: [assistantResult({ texts: ["turn-1"] })],
      stateOverrides: { conversationId },
    });
    ctx.checkpointStore = store;
    ctx.engineRoot = wtRoot;
    ctx.rebuildDeps = async () => ({
      deps: makeDeps([assistantResult({ texts: ["rebuilt"] })]),
    });

    await processChatLine({ line: "q", ctx });
    assert.equal(ctx.engineRoot, mainRoot, "重建确实发生");
    const segments = (await userTextsOf(ctx.state.messages)).filter((t) =>
      t.includes("current write root")
    );
    assert.equal(
      segments.length,
      0,
      "exit 回身份根不得注入写根段（文案会自相矛盾）"
    );
  });
});
