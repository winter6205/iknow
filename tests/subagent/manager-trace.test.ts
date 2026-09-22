/**
 * Integration test: SubAgentManager's three trace events (subagent_spawn /
 * subagent_state_change / subagent_stop) persisted to disk (double-track:
 * trace assert + no-trace deepEqual baseline).
 *
 * Contract:
 * 1. spawn → subagent_spawn recorded (manager injected with a memory-spy trace)
 * 2. state transition starting → running → at least 1 subagent_state_change
 * 3. terminal state (completed) → 1 subagent_stop (subagent_id consistent across spawn/stop)
 * 4. failed spawn (spawn factory throw) → subagent_spawn + subagent_stop with reason="crashed"
 * 5. sibling pairing: two spawns → one subagent_spawn + one subagent_stop each
 * 6. NoopTraceService baseline: observable behavior (queryBuffer / listActive / drainCompleted)
 *    deepEqual to the traced form
 * 7. real jsonl persistence: spawn → envelope → exit yields >=3 subagent_* lines
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

// ─── fake ChildProcess factory (reuses the makeFakeChild pattern from manager.test.ts) ───

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

// ─── recording trace spy ──────────────────────────────────────────────────────

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

  // Minimal spy satisfying the TraceService interface (only the three subagent
  // methods; calling any other signature throws). The interface may not require
  // every method, so use the minimal subset + casts.
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
    // `trace`'s interface shape = TraceService; only the three subagent methods injected here
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

// ─── SC1 item 1: three event kinds on disk + spawn/stop pairing ─────────────

describe("SubAgentManager trace 三类事件 (T4, #358 SC1)", () => {
  it("spawn → envelope emit → exit 0 配对: 1 spawn + ≥1 state_change + 1 stop, subagent_id 一致", async () => {
    const h = makeTracingHarness();

    const { taskId } = h.manager.spawn({
      task: "do thing",
      maxTurns: 5,
      timeoutMs: 60000,
    });
    // trigger completed (emit envelope + exit)
    emitEnvelope(h.spawned[0]!, okEnvelope("done"));

    // safeTrace-wrapped recordXxx is fire-and-forget: wait for the next microtask flush
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(h.recorded.spawns.length, 1);
    assert.ok(
      h.recorded.stateChanges.length >= 1,
      `at least 1 state_change, got ${h.recorded.stateChanges.length}`
    );
    assert.equal(h.recorded.stops.length, 1);

    // record id (= manager taskId) consistent across records
    assert.equal(h.recorded.spawns[0]!.id, taskId);
    assert.equal(h.recorded.stops[0]!.id, taskId);
    assert.equal(h.recorded.stateChanges[0]!.id, taskId);

    // spawn record fields
    assert.equal(h.recorded.spawns[0]!.taskId, taskId);
    assert.equal(h.recorded.spawns[0]!.origin, "parent");
    // ADR-0122: the per-spawn model field is deleted — a newly written
    // subagent_spawn record carries no `model` key.
    assert.ok(!("model" in h.recorded.spawns[0]!), "spawn record has no model");
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

    // at least one state_change: starting → running
    const runningChange = h.recorded.stateChanges.find(
      (s) => s.toState === "running"
    );
    assert.ok(runningChange !== undefined, "running state_change present");
  });
});

// ─── SC1 item 4: spawn-factory throw failure path ───────────────────────────

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

// ─── SC1 item 5: sibling pairing ───────────────────────────────────────────

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
    // traced form
    const withTrace = makeTracingHarness();
    const { taskId: withTraceTaskId } = withTrace.manager.spawn({
      task: "thing",
    });
    emitEnvelope(withTrace.spawned[0]!, okEnvelope("payload-A"));
    await new Promise((resolve) => setImmediate(resolve));
    const withTraceQuery = withTrace.manager.queryBuffer(withTraceTaskId);
    const withTraceList = withTrace.manager.listActive();
    const withTraceDrain = withTrace.manager.drainCompleted();
    assert.equal(withTrace.recorded.stops.length, 1, "trace 形态落 stop");

    // no-trace form: NoopTraceService injected + the same spawn path
    const noopSpawned: FakeChild[] = [];
    const noop = createSubAgentManager({
      spawn: (_def, _taskId, _payload) => {
        const c = makeFakeChild();
        noopSpawned.push(c);
        return c as unknown as ChildProcess;
      },
      trace: createNoopTraceService(),
    });
    const noopTaskId = noop.spawn({ task: "thing" }).taskId;
    emitEnvelope(noopSpawned[0]!, okEnvelope("payload-B"));
    await new Promise((resolve) => setImmediate(resolve));
    const noopQuery = noop.queryBuffer(noopTaskId);
    const noopList = noop.listActive();
    const noopDrain = noop.drainCompleted();

    // queryBuffer status shape identical (different envelope results are expected — payloads differ)
    assert.equal(noopQuery.status, withTraceQuery.status);
    // shape deep equal: same union status + same envelope fields (status / summary / result)
    if (noopQuery.status === "ok" && withTraceQuery.status === "ok") {
      const a = noopQuery as SubAgentEnvelope;
      const b = withTraceQuery as SubAgentEnvelope;
      assert.equal(a.status, b.status, "envelope.status same");
      assert.equal(typeof a.summary, typeof b.summary, "summary shape");
      assert.equal(typeof a.result, typeof b.result, "result shape");
    }
    // listActive: both empty arrays after the two emits
    assert.deepEqual([...noopList], [...withTraceList]);
    // drainCompleted length and envelope.status agree
    assert.equal(noopDrain.length, withTraceDrain.length);
    assert.equal(noopDrain.length, 1);
    assert.equal(
      (noopDrain[0]!.envelope as SubAgentEnvelope).status,
      (withTraceDrain[0]!.envelope as SubAgentEnvelope).status
    );

    // The NoopTraceService path emits no records → manager behavior is identical to the traced form (observable surface deepEqual)
    // Already covered by the listActive + drainCompleted + queryBuffer shape assertions.
  });
});

// ─── jsonl file adapter: real persistence via createJsonlTraceService ───────

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
      // wait for trace's safeTrace wrapper + write flush
      await new Promise((resolve) => setImmediate(resolve));
      // one extra microtask as a safety net (safeTrace returns a Promise; writeLine is sync)
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
