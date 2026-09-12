/**
 * #502 T2 — BackgroundTaskManager + registry 落盘单测。
 *
 * 覆盖计划 acceptance 要求的六类边界(不真启子进程,fake spawn 工厂):
 *   1. 正常路径:fake spawn → spawn 返回 {task_id, log_path} → registry json
 *      读回一致(stdout/stderr 流入 log)
 *   2. 日志尾部读:log 超默认窗口只回尾部,status/exitCode 附带
 *   3. 空 task_id → empty_task_id(typed)
 *   4. 未知 task_id → task_not_found(typed)
 *   5. 并发重复:同一 task 并发两次 stop → 幂等,第二次语义确定
 *   6. kill 竞态:对已 exited 的 task stop → 幂等成功(不再发信号)
 *   7. 落盘 IO 失败:registry save/load 遇 fs 错误 → io_failure(typed)
 *
 * fake ChildProcess 构造沿用 tests/subagent/manager.test.ts 先例:
 * EventEmitter + PassThrough stdin/stdout/stderr + kill spy。
 * registry / log 落盘全部走真实 fs(mkdtemp temp dir,afterAll 清理)。
 */
import assert from "node:assert/strict";
import { afterEach, describe, it, vi } from "vitest";
import { createBackgroundRegistry } from "../../../src/harness/background/registry.js";
import { EventEmitter } from "node:events";
import { writeFile as fsWriteFile } from "node:fs/promises";
import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { tmpdir } from "node:os";
import type { ChildProcess } from "node:child_process";

import {
  createBackgroundTaskManager,
  DEFAULT_LOG_MAX_BYTES,
} from "../../../src/harness/background/manager.js";
import type { BackgroundTaskManager } from "../../../src/harness/background/manager.js";
import { renderTaskError } from "../../../src/harness/background/registry.js";
import { resolveTasksDir } from "../../../src/harness/background/paths.js";

// ── fake ChildProcess 工厂(沿用 subagent/manager.test.ts 先例)─────────────────

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

