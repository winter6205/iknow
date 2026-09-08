/**
 * Review High-1 (2026-08-29, plans/worktree-isolation-on-mutate.md) — CLI
 * chat 入口的 per-turn 引擎重建缝。
 *
 * chat REPL 的 deps 在 runChatSession 装配一次；T3 门禁 rebind 后会话文件
 * 的 workspaceRoot 指向 task worktree，下一回合必须以该根重建 deps
 * （rebuildDeps 缝，cli.ts 提供），否则 mutate 会被 stale 引擎永久拦下。
 * 钉死三条：
 *   1. 会话文件 workspaceRoot 变化 → 查询行开跑前以新根重建并重包
 *      （violation executor + conversationId + commitMessages 语义保持）；
 *   2. 根未变化 / 无 workspaceRoot / 文件缺席 → 不重建（零额外行为）；
 *   3. 重建失败 → 可见 stderr + 保持旧 deps（mutate 仍 fail-closed）。
 *
 * 收敛修复（2026-08-29 第二轮 review）：rebuildDeps 返回完整句柄 bundle
 * （对齐 TUI buildEngine 缝 / hub per-root 形状），refresh 成功后 rewire
 * ctx 的 subagentManager / graphAssembly / autoMemory / overlayMemoryPrefetch
 * （split-brain 修复：drain 消费新 manager，/graph 快照反映新装配），并把
 * 旧引擎 shutdown 先收口、新 shutdown 注册进 engineShutdown.current
 * （cli.ts 的 registerShutdown 闭包读 current —— SC11/SC16 纪律）。
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

// stderr 拦截走共享 helper captureStderrOf（writeErr SSOT）—— 可见降级 /
// 静默性断言共用（suppress 语义）。

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
    listSubagents: () => [],
  };
}

describe("chat-session rebind 重建缝（review High-1）", () => {
  it("会话文件 workspaceRoot 变化 → 查询行开跑前以新根重建 deps 并保持包装语义", async () => {
    const dir = makeStoreDir();
    const store = new SessionStore(dir);
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

    // 模拟 T3 rebind 已落盘（上一回合门禁拦下 + store.save workspaceRoot）
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
    // 重包语义：不是 rebuiltDeps 原样（conversationId 已收敛 / 包装层生效）
    assert.notEqual(ctx.deps, rebuiltDeps);
    assert.equal(ctx.deps.conversationId, conversationId);
    assert.equal(ctx.deps.adapter, rebuiltDeps.adapter);
  });

  it("runChatSession 为重建装配 wrapRebuiltDeps（violation/commit 包装与初始装配同源）", () => {
    // 结构性钉子：runChatSession 必须把 wrapChatDeps 交给重建缝，否则
    // rebuilt 引擎会丢 violation counter 与 commitMessages 钩子。
    const src = readFileSync(
      join(import.meta.dirname, "..", "..", "src", "cli", "chat-session.ts"),
      "utf8"
    );
    expect(src.includes("wrapRebuiltDeps: wrapChatDeps")).toBe(true);
  });

  it("根未变化 / 无 workspaceRoot / 会话文件缺席 → 不重建（not_found 保持静默）", async () => {
    const dir = makeStoreDir();
    const store = new SessionStore(dir);
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

    // workspaceRoot 与 engineRoot 相同（serve bind 写主根的形态）
    await processChatLine({ line: "q", ctx });
    assert.equal(rebuilds, 0);

    // 会话文件缺席（not_found）→ 静默（typed not_found 是「无 rebind 信号」
    // 的正常形态，不算错误）
    ctx.state.conversationId = "conv-unknown";
    const stderr = await captureStderrOf(async () => {
      await processChatLine({ line: "q2", ctx });
    });
    assert.equal(rebuilds, 0);
    assert.equal(stderr, "", "not_found 必须保持静默（正常无会话形态）");
  });

  it("重建失败 → 可见 stderr，保持旧 deps，回合仍完成", async () => {
    const dir = makeStoreDir();
    const store = new SessionStore(dir);
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

    // refresh 的可见降级走 process.stderr（writeErr SSOT）—— 拦截捕获
    let r;
    const stderr = await captureStderrOf(async () => {
      r = await processChatLine({ line: "q", ctx });
    });
    assert.equal(r.ranQuery, true);
    assert.equal(ctx.engineRoot, mainRoot); // 未切换
    assert.ok(stderr.includes("引擎重建失败"), "重建失败必须可见（stderr）");
  });
});

describe("chat-session rebind 句柄换血（2026-08-29 收敛修复）", () => {
  it("rebind 前已完成的 wait:false 结果在旧 manager shutdown 前 drain 并交付主模型（plan Goal #2）", async () => {
    const dir = makeStoreDir();
    const store = new SessionStore(dir);
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
    const store = new SessionStore(dir);
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
    const store = new SessionStore(dir);
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
    const store = new SessionStore(dir);
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

    // split-brain 修复：ctx 四个句柄全部指向重建引擎
    assert.equal(ctx.subagentManager, newManager);
    assert.equal(ctx.graphAssembly, ga2);
    assert.equal(ctx.autoMemory, am2);
    assert.equal(ctx.overlayMemoryPrefetch, om2);
    // shutdown 句柄换血：旧引擎收口一次（先收口），新 shutdown 注册
    assert.equal(oldShutdownCalls, 1, "旧引擎 shutdown 必须在切换点收口");
    assert.equal(ctx.engineShutdown?.current === undefined, false);
    // 信号路径现在指向重建引擎的 shutdown（cli.ts registerShutdown 闭包读 current）
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
    const store = new SessionStore(dir);
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
    const store = new SessionStore(dir);
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
    // 注入 io_error（磁盘读失败等真实异常形态）
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
    const store = new SessionStore(dir);
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

    // slash 行：不跑引擎 → 不触发 rebind 检测（会话文件已偏离也不重建）
    await processChatLine({ line: "/help", ctx });
    assert.deepEqual(rebuilds, [], "slash 行不得触发 rebind 检测");

    // 查询行：照常检测并重建
    await processChatLine({ line: "q", ctx });
    assert.deepEqual(rebuilds, [wtRoot]);
    assert.equal(ctx.engineRoot, wtRoot);
  });

  it("cli.ts 装配钉：registerShutdown 经 activeEngineShutdown 盒读最新引擎 + engineShutdown 透传 ctx", () => {
    // 结构性钉子：重建引擎的 shutdown 必须接进进程信号路径（SC11/SC16）——
    // registerShutdown 只挂一次，信号收口读 activeEngineShutdown.current；
    // refresh 换血后 current 指向重建引擎。
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
    // 启动 workspace 成为稳定 productRoot（= workspaceRoot at first assembly）
    expect(src).toMatch(/productRoot\s*=\s*workspaceRoot/);
    expect(src).toMatch(/productRoot(?:\s*,|\s*:)/);
    // rebuild 闭包不得把 productRoot 改成 task root
    const rebuildIdx = src.indexOf("rebuildDeps:");
    assert.ok(rebuildIdx >= 0, "rebuildDeps 缝必须存在");
    const rebuildBlock = src.slice(rebuildIdx, rebuildIdx + 900);
    expect(rebuildBlock).toMatch(/workspaceRoot:\s*root/);
    expect(rebuildBlock).toMatch(/cwd:\s*root/);
    // productRoot 原样透传（变量引用），不得写成 productRoot: root
    expect(rebuildBlock).not.toMatch(/productRoot:\s*root\b/);
    expect(rebuildBlock).toMatch(/productRoot(?:\s*,|\s*\})/);
    // engineRoot 与启动 product/workspace 对齐（非裸 process.cwd()）
    expect(src).toMatch(/engineRoot:\s*(?:productRoot|workspaceRoot)\b/);
  });

  it("cli/runtime.ts：productRoot 单向透传到 buildHarnessEngine，不从 process.cwd() 重算", () => {
    const src = readFileSync(
      join(import.meta.dirname, "..", "..", "src", "cli", "runtime.ts"),
      "utf8"
    );
    expect(src).toMatch(/productRoot\?:\s*string/);
    // wrapper 不得用 process.cwd() 派生 productRoot
    expect(src).not.toMatch(/productRoot:\s*process\.cwd\(\)/);
    // 「确实透传到了」由真跑守门：tests/cli/runtime-forwards-roots.test.ts 断言
    // 每个根都落到 build-engine 的 opts 上。这里不再钉转发的**写法** ——
    // round 4 起 wrapper 不手写白名单，改为 rest 整体透传（手写白名单只关住
    // 「宿主写了接口没声明的字段」一个方向，反方向漏接编译全绿）。
    expect(src).toMatch(/withoutUndefined\(passthrough\)/);
  });
});

// 写根 trailer（specs/skill-load-write-root.md T5）：改绑成功后主会话在
// 下一次查询行给模型再给一次写根段（writeRootSegment 同一文案），仅一次；
// 未改绑不多段；重建失败不注入。文案不进 system / env_snapshot。
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
    const store = new SessionStore(dir);
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
    // turn-1 后 result.messages 进 ctx.state.messages —— 模型看见的面上
    // 必须出现一次写根段（文案与 writeRootSegment helper 字节一致）。
    const segments1 = (await userTextsOf(ctx.state.messages)).filter((t) =>
      t.includes(WRT_MARK)
    );
    assert.equal(segments1.length, 1, "改绑后第一次查询行恰好注入一次");
    // T4 (write-situation-disclosure)：rebind 通知由处境枚举驱动。本测试
    // 没显式设 isolationOn → 默认 false → `writable_main`，wtRoot 是树形
    // 但 `writable_main` 与 `writable_tree` 输出逐字节相等（SC2 硬约束）。
    assert.equal(
      segments1[0],
      writeRootSegment("writable_main", wtRoot),
      "文案必须与 writeRootSegment helper 字节一致"
    );

    // 第二行不再注入（非每条用户消息）。
    await processChatLine({ line: "q2", ctx });
    const segments2 = (await userTextsOf(ctx.state.messages)).filter((t) =>
      t.includes(WRT_MARK)
    );
    assert.equal(segments2.length, 1, "仍只有 rebind 后那一次");
  });

  it("根未变化 → 不注入写根段（未改绑不多段）", async () => {
    const dir = makeStoreDir();
    const store = new SessionStore(dir);
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
    const store = new SessionStore(dir);
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

  it("exit-task-worktree 回主仓（活写根 = 身份根）→ 不注入写根段（spec 合同 7：仅当写根 ≠ 身份根）", async () => {
    // 会话已在 task worktree（engineRoot = wtRoot），上一回合 /exit 把
    // workspaceRoot 改绑回主仓 → 重建触发。此时 newRoot = mainRoot =
    // mainCheckoutOf(newRoot)，注入的写根文案会与「Project path 只读」
    // 自相矛盾 → 必须不置入。
    const dir = makeStoreDir();
    const store = new SessionStore(dir);
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
