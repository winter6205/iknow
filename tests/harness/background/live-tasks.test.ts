/**
 * listLiveTasks — the synchronous, identity-only liveness projection.
 *
 * Acceptance groups:
 *
 *   1. liveness: a running task is listed; a task whose child settled (natural
 *      exit, or a teardown followed by the exit event) is gone; a rejected
 *      spawn never becomes a row at all. Nothing here consults a tool receipt
 *      — the projection has no such field, which is what makes the quit busy
 *      set agree whether the caller was told `ok` or `execution_failed`.
 *   2. attribution: each row carries its owner's conversation_id, and a task
 *      spawned without one reports the empty string — the projection never
 *      narrows by requester, callers join the rows themselves.
 *   3. projection shape: task_id + conversation_id only. The busy set needs
 *      identity; command text and log path stay out so no placeholder command
 *      reaches a UI surface.
 *   4. the cap gate and the projection agree (one "what counts as live"
 *      definition, not two).
 *   5. never throws.
 *
 * Real createBackgroundTaskManager + real fs (mkdtemp); the fake ChildProcess
 * follows manager.test.ts / scope.test.ts (EventEmitter + PassThrough + kill
 * spy). No bwrap needed: nothing here launches a fence.
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, it, vi } from "vitest";
import type { ChildProcess } from "node:child_process";

import {
  createBackgroundTaskManager,
  MAX_CONCURRENT_BACKGROUND_TASKS,
} from "../../../src/harness/background/manager.js";
import type { BackgroundTaskManager } from "../../../src/harness/background/manager.js";
import { resolveTasksDir } from "../../../src/harness/background/paths.js";

// ── fixtures ─────────────────────────────────────────────────────────────────

interface FakeChild {
  readonly stdin: PassThrough;
  readonly stdout: PassThrough;
  readonly stderr: PassThrough;
  readonly pid: number;
  readonly kill: ReturnType<typeof vi.fn>;
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  emit: (event: string | symbol, ...args: unknown[]) => boolean;
  once: (event: string | symbol, ...args: unknown[]) => unknown;
}

function makeFakeChild(pid: number): FakeChild {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const kill = vi.fn(() => true);
  return Object.assign(new EventEmitter(), {
    stdin,
    stdout,
    stderr,
    pid,
    kill,
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
  }) as unknown as FakeChild;
}

const tempRoots: string[] = [];

async function makeManager(): Promise<{
  manager: BackgroundTaskManager;
  spawned: FakeChild[];
}> {
  const root = await mkdtemp(join(tmpdir(), "iknow-bg-live-"));
  tempRoots.push(root);
  const spawned: FakeChild[] = [];
  const manager = createBackgroundTaskManager({
    tasksDir: resolveTasksDir({ dataDir: root, projectIdentityRoot: root }),
    spawn: async () => {
      const child = makeFakeChild(31000 + spawned.length);
      spawned.push(child);
      return child as unknown as ChildProcess;
    },
  });
  return { manager, spawned };
}

async function okSpawn(
  manager: BackgroundTaskManager,
  request: { command: string; cwd: string; conversationId?: string }
): Promise<string> {
  const res = await manager.spawn(request);
  assert.equal(res.status, "ok");
  if (res.status !== "ok") throw new Error(`spawn rejected: ${JSON.stringify(res)}`);
  return res.task_id;
}

afterEach(async () => {
  vi.clearAllTimers();
  await Promise.all(
    tempRoots.splice(0).map((p) => rm(p, { recursive: true, force: true }))
  );
});

// ── 1. liveness ──────────────────────────────────────────────────────────────

describe("listLiveTasks 存活判定", () => {
  it("running 任务在投影中；自然退出后消失", async () => {
    const { manager, spawned } = await makeManager();
    const id = await okSpawn(manager, {
      command: "sleep 1",
      cwd: ".",
      conversationId: "conv-A",
    });

    assert.deepEqual(manager.listLiveTasks(), [
      { task_id: id, conversation_id: "conv-A" },
    ]);

    spawned[0]!.emit("exit", 0, null);
    assert.equal((await manager.status(id)).status, "exited");
    assert.deepEqual(manager.listLiveTasks(), []);
  });

  it("stop 后被信号终止 → 状态 killed 并从投影消失", async () => {
    const { manager, spawned } = await makeManager();
    const id = await okSpawn(manager, {
      command: "sleep 30",
      cwd: ".",
      conversationId: "conv-A",
    });

    await manager.stop(id, "conv-A");
    // A teardown request alone is not a death: the record stays live until the
    // exit event settles it.
    assert.deepEqual(manager.listLiveTasks().map(({ task_id }) => task_id), [
      id,
    ]);

    spawned[0]!.emit("exit", null, "SIGTERM");
    assert.equal((await manager.status(id)).status, "killed");
    assert.deepEqual(manager.listLiveTasks(), []);
  });

  it("两个任务一活一死 → 投影只含活的那个", async () => {
    const { manager, spawned } = await makeManager();
    const live = await okSpawn(manager, { command: "sleep 1", cwd: "." });
    const dead = await okSpawn(manager, { command: "sleep 1", cwd: "." });

    spawned[1]!.emit("exit", 1, null);
    assert.equal((await manager.status(dead)).status, "exited");

    assert.deepEqual(manager.listLiveTasks().map(({ task_id }) => task_id), [
      live,
    ]);
  });

  it("被拒的 spawn（spawn_error）不留下行 —— 没启动起来的工作不会让会话显得忙", async () => {
    const { manager } = await makeManager();
    for (let i = 0; i < MAX_CONCURRENT_BACKGROUND_TASKS; i++) {
      await okSpawn(manager, {
        command: "sleep 1",
        cwd: ".",
        conversationId: "conv-A",
      });
    }
    const before = manager.listLiveTasks();

    const rejected = await manager.spawn({
      command: "sleep 1",
      cwd: ".",
      conversationId: "conv-A",
    });
    assert.equal(rejected.status, "spawn_error");
    assert.deepEqual(manager.listLiveTasks(), before);
  });
});

// ── 2. attribution rides along; callers join ─────────────────────────────────

describe("listLiveTasks 归属字段", () => {
  it("带归属的行报 owner，无归属的行报空串，两类都列出", async () => {
    const { manager } = await makeManager();
    const mine = await okSpawn(manager, {
      command: "sleep 1",
      cwd: ".",
      conversationId: "conv-A",
    });
    const unowned = await okSpawn(manager, { command: "sleep 1", cwd: "." });

    assert.deepEqual(
      manager
        .listLiveTasks()
        .map(({ task_id }) => task_id)
        .sort(),
      [mine, unowned].sort()
    );
    assert.deepEqual(manager.listLiveTasks().find((row) => row.task_id === mine), {
      task_id: mine,
      conversation_id: "conv-A",
    });
    assert.deepEqual(
      manager.listLiveTasks().find((row) => row.task_id === unowned),
      { task_id: unowned, conversation_id: "" }
    );
  });

  it("跨会话的任务都列出：投影不按请求者收窄", async () => {
    const { manager } = await makeManager();
    await okSpawn(manager, {
      command: "sleep 1",
      cwd: ".",
      conversationId: "conv-A",
    });
    await okSpawn(manager, {
      command: "sleep 1",
      cwd: ".",
      conversationId: "conv-B",
    });

    assert.deepEqual(
      manager
        .listLiveTasks()
        .map(({ conversation_id }) => conversation_id)
        .sort(),
      ["conv-A", "conv-B"]
    );
  });
});

// ── 3. projection shape ──────────────────────────────────────────────────────

describe("listLiveTasks 投影字段", () => {
  it("只有 task_id / conversation_id：无 command、无 log_path", async () => {
    const { manager } = await makeManager();
    await okSpawn(manager, {
      command: "python3 -m http.server 8123",
      cwd: ".",
      conversationId: "conv-A",
    });

    const [only] = manager.listLiveTasks();
    assert.ok(only !== undefined);
    assert.deepEqual(Object.keys(only).slice().sort(), [
      "conversation_id",
      "task_id",
    ]);
    const record = only as unknown as Record<string, unknown>;
    assert.equal(record.command, undefined);
    assert.equal(record.log_path, undefined);
  });

  it("重复调用返回独立快照，改动不回写 manager 状态", async () => {
    const { manager } = await makeManager();
    await okSpawn(manager, { command: "sleep 1", cwd: "." });
    const first = manager.listLiveTasks();
    const second = manager.listLiveTasks();
    assert.deepEqual(first, second);
    assert.notEqual(first, second);
  });
});

// ── 4. same liveness definition as the concurrency cap ───────────────────────

describe("listLiveTasks 与并发闸门同源", () => {
  it("填满 cap → 投影长度等于上限；退出一个 → 两侧同时少一个", async () => {
    const { manager, spawned } = await makeManager();
    const ids: string[] = [];
    for (let i = 0; i < MAX_CONCURRENT_BACKGROUND_TASKS; i++) {
      ids.push(await okSpawn(manager, { command: "sleep 1", cwd: "." }));
    }
    assert.equal(manager.listLiveTasks().length, MAX_CONCURRENT_BACKGROUND_TASKS);

    const blocked = await manager.spawn({ command: "sleep 1", cwd: "." });
    assert.equal(blocked.status, "spawn_error");
    if (blocked.status === "spawn_error") {
      assert.equal(blocked.error.kind, "concurrency_limit_reached");
    }

    spawned[0]!.emit("exit", 0, null);
    assert.equal((await manager.status(ids[0]!)).status, "exited");
    assert.equal(
      manager.listLiveTasks().length,
      MAX_CONCURRENT_BACKGROUND_TASKS - 1
    );
    assert.equal((await manager.spawn({ command: "sleep 1", cwd: "." })).status, "ok");
  });
});

// ── 5. never throws ──────────────────────────────────────────────────────────

describe("listLiveTasks 无异常路径", () => {
  it("无任务 / 全部退出并 shutdown 后 → 空数组，不抛错", async () => {
    const { manager, spawned } = await makeManager();
    assert.deepEqual(manager.listLiveTasks(), []);

    await okSpawn(manager, {
      command: "sleep 1",
      cwd: ".",
      conversationId: "conv-A",
    });
    spawned[0]!.emit("exit", 0, null);
    await manager.shutdown();
    assert.deepEqual(manager.listLiveTasks(), []);
  });
});
