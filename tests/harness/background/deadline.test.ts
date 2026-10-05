/**
 * ADR-0134: finite background task deadlines.
 *
 * The contract under test (spec Success Criterion 9 / "Process tree and
 * background" matrix row): a supplied `timeout_ms` establishes ONE deadline at
 * launch; handler return, polling, log reads and stop requests never move it;
 * expiry terminates the task and reports the cause together with the T2
 * cleanup evidence. Omitting `timeout_ms` preserves the persistent-service
 * lifecycle — in particular it is not governed by the foreground 10s default.
 *
 * Assertions are discrete observable facts only (on-disk record fields, status
 * fields, cleanup evidence, process-group liveness). The only wall-clock
 * assertions use generous bounded tolerances, never exact thresholds.
 *
 * Real-process cases (bwrap-gated, same convention as bash-background.test.ts)
 * are what prove the deadline actually kills a live process group.
 */
import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, it, vi } from "vitest";

import {
  createBackgroundTaskManager,
  defaultBackgroundSpawn,
} from "../../../src/harness/background/manager.js";
import type { BackgroundTaskManager } from "../../../src/harness/background/manager.js";
import { resolveTasksDir } from "../../../src/harness/background/paths.js";
import type { BackgroundTaskRecord } from "../../../src/harness/background/registry.js";

import { canRunBwrapFence } from "../../_helpers/bwrap-capability.js";

/**
 * Real-process arms below run `defaultBackgroundSpawn`, which assembles a real
 * bwrap fence (createBwrapFence, constant `--unshare-net`) — so they need a
 * host that can really start one, not a host that merely has the binary.
 * A capability probe, not a `bwrap --version` existence check: the latter
 * admits a GHA runner (bwrap installed, no user-namespace), where the fenced
 * `sleep`/kill-tree spawn fails instead of skipping.
 */
const CAN_RUN_FENCE = canRunBwrapFence();

/** fake ChildProcess: same shape as manager.test.ts, a kill spy that never exits on its own. */
interface FakeChild {
  readonly stdin: PassThrough;
  readonly stdout: PassThrough;
  readonly stderr: PassThrough;
  readonly pid: number;
  readonly kill: ReturnType<typeof vi.fn>;
  emit: (event: string | symbol, ...args: unknown[]) => boolean;
}

function makeFakeChild(pid: number): FakeChild {
  const kill = vi.fn(() => true);
  return Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    pid,
    kill,
  }) as unknown as FakeChild;
}

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((r) => fs.rm(r, { recursive: true, force: true }))
  );
});

async function makeFakeManager(): Promise<{
  manager: BackgroundTaskManager;
  children: FakeChild[];
  tasksDir: string;
}> {
  const root = await fs.mkdtemp(join(tmpdir(), "iknow-bg-deadline-"));
  tempRoots.push(root);
  const tasksDir = resolveTasksDir({
    dataDir: root,
    projectIdentityRoot: root,
  });
  const children: FakeChild[] = [];
  const manager = createBackgroundTaskManager({
    tasksDir,
    spawn: async () => {
      const child = makeFakeChild(20_000 + children.length);
      children.push(child);
      return child as unknown as ChildProcess;
    },
  });
  return { manager, children, tasksDir };
}

/** Narrow a spawn result to the ok arm so `log_path` is reachable. */
function okResult(res: Awaited<ReturnType<BackgroundTaskManager["spawn"]>>): {
  status: "ok";
  task_id: string;
  log_path: string;
} {
  assert.equal(res.status, "ok");
  if (res.status !== "ok") throw new Error("unreachable");
  return res;
}

/**
 * Read the persisted record. The registry writes with O_TRUNC, so a read that
 * races a settle can observe a transiently empty file; retry rather than fail
 * on the writer's window (the same hazard bash-background.test.ts documents).
 */
async function readRecord(logPath: string): Promise<BackgroundTaskRecord> {
  const path = logPath.replace(/\.log$/, ".json");
  let lastError: unknown;
  for (let i = 0; i < 50; i += 1) {
    try {
      return JSON.parse(
        await fs.readFile(path, "utf8")
      ) as BackgroundTaskRecord;
    } catch (err) {
      lastError = err;
      await new Promise((r) => setTimeout(r, 20));
    }
  }
  throw lastError;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Bounded liveness probe — the only acceptable host-timer idiom here. */
async function waitFor<T>(
  probe: () => Promise<T | undefined>,
  capMs = 5_000
): Promise<T> {
  const deadline = Date.now() + capMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error("waitFor: cap exceeded");
    await sleep(20);
  }
}

