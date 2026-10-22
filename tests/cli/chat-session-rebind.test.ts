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
import type { ProcessChatLineResult } from "../../src/cli/chat-session.ts";
import type { LoopEngineDeps } from "../../src/harness/index.ts";
import {
  SessionStore,
  CURRENT_SCHEMA_VERSION,
} from "../../src/session-api/store/index.ts";
import type { SessionFileV1 } from "../../src/session-api/store/index.ts";
import type { SubAgentManager } from "../../src/harness/subagent/manager.ts";
import type { SubAgentEnvelope } from "../../src/harness/subagent/envelope.ts";
import {
  createDeliveryLedger,
  deliveryKey,
  type ClaimedDelivery,
} from "../../src/harness/subagent/delivery-ledger.ts";
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

/**
 * Wrap a deps adapter so every `step` records the model-visible message history
 * it was handed. `LoopEngineDeps.adapter` is readonly, so this returns a NEW
 * deps object instead of mutating the one passed in.
 */
function withMessageCapture(deps: LoopEngineDeps): {
  readonly deps: LoopEngineDeps;
  readonly messages: () => string;
} {
  let seen = "";
  const base = deps.adapter;
  return {
    deps: {
      ...deps,
      adapter: {
        ...base,
        step: async (state, request, signal) => {
          seen = JSON.stringify(state.messages);
          return base.step(state, request, signal);
        },
      },
    },
    messages: () => seen,
  };
}

/**
 * A structurally complete SubAgentManager fake.
 *
 * `SubAgentManager`'s members are `readonly`, so per-test behaviour is passed
 * as an `overrides` patch spread over the defaults instead of being assigned
 * onto the returned object.
 */
function makeManagerStub(
  opts: {
    readonly drain?: Array<{ taskId: string; envelope: SubAgentEnvelope }>;
    readonly overrides?: Partial<SubAgentManager>;
  } = {}
): SubAgentManager {
  return {
    spawn: () => ({ taskId: "t-1" }),
    // A completed worker reads back as its terminal envelope (queryBuffer's
    // `completed` arm IS SubAgentEnvelope — there is no "completed" status).
    queryBuffer: () =>
      ({
        status: "ok",
        summary: "stub",
        result: "stub",
      }) satisfies SubAgentEnvelope,
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
    // Required by the interface; returns the unsubscribe seam and never fires.
    subscribe: () => () => {},
    ...opts.overrides,
    // No claim seam on purpose: the rebind closeout path reads through
    // `drainCompleted`, so this fake stays on the read-only host-drain path
    // (ADR-0150). The cast only satisfies the widened manager interface.
  } as unknown as SubAgentManager;
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
    let r: ProcessChatLineResult | undefined;
    const stderr = await captureStderrOf(async () => {
      r = await processChatLine({ line: "q", ctx });
    });
    assert.ok(r !== undefined, "processChatLine must return a result");
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
      overrides: {
        drainCompleted: () => {
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
        },
        shutdown: async () => {
          closeoutEvents.push("shutdown");
        },
      },
    });
    const captured = withMessageCapture(
      makeDeps([assistantResult({ texts: ["rebuilt"] })])
    );
    const rebuiltDeps = captured.deps;

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
      captured.messages(),
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
    const completed = {
      taskId: "running-old-task",
      envelope: {
        status: "ok" as const,
        summary: "old running manager completed",
        result: "old running wait:false result",
      },
    };
    const oldManager = makeManagerStub({
      overrides: {
        listActive: () => (running ? [completed.taskId] : []),
        drainCompleted: () => {
          closeoutEvents.push("drain");
          return running ? [] : [completed];
        },
        waitFor: async (taskId: string) => {
          closeoutEvents.push(`wait:${taskId}`);
          running = false;
          return completed.envelope;
        },
        shutdown: async () => {
          closeoutEvents.push("shutdown");
        },
      },
    });
    const captured = withMessageCapture(
      makeDeps([assistantResult({ texts: ["rebuilt"] })])
    );
    const rebuiltDeps = captured.deps;

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
    assert.match(captured.messages(), /old running manager completed/);
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
    const oldManager = makeManagerStub({
      overrides: {
        listActive: () => ["undelivered-old-task"],
        drainCompleted: () => {
          closeoutEvents.push("drain");
          return [];
        },
        waitFor: async () => {
          closeoutEvents.push("wait");
          throw new Error("old task wait failed");
        },
        shutdown: async () => {
          closeoutEvents.push("shutdown");
        },
      },
    });
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
    const oldManager = makeManagerStub({
      overrides: {
        shutdown: async () => {
          oldShutdownCalls += 1;
          shutdownOrder.push("old");
        },
      },
    });
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
    // OverlayPrefetchFn resolves the overlay TEXT; "" is the empty overlay
    // (attachPrefetchOverlay returns userText unchanged), which is what these
    // two identity-swapped stubs mean.
    const om1: OverlayPrefetchFn = async () => "";
    const om2: OverlayPrefetchFn = async () => "";
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
    const oldManager = makeManagerStub({
      overrides: {
        drainCompleted: () => {
          oldDrainCalls += 1;
          return [];
        },
      },
    });
    let newDrainCalls = 0;
    const newManager = makeManagerStub({
      overrides: {
        drainCompleted: () => {
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
        },
      },
    });

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

    let r: ProcessChatLineResult | undefined;
    const stderr = await captureStderrOf(async () => {
      r = await processChatLine({ line: "q", ctx });
    });
    assert.ok(r !== undefined, "processChatLine must return a result");
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

