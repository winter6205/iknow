/**
 * ADR-0101 — same-turn multi-spawn trajectory pinned down.
 *
 * Certified contract (Locked sentence 1): omitting `wait` still runs foreground;
 * parallel = N `spawn_subagent` calls in one assistant message (same wave, each
 * call gets its own task_id). Generic executor scheduling is already certified by
 * tests/harness/aci/aci-executor-parallel.test.ts; this file pins that conclusion
 * onto the real `spawn_subagent` toolchain:
 *   1. two spawns in one batch → two distinct task_ids, two worker child processes,
 *      and the second spawn happens before the first reaches a terminal state
 *      (first still in flight when second starts = true concurrency);
 *   2. spawns across turns: the second only appears after the first `wait:true`
 *      foreground call lands (foreground default unchanged — done precedes the
 *      second spawn in the trajectory).
 *
 * Assembly: real SubAgentManager (fake spawn factory, no real child process) +
 * real createSpawnSubAgentTool + real createAciExecutor (wave scheduling). The
 * inner Executor only dispatches handlers and normalizes results (same shape as
 * the recording executor in aci-executor-parallel).
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "vitest";
import type { ChildProcess } from "node:child_process";

import { createSubAgentManager } from "../../src/harness/subagent/manager.ts";
import type {
  SubAgentDefinition,
  SubAgentManager,
} from "../../src/harness/subagent/manager.ts";
import { createSpawnSubAgentTool } from "../../src/harness/subagent/spawn-subagent-tool.ts";
import type {
  SubAgentEnvelope,
  WorkerEnvelope,
} from "../../src/harness/subagent/envelope.ts";
import {
  getAgentEntry,
  resolveAgentCatalog,
} from "../../src/harness/subagent/catalog.ts";
import { createAciExecutor } from "../../src/harness/aci/aci-executor.ts";
import type { AciCatalog, AciToolDef } from "../../src/harness/aci/types.ts";
import type {
  Executor,
  ToolCall,
  ToolExecutionContext,
  ToolExecutionResult,
} from "../../src/harness/tools/types.ts";
import { ToolExecutionError } from "../../src/harness/errors.ts";

// ── fake child (follows the precedent in tests/subagent/manager.test.ts) ─────

interface FakeChild {
  readonly stdin: PassThrough;
  readonly stdout: PassThrough;
  readonly stderr: PassThrough;
  readonly pid: number;
  readonly kill: () => boolean;
  emit: (event: string | symbol, ...args: unknown[]) => boolean;
  once: (event: string | symbol, ...args: unknown[]) => unknown;
}

function makeFakeChild(): FakeChild {
  return Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    pid: 12345,
    kill: () => true,
  }) as unknown as FakeChild;
}

/** Trajectory event log: spawn / done appended in occurrence order; sequence asserts read it. */
type TrajectoryEvent =
  | { kind: "spawn"; taskId: string; task: string; activeCount: number }
  | { kind: "done"; taskId: string; task: string };

interface SpawnRecord {
  taskId: string;
  task: string;
  child: FakeChild;
}

function makeTrajectoryHarness(opts: {
  readonly subagentsDir: string;
  readonly trajectory: TrajectoryEvent[];
  /** child lifetime in ms: emit ok envelope + exit after spawn. */
  readonly lifetimeMs: number;
}): { manager: SubAgentManager; records: SpawnRecord[] } {
  const records: SpawnRecord[] = [];
  const manager = createSubAgentManager({
    subagentsDir: opts.subagentsDir,
    spawn: (
      def: SubAgentDefinition,
      taskId: string,
      _payload: WorkerEnvelope
    ) => {
      const child = makeFakeChild();
      records.push({ taskId, task: def.task ?? "", child });
      // Moment the spawn factory is called: manager has already registered this task
      // (starting/running). Under same-wave concurrency the second spawn call must
      // count the first task in activeCount.
      opts.trajectory.push({
        kind: "spawn",
        taskId,
        task: def.task ?? "",
        activeCount: manager.listActive().length,
      });
      setTimeout(() => {
        const env: SubAgentEnvelope = {
          status: "ok",
          summary: `done:${def.task ?? ""}`,
          result: `result:${def.task ?? ""}`,
        };
        child.stdout.write(JSON.stringify(env) + "\n");
        opts.trajectory.push({ kind: "done", taskId, task: def.task ?? "" });
        child.emit("exit", 0, null);
      }, opts.lifetimeMs);
      return child as unknown as ChildProcess;
    },
  });
  return { manager, records };
}