// ── launch-time deadline is established once and never moves ───────────────────

describe("background 有限 deadline：启动时一次建立", () => {
  it("省略 timeout_ms → 持久服务形态：落盘无 deadline 字段，status 报 null", async () => {
    const { manager } = await makeFakeManager();
    const res = okResult(await manager.spawn({ command: "serve", cwd: "." }));
    const rec = await readRecord(res.log_path);
    assert.equal(rec.timeout_ms, undefined);
    assert.equal(rec.deadline_at, undefined);
    const st = await manager.status(res.task_id);
    assert.equal(st.deadline_at, null);
    assert.equal(st.cause, null);
  });

  it("提供 timeout_ms → 落盘 timeout_ms + deadline_at，deadline_at ≈ created_at + timeout_ms", async () => {
    const { manager } = await makeFakeManager();
    const res = okResult(
      await manager.spawn({
        command: "build",
        cwd: ".",
        timeoutMs: 60_000,
      })
    );
    const rec = await readRecord(res.log_path);
    assert.equal(rec.timeout_ms, 60_000);
    assert.ok(rec.deadline_at, "deadline_at must be persisted");
    const drift =
      Date.parse(rec.deadline_at as string) - Date.parse(rec.created_at);
    // Bounded tolerance: the deadline is launch + timeout_ms, ±1s of spawn
    // bookkeeping (the record is written after the process is spawned).
    assert.ok(
      Math.abs(drift - 60_000) < 1_000,
      `deadline drift ${drift}ms must be ~60000ms`
    );
    const st = await manager.status(res.task_id);
    assert.equal(st.deadline_at, rec.deadline_at);
  });

  it("反复 poll（status / output）不重置时钟：deadline_at 逐次字节相同", async () => {
    const { manager, children } = await makeFakeManager();
    const res = okResult(
      await manager.spawn({
        command: "build",
        cwd: ".",
        timeoutMs: 120,
      })
    );
    const first = (await readRecord(res.log_path)).deadline_at;
    // Poll well past the deadline's arming window; a resetting implementation
    // would move deadline_at on each read.
    const seen = new Set<string | undefined>();
    for (let i = 0; i < 6; i += 1) {
      await manager.status(res.task_id);
      await manager.output(res.task_id);
      seen.add((await readRecord(res.log_path)).deadline_at);
    }
    assert.deepEqual([...seen], [first]);
    children[0]!.emit("exit", null, "SIGTERM");
  });
});

// ── expiry terminates the task and reports cause + cleanup evidence ────────────

describe("background 有限 deadline：到期终止", () => {
  it("到期 → 进程组收到 SIGTERM，cause=deadline_expired，终态只迁移一次", async () => {
    const { manager, children } = await makeFakeManager();
    const res = okResult(
      await manager.spawn({
        command: "build",
        cwd: ".",
        timeoutMs: 60,
      })
    );
    await waitFor(async () =>
      children[0]!.kill.mock.calls.some((c) => c[0] === "SIGTERM")
        ? true
        : undefined
    );
    const st = await manager.status(res.task_id);
    assert.equal(st.cause, "deadline_expired");
    // The teardown is a request; the terminal transition happens on exit.
    children[0]!.emit("exit", null, "SIGTERM");
    const settled = await waitFor(async () => {
      const s = await manager.status(res.task_id);
      return s.status === "killed" ? s : undefined;
    });
    assert.equal(settled.status, "killed");
    assert.equal(settled.cause, "deadline_expired");
    const rec = await readRecord(res.log_path);
    assert.equal(rec.status, "killed");
    assert.equal(rec.termination_cause, "deadline_expired");
  });

  it.skipIf(!CAN_RUN_FENCE)(
    "真实进程组：有限 deadline 到期后进程组确实消失（不是只改了状态字段）",
    async () => {
      const root = await fs.mkdtemp(join(tmpdir(), "iknow-bg-deadline-real-"));
      tempRoots.push(root);
      const manager = createBackgroundTaskManager({
        tasksDir: resolveTasksDir({ dataDir: root, projectIdentityRoot: root }),
        spawn: defaultBackgroundSpawn,
      });
      const res = okResult(
        await manager.spawn({
          command: "sleep 300",
          cwd: root,
          workspaceRoot: root,
          timeoutMs: 500,
        })
      );
      const rec = await readRecord(res.log_path);
      const pgid = rec.pgid;
      assert.doesNotThrow(() => process.kill(-pgid, 0));

      const settled = await waitFor(async () => {
        const s = await manager.status(res.task_id);
        return s.status !== "running" ? s : undefined;
      }, 8_000);
      assert.equal(settled.cause, "deadline_expired");
      // Physical fact: the whole process group is gone.
      await waitFor(async () => {
        try {
          process.kill(-pgid, 0);
          return undefined;
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === "ESRCH") return true;
          throw e;
        }
      });
      // Truthful cleanup evidence from the T2 discriminated result.
      await waitFor(async () =>
        manager
          .status(res.task_id)
          .then((s) => (s.cleanup.state === "not_started" ? undefined : s))
      );
      const final = await manager.status(res.task_id);
      assert.equal(final.cleanup.state, "confirmed_stopped");
    },
    20_000
  );
});

