/**
 * #502 T5 — conversation 可见性 scope 过滤 + 并发上限治理（Track A 治理层）。
 *
 * 覆盖计划 acceptance 三组 + 边界（plans/bash-service-loop.md T5 / ADR-0021
 * D1.4 / D1.6 / #491 D6）：
 *
 *   1. conversation scope 过滤（manager 层权威 + 工具层透传）：
 *      - 跨 conversation 读被拒：typed-error `task_not_in_scope` + 携带
 *        `owner_conversation_id`（按 task 真正的 conversationId 字段）。
 *      - 跨 conversation 停被拒：同判别 + 同 owner 字段。
 *      - 同 conversation 正常：读 / 停不抛。
 *      - ctx 缺省语义（向后兼容）：requester 缺省 / 记录无 conversationId
 *        任一为空 → 不过滤（参考 ADR-0021 D1.4）。空字符串 requester 同
 *        视为缺省（防御性，与「非空」一致）。
 *      - 工具层一致性：bash_output / bash_stop handler 把 ctx.conversationId
 *        透传给 manager.output/stop 的 requesterConversationId；跨 session
 *        在工具层报 ToolExecutionError `${kind}: ...`（typed-error catch 契约）。
 *
 *   2. 并发上限（manager.spawn 治理闸门）：
 *      - 8 个 running 后第 9 个 spawn 被拒，typed-error `concurrency_limit_reached`
 *        + 正面措辞 message（说明现状 + 可用动作 + 零负面词）；无「不」「禁止」
 *        「避免」类禁令词，含「可用 bash_stop」作为可用动作。
 *      - stop 1 个 → 名额回收：fake child emit exit → 状态 settling → 后续
 *        spawn 放行。
 *
 *   3. fresh conversationId 端到端走读（test.md 命令 handler 契约）：
 *      - temp workspaceRoot + 全新 conversationId（不预存任何 task 记录）；
 *      - 真实 fs（registry 落盘真实）+ 真实 manager + fake spawn 工厂；
 *      - 全程：spawn（同 conversationId）→ 同 id 读 → 跨 id 拒 → 同 id 停。
 *
 * 失败信号契约（code-quality.md typed-error catch 契约，禁 [object Object]）：
 *   - manager 层抛 plain object（判别联合 BackgroundTaskError），assert
 *     走 `err.kind === "..."` 判别，不依赖 message 唯一性。
 *   - 工具层以 `bash_output: ${kind}: ${context}` 渲染进 ToolExecutionError，
 *     断言走 `instanceof ToolExecutionError + message.includes(kind)`。
 *
 * 依赖真实 `createBackgroundTaskManager` + 真实 fs 落盘（mkdtemp temp
 * workspaceRoot），fake ChildProcess 沿用 manager.test.ts 先例（EventEmitter
 * + PassThrough + kill spy）。bwrap 不需要（bash-output / bash-stop handler
 * 不走 sandbox；bash handler 测试已在 scope 外即可）。
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
    tasksDir: resolveTasksDir(root),
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

/** 拒绝原因必须是 task_not_in_scope（manager 层 typed-error catch 契约）。 */
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

// ── 1. conversation scope 过滤 ───────────────────────────────────────────────

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

    // stop 同步段不抛（fake child 不 emit exit，状态仍在 running；stop 不报错）。
    await manager.stop(res.task_id, "conv-A");
  });

  it("ctx 缺省 / 记录无 conversationId → 不过滤（向后兼容，ADR-0021 D1.4）", async () => {
    const { manager } = await makeManager();
    // 记录无 conversationId（undefined → 落盘空串）；任何 requester 都能读。
    const res = await manager.spawn({ command: "sleep 1", cwd: "." });
    assert.equal(res.status, "ok");
    if (res.status !== "ok") return;

    const out = await manager.output(res.task_id, undefined, "conv-Anything");
    assert.equal(out.status, "running");
    await manager.stop(res.task_id, "conv-Anything");

    // 记录带 conversationId + requester 缺省 → 同样可见（ctx 缺省 = 开放）。
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

// ── 2. 并发上限 ─────────────────────────────────────────────────────────────

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
    // 正面措辞契约：零负面禁令词 + 含可用动作（bash_stop）。
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
    // task_id 在拒绝路径上是空串（任务未被创建，不会被误以为成功）。
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
    // 闸门：第 9 个应该被拒。
    const blocked = await manager.spawn({ command: "sleep 1", cwd: "." });
    assert.equal(blocked.status, "spawn_error");

    // 停第 1 个并 emit exit 模拟真进程被 SIGTERM 后收敛。
    await manager.stop(ids[0]!);
    spawned[0]!.emit("exit", 0, null);
    // status 同步段（settle 同步段先于 await registry.save）已完成；
    // 用 status() 稳固读取。
    const settled = await manager.status(ids[0]!);
    assert.equal(settled.status, "exited");

    // 名额回收：再次 spawn 放行。
    const fresh = await manager.spawn({ command: "sleep 1", cwd: "." });
    assert.equal(fresh.status, "ok");
  });
});

// ── 3. fresh conversationId 端到端走读 ───────────────────────────────────────

describe("fresh conversationId 端到端走读（test.md 命令 handler 契约）", () => {
  it("全新 conversationId + 真实 fs:spawn → 同 id 读 → 跨 id 拒 → 同 id 停", async () => {
    const { manager } = await makeManager();
    // 全新 conversationId；registry 目录建立但无任何 task 记录。
    const convFresh = `conv-fresh-${Math.random().toString(36).slice(2, 10)}`;

    const res = await manager.spawn({
      command: "python3 -m http.server 8123",
      cwd: ".",
      conversationId: convFresh,
    });
    assert.equal(res.status, "ok");
    if (res.status !== "ok") return;

    // registry 真实落盘 + conversation_id 字段写入（anker 边界）。
    const recJson = JSON.parse(
      await readFile(res.log_path.replace(/\.log$/, ".json"), "utf8")
    ) as Record<string, unknown>;
    assert.equal(recJson.conversation_id, convFresh);
    assert.equal(recJson.task_id, res.task_id);

    // 同 id 读：JSON envelope 状态正常。
    const out = await manager.output(res.task_id, undefined, convFresh);
    assert.equal(out.status, "running");
    assert.equal(out.task_id, res.task_id);

    // 跨 id 读：task_not_in_scope + owner_conversation_id = convFresh。
    await assert.rejects(
      manager.output(res.task_id, undefined, "conv-other"),
      (err: unknown) => isTaskNotInScope(err, convFresh)
    );

    // 跨 id 停：同判别。
    await assert.rejects(
      manager.stop(res.task_id, "conv-other"),
      (err: unknown) => isTaskNotInScope(err, convFresh)
    );

    // 同 id 停：放行（fake child 不 emit exit，状态仍在 running，stop 同步段不抛）。
    await manager.stop(res.task_id, convFresh);
  });
});