// ── ACI wiring: real tool + real aci-executor + recording inner ──────────────

function makeCatalog(tools: AciToolDef[]): AciCatalog {
  const byName = new Map(tools.map((t) => [t.name, t]));
  return Object.freeze({
    get: (n: string) => byName.get(n),
    all: () => Object.freeze([...tools]) as ReadonlyArray<AciToolDef>,
  });
}

/** inner executor: dispatches the batch to the tool handler (foreground arm blocks until terminal state). */
function makeHandlerExecutor(
  tool: AciToolDef,
  conversationId: string
): Executor {
  return Object.freeze({
    executeAll: async (
      batch: ReadonlyArray<ToolCall>
    ): Promise<ReadonlyArray<ToolExecutionResult>> =>
      Promise.all(
        batch.map(async (call): Promise<ToolExecutionResult> => {
          const ctx: ToolExecutionContext = {
            conversationId,
            toolUseId: call.id,
          };
          try {
            const out = await tool.handler(call.input, ctx);
            return {
              kind: "ok",
              toolUseId: call.id,
              payload: [{ type: "text", text: JSON.stringify(out) }],
            };
          } catch (err) {
            const message =
              err instanceof ToolExecutionError
                ? err.message
                : "execution_failed";
            return { kind: "execution_failed", toolUseId: call.id, message };
          }
        })
      ),
  });
}

function okHandoff(result: ToolExecutionResult): SubAgentEnvelope {
  assert.equal(result.kind, "ok");
  const payload = (result as { payload: { text: string }[] }).payload;
  return JSON.parse(payload[0]!.text) as SubAgentEnvelope;
}

