/**
 * #502 T6 — BackgroundTaskManager 生命周期收尾:shutdown 进程级 reap /
 * 启动 stale 清扫(reapStaleTasks)/ reap 接缝(onConversationDeleted)。
 *
 * acceptance(plans/bash-service-loop.md T6, Track A 生命周期收尾层):
 *   1. shutdown 后无存活子进程组(真实 detached spawn e2e)
 *   2. host-SIGKILL 后重启清理回收 orphan + json 标 dead
 *   3. owner-alive record 跳过(多进程不误 kill)
 *   4. reap 幂等(second run zero kills / zero json changes)
 *   5. starttime 加固分支(ADR-0021 D1.5):mismatch → 只标 dead 不 kill
 *      (dummy 组存活);无 starttime → 保守跳过(断言行为)
 *   6. shutdown 幂等(second call no throw)
 *   7. reap 失败不 crash(missing tasksDir / broken json → skip + log,不 throw)
 *
 * 真实进程 e2e 不需要 bwrap:plain node spawn(detached) 即建真实进程组,
 * process.kill(-pgid, 0) 抛 ESRCH 判定组消失。vitest pool = forks(隔离
 * subprocess),真实 child 安全;afterEach SIGKILL 兜底清扫。
 * 仅 Linux(grep /proc/<pid>/stat),仓库默认 WSL/Linux 目标。
 */
import assert from "node:assert/strict";
import { afterEach, describe, it, vi } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { readFileSync, promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PassThrough } from "node:stream";

import {
  createBackgroundTaskManager,
  type BackgroundTaskManager,
} from "../../../src/harness/background/manager.js";
import { reapStaleTasks } from "../../../src/harness/background/stale-reap.js";
import { resolveTasksDir } from "../../../src/harness/background/paths.js";
import type {
  BackgroundTaskRecord,
  BackgroundTaskStatus,
} from "../../../src/harness/background/registry.js";

// ── 真实 detached 进程组 helper ───────────────────────────────────────────────

const realChildren: ChildProcess[] = [];

function spawnRealDetached(sleepSec = 60): ChildProcess {
  const child = spawn("bash", ["-c", `sleep ${sleepSec}`], {
    stdio: "ignore",
    detached: true,
  });
  realChildren.push(child);
  return child;
}