/* -------------------------------------------------------------------------- *
 * ADR-0150 — exactly-once sub-agent result delivery across a rebind.
 * -------------------------------------------------------------------------- */

interface DeliveryEntry {
  readonly taskId: string;
  readonly terminalSeq: number;
  readonly envelope: SubAgentEnvelope;
}

interface RebindDeliveryFixture {
  readonly manager: SubAgentManager;
  /** Entries handed out per claim call, in call order (0 = nothing claimable). */
  readonly claimBatches: number[];
  readonly drainCalls: () => number;
  readonly shutdownCalls: () => number;
  readonly isDelivered: (taskId: string) => boolean;
}

/**
 * A manager view over the REAL delivery ledger (ADR-0150). `shutdown`
 * mirrors the production manager: it drops the buffer and the ledger, so a
 * shut-down manager can never replay a result.
 */
function makeRebindDeliveryManager(
  entries: ReadonlyArray<DeliveryEntry>
): RebindDeliveryFixture {
  const ledger = createDeliveryLedger();
  const claimBatches: number[] = [];
  let drainCalls = 0;
  let shutdownCalls = 0;
  let closed = false;
  const ledgerEntries = (): ReadonlyArray<{
    conversationId: string;
    taskId: string;
    terminalSeq: number;
    envelope: SubAgentEnvelope;
  }> =>
    entries.map((entry) => ({
      conversationId: "",
      taskId: entry.taskId,
      terminalSeq: entry.terminalSeq,
      envelope: entry.envelope,
    }));
  const manager = {
    drainCompleted: (
      _conversationId?: string,
      drainOpts?: { readonly includeDelivered?: boolean }
    ): ReadonlyArray<{ taskId: string; envelope: SubAgentEnvelope }> => {
      drainCalls += 1;
      if (closed) return [];
      const visible =
        drainOpts?.includeDelivered === true
          ? ledgerEntries()
          : ledger.undelivered(ledgerEntries());
      return visible.map(({ taskId, envelope }) => ({ taskId, envelope }));
    },
    claimCompleted: () => {
      if (closed) return [];
      const claims = ledger.claim(ledgerEntries());
      claimBatches.push(claims.length);
      return claims;
    },
    acknowledgeDeliveries: (
      claims: ReadonlyArray<ClaimedDelivery<unknown>>
    ): void => {
      ledger.acknowledge(claims);
    },
    releaseDeliveries: (
      claims: ReadonlyArray<ClaimedDelivery<unknown>>
    ): void => {
      ledger.release(claims);
    },
    listActive: () => [],
    waitFor: async (): Promise<SubAgentEnvelope> => {
      throw new Error("delivery fixture: waitFor is not used");
    },
    queryBuffer: () => ({ status: "not_found" as const }),
    shutdown: async () => {
      shutdownCalls += 1;
      closed = true;
      ledger.clear();
    },
    spawn: () => ({ taskId: "delivery-fixture" }),
    abortTask: () => false,
    getCapacity: () => 15,
    listSubagents: () => [],
    subscribe: () => () => {},
  } as unknown as SubAgentManager;
  return {
    manager,
    claimBatches,
    drainCalls: () => drainCalls,
    shutdownCalls: () => shutdownCalls,
    isDelivered: (taskId: string) => {
      const entry = entries.find((candidate) => candidate.taskId === taskId);
      return ledger.isDelivered(
        deliveryKey({
          conversationId: "",
          taskId,
          terminalSeq: entry?.terminalSeq ?? 0,
        })
      );
    },
  };
}