describe("ADR-0101 T1 — 同轮双 spawn 轨迹（前景默认不变）", () => {
  let subagentsDir: string;
  beforeEach(() => {
    subagentsDir = mkdtempSync(join(tmpdir(), "iknow-same-turn-spawn-"));
  });
  afterEach(() => {
    rmSync(subagentsDir, { recursive: true, force: true });
  });

  it("同一 assistant 消息两条 spawn_subagent → 两个 task_id、两个 worker 进程、同 wave 并发", async () => {
    const trajectory: TrajectoryEvent[] = [];
    const { manager, records } = makeTrajectoryHarness({
      subagentsDir,
      trajectory,
      lifetimeMs: 60,
    });
    const tool = createSpawnSubAgentTool({
      manager,
      catalog: {
        list: () => resolveAgentCatalog(),
        get: (id: string) => getAgentEntry(id),
      },
    });
    const aciExec = createAciExecutor({
      inner: makeHandlerExecutor(tool, "conv-same-turn"),
      catalog: makeCatalog([tool]),
    });

    // one batch = two tool_use in the same assistant message (wait omitted = foreground).
    const batch = [
      {
        id: "tu1",
        name: "spawn_subagent",
        input: { title: "recon A", task: "A" },
      },
      {
        id: "tu2",
        name: "spawn_subagent",
        input: { title: "recon B", task: "B" },
      },
    ];
    const results = await aciExec.executeAll(batch);

    assert.equal(results.length, 2);
    // Spec subagent-card-title input contract, concurrent column: two spawns in
    // one turn each carry their own title. These are the very input objects the
    // loop persists as tool_use, so reading them back after the run also proves
    // the tool left them untouched (line 1 of each card reads its own title).
    assert.deepEqual(
      batch.map((call) => call.input.title),
      ["recon A", "recon B"]
    );
    const handoffA = okHandoff(results[0]!);
    const handoffB = okHandoff(results[1]!);

    // two distinct task_ids, each handed back to the parent in its envelope.
    assert.ok(
      typeof handoffA.task_id === "string" && handoffA.task_id.length > 0
    );
    assert.ok(
      typeof handoffB.task_id === "string" && handoffB.task_id.length > 0
    );
    assert.notEqual(handoffA.task_id, handoffB.task_id);

    // two worker child processes, one task_id each (matched on the spawn-factory side).
    assert.equal(records.length, 2);
    const ids = new Set(records.map((r) => r.taskId));
    assert.equal(ids.size, 2);
    assert.ok(ids.has(handoffA.task_id));
    assert.ok(ids.has(handoffB.task_id));

    // same-wave concurrency: first task still in flight at the second spawn call →
    // activeCount === 2, and every done event in the trajectory lands after both spawns.
    const spawns = trajectory.filter((e) => e.kind === "spawn");
    const dones = trajectory.filter((e) => e.kind === "done");
    assert.equal(spawns.length, 2);
    assert.equal(dones.length, 2);
    assert.equal((spawns[1] as { activeCount: number }).activeCount, 2);
    let lastSpawn = -1;
    for (let i = 0; i < trajectory.length; i++) {
      if (trajectory[i]!.kind === "spawn") lastSpawn = i;
    }
    const firstDone = trajectory.findIndex((e) => e.kind === "done");
    assert.ok(
      firstDone > lastSpawn,
      `both workers must be in flight before either lands: ${JSON.stringify(trajectory)}`
    );

    // Foreground-arm mutual exclusion is certified by foreground-drain-exclusion.test.ts;
    // here we pin only the trajectory shape, no repeated assertion.
  });

  it("跨回合第二条 spawn 在第一条 wait:true 终态之后才出现（前景默认契约）", async () => {
    const trajectory: TrajectoryEvent[] = [];
    const { manager } = makeTrajectoryHarness({
      subagentsDir,
      trajectory,
      lifetimeMs: 40,
    });
    const tool = createSpawnSubAgentTool({
      manager,
      catalog: {
        list: () => resolveAgentCatalog(),
        get: (id: string) => getAgentEntry(id),
      },
    });
    const aciExec = createAciExecutor({
      inner: makeHandlerExecutor(tool, "conv-cross-turn"),
      catalog: makeCatalog([tool]),
    });

    // turn 1: foreground spawn A — this turn's handler blocks until A reaches terminal state.
    const turn1 = await aciExec.executeAll([
      {
        id: "tu1",
        name: "spawn_subagent",
        input: { title: "recon A", task: "A" },
      },
    ]);
    const handoffA = okHandoff(turn1[0]!);
    assert.equal(handoffA.status, "ok");
    // at the end of turn 1 the trajectory holds only spawn+done, no second process.
    assert.deepEqual(
      trajectory.map((e) => `${e.kind}:${e.task}`),
      ["spawn:A", "done:A"]
    );

    // turn 2: foreground spawn B — can only be dispatched after A has handed off.
    const turn2 = await aciExec.executeAll([
      {
        id: "tu2",
        name: "spawn_subagent",
        input: { title: "recon B", task: "B" },
      },
    ]);
    const handoffB = okHandoff(turn2[0]!);
    assert.equal(handoffB.status, "ok");

    assert.deepEqual(
      trajectory.map((e) => `${e.kind}:${e.task}`),
      ["spawn:A", "done:A", "spawn:B", "done:B"]
    );
    // cross-turn: the second spawn's activeCount counts only itself (previous task already settled).
    const spawnB = trajectory[2] as { activeCount: number };
    assert.equal(spawnB.activeCount, 1);
    assert.notEqual(handoffA.task_id, handoffB.task_id);
  });
});