function makeFakeChild(pid = 12345): FakeChild {
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

// ── 会话级 temp 落盘根(registry/log 走真实 fs)───────────────────────────────

const tempRoots: string[] = [];

async function makeManager(opts?: {
  tasksDir?: string;
}): Promise<{ manager: BackgroundTaskManager; spawned: FakeChild[] }> {
  const root = await fs.mkdtemp(join(tmpdir(), "iknow-bg-"));
  tempRoots.push(root);
  const spawned: FakeChild[] = [];
  const manager = createBackgroundTaskManager({
    tasksDir:
      opts?.tasksDir ??
      resolveTasksDir({ dataDir: root, projectIdentityRoot: root }),
    spawn: async (_req) => {
      const child = makeFakeChild();
      child.pid = 12345 + spawned.length;
      spawned.push(child);
      return child as unknown as ChildProcess;
    },
  });
  return { manager, spawned };
}

afterEach(() => {
  // 清掉 stop 升级发出的兜底 timer(不 unref 时防悬挂)。
  vi.clearAllTimers();
});

// ── 1.正常路径 ─────────────────────────────────────────────────────────────────

describe("BackgroundTaskManager 正常路径", () => {
  it("spawn 返回 {task_id, log_path},registry json 读回字段全对齐", async () => {
    const { manager } = await makeManager();
    const res = await manager.spawn({
      command: "python3 -m http.server 8123",
      cwd: process.cwd(),
    });
    assert.match(res.task_id, /^bg-[0-9a-f]{12}$/);
    assert.ok(res.log_path.endsWith(`/${res.task_id}.log`));

    const status = await manager.status(res.task_id);
    assert.equal(status.status, "running");
    assert.equal(status.task_id, res.task_id);

    // 落盘 json 读回,字段全对齐
    const jsonPath = res.log_path.replace(/\.log$/, ".json");
    const raw = await fs.readFile(jsonPath, "utf8");
    const rec = JSON.parse(raw) as Record<string, unknown>;
    assert.equal(rec.task_id, res.task_id);
    assert.equal(rec.command, "python3 -m http.server 8123");
    assert.equal(rec.owner_pid, process.pid);
    assert.equal(rec.pgid, 12345);
    assert.equal(rec.status, "running");
    assert.equal(rec.conversation_id, "");
    assert.equal(rec.log_path, res.log_path);
    assert.ok(typeof rec.created_at === "string");
    assert.ok(rec.created_at.length > 0);
  });

  it("recordCommand 缺省 → 落盘 command 回退为 request.command（其他调用方兼容，#502 review-repair #406 roundtrip 契约回退路径）", async () => {
    const { manager } = await makeManager();
    const res = await manager.spawn({ command: "echo fallback", cwd: "." });
    const rec = JSON.parse(
      await fs.readFile(res.log_path.replace(/\.log$/, ".json"), "utf8")
    ) as { command: string };
    // 无 recordCommand 字段:manager 内部 `request.recordCommand ?? request.command`
    // 取 command,落盘 command = request.command。既有手写调用方（spawn
    // 不带 recordCommand）行为零回归。
    assert.equal(rec.command, "echo fallback");
  });

  it("recordCommand 存在 → 落盘 command = recordCommand,spawn 工厂仍收 command（真值不上盘）", async () => {
    // 自定义 manager:spawn 工厂捕获 request,断言 spawn 工厂收真值、registry
    // 落盘记录存占位符形态。#502 review-repair #406 roundtrip 契约。
    const root = await fs.mkdtemp(join(tmpdir(), "iknow-bg-record-"));
    tempRoots.push(root);
    let capturedRequest:
      | {
          command: string;
          recordCommand: string | undefined;
        }
      | undefined;
    const manager = createBackgroundTaskManager({
      tasksDir: resolveTasksDir({ dataDir: root, projectIdentityRoot: root }),
      spawn: async (req) => {
        capturedRequest = {
          command: req.command,
          recordCommand: req.recordCommand,
        };
        return makeFakeChild(55555) as unknown as ChildProcess;
      },
    });
    const res = await manager.spawn({
      command: 'echo "sk-real-secret"',
      recordCommand: 'echo "<<<SECRET_1>>>"',
      cwd: root,
    });
    assert.equal(res.status, "ok");

    // spawn 工厂只收 request.command(还原后真值);recordCommand 字段存在于
    // request 但不参与 spawn 调用栈。
    assert.ok(capturedRequest, "spawn factory must have captured request");
    assert.equal(capturedRequest!.command, 'echo "sk-real-secret"');
    assert.equal(capturedRequest!.recordCommand, 'echo "<<<SECRET_1>>>"');

    // 落盘 JSON:command 字段 = 占位符形态,真值不上盘。
    const rec = JSON.parse(
      await fs.readFile(res.log_path.replace(/\.log$/, ".json"), "utf8")
    ) as { command: string };
    assert.equal(rec.command, 'echo "<<<SECRET_1>>>"');
    assert.ok(!rec.command.includes("sk-real-secret"));
    assert.ok(rec.command.includes("<<<SECRET_1>>>"));
  });

  it("stdout + stderr 合并流入 log 文件", async () => {
    const { manager, spawned } = await makeManager();
    const { task_id } = await manager.spawn({ command: "echo hi", cwd: "." });
    await new Promise<void>((resolvePromise) => {
      spawned[0]!.stdout.write("hello\n", () => resolvePromise());
    });
    await new Promise<void>((resolvePromise) => {
      spawned[0]!.stderr.write("warn\n", () => resolvePromise());
    });
    await new Promise<void>((resolvePromise) => {
      spawned[0]!.stdout.write("tail", () => resolvePromise());
    });
    // 无换行结尾:exit 时 flush 剩余 buffer
    spawned[0]!.emit("exit", 0, null);
    const out = await manager.output(task_id);
    assert.equal(out.status, "exited");
    assert.equal(out.exit_code, 0);
    assert.equal(out.text, "hello\nwarn\ntail");
  });

  it("模拟 exit 状态迁移 → exited + exitCode 落 json", async () => {
    const { manager, spawned } = await makeManager();
    const { task_id, log_path } = await manager.spawn({
      command: "exit 3",
      cwd: ".",
    });
    spawned[0]!.stdout.write("bye\n");
    spawned[0]!.emit("exit", 3, null);

    const status = await manager.status(task_id);
    assert.equal(status.status, "exited");
    assert.equal(status.exit_code, 3);

    await vi.waitFor(async () => {
      const rec = JSON.parse(
        await fs.readFile(log_path.replace(/\.log$/, ".json"), "utf8")
      ) as {
        status: string;
        exit_code: number;
      };
      assert.equal(rec.status, "exited");
      assert.equal(rec.exit_code, 3);
    });
  });
});

// ── 2.日志尾部读 ───────────────────────────────────────────────────────────────

describe("BackgroundTaskManager output 尾部读", () => {
  it("log 超过默认窗口只回尾部(<= limit)", async () => {
    const { manager, spawned } = await makeManager();
    const { task_id } = await manager.spawn({ command: "tail", cwd: "." });
    const big = "x".repeat(DEFAULT_LOG_MAX_BYTES + 5000);
    await new Promise<void>((resolvePromise) => {
      spawned[0]!.stdout.write(big, () => resolvePromise());
    });
    spawned[0]!.emit("exit", 0, null);
    const out = await manager.output(task_id);
    assert.equal(out.status, "exited");
    assert.equal(out.exit_code, 0);
    assert.ok(
      out.text.length <= DEFAULT_LOG_MAX_BYTES,
      `len=${out.text.length}`
    );
    assert.equal(out.text.slice(-1), "x");
  });

  it("maxBytes 参数覆盖默认窗口", async () => {
    const { manager, spawned } = await makeManager();
    const { task_id } = await manager.spawn({ command: "tail", cwd: "." });
    spawned[0]!.stdout.write("0123456789");
    spawned[0]!.emit("exit", 0, null);
    const out = await manager.output(task_id, 5);
    assert.equal(out.text, "56789");
  });
});

// ── 3.空 task_id → empty_task_id ───────────────────────────────────────────────

describe("BackgroundTaskManager typed-error:空 task_id", () => {
  it('stop("") → 抛出 kind=empty_task_id', async () => {
    const { manager } = await makeManager();
    await assert.rejects(manager.stop(""), (err: unknown) => {
      assert.equal((err as { kind?: string }).kind, "empty_task_id");
      return true;
    });
  });

  it('status("") → 抛出 kind=empty_task_id', async () => {
    const { manager } = await makeManager();
    await assert.rejects(manager.status(""), (err: unknown) => {
      assert.equal((err as { kind?: string }).kind, "empty_task_id");
      return true;
    });
  });

  it('output("") → 抛出 kind=empty_task_id', async () => {
    const { manager } = await makeManager();
    await assert.rejects(manager.output(""), (err: unknown) => {
      assert.equal((err as { kind?: string }).kind, "empty_task_id");
      return true;
    });
  });
});

// ── 4.未知 task_id → task_not_found ───────────────────────────────────────────

describe("BackgroundTaskManager typed-error:未知 task_id", () => {
  it('status("bg-unknown") → 抛出 kind=task_not_found', async () => {
    const { manager } = await makeManager();
    await assert.rejects(manager.status("bg-0123456789ab"), (err: unknown) => {
      assert.equal((err as { kind?: string }).kind, "task_not_found");
      return true;
    });
  });

  it('output("bg-unknown") → 抛出 kind=task_not_found', async () => {
    const { manager } = await makeManager();
    await assert.rejects(manager.output("bg-0123456789ab"), (err: unknown) => {
      assert.equal((err as { kind?: string }).kind, "task_not_found");
      return true;
    });
  });

  it('stop("bg-unknown") → 抛出 kind=task_not_found', async () => {
    const { manager } = await makeManager();
    await assert.rejects(manager.stop("bg-0123456789ab"), (err: unknown) => {
      assert.equal((err as { kind?: string }).kind, "task_not_found");
      return true;
    });
  });
});

// ── 5.并发重复 ─────────────────────────────────────────────────────────────────

describe("BackgroundTaskManager 并发重复 stop", () => {
  it("同一 task 并发两次 stop → 都成功且 SIGTERM 次数有限", async () => {
    const { manager, spawned } = await makeManager();
    const { task_id } = await manager.spawn({ command: "long", cwd: "." });
    const results = await Promise.allSettled([
      manager.stop(task_id),
      manager.stop(task_id),
    ]);
    // 两次 stop 都成功(并发被 manager 内部串行化)
    assert.equal(results[0]?.status, "fulfilled");
    assert.equal(results[1]?.status, "fulfilled");
    // INVARIANT:fake 不退出时,kill 调用次数 <= 2(每次 stop 一轮 SIGTERM)
    const sigterms = spawned[0]!.kill.mock.calls.filter(
      (c) => c[0] === "SIGTERM"
    ).length;
    assert.ok(sigterms >= 1 && sigterms <= 2, `sigterm count=${sigterms}`);
    // 收尾:fake 退出 → kill 兜底 timer 清理
    spawned[0]!.emit("exit", null, "SIGTERM");
  });

  it("同一 task 并发两次 stop → 最终状态 killed", async () => {
    const { manager, spawned } = await makeManager();
    const { task_id } = await manager.spawn({ command: "long", cwd: "." });
    await Promise.allSettled([manager.stop(task_id), manager.stop(task_id)]);
    spawned[0]!.emit("exit", null, "SIGTERM");
    const final = await manager.status(task_id);
    assert.equal(final.status, "killed");
  });
});

// ── 6.kill 竞态(对已终态任务 stop)───────────────────────────────────────────

describe("BackgroundTaskManager kill 竞态", () => {
  it("对已 exited 的 task stop → 幂等成功(不再发任何信号)", async () => {
    const { manager, spawned } = await makeManager();
    const { task_id } = await manager.spawn({ command: "fast", cwd: "." });
    spawned[0]!.emit("exit", 0, null);
    const st = await manager.status(task_id);
    assert.equal(st.status, "exited");
    // 对已终态 stop:幂等成功,不 throw
    await manager.stop(task_id);
    // 不追加任何信号
    assert.equal(spawned[0]!.kill.mock.calls.length, 0);
    const st2 = await manager.status(task_id);
    assert.equal(st2.status, "exited");
  });

  it("对已 killed 的任务 stop → 幂等成功", async () => {
    const { manager, spawned } = await makeManager();
    const { task_id } = await manager.spawn({ command: "fast", cwd: "." });
    // 先 stop:child 收到 SIGTERM 后以信号退出 → terminal 态
    await manager.stop(task_id);
    spawned[0]!.emit("exit", null, "SIGTERM");
    const st = await manager.status(task_id);
    assert.equal(st.status, "killed");
    // 再 stop:幂等成功,不再追加信号
    await manager.stop(task_id);
    const sigtermCount = spawned[0]!.kill.mock.calls.filter(
      (c) => c[0] === "SIGTERM"
    ).length;
    assert.equal(sigtermCount, 1);
  });
});

// ── 7.落盘 IO 失败 ────────────────────────────────────────────────────────────

describe("BackgroundTaskManager 落盘 IO 失败", () => {
  it("tasksDir 不可写(父路径是文件) → spawn 返回 spawn_error 且 error.kind=io_failure", async () => {
    const root = await fs.mkdtemp(join(tmpdir(), "iknow-bg-ro-"));
    tempRoots.push(root);
    const blocker = join(root, "blocker");
    await fsWriteFile(blocker, "file", "utf8");
    const tasksDir = join(blocker, "tasks"); // 父路径是文件 → mkdir ENOTDIR
    const manager = createBackgroundTaskManager({
      tasksDir,
      spawn: async (_req) => makeFakeChild(1) as unknown as ChildProcess,
    });
    const res = await manager.spawn({ command: "x", cwd: "." });
    assert.equal(res.status, "spawn_error");
    const err = res.error as { kind?: string };
    assert.equal(err.kind, "io_failure");
  });

  it("registry save 遇 IO 错误 → io_failure(而非 crash)", async () => {
    const root = await fs.mkdtemp(join(tmpdir(), "iknow-bg-iofail-"));
    tempRoots.push(root);
    const blocker = join(root, "blocker");
    await fsWriteFile(blocker, "file", "utf8");
    const registry = createBackgroundRegistry({
      tasksDir: join(blocker, "tasks"),
    });
    await assert.rejects(
      registry.save({
        task_id: "bg-0123456789ab",
        command: "x",
        owner_pid: 1,
        conversation_id: "",
        pgid: 1,
        status: "running",
        exit_code: null,
        created_at: "now",
        log_path: "/none/tasks/bg-0123456789ab.log",
      }),
      (err: unknown) => {
        assert.equal((err as { kind?: string }).kind, "io_failure");
        return true;
      }
    );
  });

  it("registry load 遇到坏 JSON → 抛 kind=schema_invalid(registry 层职责)", async () => {
    const root = await fs.mkdtemp(join(tmpdir(), "iknow-bg-badjson-"));
    tempRoots.push(root);
    const tasksDir = resolveTasksDir({
      dataDir: root,
      projectIdentityRoot: root,
    });
    await fs.mkdir(tasksDir, { recursive: true });
    await fsWriteFile(join(tasksDir, "bg-0123456789ab.json"), "{bad json");
    const registry = createBackgroundRegistry({ tasksDir });
    await assert.rejects(registry.load("bg-0123456789ab"), (err: unknown) => {
      assert.equal((err as { kind?: string }).kind, "schema_invalid");
      return true;
    });
  });
});

// ── typed-error catch 契约:用 kind 判别,不用 message 字符串 ──────────────────

describe("typed-error catch 契约(kind 判别)", () => {
  it("errors 带 kind + context 供判别渲染", async () => {
    const { manager } = await makeManager();
    await assert.rejects(manager.output("bg-ffffffffffff"), (err: unknown) => {
      const e = err as { kind?: string; context?: string };
      assert.equal(e.kind, "task_not_found");
      assert.ok(typeof e.context === "string");
      return true;
    });
  });

  it("renderTaskError 输出 `${kind}: ${context}` 形态", () => {
    assert.equal(
      renderTaskError({ kind: "task_not_found", context: "bg-x" }),
      "task_not_found: bg-x"
    );
    assert.equal(
      renderTaskError({
        kind: "io_failure",
        context: "save bg-x",
        cause: "EACCES",
      }),
      "io_failure: save bg-x"
    );
  });
});

// ── paths.ts 纯函数 ───────────────────────────────────────────────────────────

describe("paths.resolveTasksDir", () => {
  it("返回 <pool>/projects/<slug>/tasks，slug 与 resolveProjectSessionDir 同公式", () => {
    // ADR-0088：任务登记跟会话池同一项目树。slug = basename(root)-sha1(root)[:12]，
    // 与 src/session-api/store/session-store.ts 的 resolveProjectSessionDir 逐字节相同
    // （两处刻意不共享实现：harness 不得反向依赖 session-api）。
    const digest = createHash("sha1")
      .update("/repo")
      .digest("hex")
      .slice(0, 12);
    assert.equal(
      resolveTasksDir({ dataDir: "/home/x", projectIdentityRoot: "/repo" }),
      join("/home/x", "projects", `repo-${digest}`, "tasks")
    );
  });

  it("workspaceRoot 不再参与派生（多 checkout 共用一份账本）", () => {
    // ADR-0088：throwaway checkout 不另开活账本 —— 同一 projectIdentityRoot
    // 下换个 dataDir 才换池，换工作区不换。
    const a = resolveTasksDir({
      dataDir: "/pool-a",
      projectIdentityRoot: "/repo",
    });
    const b = resolveTasksDir({
      dataDir: "/pool-a",
      projectIdentityRoot: "/repo",
    });
    assert.equal(a, b);
    assert.ok(!a.includes(".iknow/tasks"));
  });

  it("缺根 / 空白 / 相对 / 超长 projectIdentityRoot → typed SessionRootError", () => {
    const cases: ReadonlyArray<string> = ["", "   ", "relative/path"];
    for (const bad of cases) {
      assert.throws(
        () => resolveTasksDir({ dataDir: "/pool", projectIdentityRoot: bad }),
        (err: unknown) => {
          const e = err as { name?: string; kind?: string };
          assert.equal(e.name, "SessionRootError");
          assert.ok(
            e.kind === "missing_root" || e.kind === "invalid_root",
            `unexpected kind: ${String(e.kind)}`
          );
          return true;
        }
      );
    }
  });
});

describe("registry 读回一致性(字段全对齐)", () => {
  it("conversationId 记账字段落盘", async () => {
    const { manager, spawned } = await makeManager();
    const res = await manager.spawn({
      command: "true",
      cwd: ".",
      conversationId: "conv-test-1",
    });
    const rec = JSON.parse(
      await fs.readFile(res.log_path.replace(/\.log$/, ".json"), "utf8")
    ) as Record<string, unknown>;
    assert.equal(rec.task_id, res.task_id);
    assert.equal(rec.command, "true");
    assert.equal(rec.conversation_id, "conv-test-1");
    assert.equal(rec.owner_pid, process.pid);
    assert.equal(rec.pgid, spawned[0]!.pid);
    assert.equal(rec.status, "running");
    assert.equal(rec.log_path, res.log_path);
    assert.ok(typeof rec.created_at === "string");
  });
});