// ── omission preserves the persistent-service lifecycle ──────────────────────

describe("background 省略 timeout_ms：持久服务不被前台 10s 默认杀掉", () => {
  it.skipIf(!CAN_RUN_FENCE)(
    "无 timeout_ms 的长驻进程存活过 10 秒前台默认（且从未建立 deadline）",
    async () => {
      const root = await fs.mkdtemp(join(tmpdir(), "iknow-bg-service-"));
      tempRoots.push(root);
      const tasksDir = resolveTasksDir({
        dataDir: root,
        projectIdentityRoot: root,
      });
      const manager = createBackgroundTaskManager({
        tasksDir,
        spawn: defaultBackgroundSpawn,
      });
      const res = okResult(
        await manager.spawn({
          command: "sleep 300",
          cwd: root,
          workspaceRoot: root,
        })
      );
      const rec = await readRecord(res.log_path);
      assert.equal(rec.deadline_at, undefined);
      const pgid = rec.pgid;
      await sleep(10_500);
      const st = await manager.status(res.task_id);
      assert.equal(st.status, "running");
      assert.equal(st.cause, null);
      assert.equal(st.deadline_at, null);
      assert.doesNotThrow(() => process.kill(-pgid, 0));
      await manager.stop(res.task_id);
      await waitFor(async () => {
        try {
          process.kill(-pgid, 0);
          return undefined;
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === "ESRCH") return true;
          throw e;
        }
      });
    },
    25_000
  );
});

// ── concurrency: independent deadlines ────────────────────────────────────────

describe("background 并发任务：各自独立 deadline", () => {
  it.skipIf(!CAN_RUN_FENCE)(
    "短 deadline 的任务被杀，长 deadline 的任务仍在运行",
    async () => {
      const root = await fs.mkdtemp(join(tmpdir(), "iknow-bg-conc-deadline-"));
      tempRoots.push(root);
      const manager = createBackgroundTaskManager({
        tasksDir: resolveTasksDir({ dataDir: root, projectIdentityRoot: root }),
        spawn: defaultBackgroundSpawn,
      });
      const base = {
        cwd: root,
        workspaceRoot: root,
        command: "sleep 300",
      };
      const short = await manager.spawn({ ...base, timeoutMs: 400 });
      const long = await manager.spawn({ ...base, timeoutMs: 60_000 });

      const shortFinal = await waitFor(async () => {
        const s = await manager.status(short.task_id);
        return s.status !== "running" ? s : undefined;
      }, 8_000);
      assert.equal(shortFinal.cause, "deadline_expired");
      const longNow = await manager.status(long.task_id);
      assert.equal(longNow.status, "running");
      assert.equal(longNow.cause, null);
      await manager.stop(long.task_id);
    },
    20_000
  );
});

// ── stop / timeout / exit race: one terminal transition ───────────────────────

