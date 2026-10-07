/**
 * Conversation visibility scope filtering + concurrency-cap governance.
 *
 * Acceptance groups (ADR-0021 D1.4 / D1.6):
 *
 *   1. conversation scope filtering (manager is the authority; tools passthrough):
 *      - cross-conversation read rejected: typed-error `task_not_in_scope`
 *        carrying `owner_conversation_id` (the task's real conversationId field).
 *      - cross-conversation stop rejected: same discriminator + owner field.
 *      - same-conversation read / stop never throw.
 *      - absent-ctx semantics (backward compat, ADR-0021 D1.4): empty requester
 *        or record without conversationId -> no filtering. An empty-string
 *        requester is also treated as absent (defensive, consistent with "non-empty").
 *      - tool-layer consistency: bash_output / bash_stop handlers pass
 *        ctx.conversationId through to manager.output/stop as
 *        requesterConversationId; cross-session surfaces as ToolExecutionError
 *        `${kind}: ...` (typed-error catch contract).
 *
 *   2. concurrency cap (manager.spawn governance gate):
 *      - after 8 running tasks the 9th spawn is rejected with typed-error
 *        `concurrency_limit_reached` + positively-worded message (current
 *        state + available actions + zero negation words); the Chinese
 *        message must contain no prohibition wording and must mention
 *        "可用 bash_stop" ("bash_stop is available") as the actionable option.
 *      - stopping 1 task reclaims the slot: fake child emits exit -> status
 *        settles -> later spawns are allowed.
 *
 *   3. fresh-conversationId end-to-end walkthrough (command-handler contract):
 *      - temp workspaceRoot + brand-new conversationId (no pre-stored task records);
 *      - real fs (registry really persists) + real manager + fake spawn factory;
 *      - full flow: spawn (same conversationId) -> read by same id -> reject
 *        by foreign id -> stop by same id.
 *
 * Failure-signal contract (typed-error catch contract; [object Object] forbidden):
 *   - the manager layer throws a plain object (discriminated union
 *     BackgroundTaskError); asserts go through `err.kind === "..."`, never
 *     relying on message uniqueness.
 *   - the tool layer renders `bash_output: ${kind}: ${context}` into
 *     ToolExecutionError; asserts use `instanceof ToolExecutionError + message.includes(kind)`.
 *
 * Uses the real createBackgroundTaskManager + real fs (mkdtemp workspaceRoot);
 * the fake ChildProcess follows manager.test.ts (EventEmitter + PassThrough +
 * kill spy). No bwrap needed: bash_output / bash_stop handlers bypass the
 * sandbox.
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, it, vi } from "vitest";
import type { ChildProcess } from "node:child_process";

import { ToolExecutionError } from "../../../src/harness/errors.js";
import {
  createBackgroundTaskManager,
  MAX_CONCURRENT_BACKGROUND_TASKS,
} from "../../../src/harness/background/manager.js";
import type { BackgroundTaskManager } from "../../../src/harness/background/manager.js";
import { resolveTasksDir } from "../../../src/harness/background/paths.js";
import type { BackgroundTaskError } from "../../../src/harness/background/registry.js";
import { createBashOutputTool } from "../../../src/harness/aci/tools/bash-output.js";
import { createBashStopTool } from "../../../src/harness/aci/tools/bash-stop.js";

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

function makeFakeChild(pid = 23456): FakeChild {
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
  const root = await mkdtemp(join(tmpdir(), "iknow-bg-scope-"));
  tempRoots.push(root);
  const spawned: FakeChild[] = [];
  const manager = createBackgroundTaskManager({
    tasksDir: resolveTasksDir({ dataDir: root, projectIdentityRoot: root }),
    spawn: async () => {
      const child = makeFakeChild(23456 + spawned.length);
      spawned.push(child);
      return child as unknown as ChildProcess;
    },
  });
  return { manager, spawned };
}

afterEach(async () => {
  vi.clearAllTimers();
  await Promise.all(
    tempRoots.splice(0).map((p) => rm(p, { recursive: true, force: true }))
  );
});

/** Rejection must be task_not_in_scope (manager-layer typed-error catch contract). */
function isTaskNotInScope(
  err: unknown,
  expectedOwner: string
): err is BackgroundTaskError {
  if (err === null || typeof err !== "object") return false;
  const e = err as Partial<BackgroundTaskError>;
  return (
    e.kind === "task_not_in_scope" &&
    (e as { owner_conversation_id?: string }).owner_conversation_id ===
      expectedOwner
  );
}

// ── 1. conversation scope filtering ──────────────────────────────────────────