/** Record the model-visible history of every main model call. */
function withHistoryList(deps: LoopEngineDeps): {
  readonly deps: LoopEngineDeps;
  readonly histories: () => readonly string[];
} {
  const histories: string[] = [];
  const base = deps.adapter;
  return {
    deps: {
      ...deps,
      adapter: {
        ...base,
        step: async (state, request, signal) => {
          if (request.tools !== undefined) {
            histories.push(JSON.stringify(state.messages));
          }
          return base.step(state, request, signal);
        },
      },
    },
    histories: () => histories,
  };
}

/** Message events in the persisted JSONL that carry `needle`. */
function countMessageEvents(filePath: string, needle: string): number {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch {
    return 0;
  }
  let count = 0;
  for (const line of raw.split("\n")) {
    if (line.trim().length === 0) continue;
    const record = JSON.parse(line) as {
      readonly type?: string;
      readonly message?: {
        readonly content?: ReadonlyArray<{
          readonly type?: string;
          readonly text?: string;
        }>;
      };
    };
    if (record.type !== "message") continue;
    const text = (record.message?.content ?? [])
      .map((block) => block.text ?? "")
      .join("");
    if (text.includes(needle)) count += 1;
  }
  return count;
}

/** Occurrences of `needle` in `haystack`. */
function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe("ADR-0150 rebind delivery is exactly-once", () => {
  it("delivers the old and the new manager results each exactly once across a rebind", async () => {
    const dir = makeStoreDir();
    const store = new SessionStore(dir, process.cwd());
    const conversationId = "conv-rebind-delivery-once";
    const mainRoot = join(dir, "main");
    const wtRoot = join(mainRoot, ".iknow", "worktrees", conversationId);
    await store.save({
      id: conversationId,
      file: makeSessionFile(conversationId, mainRoot),
    });

    const oldMarker = "old result summary a1b2";
    const newMarker = "new result summary c3d4";
    const oldDelivery = makeRebindDeliveryManager([
      {
        taskId: "old-task",
        terminalSeq: 1,
        envelope: { status: "ok", summary: oldMarker, result: "old body" },
      },
    ]);
    const newDelivery = makeRebindDeliveryManager([
      {
        taskId: "new-task",
        terminalSeq: 2,
        envelope: { status: "ok", summary: newMarker, result: "new body" },
      },
    ]);
    const captured = withHistoryList(
      makeDeps([
        assistantResult({ texts: ["first answer"] }),
        assistantResult({ texts: ["second answer"] }),
      ])
    );

    const ctx = makeCtx({
      responses: [],
      stateOverrides: { conversationId },
    });
    ctx.deps = captured.deps;
    ctx.checkpointStore = store;
    ctx.workspaceRoot = wtRoot;
    ctx.engineRoot = mainRoot;
    ctx.subagentManager = oldDelivery.manager;
    ctx.engineShutdown = {
      current: oldDelivery.manager.shutdown.bind(oldDelivery.manager),
    };
    ctx.rebuildDeps = async () => ({
      deps: captured.deps,
      subagentManager: newDelivery.manager,
    });

    const file = await store.load(conversationId);
    await store.save({
      id: conversationId,
      file: { ...file, workspaceRoot: wtRoot },
    });

    const first = await processChatLine({ line: "first question", ctx });
    assert.equal(first.ranQuery, true);

    // Both generations reached the first post-rebind run, once.
    assert.equal(ctx.subagentManager, newDelivery.manager);
    assert.equal(captured.histories().length, 1);
    const oldOccurrences = occurrences(captured.histories()[0]!, oldMarker);
    const newOccurrences = occurrences(captured.histories()[0]!, newMarker);
    assert.ok(oldOccurrences > 0);
    assert.ok(newOccurrences > 0);

    // The closeout only READS the old manager; the round's claim belongs to
    // the new manager and was acknowledged by the digest-carrying save.
    assert.deepEqual(oldDelivery.claimBatches, []);
    assert.equal(oldDelivery.shutdownCalls(), 1);
    assert.equal(newDelivery.isDelivered("new-task"), true);

    // "The old manager's shutdown does not replay a delivered result":
    // after shutdown its buffer and ledger are empty.
    assert.deepEqual(oldDelivery.manager.drainCompleted(), []);
    const drainCallsAfterRebind = oldDelivery.drainCalls();

    const second = await processChatLine({ line: "second question", ctx });
    assert.equal(second.ranQuery, true);

    // No replay: the second round's model history carries neither result a
    // second time (the delivered digest stays in the conversation history,
    // but it is not re-injected).
    assert.equal(captured.histories().length, 2);
    assert.equal(
      occurrences(captured.histories()[1]!, oldMarker),
      oldOccurrences
    );
    assert.equal(
      occurrences(captured.histories()[1]!, newMarker),
      newOccurrences
    );
    assert.equal(
      oldDelivery.drainCalls(),
      drainCallsAfterRebind,
      "the rebind closeout runs once; the old manager is never drained again"
    );

    const jsonlPath = join(
      store.getProjectDir(),
      conversationId,
      `${conversationId}.jsonl`
    );
    assert.equal(countMessageEvents(jsonlPath, oldMarker), 1);
    assert.equal(countMessageEvents(jsonlPath, newMarker), 1);
  });

  it("clears the rebind closeout text after the round that carried it", async () => {
    const dir = makeStoreDir();
    const store = new SessionStore(dir, process.cwd());
    const conversationId = "conv-rebind-closeout-clear";
    const mainRoot = join(dir, "main");
    const wtRoot = join(mainRoot, ".iknow", "worktrees", conversationId);
    await store.save({
      id: conversationId,
      file: makeSessionFile(conversationId, mainRoot),
    });

    const oldMarker = "closeout summary e5f6";
    const oldDelivery = makeRebindDeliveryManager([
      {
        taskId: "old-task",
        terminalSeq: 1,
        envelope: { status: "ok", summary: oldMarker, result: "old body" },
      },
    ]);
    // The new manager has no terminal result: the closeout text is the only
    // drain in the first post-rebind round.
    const newDelivery = makeRebindDeliveryManager([]);
    const captured = withHistoryList(
      makeDeps([
        assistantResult({ texts: ["first answer"] }),
        assistantResult({ texts: ["second answer"] }),
      ])
    );

    const ctx = makeCtx({
      responses: [],
      stateOverrides: { conversationId },
    });
    ctx.deps = captured.deps;
    ctx.checkpointStore = store;
    ctx.workspaceRoot = wtRoot;
    ctx.engineRoot = mainRoot;
    ctx.subagentManager = oldDelivery.manager;
    ctx.engineShutdown = {
      current: oldDelivery.manager.shutdown.bind(oldDelivery.manager),
    };
    ctx.rebuildDeps = async () => ({
      deps: captured.deps,
      subagentManager: newDelivery.manager,
    });

    const file = await store.load(conversationId);
    await store.save({
      id: conversationId,
      file: { ...file, workspaceRoot: wtRoot },
    });

    await processChatLine({ line: "first question", ctx });

    const closeoutOccurrences = occurrences(
      captured.histories()[0]!,
      oldMarker
    );
    assert.ok(closeoutOccurrences > 0);
    // The closeout text is host text, not a claimed generation: it clears
    // after the successful round.
    assert.equal(ctx.pendingSubagentDrain, undefined);

    await processChatLine({ line: "second question", ctx });

    // The second round carries the closeout text only as history, never as a
    // re-injected drain.
    assert.equal(captured.histories().length, 2);
    assert.equal(
      occurrences(captured.histories()[1]!, oldMarker),
      closeoutOccurrences
    );
  });
});