/** kill(-pgid, 0) 探测组是否存活:ESRCH = 已消失。 */
function isGroupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitGroupGone(pgid: number, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (isGroupAlive(pgid)) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`process group ${pgid} still alive after ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** /proc/<pid>/stat 第 22 字段(starttime):suffix 空格分词 index 19(已验证)。 */
function readStartTime(pid: number): number | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const suffix = stat
      .slice(stat.lastIndexOf(")") + 1)
      .trim()
      .split(/\s+/);
    const v = Number(suffix[19]);
    return Number.isFinite(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

afterEach(() => {
  if (vi.isFakeTimers()) vi.useRealTimers();
  for (const child of realChildren) {
    const pid = child.pid;
    if (pid === undefined) continue;
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      /* ESRCH 已死 */
    }
  }
  realChildren.length = 0;
});

// ── fake ChildProcess(manager.test.ts 同款,用于 timer/订阅点路径)──────────────

interface FakeChild {
  readonly pid: number;
  readonly kill: ReturnType<typeof vi.fn>;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  emit: (event: string | symbol, ...args: unknown[]) => boolean;
  once: (event: string | symbol, ...args: unknown[]) => unknown;
}

function makeFakeChild(pid = 31337): FakeChild {
  const kill = vi.fn(() => true);
  return Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    pid,
    kill,
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
  }) as unknown as FakeChild;
}

async function makeFakeManager(): Promise<{
  manager: BackgroundTaskManager;
  spawned: FakeChild[];
}> {
  const root = await fs.mkdtemp(join(tmpdir(), "iknow-bg-life-"));
  const spawned: FakeChild[] = [];
  const manager = createBackgroundTaskManager({
    tasksDir: resolveTasksDir(root),
    spawn: async () => {
      const child = makeFakeChild(31337 + spawned.length);
      spawned.push(child);
      return child as unknown as ChildProcess;
    },
  });
  return { manager, spawned };
}

async function makeRealManager(opts?: {
  tasksDir?: string;
}): Promise<{ manager: BackgroundTaskManager }> {
  const root = await fs.mkdtemp(join(tmpdir(), "iknow-bg-life-"));
  const manager = createBackgroundTaskManager({
    tasksDir: opts?.tasksDir ?? resolveTasksDir(root),
    spawn: async () => spawnRealDetached() as unknown as ChildProcess,
  });
  return { manager };
}

async function readRec(
  tasksDir: string,
  taskId: string
): Promise<BackgroundTaskRecord> {
  return JSON.parse(
    await fs.readFile(join(tasksDir, `${taskId}.json`), "utf8")
  ) as BackgroundTaskRecord;
}

function makeRecord(opts: {
  taskId: string;
  ownerPid: number;
  pgid: number;
  status?: BackgroundTaskStatus;
  starttime?: number;
  logPath?: string;
}): BackgroundTaskRecord {
  return {
    task_id: opts.taskId,
    command: "sleep 60",
    owner_pid: opts.ownerPid,
    conversation_id: "",
    pgid: opts.pgid,
    status: opts.status ?? "running",
    exit_code: null,
    created_at: new Date().toISOString(),
    log_path: opts.logPath ?? `/none/tasks/${opts.taskId}.log`,
    ...(opts.starttime !== undefined ? { starttime: opts.starttime } : {}),
  };
}

// ── T6 manager.shutdown 进程级收尾 ───────────────────────────────────────────

describe("T6 manager.shutdown 进程级收尾", () => {
  it("shutdown 杀真实 detached 进程组 + json 标 killed", async () => {
    const root = await fs.mkdtemp(join(tmpdir(), "iknow-bg-life-"));
    const tasksDir = resolveTasksDir(root);
    const manager = createBackgroundTaskManager({
      tasksDir,
      spawn: async () => spawnRealDetached() as unknown as ChildProcess,
    });
    const res = await manager.spawn({ command: "sleep 60", cwd: root });
    assert.equal(res.status, "ok");
    if (res.status !== "ok") return;
    const rec = await readRec(tasksDir, res.task_id);
    const pgid = rec.pgid;
    assert.equal(isGroupAlive(pgid), true, "group alive before shutdown");

    await manager.shutdown();

    // 核心断言:shutdown 返回后进程组不存在。
    await waitGroupGone(pgid);
    assert.equal(isGroupAlive(pgid), false, "group gone after shutdown");
    // registry json 收敛:signal 终止 → killed。
    await vi.waitFor(async () => {
      const after = await readRec(tasksDir, res.task_id);
      assert.equal(after.status, "killed");
    });
  });

  it("shutdown 幂等 —— 第二次调用不 throw", async () => {
    const root = await fs.mkdtemp(join(tmpdir(), "iknow-bg-life-"));
    const tasksDir = resolveTasksDir(root);
    const manager = createBackgroundTaskManager({
      tasksDir,
      spawn: async () => spawnRealDetached() as unknown as ChildProcess,
    });
    const res = await manager.spawn({ command: "sleep 60", cwd: root });
    assert.equal(res.status, "ok");
    await manager.shutdown();
    await manager.shutdown(); // 第二次:空任务集合,不 throw
  });

  it("shutdown 清 killFallback timer —— stop 已 arm 的 timer 不补发 SIGKILL", async () => {
    vi.useFakeTimers();
    try {
      const root = await fs.mkdtemp(join(tmpdir(), "iknow-bg-life-"));
      const tasksDir = resolveTasksDir(root);
      const spawned: FakeChild[] = [];
      const manager = createBackgroundTaskManager({
        tasksDir,
        spawn: async () => {
          const child = makeFakeChild();
          spawned.push(child);
          return child as unknown as ChildProcess;
        },
      });
      const res = await manager.spawn({ command: "long", cwd: root });
      assert.equal(res.status, "ok");
      if (res.status !== "ok") return;
      await manager.stop(res.task_id); // SIGTERM + arm 2s killFallback

      const shutdownP = manager.shutdown();
      await vi.advanceTimersByTimeAsync(5_000); // 走完 shutdown 5s 宽限 + 升级
      await shutdownP;

      // fake 从不 exit、running 态持续:若 stop 的 killFallback 未被 shutdown
      // 清除,会在 t=2s 先补一发 SIGKILL,shutdown 自身 t=5s 再补一发 = 2。
      const sigkills = spawned[0]!.kill.mock.calls.filter(
        (c) => c[0] === "SIGKILL"
      );
      assert.equal(sigkills.length, 1);

      // shutdown 返回后再推进:已清空的 timer 不再触发任何信号。
      await vi.advanceTimersByTimeAsync(5_000);
      const sigkillsAfter = spawned[0]!.kill.mock.calls.filter(
        (c) => c[0] === "SIGKILL"
      );
      assert.equal(sigkillsAfter.length, 1);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ── T6 启动 stale 清扫 reapStaleTasks ────────────────────────────────────────

describe("T6 启动 stale 清扫 reapStaleTasks", () => {
  async function writeRec(
    tasksDir: string,
    rec: BackgroundTaskRecord
  ): Promise<void> {
    await fs.mkdir(tasksDir, { recursive: true });
    await fs.writeFile(
      join(tasksDir, `${rec.task_id}.json`),
      JSON.stringify(rec),
      "utf8"
    );
  }

  it("owner-dead + starttime 匹配 → 杀组 + json 标 dead + summary.reaped", async () => {
    const root = await fs.mkdtemp(join(tmpdir(), "iknow-bg-reap-"));
    const tasksDir = resolveTasksDir(root);
    const orphan = spawnRealDetached();
    const pgid = orphan.pid as number;
    const starttime = readStartTime(pgid);
    assert.ok(starttime !== undefined, "starttime resolves for live child");

    await writeRec(
      tasksDir,
      makeRecord({
        taskId: "bg-reap-orphan01",
        ownerPid: 999_999_999, // 死 PID(> pid_max,必然 ESRCH)
        pgid,
        starttime,
      })
    );

    const summary = await reapStaleTasks({ tasksDir });
    assert.deepEqual(summary.reaped, ["bg-reap-orphan01"]);
    assert.deepEqual(summary.skipped, []);

    await waitGroupGone(pgid);
    assert.equal(isGroupAlive(pgid), false, "orphan group killed");
    const rec = await readRec(tasksDir, "bg-reap-orphan01");
    assert.equal(rec.status, "dead");
  });

  it("starttime mismatch → 只标 dead、不 kill(dummy 组存活)", async () => {
    const root = await fs.mkdtemp(join(tmpdir(), "iknow-bg-reap-"));
    const tasksDir = resolveTasksDir(root);
    const dummy = spawnRealDetached();
    const pgid = dummy.pid as number;
    const realStart = readStartTime(pgid) as number;
    assert.ok(realStart > 0);

    await writeRec(
      tasksDir,
      makeRecord({
        taskId: "bg-reap-mismatch",
        ownerPid: 999_999_999,
        pgid,
        starttime: realStart + 10_000, // pgid 已被复用(另一个进程组的 starttime)
      })
    );

    const summary = await reapStaleTasks({ tasksDir });
    assert.ok(summary.reaped.includes("bg-reap-mismatch"));
    // 关键断言:starttime mismatch → 不 kill,dummy 组必须存活。
    assert.equal(isGroupAlive(pgid), true, "dummy group survives mismatch");
    const rec = await readRec(tasksDir, "bg-reap-mismatch");
    assert.equal(rec.status, "dead");
  });

  it("无 starttime → 保守跳过(json 保持 running,summary.skipped 含,组存活)", async () => {
    const root = await fs.mkdtemp(join(tmpdir(), "iknow-bg-reap-"));
    const tasksDir = resolveTasksDir(root);
    const dummy = spawnRealDetached();
    const pgid = dummy.pid as number;

    await writeRec(
      tasksDir,
      makeRecord({
        taskId: "bg-reap-nost",
        ownerPid: 999_999_999,
        pgid,
        // 无 starttime:T3 之前落盘的旧 record —— 保守政策:不 kill。
      })
    );

    const summary = await reapStaleTasks({ tasksDir });
    assert.deepEqual(summary.reaped, []);
    assert.deepEqual(summary.skipped, ["bg-reap-nost"]);
    assert.equal(isGroupAlive(pgid), true, "no-starttime record never killed");
    const rec = await readRec(tasksDir, "bg-reap-nost");
    assert.equal(rec.status, "running");
  });

  it("owner-alive(owner_pid = process.pid) → 跳过且 json 不动", async () => {
    const root = await fs.mkdtemp(join(tmpdir(), "iknow-bg-reap-"));
    const tasksDir = resolveTasksDir(root);
    const live = spawnRealDetached();
    const pgid = live.pid as number;
    const starttime = readStartTime(pgid) as number;

    await writeRec(
      tasksDir,
      makeRecord({
        taskId: "bg-reap-owneralive",
        ownerPid: process.pid, // 本进程存活 → 另一个 iknow 的 live task
        pgid,
        starttime,
      })
    );

    const summary = await reapStaleTasks({ tasksDir });
    assert.deepEqual(summary.reaped, []);
    assert.deepEqual(summary.skipped, ["bg-reap-owneralive"]);
    assert.equal(isGroupAlive(pgid), true);
    const rec = await readRec(tasksDir, "bg-reap-owneralive");
    assert.equal(rec.status, "running");
  });

  it("reap 幂等 —— 第二次 zero reaped / 已 dead json 不再改写", async () => {
    const root = await fs.mkdtemp(join(tmpdir(), "iknow-bg-reap-"));
    const tasksDir = resolveTasksDir(root);
    const orphan = spawnRealDetached();
    const pgid = orphan.pid as number;
    const starttime = readStartTime(pgid) as number;

    await writeRec(
      tasksDir,
      makeRecord({
        taskId: "bg-reap-idem",
        ownerPid: 999_999_999,
        pgid,
        starttime,
      })
    );

    const first = await reapStaleTasks({ tasksDir });
    assert.deepEqual(first.reaped, ["bg-reap-idem"]);
    await waitGroupGone(pgid);
    const mtime1 = (await fs.stat(join(tasksDir, "bg-reap-idem.json"))).mtimeMs;

    const second = await reapStaleTasks({ tasksDir });
    assert.deepEqual(second.reaped, []);
    // 已 dead 记录不再处理 → 文件未被改写
    const mtime2 = (await fs.stat(join(tasksDir, "bg-reap-idem.json"))).mtimeMs;
    assert.equal(mtime1, mtime2);
    const rec = await readRec(tasksDir, "bg-reap-idem");
    assert.equal(rec.status, "dead");
  });

  it("missing tasksDir → 空 summary,不 throw", async () => {
    const root = await fs.mkdtemp(join(tmpdir(), "iknow-bg-reap-"));
    const tasksDir = join(root, "never-created");
    const summary = await reapStaleTasks({ tasksDir });
    assert.deepEqual(summary, { reaped: [], skipped: [] });
  });

  it("tasksDir 是文件(readdir 失败)→ 不 throw,空 summary", async () => {
    const root = await fs.mkdtemp(join(tmpdir(), "iknow-bg-reap-"));
    const blocker = join(root, "blocker");
    await fs.writeFile(blocker, "file", "utf8");
    const summary = await reapStaleTasks({ tasksDir: join(blocker, "tasks") });
    assert.deepEqual(summary, { reaped: [], skipped: [] });
  });

  it("broken json record → 该条 skipped,其他记录正常处理,不 throw", async () => {
    const root = await fs.mkdtemp(join(tmpdir(), "iknow-bg-reap-"));
    const tasksDir = resolveTasksDir(root);
    await fs.mkdir(tasksDir, { recursive: true });
    await fs.writeFile(join(tasksDir, "bg-reap-bad.json"), "{bad json", "utf8");
    const orphan = spawnRealDetached();
    const pgid = orphan.pid as number;
    const starttime = readStartTime(pgid) as number;
    await writeRec(
      tasksDir,
      makeRecord({
        taskId: "bg-reap-good",
        ownerPid: 999_999_999,
        pgid,
        starttime,
      })
    );

    const summary = await reapStaleTasks({ tasksDir });
    assert.deepEqual(summary.reaped, ["bg-reap-good"]);
    assert.ok(summary.skipped.includes("bg-reap-bad"));
    await waitGroupGone(pgid);
  });

  it("reap 追加 log marker + 无 log 文件不 crash", async () => {
    const root = await fs.mkdtemp(join(tmpdir(), "iknow-bg-reap-"));
    const tasksDir = resolveTasksDir(root);
    await fs.mkdir(tasksDir, { recursive: true });

    const withLog = spawnRealDetached();
    await writeRec(
      tasksDir,
      makeRecord({
        taskId: "bg-reap-logged",
        ownerPid: 999_999_999,
        pgid: withLog.pid as number,
        starttime: readStartTime(withLog.pid as number),
        logPath: join(tasksDir, "bg-reap-logged.log"),
      })
    );
    await fs.writeFile(
      join(tasksDir, "bg-reap-logged.log"),
      "hello world",
      "utf8"
    );

    const noLog = spawnRealDetached();
    await writeRec(
      tasksDir,
      makeRecord({
        taskId: "bg-reap-nolog",
        ownerPid: 999_999_999,
        pgid: noLog.pid as number,
        starttime: readStartTime(noLog.pid as number),
      })
    );

    const summary = await reapStaleTasks({ tasksDir });
    assert.ok(summary.reaped.includes("bg-reap-logged"));
    assert.ok(summary.reaped.includes("bg-reap-nolog"));

    const logged = await fs.readFile(
      join(tasksDir, "bg-reap-logged.log"),
      "utf8"
    );
    assert.ok(logged.includes("reap"), `reap marker appended, got: ${logged}`);
    // 无 log 文件 → 吞错误,不创建文件。
    await assert.rejects(fs.stat(join(tasksDir, "bg-reap-nolog.log")));
    await waitGroupGone(withLog.pid as number);
    await waitGroupGone(noLog.pid as number);
  });

  const isRoot = typeof process.getuid === "function" && process.getuid() === 0;

  it("reap 标 dead 落盘失败 → 不 throw,该条已处理(尽力而为)", async () => {
    if (isRoot) return; // root 无视 chmod 只读,这种失败无法构造(跳过)
    const root = await fs.mkdtemp(join(tmpdir(), "iknow-bg-reap-"));
    const tasksDir = resolveTasksDir(root);
    const orphan = spawnRealDetached();
    const pgid = orphan.pid as number;
    await writeRec(
      tasksDir,
      makeRecord({
        taskId: "bg-reap-savefail",
        ownerPid: 999_999_999,
        pgid,
        starttime: readStartTime(pgid),
      })
    );
    await fs.chmod(tasksDir, 0o500); // 只读:save(写 json)失败
    try {
      const summary = await reapStaleTasks({ tasksDir });
      // kill 仍执行;标 dead 的落盘失败被吞(不 throw)。
      assert.ok(summary.reaped.includes("bg-reap-savefail"));
      await waitGroupGone(pgid);
    } finally {
      await fs.chmod(tasksDir, 0o700);
    }
  });
});

// ── T6 reap 接缝 onConversationDeleted(subscription point)───────────────────

describe("T6 reap 接缝 onConversationDeleted(subscription point)", () => {
  it("注册回调 + 迭代调用全部注册者;无内部 caller 时 calls 为空", async () => {
    const { manager } = await makeFakeManager();
    const calls: string[] = [];
    manager.registerConversationDeletedListener((id) => calls.push(`a:${id}`));
    manager.registerConversationDeletedListener((id) => calls.push(`b:${id}`));

    // 本票只留缝,不实现 lifecycle:注册本身不触发任何调用。
    assert.deepEqual(calls, []);

    // 订阅点事件发射由外部生命周期组件(#440 Not yet specified)驱动。
    manager.onConversationDeleted("conv-1");
    assert.deepEqual(calls, ["a:conv-1", "b:conv-1"]);

    manager.onConversationDeleted("conv-2");
    assert.deepEqual(calls, ["a:conv-1", "b:conv-1", "a:conv-2", "b:conv-2"]);
  });
});

// ── paths.resolveTasksDir 保持 ───────────────────────────────────────────────

describe("T6 paths.resolveTasksDir", () => {
  it("仍返回 <workspaceRoot>/.iknow/tasks", () => {
    assert.equal(resolveTasksDir("/w"), "/w/.iknow/tasks");
  });
});