describe("conversation scope 过滤（manager 层权威）", () => {
  it("跨 conversation 读被拒 → task_not_in_scope + owner_conversation_id", async () => {
    const { manager } = await makeManager();
    const res = await manager.spawn({
      command: "sleep 1",
      cwd: ".",
      conversationId: "conv-A",
    });
    assert.equal(res.status, "ok");
    if (res.status !== "ok") return;

    await assert.rejects(
      manager.output(res.task_id, undefined, "conv-B"),
      (err: unknown) => isTaskNotInScope(err, "conv-A")
    );
  });

  it("跨 conversation 停被拒 → task_not_in_scope + owner_conversation_id", async () => {
    const { manager } = await makeManager();
    const res = await manager.spawn({
      command: "sleep 1",
      cwd: ".",
      conversationId: "conv-A",
    });
    assert.equal(res.status, "ok");
    if (res.status !== "ok") return;

    await assert.rejects(manager.stop(res.task_id, "conv-B"), (err: unknown) =>
      isTaskNotInScope(err, "conv-A")
    );
  });

  it("同 conversation 读 / 停正常（kind 路径不抛）", async () => {
    const { manager } = await makeManager();
    const res = await manager.spawn({
      command: "sleep 1",
      cwd: ".",
      conversationId: "conv-A",
    });
    assert.equal(res.status, "ok");
    if (res.status !== "ok") return;

    const out = await manager.output(res.task_id, undefined, "conv-A");
    assert.equal(out.status, "running");
    assert.equal(out.task_id, res.task_id);

    // stop's sync segment does not throw (fake child never emits exit, so the
    // task stays running; stop reports no error).
    await manager.stop(res.task_id, "conv-A");
  });

  it("ctx 缺省 / 记录无 conversationId → 不过滤（向后兼容，ADR-0021 D1.4）", async () => {
    const { manager } = await makeManager();
    // Record without conversationId (undefined -> persisted as empty string); any requester can read.
    const res = await manager.spawn({ command: "sleep 1", cwd: "." });
    assert.equal(res.status, "ok");
    if (res.status !== "ok") return;

    const out = await manager.output(res.task_id, undefined, "conv-Anything");
    assert.equal(out.status, "running");
    await manager.stop(res.task_id, "conv-Anything");

    // Record with conversationId + absent requester -> still visible (absent ctx = open).
    const res2 = await manager.spawn({
      command: "sleep 1",
      cwd: ".",
      conversationId: "conv-A",
    });
    assert.equal(res2.status, "ok");
    if (res2.status !== "ok") return;
    const out2 = await manager.output(res2.task_id);
    assert.equal(out2.status, "running");
  });

  it("空字符串 requester conversationId → 不过滤（防御性，与「非空」一致）", async () => {
    const { manager } = await makeManager();
    const res = await manager.spawn({
      command: "sleep 1",
      cwd: ".",
      conversationId: "conv-A",
    });
    assert.equal(res.status, "ok");
    if (res.status !== "ok") return;

    const out = await manager.output(res.task_id, undefined, "");
    assert.equal(out.status, "running");
  });
});

describe("conversation scope 工具层透传（bash_output / bash_stop handler）", () => {
  it("bash_output 跨 conversation → ToolExecutionError 含 task_not_in_scope", async () => {
    const { manager } = await makeManager();
    const res = await manager.spawn({
      command: "sleep 1",
      cwd: ".",
      conversationId: "conv-A",
    });
    assert.equal(res.status, "ok");
    if (res.status !== "ok") return;

    const tool = createBashOutputTool({ backgroundManager: manager });
    await assert.rejects(
      async () =>
        tool.handler({ task_id: res.task_id }, { conversationId: "conv-B" }),
      (err: unknown) =>
        err instanceof ToolExecutionError &&
        err.message.includes("task_not_in_scope")
    );
  });

  it("bash_stop 跨 conversation → ToolExecutionError 含 task_not_in_scope", async () => {
    const { manager } = await makeManager();
    const res = await manager.spawn({
      command: "sleep 1",
      cwd: ".",
      conversationId: "conv-A",
    });
    assert.equal(res.status, "ok");
    if (res.status !== "ok") return;

    const tool = createBashStopTool({ backgroundManager: manager });
    await assert.rejects(
      async () =>
        tool.handler({ task_id: res.task_id }, { conversationId: "conv-B" }),
      (err: unknown) =>
        err instanceof ToolExecutionError &&
        err.message.includes("task_not_in_scope")
    );
  });

  it("bash_output 同 conversation → JSON envelope 正常返回", async () => {
    const { manager } = await makeManager();
    const res = await manager.spawn({
      command: "sleep 1",
      cwd: ".",
      conversationId: "conv-A",
    });
    assert.equal(res.status, "ok");
    if (res.status !== "ok") return;

    const tool = createBashOutputTool({ backgroundManager: manager });
    const out = JSON.parse(
      (await tool.handler(
        { task_id: res.task_id },
        { conversationId: "conv-A" }
      )) as string
    ) as { status: string; task_id: string };
    assert.equal(out.status, "running");
    assert.equal(out.task_id, res.task_id);
  });
});

