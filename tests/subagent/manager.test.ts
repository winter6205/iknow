/**
 * #356 T2 — SubAgentManager 单测(fake spawn 工厂,不真启子进程)。
 *
 * 覆盖 10 fixture(票面):
 *   1. spawn → stdout 合法 envelope → completed
 *   2. spawn → exit code=1 → crashed
 *   3. spawn → stdout 非法 JSON → protocolError
 *   4. spawn → stdout 超 20000 result → truncated envelope
 *   5. spawn → 'error' ENOENT → crashed
 *   6. shutdown:两 running child 收 SIGTERM;fake 不退出 → 兜底 SIGKILL
 *   7. queryBuffer 四态覆盖(not_found / running / completed / failed)
 *   8. waitFor timeout:fake 不 emit → reject reason=timeout
 *   9. drainCompleted 只列举 completed(running / failed 不出现)
 *  10. SubAgentDefinition 本地定义 typecheck
 *
 * fake ChildProcess 构造沿用 tests/harness/lsp/client.test.ts 先例:
 * EventEmitter + PassThrough stdin/stdout/stderr + kill spy。
 */
import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { describe, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";

import {
  createSubAgentManager,
  MAX_CONCURRENT_WORKERS,
  SubAgentAbortError,
  SubAgentCapacityError,
  SubAgentWaitTimeoutError,
} from "../../src/harness/subagent/manager.ts";
import type {
  QueryBufferResult,
  SubAgentDefinition,
  SubAgentManager,
} from "../../src/harness/subagent/manager.ts";
import type {
  SubAgentEnvelope,
  WorkerEnvelope,
} from "../../src/harness/subagent/envelope.ts";

// ── fake ChildProcess 工厂 ────────────────────────────────────────────────────

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

function makeFakeChild(): FakeChild {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const kill = vi.fn(() => true);
  return Object.assign(new EventEmitter(), {
    stdin,
    stdout,
    stderr,
    pid: 12345,
    kill,
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
  }) as unknown as FakeChild;
}

/** 收 wrapper:记录最近一次 spawn 的 child + 入参,供测试 emit。
 *  `opts.taskTimeoutMs` 透传给 createSubAgentManager (T2 三层缺省链中段)。 */
function makeHarness(
  opts: {
    readonly taskTimeoutMs?: number;
    readonly maxConcurrentWorkers?: number;
  } = {}
) {
  const spawned: FakeChild[] = [];
  const spawnCalls: {
    def: SubAgentDefinition;
    taskId: string;
    payload: WorkerEnvelope;
  }[] = [];
  const manager = createSubAgentManager({
    spawn: (def, taskId, payload) => {
      const child = makeFakeChild();
      spawned.push(child);
      spawnCalls.push({ def, taskId, payload });
      return child as unknown as ChildProcess;
    },
    ...(opts.taskTimeoutMs !== undefined
      ? { taskTimeoutMs: opts.taskTimeoutMs }
      : {}),
    ...(opts.maxConcurrentWorkers !== undefined
      ? { maxConcurrentWorkers: opts.maxConcurrentWorkers }
      : {}),
  });
  return { manager, spawned, spawnCalls };
}

describe("SubAgentManager concurrency capacity", () => {
  it("default capacity is 15 and the 16th spawn fails immediately", () => {
    assert.equal(MAX_CONCURRENT_WORKERS, 15);
    const { manager } = makeHarness();

    for (let i = 0; i < MAX_CONCURRENT_WORKERS; i++) {
      assert.doesNotThrow(() => manager.spawn({ task: `default-${i}` }));
    }
    assert.throws(
      () => manager.spawn({ task: "default-overflow" }),
      (error: unknown) => {
        assert.ok(error instanceof SubAgentCapacityError);
        assert.equal(error.active, 15);
        assert.match(error.message, /15\/15/);
        return true;
      }
    );
  });

  it("uses an injected smaller capacity without queueing", () => {
    const { manager } = makeHarness({ maxConcurrentWorkers: 2 });

    manager.spawn({ task: "first" });
    manager.spawn({ task: "second" });
    assert.throws(
      () => manager.spawn({ task: "overflow" }),
      (error: unknown) => {
        assert.ok(error instanceof SubAgentCapacityError);
        assert.equal(error.active, 2);
        assert.match(error.message, /2\/2/);
        return true;
      }
    );
  });

  // Spec Layer 3 item 7 + SC3: the rejection is observable as the exact
  // active/max pair, and the surplus request starts NOTHING — no child is
  // spawned for the rejected call (no queue, no silent backlog).
  it("rejecting at capacity spawns no extra child", () => {
    const { manager, spawned } = makeHarness({ maxConcurrentWorkers: 2 });

    manager.spawn({ task: "first" });
    manager.spawn({ task: "second" });
    const before = spawned.length;

    assert.throws(
      () => manager.spawn({ task: "third" }),
      SubAgentCapacityError
    );
    assert.equal(spawned.length, before);
  });

  it("same-turn batch up to max all start, and the (max+1)-th is the only failure", () => {
    // Spec Layer 3 item 8 + input-contract row "same-turn multi-spawn ≤ max":
    // dispatching a whole batch in one turn is the supported shape — every
    // call up to the cap is admitted, and the boundary is exactly one over.
    const cap = 4;
    const { manager, spawned } = makeHarness({ maxConcurrentWorkers: cap });

    for (let i = 0; i < cap; i++) {
      assert.doesNotThrow(() => manager.spawn({ task: `batch-${i}` }));
    }
    assert.equal(spawned.length, cap);

    assert.throws(
      () => manager.spawn({ task: "batch-over" }),
      (error: unknown) => {
        assert.ok(error instanceof SubAgentCapacityError);
        assert.equal(error.active, cap);
        assert.equal(error.maxConcurrentWorkers, cap);
        assert.match(error.message, new RegExp(`${cap}/${cap}`));
        return true;
      }
    );
    assert.equal(spawned.length, cap);
  });

  it("falls back to the default for an illegal injected capacity", () => {
    const { manager } = makeHarness({ maxConcurrentWorkers: 0 });
    for (let i = 0; i < MAX_CONCURRENT_WORKERS; i++) {
      assert.doesNotThrow(() => manager.spawn({ task: `fallback-${i}` }));
    }
    assert.throws(() => manager.spawn({ task: "fallback-overflow" }));
  });
});

function okEnvelope(result = "ok result"): SubAgentEnvelope {
  return { status: "ok", summary: "done", result };
}

function emitEnvelope(child: FakeChild, env: SubAgentEnvelope): void {
  child.stdout.write(JSON.stringify(env) + "\n");
  child.emit("exit", 0, null);
}

async function emitCrashAndWait(
  manager: SubAgentManager,
  child: FakeChild,
  taskId: string,
  code: number | null,
  signal: NodeJS.Signals | null
): Promise<SubAgentEnvelope> {
  child.stderr.end();
  child.emit("exit", code, signal);
  return manager.waitFor(taskId, 1000);
}

// ── fixture 1:completed ───────────────────────────────────────────────────────

describe("SubAgentManager spawn → completed", () => {
  it("valid envelope on stdout → completed, queryBuffer returns envelope", () => {
    const { manager, spawned } = makeHarness();
    const { taskId } = manager.spawn({
      systemPrompt: "be concise",
      model: "opus",
    });
    assert.ok(taskId.length > 0);

    emitEnvelope(spawned[0]!, okEnvelope("hello"));

    const q = manager.queryBuffer(taskId);
    assert.equal(q.status, "ok");
    assert.equal((q as SubAgentEnvelope).result, "hello");
  });

  it("writes a newline-JSON WorkerEnvelope payload to stdin then ends it", () => {
    const { manager, spawnCalls } = makeHarness();
    const def: SubAgentDefinition = {
      systemPrompt: "p",
      disallowedTools: ["edit_file"],
      model: "opus",
      maxTurns: 5,
      timeoutMs: 30000,
    };
    manager.spawn(def);
    assert.equal(spawnCalls.length, 1);
    const { payload, taskId } = spawnCalls[0]!;
    // taskId 是 manager 内部 randomUUID 唯一真值(SC3)
    assert.ok(taskId.length > 0);
    assert.equal(payload.task, "");
    // #357 T1 (承 #365): def 缺席 sandboxRoot → manager 以父 sandboxRoot 补齐。
    // makeHarness 不传 sandboxRoot opt → fallback = realpathSync(process.cwd())。
    // 缺省继承父根而非 process.cwd() 字面值(SC8 锁定行为变更)。
    assert.equal(payload.sandboxRoot, realpathSync(process.cwd()));
    assert.equal(payload.systemPrompt, "p");
    assert.deepEqual(payload.disallowedTools, ["edit_file"]);
    assert.equal(payload.model, "opus");
    assert.equal(payload.maxTurns, 5);
    assert.equal(payload.timeoutMs, 30000);
  });

  it("worker 侧读 stdin 到 EOF 拿到整条 payload 行 (真 worker 的 for-await 契约)", async () => {
    const { manager, spawned, spawnCalls } = makeHarness();
    manager.spawn({ systemPrompt: "p", model: "opus" });
    const chunks: string[] = [];
    // 真 worker 的消费形态:for-await 到 EOF。manager 不 end() stdin 时这里
    // 永远收不到 EOF,worker 永远不开跑(T8 live e2e 的挂死形态)。
    for await (const chunk of spawned[0]!.stdin) chunks.push(String(chunk));
    const raw = chunks.join("");
    assert.equal(raw.endsWith("\n"), true, "payload 必须以换行收尾");
    assert.deepEqual(JSON.parse(raw.trim()), spawnCalls[0]!.payload);
  });

  it("waitFor resolves envelope on completed", async () => {
    const { manager, spawned } = makeHarness();
    const { taskId } = manager.spawn({});
    // 先同步标 completed(emit 在 data/exit 同步派发,waitFor 首查即收敛)
    emitEnvelope(spawned[0]!, okEnvelope("w"));
    const env = await manager.waitFor(taskId, 1000);
    assert.equal(env.status, "ok");
    assert.equal(env.result, "w");
  });

  it("multiple stdout envelopes → last one wins", () => {
    const { manager, spawned } = makeHarness();
    const { taskId } = manager.spawn({});
    spawned[0]!.stdout.write(JSON.stringify(okEnvelope("first")) + "\n");
    spawned[0]!.stdout.write(JSON.stringify(okEnvelope("second")) + "\n");
    spawned[0]!.emit("exit", 0, null);
    const q = manager.queryBuffer(taskId);
    assert.equal((q as SubAgentEnvelope).result, "second");
  });
});

// ── fixture 2 / 5:failed(crashed) ─────────────────────────────────────────────

describe("SubAgentManager spawn → crashed", () => {
  it("exit code=1 → failed reason=crashed with summary", async () => {
    const { manager, spawned } = makeHarness();
    const { taskId } = manager.spawn({});
    const q = await emitCrashAndWait(manager, spawned[0]!, taskId, 1, null);
    assert.equal(q.status, "failed");
    if (q.status === "failed") {
      assert.equal(q.reason, "crashed");
      assert.match(q.summary, /worker exit code=1 signal=null/);
    }
  });

  it("stderr before exit → crashed summary includes the bounded stderr tail", async () => {
    const { SUMMARY_LIMIT } =
      await import("../../src/harness/subagent/envelope.ts");
    const { manager, spawned } = makeHarness();
    const { taskId } = manager.spawn({});
    // 2500-char body sits inside a 4096 window but outside SUMMARY_LIMIT=2000,
    // so DROPME surviving would mean the drain still uses a second magic cap.
    const stderr = "DROPME\n" + "x".repeat(2_500) + "\nKEEPME\n";

    spawned[0]!.stderr.write(stderr);
    assert.equal(spawned[0]!.stderr.readableLength, 0);
    spawned[0]!.stderr.end();
    spawned[0]!.emit("exit", 2, null);

    const q = await manager.waitFor(taskId, 1000);
    assert.equal(q.status, "failed");
    if (q.status === "failed") {
      assert.match(q.summary, /worker exit code=2 signal=null/);
      assert.match(q.summary, /KEEPME/);
      assert.doesNotMatch(q.summary, /DROPME/);
      assert.ok(q.summary.length <= SUMMARY_LIMIT + 80);
    }
  });

  it("empty stderr → crashed summary remains unchanged", async () => {
    const { manager, spawned } = makeHarness();
    const { taskId } = manager.spawn({});
    const q = await emitCrashAndWait(manager, spawned[0]!, taskId, 1, null);

    assert.equal(q.status, "failed");
    if (q.status === "failed") {
      assert.equal(q.summary, "worker exit code=1 signal=null");
    }
  });

  it("killed by signal → failed reason=crashed", async () => {
    const { manager, spawned } = makeHarness();
    const { taskId } = manager.spawn({});
    const q = await emitCrashAndWait(
      manager,
      spawned[0]!,
      taskId,
      null,
      "SIGTERM"
    );
    assert.equal(q.status, "failed");
    if (q.status === "failed") {
      assert.equal(q.reason, "crashed");
      assert.match(q.summary, /signal=SIGTERM/);
    }
  });

  it("spawn factory throw → failed reason=crashed", () => {
    const manager = createSubAgentManager({
      spawn: () => {
        throw new Error("ENOENT: no iknow bin");
      },
    });
    const { taskId } = manager.spawn({});
    const q = manager.queryBuffer(taskId);
    assert.equal(q.status, "failed");
    if (q.status === "failed") {
      assert.equal(q.reason, "crashed");
      assert.match(q.summary, /spawn failed: ENOENT/);
    }
  });

  it("child 'error' ENOENT → failed reason=crashed summary=err.message", async () => {
    const { manager, spawned } = makeHarness();
    const { taskId } = manager.spawn({});
    spawned[0]!.stderr.end();
    spawned[0]!.emit(
      "error",
      Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" })
    );
    const q = await manager.waitFor(taskId, 1000);
    assert.equal(q.status, "failed");
    if (q.status === "failed") {
      assert.equal(q.reason, "crashed");
      assert.equal(q.summary, "spawn ENOENT");
    }
  });
});

// ── fixture 3:protocolError ───────────────────────────────────────────────────

describe("SubAgentManager clean exit without envelope", () => {
  it("exit code=0 without envelope → failed protocolError and releases the slot", () => {
    const { manager, spawned } = makeHarness();
    const { taskId } = manager.spawn({});

    spawned[0]!.emit("exit", 0, null);

    const q = manager.queryBuffer(taskId);
    assert.equal(q.status, "failed");
    if (q.status === "failed") {
      assert.equal(q.reason, "protocolError");
      assert.match(q.summary, /without envelope/);
    }
    assert.deepEqual(manager.listActive(), []);
  });

  it("four clean exits without envelopes release capacity for a fifth spawn", () => {
    const { manager, spawned } = makeHarness();
    for (let i = 0; i < 4; i++) manager.spawn({});

    for (const child of spawned) child.emit("exit", 0, null);

    assert.doesNotThrow(() => manager.spawn({}));
  });
});

describe("SubAgentManager spawn → protocolError", () => {
  it("invalid JSON on stdout → failed reason=protocolError", () => {
    const { manager, spawned } = makeHarness();
    const { taskId } = manager.spawn({});
    spawned[0]!.stdout.write("{not json\n");
    const q = manager.queryBuffer(taskId);
    assert.equal(q.status, "failed");
    if (q.status === "failed") {
      assert.equal(q.reason, "protocolError");
      assert.match(q.summary, /subagent envelope protocol error/);
    }
  });

  it("schema-invalid envelope (missing required) → failed reason=protocolError", () => {
    const { manager, spawned } = makeHarness();
    const { taskId } = manager.spawn({});
    spawned[0]!.stdout.write(
      JSON.stringify({ status: "ok", summary: "s" }) + "\n"
    ); // 缺 result
    const q = manager.queryBuffer(taskId);
    assert.equal(q.status, "failed");
    if (q.status === "failed") assert.equal(q.reason, "protocolError");
  });
});

// ── fixture 4:truncation ──────────────────────────────────────────────────────

describe("SubAgentManager envelope truncation (SC10)", () => {
  it("result > 20000 chars → short folded envelope in buffer", () => {
    const { manager, spawned } = makeHarness();
    const { taskId } = manager.spawn({});
    emitEnvelope(spawned[0]!, {
      status: "ok",
      summary: "completed with a long report " + "x".repeat(25000),
      result: "x".repeat(25000),
      fileRefs: ["src/changed.ts"],
      stop_reason: "completed",
    });
    const q = manager.queryBuffer(taskId) as SubAgentEnvelope;
    assert.equal(q.status, "ok");
    assert.equal(q.truncated, true);
    assert.equal(q.totalLength, 25000);
    assert.ok(q.summary.length < 25000);
    assert.ok(q.result.length < 20000);
    assert.notEqual(q.result, "x".repeat(25000));
    assert.match(q.result, /src\/changed\.ts/);
    assert.match(q.result, /report folded/);
    assert.equal(q.stop_reason, "completed");
  });
});

// ── fixture 7:queryBuffer 四态 ────────────────────────────────────────────────

describe("SubAgentManager queryBuffer 四态 (SC5)", () => {
  it("unknown taskId → not_found", () => {
    const { manager } = makeHarness();
    assert.deepEqual(manager.queryBuffer("nope"), { status: "not_found" });
  });

  it("spawned but no stdout/exit → running", () => {
    const { manager } = makeHarness();
    const { taskId } = manager.spawn({});
    assert.deepEqual(manager.queryBuffer(taskId), { status: "running" });
  });

  it("completed → full envelope", () => {
    const { manager, spawned } = makeHarness();
    const { taskId } = manager.spawn({});
    emitEnvelope(spawned[0]!, okEnvelope("r"));
    const q = manager.queryBuffer(taskId);
    assert.equal(q.status, "ok");
    assert.equal((q as SubAgentEnvelope).result, "r");
  });

  it("failed → {status:failed, reason, summary}", async () => {
    const { manager, spawned } = makeHarness();
    const { taskId } = manager.spawn({});
    spawned[0]!.stderr.end();
    spawned[0]!.emit("exit", 2, null);
    await manager.waitFor(taskId, 1000);
    const q = manager.queryBuffer(taskId);
    assert.equal(q.status, "failed");
    if (q.status === "failed") assert.equal(q.reason, "crashed");
  });
});

// ── fixture 6b:per-task timeout (High #2 / SC6 / 假设 14) ────────────────────────

describe("SubAgentManager per-task timeout (def.timeoutMs)", () => {
  it("timeoutMs 到期且 child 未完成 → failed reason=timeout + SIGTERM", async () => {
    vi.useFakeTimers();
    try {
      const { manager, spawned } = makeHarness();
      const { taskId } = manager.spawn({ timeoutMs: 50 });
      // 初始 running
      assert.deepEqual(manager.queryBuffer(taskId), { status: "running" });

      // 50ms 后 timer 触发 → failed reason=timeout + SIGTERM
      await vi.advanceTimersByTimeAsync(50);
      const q = manager.queryBuffer(taskId);
      assert.equal(q.status, "failed");
      if (q.status === "failed") {
        assert.equal(q.reason, "timeout");
        assert.match(q.summary, /timeout after 50ms/);
      }
      // child 收到 SIGTERM(第一击)
      const signals = spawned[0]!.kill.mock.calls.map((c) => c[0]);
      assert.deepEqual(signals, ["SIGTERM"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("child 以 SIGTERM 退出不覆盖 timeout envelope(保持 reason=timeout)", async () => {
    vi.useFakeTimers();
    try {
      const { manager, spawned } = makeHarness();
      const { taskId } = manager.spawn({ timeoutMs: 50 });
      await vi.advanceTimersByTimeAsync(50);
      // timeout 已标 failed;child 随后以信号退出 → 不覆盖为 crashed
      spawned[0]!.emit("exit", null, "SIGTERM");
      const q = manager.queryBuffer(taskId);
      assert.equal(q.status, "failed");
      if (q.status === "failed") {
        assert.equal(q.reason, "timeout");
        assert.match(q.summary, /timeout after 50ms/);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("timeout 前 child 正常完成 → 不标 timeout,timer 被 exit handler 清理", async () => {
    vi.useFakeTimers();
    try {
      const { manager, spawned } = makeHarness();
      const { taskId } = manager.spawn({ timeoutMs: 50 });
      emitEnvelope(spawned[0]!, okEnvelope("fast done"));
      assert.equal(
        (manager.queryBuffer(taskId) as SubAgentEnvelope).status,
        "ok"
      );
      // 越过 timeout 窗口:已 completed,timer 回调应被 exit 清理 / 不再覆写
      await vi.advanceTimersByTimeAsync(100);
      const q = manager.queryBuffer(taskId);
      assert.equal(q.status, "ok");
      assert.equal((q as SubAgentEnvelope).result, "fast done");
    } finally {
      vi.useRealTimers();
    }
  });

  it("shutdown 清掉 timeoutTimer,timeout 不再触发 SIGTERM(只 shutdown 自己的 SIGTERM)", async () => {
    vi.useFakeTimers();
    try {
      const { manager, spawned } = makeHarness();
      const { taskId } = manager.spawn({ timeoutMs: 50 });
      // 立即 shutdown(timeoutTimer 尚未到期)
      const done = manager.shutdown();
      // 越过 50ms timeout 窗口 + shutdown 5s 兜底
      await vi.advanceTimersByTimeAsync(5000);
      await done;
      // 若 timeoutTimer 未清,50ms 时会再发一次 SIGTERM。
      // shutdown 兜底会再发 SIGKILL(fake 不退),不计入 SIGTERM 计数。
      const sigtermCount = spawned[0]!.kill.mock.calls.filter(
        (c) => c[0] === "SIGTERM"
      ).length;
      assert.equal(sigtermCount, 1);
      assert.deepEqual(manager.queryBuffer(taskId), { status: "not_found" });
    } finally {
      vi.useRealTimers();
    }
  });
});

// ── #358 T2: per-task 三层缺省链 def.timeoutMs ?? opts.taskTimeoutMs ?? 常量 ──

describe("SubAgentManager per-task 缺省链 (T2: def ?? taskTimeoutMs ?? 7200s)", () => {
  it("层 1: def.timeoutMs=111 优先 → 111ms 触发 SIGTERM (不 shell 到下方层)", async () => {
    vi.useFakeTimers();
    try {
      const { manager, spawned } = makeHarness({ taskTimeoutMs: 222 });
      const { taskId } = manager.spawn({ timeoutMs: 111 });
      await vi.advanceTimersByTimeAsync(111);
      const q = manager.queryBuffer(taskId);
      assert.equal(q.status, "failed");
      if (q.status === "failed") {
        assert.equal(q.reason, "timeout");
        assert.match(q.summary, /timeout after 111ms/);
      }
      const signals = spawned[0]!.kill.mock.calls.map((c) => c[0]);
      assert.deepEqual(signals, ["SIGTERM"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("层 2: 无 def.timeoutMs + opts.taskTimeoutMs=222 → 222ms 触发 SIGTERM", async () => {
    vi.useFakeTimers();
    try {
      const { manager, spawned } = makeHarness({ taskTimeoutMs: 222 });
      const { taskId } = manager.spawn({});
      await vi.advanceTimersByTimeAsync(222);
      const q = manager.queryBuffer(taskId);
      assert.equal(q.status, "failed");
      if (q.status === "failed") {
        assert.equal(q.reason, "timeout");
        assert.match(q.summary, /timeout after 222ms/);
      }
      const signals = spawned[0]!.kill.mock.calls.map((c) => c[0]);
      assert.deepEqual(signals, ["SIGTERM"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("层 3: 前两层皆缺席 → 默认 7_200_000ms (固定常量, 不 shell 到任何 env)", async () => {
    vi.useFakeTimers();
    try {
      const { manager, spawned } = makeHarness();
      const { taskId } = manager.spawn({});
      assert.deepEqual(manager.queryBuffer(taskId), { status: "running" });
      await vi.advanceTimersByTimeAsync(7_200_000);
      const q = manager.queryBuffer(taskId);
      assert.equal(q.status, "failed");
      if (q.status === "failed") {
        assert.equal(q.reason, "timeout");
        assert.match(q.summary, /timeout after 7200000ms/);
      }
      const signals = spawned[0]!.kill.mock.calls.map((c) => c[0]);
      assert.deepEqual(signals, ["SIGTERM"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("waitFor timeout rejects while the child remains live", async () => {
    vi.useFakeTimers();
    try {
      const { manager } = makeHarness({ taskTimeoutMs: 1000 });
      const { taskId } = manager.spawn({});
      const pending = manager.waitFor(taskId, 50);
      const rejected = assert.rejects(pending, SubAgentWaitTimeoutError);
      await vi.advanceTimersByTimeAsync(100);
      await rejected;
    } finally {
      vi.useRealTimers();
    }
  });
});

// ── fixture 8:waitFor timeout ─────────────────────────────────────────────────

describe("SubAgentManager waitFor timeout", () => {
  it("rejects with reason=timeout when no terminal event within timeoutMs", async () => {
    const { manager } = makeHarness();
    const { taskId } = manager.spawn({});
    await assert.rejects(manager.waitFor(taskId, 100), (err: unknown) => {
      assert.ok(err instanceof SubAgentWaitTimeoutError);
      assert.equal(err.status, "failed");
      assert.equal(err.reason, "timeout");
      return true;
    });
  });

  it("rejects for unknown taskId", async () => {
    const { manager } = makeHarness();
    await assert.rejects(
      manager.waitFor("nope", 100),
      SubAgentWaitTimeoutError
    );
  });
});

// ── fixture 6:shutdown ────────────────────────────────────────────────────────

describe("SubAgentManager shutdown (SC12)", () => {
  it("running children receive SIGTERM; those not exiting get SIGKILL fallback", async () => {
    vi.useFakeTimers();
    try {
      const { manager, spawned } = makeHarness();
      const { taskId: a } = manager.spawn({});
      const { taskId: b } = manager.spawn({});
      assert.ok(a && b);

      const done = manager.shutdown();
      // 两个 child 都收到 SIGTERM(第一击)
      for (const child of spawned) {
        assert.deepEqual(child.kill.mock.calls.at(-1), ["SIGTERM"]);
      }
      // fake 不 emit exit → 兜底 SIGKILL(第二击)
      await vi.advanceTimersByTimeAsync(5000);
      await done;

      for (const child of spawned) {
        const signals = child.kill.mock.calls.map((c) => c[0]);
        assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
      }
      // shutdown 后 buffer 清空 → not_found
      assert.deepEqual(manager.queryBuffer(a), { status: "not_found" });
      assert.deepEqual(manager.queryBuffer(b), { status: "not_found" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("children that exit on SIGTERM → no SIGKILL fallback", async () => {
    vi.useFakeTimers();
    try {
      const { manager, spawned } = makeHarness();
      const { taskId } = manager.spawn({});
      const done = manager.shutdown();
      // child 收到 SIGTERM 后同步退出(emit exit)
      spawned[0]!.emit("exit", null, "SIGTERM");
      await vi.advanceTimersByTimeAsync(5000);
      await done;
      const signals = spawned[0]!.kill.mock.calls.map((c) => c[0]);
      assert.deepEqual(signals, ["SIGTERM"]);
      assert.deepEqual(manager.queryBuffer(taskId), { status: "not_found" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("pending waitFor is rejected by shutdown (SC16 no hang)", async () => {
    vi.useFakeTimers();
    try {
      const { manager } = makeHarness();
      const { taskId } = manager.spawn({});
      const pending = manager.waitFor(taskId, 60000);
      // 立即挂 handler,避免 shutdown 主动拒绝时触发 unhandledRejection
      const rejected = assert.rejects(pending, SubAgentWaitTimeoutError);
      const done = manager.shutdown();
      await vi.advanceTimersByTimeAsync(5000);
      await done;
      await rejected;
    } finally {
      vi.useRealTimers();
    }
  });
});

// ── fixture 9:drainCompleted ──────────────────────────────────────────────────

describe("SubAgentManager drainCompleted (T7 host-drain 最小枚举)", () => {
  it("lists only completed tasks; running and failed absent", () => {
    const { manager, spawned } = makeHarness();
    const doneTask = manager.spawn({}).taskId;
    emitEnvelope(spawned[0]!, okEnvelope("done"));
    const runningTask = manager.spawn({}).taskId;
    const failedTask = manager.spawn({}).taskId;
    spawned[2]!.emit("exit", 1, null);

    const drained = manager.drainCompleted();
    assert.equal(drained.length, 1);
    assert.equal(drained[0]!.taskId, doneTask);
    assert.equal(drained[0]!.envelope.status, "ok");
    // 不修改状态(host drain 是读操作):再次枚举结果一致
    const drained2 = manager.drainCompleted();
    assert.equal(drained2.length, 1);
    assert.equal(drained2[0]!.taskId, doneTask);
    // running / failed 不出现
    assert.ok(!drained.some((d) => d.taskId === runningTask));
    assert.ok(!drained.some((d) => d.taskId === failedTask));
  });

  it("excludeFromHostDrain=true completed 任务不进 drainCompleted", () => {
    const { manager, spawned, spawnCalls } = makeHarness();
    const hidden = manager.spawn({ excludeFromHostDrain: true }).taskId;
    emitEnvelope(spawned[0]!, okEnvelope("judge abort json"));
    const visible = manager.spawn({}).taskId;
    emitEnvelope(spawned[1]!, okEnvelope("user subagent"));

    assert.equal(
      "excludeFromHostDrain" in spawnCalls[0]!.payload,
      false,
      "excludeFromHostDrain is parent-only; must not land on WorkerEnvelope"
    );

    const drained = manager.drainCompleted();
    assert.equal(drained.length, 1);
    assert.equal(drained[0]!.taskId, visible);
    assert.ok(!drained.some((d) => d.taskId === hidden));
  });

  it("excludeFromHostDrain 与 role 并存：payload 只拷 role", () => {
    const { manager, spawned, spawnCalls } = makeHarness();
    manager.spawn({ role: "explore", excludeFromHostDrain: true });
    emitEnvelope(spawned[0]!, okEnvelope("hidden explore"));
    assert.equal(spawnCalls[0]!.payload.role, "explore");
    assert.equal("excludeFromHostDrain" in spawnCalls[0]!.payload, false);
    assert.equal(manager.drainCompleted().length, 0);
  });
});

// ── fixture 11:#361 T5 abortTask ─────────────────────────────────────────────

describe("SubAgentManager abortTask (#361 T5)", () => {
  it("running task → SIGTERM 一次(arm SIGKILL 兜底复用同一 armKillFallback 路径)", () => {
    const { manager, spawned } = makeHarness();
    const { taskId } = manager.spawn({});
    // 初始 running
    assert.deepEqual(manager.queryBuffer(taskId), { status: "running" });

    const ok = manager.abortTask(taskId);
    assert.equal(ok, true);
    // 第一击 SIGTERM
    const signals = spawned[0]!.kill.mock.calls.map((c) => c[0]);
    assert.deepEqual(signals, ["SIGTERM"]);
  });

  it("arm SIGKILL 兜底:fake child 不退出 → 5s 后 SIGKILL 强杀", async () => {
    vi.useFakeTimers();
    try {
      const { manager, spawned } = makeHarness();
      const { taskId } = manager.spawn({});
      manager.abortTask(taskId);
      // 5s 后 killFallback 兜底 SIGKILL
      await vi.advanceTimersByTimeAsync(5000);
      const signals = spawned[0]!.kill.mock.calls.map((c) => c[0]);
      assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
      // 防止后续 spawn 留下 stray timer
      spawned[0]!.stderr.end();
      spawned[0]!.emit("exit", null, "SIGKILL");
      await vi.advanceTimersByTimeAsync(500);
      await manager.shutdown();
    } finally {
      vi.useRealTimers();
    }
  }, 10000);

  it("running task → abortCtrl 已 abort(传播到 in-flight)", () => {
    const { manager } = makeHarness();
    const { taskId } = manager.spawn({});
    manager.abortTask(taskId);
    // 无直接断言面:确保不抛 + 状态仍 running(buffer 不变,等待 exit handler)。
    assert.deepEqual(manager.queryBuffer(taskId), { status: "running" });
  });

  it("未知 taskId → no-op 返回 false", () => {
    const { manager } = makeHarness();
    assert.equal(manager.abortTask("nope"), false);
  });

  // ── SC14: 操作员强杀必须 settle 本任务在飞的 waitFor ─────────────────────
  it("SC14: in-flight waitFor → abortTask 以 SubAgentAbortError 拒绝(非 WaitTimeout)", async () => {
    const { manager, spawned } = makeHarness();
    const { taskId } = manager.spawn({});
    const pending = manager.waitFor(taskId, 60000);
    const rejected = assert.rejects(pending, (err: unknown) => {
      assert.ok(
        err instanceof SubAgentAbortError,
        `expected SubAgentAbortError, got ${String((err as Error)?.name)}`
      );
      assert.equal(err.taskId, taskId);
      assert.ok(!(err instanceof SubAgentWaitTimeoutError));
      return true;
    });
    assert.equal(manager.abortTask(taskId), true);
    await rejected;
    // 拒绝之后才轮到 SIGTERM(顺序契约:先 settle 父侧 wait,再杀 worker)。
    assert.deepEqual(
      spawned[0]!.kill.mock.calls.map((c) => c[0]),
      ["SIGTERM"]
    );
  });

  it("SC14: abortTask 只拒绝本任务;另一任务的 waitFor 不受影响", async () => {
    const { manager, spawned } = makeHarness();
    const { taskId: victim } = manager.spawn({});
    const { taskId: bystander } = manager.spawn({});
    let bystanderSettled = false;
    const bystanderWait = manager.waitFor(bystander, 60000).finally(() => {
      bystanderSettled = true;
    });
    bystanderWait.catch(() => {});
    const victimWait = assert.rejects(
      manager.waitFor(victim, 60000),
      SubAgentAbortError
    );
    assert.equal(manager.abortTask(victim), true);
    await victimWait;
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(bystanderSettled, false, "bystander wait must stay pending");
    // 旁观任务仍活:终态信封到达后正常 resolve。
    emitEnvelope(spawned[1]!, okEnvelope("bystander done"));
    assert.equal((await bystanderWait).summary, "done");
    assert.equal(bystanderSettled, true);
  });

  it("SC14: 已 settle 的 waitFor 不再被 abortTask 二次 settle(cleanup 摘除)", async () => {
    const { manager, spawned } = makeHarness();
    const { taskId } = manager.spawn({});
    const first = manager.waitFor(taskId, 1000);
    emitEnvelope(spawned[0]!, okEnvelope("early"));
    assert.equal((await first).summary, "done");
    // task 已 completed → abortTask no-op(既有契约),且不会抛 / 二次 reject。
    assert.equal(manager.abortTask(taskId), false);
  });

  it("SC13 不回归: 真墙钟到期仍是 SubAgentWaitTimeoutError(不是 abort 归因)", async () => {
    const { manager } = makeHarness();
    const { taskId } = manager.spawn({});
    const pending = manager.waitFor(taskId, 50);
    await assert.rejects(pending, (err: unknown) => {
      assert.ok(err instanceof SubAgentWaitTimeoutError);
      assert.ok(!(err instanceof SubAgentAbortError));
      return true;
    });
  });

  it("已终态(completed)task → no-op 返回 false,不再 SIGTERM", () => {
    const { manager, spawned } = makeHarness();
    const { taskId } = manager.spawn({});
    emitEnvelope(spawned[0]!, okEnvelope("done"));
    assert.equal(manager.abortTask(taskId), false);
    assert.equal(spawned[0]!.kill.mock.calls.length, 0);
  });
});

// ── fixture 10:SubAgentDefinition 本地定义 typecheck ─────────────────────────

describe("SubAgentDefinition local definition typecheck", () => {
  it("accepts all optional camelCase fields", () => {
    const def: SubAgentDefinition = {
      systemPrompt: "p",
      disallowedTools: ["spawn_subagent", "edit_file"],
      model: "opus",
      maxTurns: 5,
      timeoutMs: 30000,
    };
    assert.equal(def.maxTurns, 5);
    assert.equal(def.model, "opus");
  });

  it("accepts an empty definition (all fields optional)", () => {
    const def: SubAgentDefinition = {};
    assert.equal(def.systemPrompt, undefined);
  });

  it("manager surface exposes the seven-member API", () => {
    const { manager } = makeHarness();
    const api: SubAgentManager = manager;
    assert.equal(typeof api.spawn, "function");
    assert.equal(typeof api.queryBuffer, "function");
    assert.equal(typeof api.waitFor, "function");
    assert.equal(typeof api.shutdown, "function");
    assert.equal(typeof api.drainCompleted, "function");
    assert.equal(typeof api.listActive, "function");
    // #358 T7: 只读枚举面（Session API 端点消费；running/completed/failed 三态合一）。
    assert.equal(typeof api.listSubagents, "function");
  });
});

// ── #358 T7:listSubagents (只读枚举面,Session API 端点消费) ──────────────────

describe("SubAgentManager listSubagents (#358 T7)", () => {
  it("空管理面 → 返回空数组", () => {
    const { manager } = makeHarness();
    const items = manager.listSubagents();
    assert.equal(items.length, 0);
  });

  it("completed 任务 → taskId/state/startedAt/taskPreview/endedAt/summary 齐全", () => {
    const { manager, spawned } = makeHarness();
    const { taskId } = manager.spawn({
      task: "第一个任务提示词".repeat(40),
    });
    emitEnvelope(spawned[0]!, okEnvelope("r"));
    const items = manager.listSubagents();
    assert.equal(items.length, 1);
    const item = items[0]!;
    assert.equal(item.taskId, taskId);
    assert.equal(item.state, "completed");
    assert.equal(typeof item.startedAt, "string");
    // 权限行: taskPreview 截断 ≤120,不落 task 全文 (spec 358 权限 row)。
    assert.ok(item.taskPreview.length <= 120);
    assert.equal(item.taskPreview, "第一个任务提示词".repeat(40).slice(0, 120));
    // Postel: completed 必有 endedAt + summary。
    assert.equal(typeof item.endedAt, "string");
    assert.equal(item.summary, "done");
    assert.equal(item.reason, undefined);
  });

  it("failed 任务 → state=failed + reason + summary (Postel: endedAt 必在)", async () => {
    const { manager, spawned } = makeHarness();
    const taskId = manager.spawn({ task: "explore the repo" }).taskId;
    await emitCrashAndWait(manager, spawned[0]!, taskId, 1, null);
    const items = manager.listSubagents();
    assert.equal(items.length, 1);
    const item = items[0]!;
    assert.equal(item.state, "failed");
    assert.equal(item.reason, "crashed");
    assert.match(item.summary!, /worker exit code=1 signal=null/);
    assert.equal(typeof item.endedAt, "string");
  });

  it("running 任务 → Postel: endedAt/summary/reason 全缺席 (仅必备四字段)", () => {
    const { manager } = makeHarness();
    manager.spawn({ task: "long running" });
    const items = manager.listSubagents();
    assert.equal(items.length, 1);
    const item = items[0]!;
    assert.equal(item.state, "running");
    assert.equal(item.endedAt, undefined);
    assert.equal(item.summary, undefined);
    assert.equal(item.reason, undefined);
    assert.equal(item.role, undefined);
  });

  it("spawn 带 role → listSubagents 投影 role（TUI 行首名称）", () => {
    const { manager } = makeHarness();
    manager.spawn({ task: "look around", role: "explore" });
    const items = manager.listSubagents();
    assert.equal(items[0]!.role, "explore");
  });

  it("task 缺席 → taskPreview 为空串 (回退不落全文)", () => {
    const { manager } = makeHarness();
    manager.spawn({ model: "opus" });
    const items = manager.listSubagents();
    assert.equal(items[0]!.taskPreview, "");
  });

  it("completed + failed + running 混合 → 返回全部三项 (每项 snapshot 只读)", async () => {
    const { manager, spawned, spawnCalls } = makeHarness();
    manager.spawn({ task: "completed-task" }); // 0
    const failedTask = manager.spawn({ task: "failed-task" }).taskId; // 1
    manager.spawn({ task: "running-task" }); // 2
    emitEnvelope(spawned[0]!, okEnvelope("done"));
    await emitCrashAndWait(manager, spawned[1]!, failedTask, 1, null);
    assert.equal(spawnCalls.length, 3);
    const items = manager.listSubagents();
    assert.equal(items.length, 3);
    const byState = Object.fromEntries(items.map((i) => [i.state, i]));
    assert.equal(byState["completed"]!.taskPreview, "completed-task");
    assert.equal(byState["failed"]!.taskPreview, "failed-task");
    assert.equal(byState["running"]!.taskPreview, "running-task");
  });

  it("按父 conversationId 过滤列表与终态订阅", () => {
    const { manager, spawned } = makeHarness();
    const notices: string[] = [];
    manager.subscribe((notice) => {
      notices.push(notice.taskId);
    }, "session-a");
    const sessionATask = manager.spawn({
      task: "session A",
      conversationId: "session-a",
    }).taskId;
    const sessionBTask = manager.spawn({
      task: "session B",
      conversationId: "session-b",
    }).taskId;

    emitEnvelope(spawned[0]!, okEnvelope("A result"));
    emitEnvelope(spawned[1]!, okEnvelope("B result"));

    assert.deepEqual(
      manager.listSubagents("session-a").map(({ taskId }) => taskId),
      [sessionATask]
    );
    assert.deepEqual(
      manager.listSubagents("session-b").map(({ taskId }) => taskId),
      [sessionBTask]
    );
    assert.deepEqual(notices, [sessionATask]);
  });
});