describe("background stop / timeout / exit 竞态：只结算一次", () => {
  it("自然 exit 先到 → cause=exit，deadline 定时器不得事后改写终态", async () => {
    const { manager, children } = await makeFakeManager();
    const res = okResult(
      await manager.spawn({
        command: "quick",
        cwd: ".",
        timeoutMs: 80,
      })
    );
    children[0]!.emit("exit", 0, null);
    const settled = await waitFor(async () => {
      const s = await manager.status(res.task_id);
      return s.status === "exited" ? s : undefined;
    });
    assert.equal(settled.cause, "exit");
    // Let the (correctly cleared) deadline window pass; the terminal state and
    // its cause must be unchanged.
    await sleep(300);
    const after = await manager.status(res.task_id);
    assert.equal(after.status, "exited");
    assert.equal(after.cause, "exit");
    const rec = await readRecord(res.log_path);
    assert.equal(rec.status, "exited");
    assert.equal(rec.termination_cause, "exit");
    assert.equal(
      children[0]!.kill.mock.calls.filter((c) => c[0] === "SIGTERM").length,
      0,
      "an exited task must not be signalled by its own deadline"
    );
  });

  it("stop 与 deadline 同时竞争 → 只有一个终态，cause 稳定不变", async () => {
    const { manager, children } = await makeFakeManager();
    const res = okResult(
      await manager.spawn({
        command: "build",
        cwd: ".",
        timeoutMs: 60,
      })
    );
    await manager.stop(res.task_id);
    await waitFor(async () =>
      children[0]!.kill.mock.calls.some((c) => c[0] === "SIGTERM")
        ? true
        : undefined
    );
    // Let the deadline window elapse too; neither side may claim a second
    // terminal transition.
    await sleep(200);
    children[0]!.emit("exit", null, "SIGTERM");
    const settled = await waitFor(async () => {
      const s = await manager.status(res.task_id);
      return s.status === "killed" ? s : undefined;
    });
    const cause = settled.cause;
    assert.ok(
      cause === "stop_requested" || cause === "deadline_expired",
      `unexpected cause ${cause}`
    );
    await sleep(200);
    const after = await manager.status(res.task_id);
    assert.equal(after.status, "killed");
    assert.equal(after.cause, cause, "the first terminal cause must win");
    const rec = await readRecord(res.log_path);
    assert.equal(rec.termination_cause, cause);
    // One SIGTERM round per stop request, never a re-escalation from the race.
    assert.ok(
      children[0]!.kill.mock.calls.filter((c) => c[0] === "SIGTERM").length <= 2
    );
  });

  it("并发重复 stop 在有 deadline 时仍幂等（SIGTERM 轮次有界）", async () => {
    const { manager, children } = await makeFakeManager();
    const res = okResult(
      await manager.spawn({
        command: "build",
        cwd: ".",
        timeoutMs: 5_000,
      })
    );
    await Promise.allSettled([
      manager.stop(res.task_id),
      manager.stop(res.task_id),
    ]);
    const sigterms = children[0]!.kill.mock.calls.filter(
      (c) => c[0] === "SIGTERM"
    ).length;
    assert.ok(sigterms >= 1 && sigterms <= 2, `sigterm rounds=${sigterms}`);
    children[0]!.emit("exit", null, "SIGTERM");
  });
});

// ── invalid input: typed failure before any process / record / timer ──────────

describe("background 非法 timeout_ms：前置失败不留痕", () => {
  const invalid: ReadonlyArray<readonly [string, number]> = [
    ["zero", 0],
    ["negative", -1],
    ["fractional", 1.5],
    ["non-finite", Number.POSITIVE_INFINITY],
    ["NaN", Number.NaN],
    ["overflowing", Number.MAX_SAFE_INTEGER + 2],
  ];

  for (const [label, value] of invalid) {
    it(`${label} → spawn_validation_failed，不起进程、不落盘、不建定时器`, async () => {
      const { manager, children, tasksDir } = await makeFakeManager();
      const res = await manager.spawn({
        command: "build",
        cwd: ".",
        timeoutMs: value,
      });
      assert.equal(res.status, "spawn_error");
      assert.equal(res.task_id, "", "no task id may be allocated");
      if (res.status === "spawn_error") {
        assert.equal(res.error.kind, "spawn_validation_failed");
      }
      assert.equal(children.length, 0, "spawn factory must not be called");
      assert.deepEqual(
        await fs.readdir(tasksDir).catch(() => [] as string[]),
        []
      );
    });
  }
});