// ── 2. concurrency cap ───────────────────────────────────────────────────────

describe("并发上限（manager.spawn 治理闸门）", () => {
  it("8 个 running 后第 9 个 spawn 被拒 → concurrency_limit_reached + 正面措辞", async () => {
    const { manager } = await makeManager();
    for (let i = 0; i < MAX_CONCURRENT_BACKGROUND_TASKS; i++) {
      const r = await manager.spawn({ command: "sleep 1", cwd: "." });
      assert.equal(r.status, "ok");
    }
    const ninth = await manager.spawn({ command: "sleep 1", cwd: "." });
    assert.equal(ninth.status, "spawn_error");
    if (ninth.status !== "spawn_error") return;
    assert.equal(ninth.error.kind, "concurrency_limit_reached");
    // Positive-wording contract: zero prohibition words + an available action (bash_stop).
    const msg = ninth.error.message;
    assert.ok(
      typeof msg === "string" && msg.length > 0,
      `concurrency_limit_reached.message must be non-empty: ${String(msg)}`
    );
    assert.equal(
      /不|禁止|避免|严禁|不得|不要/.test(msg),
      false,
      `concurrency_limit_reached.message must avoid negative wording: ${msg}`
    );
    assert.ok(
      msg.includes("bash_stop"),
      `concurrency_limit_reached.message must suggest bash_stop: ${msg}`
    );
    assert.ok(
      msg.includes(String(MAX_CONCURRENT_BACKGROUND_TASKS)),
      `concurrency_limit_reached.message must reference the current limit: ${msg}`
    );
    // On the rejection path task_id is an empty string (no task was created, so nothing can be mistaken for success).
    assert.equal(ninth.task_id, "");
  });

  it("stop 1 个 → 名额回收（fake child emit exit 释放 slot）", async () => {
    const { manager, spawned } = await makeManager();
    const ids: string[] = [];
    for (let i = 0; i < MAX_CONCURRENT_BACKGROUND_TASKS; i++) {
      const r = await manager.spawn({ command: "sleep 1", cwd: "." });
      assert.equal(r.status, "ok");
      if (r.status === "ok") ids.push(r.task_id);
    }
    // Gate: the 9th spawn must be rejected.
    const blocked = await manager.spawn({ command: "sleep 1", cwd: "." });
    assert.equal(blocked.status, "spawn_error");

    // Stop the first task and emit exit to simulate a real process converging after SIGTERM.
    await manager.stop(ids[0]!);
    spawned[0]!.emit("exit", 0, null);
    // The status sync segment (settle sync precedes await registry.save) is
    // done; read it stably via status().
    const settled = await manager.status(ids[0]!);
    assert.equal(settled.status, "exited");

    // Slot reclaimed: the next spawn is allowed.
    const fresh = await manager.spawn({ command: "sleep 1", cwd: "." });
    assert.equal(fresh.status, "ok");
  });
});

// ── 3. fresh-conversationId end-to-end walkthrough ───────────────────────────

describe("fresh conversationId 端到端走读（test.md 命令 handler 契约）", () => {
  it("全新 conversationId + 真实 fs:spawn → 同 id 读 → 跨 id 拒 → 同 id 停", async () => {
    const { manager } = await makeManager();
    // Brand-new conversationId; the registry dir exists but holds no task records.
    const convFresh = `conv-fresh-${Math.random().toString(36).slice(2, 10)}`;

    const res = await manager.spawn({
      command: "python3 -m http.server 8123",
      cwd: ".",
      conversationId: convFresh,
    });
    assert.equal(res.status, "ok");
    if (res.status !== "ok") return;

    // Registry really persists and the conversation_id field is written.
    const recJson = JSON.parse(
      await readFile(res.log_path.replace(/\.log$/, ".json"), "utf8")
    ) as Record<string, unknown>;
    assert.equal(recJson.conversation_id, convFresh);
    assert.equal(recJson.task_id, res.task_id);

    // Read by same id: JSON envelope returns normal status.
    const out = await manager.output(res.task_id, undefined, convFresh);
    assert.equal(out.status, "running");
    assert.equal(out.task_id, res.task_id);

    // Read by foreign id: task_not_in_scope + owner_conversation_id = convFresh.
    await assert.rejects(
      manager.output(res.task_id, undefined, "conv-other"),
      (err: unknown) => isTaskNotInScope(err, convFresh)
    );

    // Stop by foreign id: same discriminator.
    await assert.rejects(
      manager.stop(res.task_id, "conv-other"),
      (err: unknown) => isTaskNotInScope(err, convFresh)
    );

    // Stop by same id: allowed (fake child never emits exit, task stays running, stop's sync segment doesn't throw).
    await manager.stop(res.task_id, convFresh);
  });
});
