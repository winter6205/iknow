/**
 * #358 T4 — SubAgentManager 三类 trace 事件 (subagent_spawn / subagent_state_change / subagent_stop)
 * 落盘集成测试（double-track：trace assert + no-trace deepEqual 基线）.
 *
 * 契约（plans/358 §SC1 + spec Testing Strategy 三角矩阵）:
 * 1. spawn → subagent_spawn 落盘 (manager 注入 memory-spy trace)
 * 2. state 迁移 starting → running → 至少 1 条 subagent_state_change
 * 3. 终态 (completed) → 1 条 subagent_stop（subagent_id 跨 spawn/stop 一致）
 * 4. 失败 spawn（spawn 工厂 throw）→ subagent_spawn + subagent_stop with reason="crashed"
 * 5. sibling 配对：两个 spawn 各一条 subagent_spawn + 各一条 subagent_stop
 * 6. NoopTraceService baseline：可观测行为 (queryBuffer / listActive / drainCompleted)
 *    与带 trace 形态 deepEqual
 * 7. 真实 jsonl 文件落盘：spawn → envelope → exit 后 >=3 行 subagent_*
 */

import assert from "node:assert/strict";
import { describe, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";

import {
  createSubAgentManager,
  type SubAgentManager,
} from "../../src/harness/subagent/manager.ts";
import type {
  SubAgentEnvelope,
  WorkerEnvelope,
} from "../../src/harness/subagent/envelope.ts";
import type { SubAgentDefinition } from "../../src/harness/subagent/manager.ts";
import { createJsonlTraceService } from "../../src/harness/trace/jsonl.ts";
import { createNoopTraceService } from "../../src/harness/trace/noop.ts";
import type {
  SubagentSpawnRecord,
  SubagentStopRecord,
  SubagentStateChangeRecord,
} from "../../src/harness/trace/types.ts";

// ─── fake ChildProcess 工厂 (复用 manager.test.ts 的 makeFakeChild 模式) ───

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

function okEnvelope(result = "ok result"): SubAgentEnvelope {
  return { status: "ok", summary: "done", result };
}

function emitEnvelope(child: FakeChild, env: SubAgentEnvelope): void {
  child.stdout.write(JSON.stringify(env) + "\n");
  child.emit("exit", 0, null);
}

// ─── 录制式 trace spy ──────────────────────────────────────────────────────

interface RecordedTrace {
  readonly spawns: ReadonlyArray<SubagentSpawnRecord>;
  readonly stateChanges: ReadonlyArray<SubagentStateChangeRecord>;
  readonly stops: ReadonlyArray<SubagentStopRecord>;
}

interface TracingHarness {
  readonly manager: SubAgentManager;
  readonly spawned: FakeChild[];
  readonly spawnCalls: Array<{
    def: SubAgentDefinition;
    taskId: string;
    payload: WorkerEnvelope;
  }>;
  readonly recorded: RecordedTrace;
}

function makeTracingHarness(
  opts: {
    readonly spawnImpl?: (
      def: SubAgentDefinition,
      taskId: string,
      payload: WorkerEnvelope
    ) => ChildProcess;
  } = {}
): TracingHarness {
  const spawned: FakeChild[] = [];
  const spawnCalls: {
    def: SubAgentDefinition;
    taskId: string;
    payload: WorkerEnvelope;
  }[] = [];
  const spawns: SubagentSpawnRecord[] = [];
  const stateChanges: SubagentStateChangeRecord[] = [];
  const stops: SubagentStopRecord[] = [];

  const defaultImpl = (
    _def: SubAgentDefinition,
    _taskId: string,
    _payload: WorkerEnvelope
  ): ChildProcess => {
    const child = makeFakeChild();
    spawned.push(child);
    spawnCalls.push({
      def: _def,
      taskId: _taskId,
      payload: _payload,
    });
    return child as unknown as ChildProcess;
  };
  const impl = opts.spawnImpl ?? defaultImpl;

  // 满足 TraceService 接口的最小 spy(只实现 subagent 三件,其它签名调用即抛错)。
  // 这里我们不知类型是否要求全部方法,所以用最小子集 + casts 处理。
  const trace = {
    recordSubagentSpawn: (
      rec: SubagentSpawnRecord
    ): Promise<string | undefined> => {
      spawns.push(rec);
      return Promise.resolve(rec.id);
    },
    recordSubagentStateChange: (
      rec: SubagentStateChangeRecord
    ): Promise<string | undefined> => {
      stateChanges.push(rec);
      return Promise.resolve(rec.id);
    },
    recordSubagentStop: (
      rec: SubagentStopRecord
    ): Promise<string | undefined> => {
      stops.push(rec);
      return Promise.resolve(rec.id);
    },
  };

  const manager = createSubAgentManager({
    spawn: impl,
    // `trace` 接口形 = TraceService,这里仅注入 subagent 相关三件
    trace: trace as unknown as Parameters<
      typeof createSubAgentManager
    >[0]["trace"],
  });
  return {
    manager,
    spawned,
    spawnCalls,
    recorded: { spawns, stateChanges, stops },
  };
}

// ─── SC1 #1: 三类事件落盘 + spawn/stop 配对 ────────────────────────────────

describe("SubAgentManager trace 三类事件 (T4, #358 SC1)", () => {
  it("spawn → envelope emit → exit 0 配对: 1 spawn + ≥1 state_change + 1 stop, subagent_id 一致", async () => {
    const h = makeTracingHarness();

    const { taskId } = h.manager.spawn({
      task: "do thing",
      model: "opus",
      maxTurns: 5,
      timeoutMs: 60000,
    });
    // 触发 completed (emit envelope + exit)
    emitEnvelope(h.spawned[0]!, okEnvelope("done"));

    // safeTrace 包裹的 recordXxx 是 fire-and-forget: 等下一次 microtask flush
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(h.recorded.spawns.length, 1);
    assert.ok(
      h.recorded.stateChanges.length >= 1,
      `at least 1 state_change, got ${h.recorded.stateChanges.length}`
    );
    assert.equal(h.recorded.stops.length, 1);

    // record 的 id (= manager taskId) 跨 record 一致
    assert.equal(h.recorded.spawns[0]!.id, taskId);
    assert.equal(h.recorded.stops[0]!.id, taskId);
    assert.equal(h.recorded.stateChanges[0]!.id, taskId);

    // spawn record fields
    assert.equal(h.recorded.spawns[0]!.taskId, taskId);
    assert.equal(h.recorded.spawns[0]!.origin, "parent");
    assert.match(
      h.recorded.spawns[0]!.startedAt,
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
    );

    // stop record fields
    const stop = h.recorded.stops[0]!;
    assert.equal(stop.finalState, "completed");
    assert.ok(typeof stop.durationMs === "number");
    assert.ok(stop.durationMs >= 0);
    assert.equal(stop.status, "ok");
    assert.ok(stop.endedAt !== undefined);
    assert.match(stop.endedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

    // 至少一条 state_change: starting → running
    const runningChange = h.recorded.stateChanges.find(
      (s) => s.toState === "running"
    );
    assert.ok(runningChange !== undefined, "running state_change present");
  });
});

// ─── SC1 #4: spawn 工厂 throw 失败路径 ────────────────────────────────────

describe("SubAgentManager trace 失败路径 (spawn 抛错)", () => {
  it("spawn factory throws → 1 subagent_spawn + 1 subagent_stop with reason=crashed", async () => {
    const h = makeTracingHarness({
      spawnImpl: () => {
        throw new Error("ENOENT no iknow bin");
      },
    });
    const { taskId } = h.manager.spawn({ task: "do thing" });
    assert.ok(taskId);

    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(h.recorded.spawns.length, 1, "spawn event still emitted");
    assert.equal(h.recorded.stops.length, 1, "stop event emitted on failure");
    assert.equal(h.recorded.spawns[0]!.id, taskId);
    const stop = h.recorded.stops[0]!;
    assert.equal(stop.finalState, "failed");
    assert.equal(stop.reason, "crashed");
    assert.match(stop.summary ?? "", /spawn failed: ENOENT/);
  });
});

// ─── SC1 #5: sibling 配对 ────────────────────────────────────────────────

describe("SubAgentManager trace sibling 配对 (SC1)", () => {
  it("sequential 2 spawns → 2 subagent_spawn + 2 subagent_stop 同 taskId 一一配对", async () => {
    const h = makeTracingHarness();

    const a = h.manager.spawn({ task: "A" });
    emitEnvelope(h.spawned[0]!, okEnvelope("a-result"));

    const b = h.manager.spawn({ task: "B" });
    emitEnvelope(h.spawned[1]!, okEnvelope("b-result"));

    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(h.recorded.spawns.length, 2);
    assert.equal(h.recorded.stops.length, 2);
    const spawnIds = h.recorded.spawns.map((s) => s.id);
    const stopIds = h.recorded.stops.map((s) => s.id);
    assert.equal(spawnIds[0], a.taskId);
    assert.equal(stopIds[0], a.taskId);
    assert.equal(spawnIds[1], b.taskId);
    assert.equal(stopIds[1], b.taskId);
  });
});

// ─── double-track #2: NoopTraceService baseline deepEqual ─────────────────

describe("SubAgentManager NoopTraceService baseline (T4 double-track #2)", () => {
  it("createNoopTraceService 注入 → 可观测行为 (queryBuffer / listActive / drainCompleted / spawn 返回) 与带 trace 形态 deepEqual", async () => {
    // 含 trace 形态
    const withTrace = makeTracingHarness();
    const { taskId: withTraceTaskId } = withTrace.manager.spawn({
      task: "thing",
      model: "opus",
    });
    emitEnvelope(withTrace.spawned[0]!, okEnvelope("payload-A"));
    await new Promise((resolve) => setImmediate(resolve));
    const withTraceQuery = withTrace.manager.queryBuffer(withTraceTaskId);
    const withTraceList = withTrace.manager.listActive();
    const withTraceDrain = withTrace.manager.drainCompleted();
    assert.equal(withTrace.recorded.stops.length, 1, "trace 形态落 stop");

    // 无 trace 形态: 用 NoopTraceService 注入 + 同一 spawn 路径
    const noopSpawned: FakeChild[] = [];
    const noop = createSubAgentManager({
      spawn: (_def, _taskId, _payload) => {
        const c = makeFakeChild();
        noopSpawned.push(c);
        return c as unknown as ChildProcess;
      },
      trace: createNoopTraceService(),
    });
    const noopTaskId = noop.spawn({ task: "thing", model: "opus" }).taskId;
    emitEnvelope(noopSpawned[0]!, okEnvelope("payload-B"));
    await new Promise((resolve) => setImmediate(resolve));
    const noopQuery = noop.queryBuffer(noopTaskId);
    const noopList = noop.listActive();
    const noopDrain = noop.drainCompleted();

    // queryBuffer status shape 完全一致 (envelope 不同 result 是预期 — payload 不同)
    assert.equal(noopQuery.status, withTraceQuery.status);
    // shape deep equal: same union status + 同 envelope 字段 (status / summary / result)
    if (noopQuery.status === "ok" && withTraceQuery.status === "ok") {
      const a = noopQuery as SubAgentEnvelope;
      const b = withTraceQuery as SubAgentEnvelope;
      assert.equal(a.status, b.status, "envelope.status same");
      assert.equal(typeof a.summary, typeof b.summary, "summary shape");
      assert.equal(typeof a.result, typeof b.result, "result shape");
    }
    // listActive: 两条都 emit 后,空数组等
    assert.deepEqual([...noopList], [...withTraceList]);
    // drainCompleted 长度与 envelope.status 一致
    assert.equal(noopDrain.length, withTraceDrain.length);
    assert.equal(noopDrain.length, 1);
    assert.equal(
      (noopDrain[0]!.envelope as SubAgentEnvelope).status,
      (withTraceDrain[0]!.envelope as SubAgentEnvelope).status
    );

    // NoopTraceService 路径不发任何埋点 → manager 行为与带 trace 完全一致 (可观测面 deepEqual)
    // Already covered by listActive + drainCompleted + queryBuffer shape 断言。
  });
});

// ─── jsonl 文件适配: 直接用 createJsonlTraceService 真实落盘 ─────────────

describe("SubAgentManager trace 真实 jsonl 落盘 (T4 SC1 grep -c subagent_ >= 3)", () => {
  it("spawn → envelope → exit 后 grep -c subagent_ >= 3", async () => {
    const scratchDir = mkdtempSync(join(tmpdir(), "iknow-trace-mgr-"));
    try {
      const trace = createJsonlTraceService({
        filePath: scratchDir,
        conversationId: "conv-mgr-trace",
      });

      const spawned: FakeChild[] = [];
      const manager = createSubAgentManager({
        spawn: (_def, _taskId, _payload) => {
          const c = makeFakeChild();
          spawned.push(c);
          return c as unknown as ChildProcess;
        },
        trace,
      });

      manager.spawn({ task: "do" });
      emitEnvelope(spawned[0]!, okEnvelope("r"));
      // 等 trace 的 safeTrace 包装 + write flush
      await new Promise((resolve) => setImmediate(resolve));
      // 再 await 一个 microtask 兜底 (safeTrace 是 Promise + writeLine 是同步)
      await Promise.resolve();

      const filePath = join(scratchDir, "conv-mgr-trace.jsonl");
      const content = readFileSync(filePath, "utf8");
      const lines = content.split("\n").filter(Boolean);
      const recordTypes = lines.map((l) => JSON.parse(l).record_type as string);
      const subagentLines = recordTypes.filter((t) =>
        t.startsWith("subagent_")
      );
      assert.ok(
        subagentLines.length >= 3,
        `expected >=3 subagent_* lines, got ${subagentLines.length} (${recordTypes.join(",")})`
      );
    } finally {
      rmSync(scratchDir, { recursive: true, force: true });
    }
  });
});

describe("SubAgentManager crash stderr drain race (T1)", () => {
  it("waitFor resolves only after the post-exit stderr burst is in the crash summary", async () => {
    const h = makeTracingHarness();
    const { taskId } = h.manager.spawn({ task: "crash wait race" });
    const burst = "x".repeat(70_000) + "\nLAST-STDERR-LINE\n";

    h.spawned[0]!.emit("exit", 2, null);
    const pending = h.manager.waitFor(taskId, 1000);
    assert.deepEqual(h.manager.queryBuffer(taskId), { status: "running" });
    setImmediate(() => {
      h.spawned[0]!.stderr.write(burst);
      h.spawned[0]!.stderr.end();
    });

    const result = await pending;
    assert.equal(result.status, "failed");
    if (result.status === "failed") {
      assert.match(result.summary, /LAST-STDERR-LINE/);
    }
  });

  it("waits for a >64KB stderr burst after exit before building the crash summary", async () => {
    const h = makeTracingHarness();
    const { taskId } = h.manager.spawn({ task: "crash race" });
    const burst = "x".repeat(70_000) + "\nLAST-STDERR-LINE\n";

    h.spawned[0]!.emit("exit", 2, null);
    setImmediate(() => {
      h.spawned[0]!.stderr.write(burst);
      h.spawned[0]!.stderr.end();
    });

    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    const result = h.manager.queryBuffer(taskId);
    assert.equal(result.status, "failed");
    if (result.status === "failed") {
      assert.match(result.summary, /LAST-STDERR-LINE/);
    }
    await new Promise((resolve) => setImmediate(resolve));
    const stateFailure = h.recorded.stateChanges.find(
      (record) => record.toState === "failed"
    );
    assert.equal(stateFailure?.error?.type, "unknown");
    assert.equal(h.recorded.stops[0]?.error?.type, "unknown");
  });
});
