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
import { describe, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";

import {
  createSubAgentManager,
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

/** 收 wrapper:记录最近一次 spawn 的 child + 入参,供测试 emit。 */
function makeHarness() {
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
  });
  return { manager, spawned, spawnCalls };
}

function okEnvelope(result = "ok result"): SubAgentEnvelope {
  return { status: "ok", summary: "done", result };
}

function emitEnvelope(child: FakeChild, env: SubAgentEnvelope): void {
  child.stdout.write(JSON.stringify(env) + "\n");
  child.emit("exit", 0, null);
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
    assert.equal(payload.sandboxRoot, "");
    assert.equal(payload.systemPrompt, "p");
    assert.deepEqual(payload.disallowedTools, ["edit_file"]);
    assert.equal(payload.model, "opus");
    assert.equal(payload.maxTurns, 5);
    assert.equal(payload.timeoutMs, 30000);
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
  it("exit code=1 → failed reason=crashed with summary", () => {
    const { manager, spawned } = makeHarness();
    const { taskId } = manager.spawn({});
    spawned[0]!.emit("exit", 1, null);
    const q = manager.queryBuffer(taskId);
    assert.equal(q.status, "failed");
    if (q.status === "failed") {
      assert.equal(q.reason, "crashed");
      assert.match(q.summary, /worker exit code=1 signal=null/);
    }
  });

  it("killed by signal → failed reason=crashed", () => {
    const { manager, spawned } = makeHarness();
    const { taskId } = manager.spawn({});
    spawned[0]!.emit("exit", null, "SIGTERM");
    const q = manager.queryBuffer(taskId);
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

  it("child 'error' ENOENT → failed reason=crashed summary=err.message", () => {
    const { manager, spawned } = makeHarness();
    const { taskId } = manager.spawn({});
    spawned[0]!.emit(
      "error",
      Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" })
    );
    const q = manager.queryBuffer(taskId);
    assert.equal(q.status, "failed");
    if (q.status === "failed") {
      assert.equal(q.reason, "crashed");
      assert.equal(q.summary, "spawn ENOENT");
    }
  });
});

// ── fixture 3:protocolError ───────────────────────────────────────────────────

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
  it("result > 20000 chars → truncated envelope in buffer", () => {
    const { manager, spawned } = makeHarness();
    const { taskId } = manager.spawn({});
    emitEnvelope(spawned[0]!, okEnvelope("x".repeat(25000)));
    const q = manager.queryBuffer(taskId) as SubAgentEnvelope;
    assert.equal(q.status, "ok");
    assert.equal(q.truncated, true);
    assert.equal(q.totalLength, 25000);
    assert.match(q.result, /^\[\.\.\.truncated to 20000 chars; total 25000\]$/);
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

  it("failed → {status:failed, reason, summary}", () => {
    const { manager, spawned } = makeHarness();
    const { taskId } = manager.spawn({});
    spawned[0]!.emit("exit", 2, null);
    const q = manager.queryBuffer(taskId);
    assert.equal(q.status, "failed");
    if (q.status === "failed") assert.equal(q.reason, "crashed");
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

  it("manager surface exposes the five-member API", () => {
    const { manager } = makeHarness();
    const api: SubAgentManager = manager;
    assert.equal(typeof api.spawn, "function");
    assert.equal(typeof api.queryBuffer, "function");
    assert.equal(typeof api.waitFor, "function");
    assert.equal(typeof api.shutdown, "function");
    assert.equal(typeof api.drainCompleted, "function");
  });
});
