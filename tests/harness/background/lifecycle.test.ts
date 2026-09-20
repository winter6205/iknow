/**
 * BackgroundTaskManager lifecycle teardown: shutdown-level process-group reap,
 * stale cleanup at startup (reapStaleTasks), and the reap seam
 * (onConversationDeleted).
 *
 * Acceptance:
 *   1. no live child process groups after shutdown (real detached-spawn e2e)
 *   2. after host SIGKILL, restart reaps orphans and marks their json dead
 *   3. owner-alive records are skipped (multi-process must not kill each other)
 *   4. reap is idempotent (second run: zero kills / zero json changes)
 *   5. starttime hardening (ADR-0021 D1.5): mismatch -> mark dead only, no kill
 *      (dummy group survives); missing starttime -> conservative skip
 *   6. shutdown is idempotent (second call does not throw)
 *   7. reap failure never crashes (missing tasksDir / broken json -> skip + log)
 *
 * Real-process e2e needs no bwrap: a plain detached node spawn already creates
 * a real process group, and kill(-pgid, 0) raising ESRCH proves the group is
 * gone. vitest forks pool isolates subprocesses; afterEach SIGKILLs survivors.
 * Linux-only (reads /proc/<pid>/stat).
 */
import assert from "node:assert/strict";
import { afterEach, describe, it, vi } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PassThrough } from "node:stream";

import {
  createBackgroundTaskManager,
  type BackgroundTaskManager,
} from "../../../src/harness/background/manager.js";
import { reapStaleTasks } from "../../../src/harness/background/stale-reap.js";
import { resolveTasksDir } from "../../../src/harness/background/paths.js";
import { resolveProjectSessionDir } from "../../../src/session-api/store/session-store.js";
import { readProcStartTime as readStartTime } from "../../../src/harness/background/proc.js";
import type {
  BackgroundTaskRecord,
  BackgroundTaskStatus,
} from "../../../src/harness/background/registry.js";

// ── real detached process-group helpers ──────────────────────────────────────

const realChildren: ChildProcess[] = [];

function spawnRealDetached(sleepSec = 60): ChildProcess {
  const child = spawn("bash", ["-c", `sleep ${sleepSec}`], {
    stdio: "ignore",
    detached: true,
  });
  realChildren.push(child);
  return child;
}

/** Probe group liveness via kill(-pgid, 0): ESRCH means the group is gone. */
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

afterEach(() => {
  if (vi.isFakeTimers()) vi.useRealTimers();
  for (const child of realChildren) {
    const pid = child.pid;
    if (pid === undefined) continue;
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      /* ESRCH: already dead */
    }
  }
  realChildren.length = 0;
});

// ── fake ChildProcess (same shape as manager.test.ts; covers timer/subscription paths) ─

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
    tasksDir: resolveTasksDir({ dataDir: root, projectIdentityRoot: root }),
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
    tasksDir:
      opts?.tasksDir ??
      resolveTasksDir({ dataDir: root, projectIdentityRoot: root }),
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

// ── manager.shutdown process-level teardown ──────────────────────────────────

describe("T6 manager.shutdown 进程级收尾", () => {
  it("shutdown 杀真实 detached 进程组 + json 标 killed", async () => {
    const root = await fs.mkdtemp(join(tmpdir(), "iknow-bg-life-"));
    const tasksDir = resolveTasksDir({
      dataDir: root,
      projectIdentityRoot: root,
    });
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

    // Core assertion: the process group no longer exists once shutdown returns.
    await waitGroupGone(pgid);
    assert.equal(isGroupAlive(pgid), false, "group gone after shutdown");
    // Registry json converges: terminated by signal -> killed.
    await vi.waitFor(async () => {
      const after = await readRec(tasksDir, res.task_id);
      assert.equal(after.status, "killed");
    });
  });

  it("shutdown 收敛保留 spawn 时原 created_at(时间不变的实体,review-repair #502/#503 Low #7)", async () => {
    // Must fire at shutdown step 5: task still running after grace (no exit
    // event). Fake child never emits exit; fake timers (incl. Date) make the
    // clock deterministic: anchor spawn time, advance past it, then shutdown.
    // Before the fix, shutdown overwrote created_at with a fresh timestamp;
    // after it, the original spawn-time created_at must be preserved.
    vi.useFakeTimers();
    try {
      const initial = new Date("2026-08-18T00:00:00.000Z");
      vi.setSystemTime(initial);
      const root = await fs.mkdtemp(join(tmpdir(), "iknow-bg-life-"));
      const tasksDir = resolveTasksDir({
        dataDir: root,
        projectIdentityRoot: root,
      });
      const manager = createBackgroundTaskManager({
        tasksDir,
        spawn: async () => makeFakeChild() as unknown as ChildProcess,
      });
      const res = await manager.spawn({ command: "never-exits", cwd: root });
      assert.equal(res.status, "ok");
      if (res.status !== "ok") return;
      const before = await readRec(tasksDir, res.task_id);
      assert.equal(before.status, "running");
      const createdBefore = before.created_at;

      // Advance fake Date by >1ms: unfixed shutdown would stamp a new
      // created_at here; the invariant only holds post-fix.
      vi.setSystemTime(new Date("2026-08-18T00:00:05.500Z"));
      const shutdownP = manager.shutdown();
      await vi.advanceTimersByTimeAsync(5_500);
      await shutdownP;

      const after = await readRec(tasksDir, res.task_id);
      assert.equal(after.status, "killed");
      // Invariant: when shutdown writes killed, created_at keeps the spawn-time value.
      assert.equal(after.created_at, createdBefore);
    } finally {
      vi.useRealTimers();
    }
  });

  it("shutdown 幂等 —— 第二次调用不 throw", async () => {
    const root = await fs.mkdtemp(join(tmpdir(), "iknow-bg-life-"));
    const tasksDir = resolveTasksDir({
      dataDir: root,
      projectIdentityRoot: root,
    });
    const manager = createBackgroundTaskManager({
      tasksDir,
      spawn: async () => spawnRealDetached() as unknown as ChildProcess,
    });
    const res = await manager.spawn({ command: "sleep 60", cwd: root });
    assert.equal(res.status, "ok");
    await manager.shutdown();
    await manager.shutdown(); // second call: empty task set, no throw
  });

  it("shutdown 清 killFallback timer —— stop 已 arm 的 timer 不补发 SIGKILL", async () => {
    vi.useFakeTimers();
    try {
      const root = await fs.mkdtemp(join(tmpdir(), "iknow-bg-life-"));
      const tasksDir = resolveTasksDir({
        dataDir: root,
        projectIdentityRoot: root,
      });
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
      await vi.advanceTimersByTimeAsync(5_000); // exhaust shutdown's 5s grace + escalation
      await shutdownP;

      // The fake never exits, so status stays running. If stop's killFallback
      // were not cleared by shutdown, it would fire a SIGKILL at t=2s and
      // shutdown would fire its own at t=5s, giving 2 total.
      const sigkills = spawned[0]!.kill.mock.calls.filter(
        (c) => c[0] === "SIGKILL"
      );
      assert.equal(sigkills.length, 1);

      // After shutdown returns, further time advancement must trigger no more signals.
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

// ── startup stale sweep: reapStaleTasks ──────────────────────────────────────

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
    const tasksDir = resolveTasksDir({
      dataDir: root,
      projectIdentityRoot: root,
    });
    const orphan = spawnRealDetached();
    const pgid = orphan.pid as number;
    const starttime = readStartTime(pgid);
    assert.ok(starttime !== undefined, "starttime resolves for live child");

    await writeRec(
      tasksDir,
      makeRecord({
        taskId: "bg-reap-orphan01",
        ownerPid: 999_999_999, // dead PID (> pid_max, guaranteed ESRCH)
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
    const tasksDir = resolveTasksDir({
      dataDir: root,
      projectIdentityRoot: root,
    });
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
        starttime: realStart + 10_000, // pgid reused: starttime belongs to another group
      })
    );

    const summary = await reapStaleTasks({ tasksDir });
    assert.ok(summary.reaped.includes("bg-reap-mismatch"));
    // Key assertion: starttime mismatch -> no kill; the dummy group survives.
    assert.equal(isGroupAlive(pgid), true, "dummy group survives mismatch");
    const rec = await readRec(tasksDir, "bg-reap-mismatch");
    assert.equal(rec.status, "dead");
  });

  it("无 starttime → 保守跳过(json 保持 running,summary.skipped 含,组存活)", async () => {
    const root = await fs.mkdtemp(join(tmpdir(), "iknow-bg-reap-"));
    const tasksDir = resolveTasksDir({
      dataDir: root,
      projectIdentityRoot: root,
    });
    const dummy = spawnRealDetached();
    const pgid = dummy.pid as number;

    await writeRec(
      tasksDir,
      makeRecord({
        taskId: "bg-reap-nost",
        ownerPid: 999_999_999,
        pgid,
        // No starttime: record written before starttime was tracked — conservative policy: no kill.
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
    const tasksDir = resolveTasksDir({
      dataDir: root,
      projectIdentityRoot: root,
    });
    const live = spawnRealDetached();
    const pgid = live.pid as number;
    const starttime = readStartTime(pgid) as number;

    await writeRec(
      tasksDir,
      makeRecord({
        taskId: "bg-reap-owneralive",
        ownerPid: process.pid, // this process is alive -> another iknow's live task
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
    const tasksDir = resolveTasksDir({
      dataDir: root,
      projectIdentityRoot: root,
    });
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
    // Already-dead records are not reprocessed -> the file was not rewritten.
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
    const tasksDir = resolveTasksDir({
      dataDir: root,
      projectIdentityRoot: root,
    });
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
    const tasksDir = resolveTasksDir({
      dataDir: root,
      projectIdentityRoot: root,
    });
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
    // No log file -> error swallowed, no file created.
    await assert.rejects(fs.stat(join(tasksDir, "bg-reap-nolog.log")));
    await waitGroupGone(withLog.pid as number);
    await waitGroupGone(noLog.pid as number);
  });

  const isRoot = typeof process.getuid === "function" && process.getuid() === 0;

  it("reap 标 dead 落盘失败 → 不 throw,该条已处理(尽力而为)", async () => {
    if (isRoot) return; // root ignores chmod read-only; this failure can't be constructed
    const root = await fs.mkdtemp(join(tmpdir(), "iknow-bg-reap-"));
    const tasksDir = resolveTasksDir({
      dataDir: root,
      projectIdentityRoot: root,
    });
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
    await fs.chmod(tasksDir, 0o500); // read-only: the json save fails
    try {
      const summary = await reapStaleTasks({ tasksDir });
      // The kill still happens; the failed dead-status save is swallowed (no throw).
      assert.ok(summary.reaped.includes("bg-reap-savefail"));
      await waitGroupGone(pgid);
    } finally {
      await fs.chmod(tasksDir, 0o700);
    }
  });
});

// ── reap seam: onConversationDeleted (subscription point) ────────────────────

describe("T6 reap 接缝 onConversationDeleted(subscription point)", () => {
  it("注册回调 + 迭代调用全部注册者;无内部 caller 时 calls 为空", async () => {
    const { manager } = await makeFakeManager();
    const calls: string[] = [];
    manager.registerConversationDeletedListener((id) => calls.push(`a:${id}`));
    manager.registerConversationDeletedListener((id) => calls.push(`b:${id}`));

    // This task only opens the seam; registering listeners triggers nothing.
    assert.deepEqual(calls, []);

    // Firing the subscription-point event is driven by an external lifecycle component (not yet specified).
    manager.onConversationDeleted("conv-1");
    assert.deepEqual(calls, ["a:conv-1", "b:conv-1"]);

    manager.onConversationDeleted("conv-2");
    assert.deepEqual(calls, ["a:conv-1", "b:conv-1", "a:conv-2", "b:conv-2"]);
  });
});

// ── paths.resolveTasksDir ────────────────────────────────────────────────────

describe("paths.resolveTasksDir", () => {
  it("返回 <pool>/projects/<slug>/tasks，与 resolveProjectSessionDir 严格同树", () => {
    // ADR-0088: task records live in the same project tree as the session
    // pool. The slug formula and cap are shared via `computeProjectSlug` in
    // `src/shared/project-slug.ts`, so resolveTasksDir and
    // `resolveProjectSessionDir` must derive the same slug — assert a
    // cross-function equality so drift on either side fails (previously each
    // test recomputed the hash independently and stayed green while drifting).
    assert.equal(
      resolveTasksDir({ dataDir: "/home/x", projectIdentityRoot: "/repo" }),
      join(resolveProjectSessionDir("/home/x", "/repo"), "tasks")
    );
  });

  it("workspaceRoot 不再影响派生（ADR-0088 throwaway 不另开活账本）", () => {
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
});
