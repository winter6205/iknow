/**
 * ADR-0101 / plan subagent-stop-and-continue T1 — 同轮多 spawn 轨迹钉死。
 *
 * 认证的合同（Locked sentence 1）：省略 `wait` 仍前景；并行 = 同一 assistant
 * 消息里 N 次 `spawn_subagent`（同一 wave 并发启动，各调用自有 task_id）。
 * 通用 executor 调度已由 tests/harness/aci/aci-executor-parallel.test.ts (AC46)
 * 认证；本文件把该结论钉到 **spawn_subagent 这条真实工具链**上：
 *   1. 同一批次两条 spawn → 两个不同 task_id、两个 worker 子进程，且第二条
 *      spawn 发生在第一条终态之前（第二进程在飞时第一进程尚未落定 = 真并发）；
 *   2. 跨回合两条 spawn：第二条只在第一条 `wait:true` 前景终态之后才出现
 *      （前景默认不被本计划改动 —— 轨迹序列里 done 先于第二次 spawn）。
 *
 * 组装面：真实 SubAgentManager（fake spawn 工厂，不真启子进程）+ 真实
 * createSpawnSubAgentTool + 真实 createAciExecutor（wave 调度）。inner
 * Executor 只做 handler 派发 + 结果归一（与 aci-executor-parallel 的
 * recording executor 同形态）。
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
import { getAgentEntry, resolveAgentCatalog } from "../../src/harness/subagent/catalog.ts";
import { createAciExecutor } from "../../src/harness/aci/aci-executor.ts";
import type { AciCatalog, AciToolDef } from "../../src/harness/aci/types.ts";
import type {
  Executor,
  ToolCall,
  ToolExecutionContext,
  ToolExecutionResult,
} from "../../src/harness/tools/types.ts";
import { ToolExecutionError } from "../../src/harness/errors.ts";

// ── fake child（沿用 tests/subagent/manager.test.ts 先例）────────────────────

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

/** 轨迹事件日志：spawn / done 按发生顺序追加，序列断言读它。 */
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
  /** 子进程存活时长(ms)：spawn 后 emit ok envelope + exit。 */
  readonly lifetimeMs: number;
}): { manager: SubAgentManager; records: SpawnRecord[] } {
  const records: SpawnRecord[] = [];
  const manager = createSubAgentManager({
    subagentsDir: opts.subagentsDir,
    spawn: (def: SubAgentDefinition, taskId: string, _payload: WorkerEnvelope) => {
      const child = makeFakeChild();
      records.push({ taskId, task: def.task ?? "", child });
      // spawn 工厂被调用的时刻：manager 已把本任务入 map（starting/running）。
      // 同 wave 并发时第二个 spawn 的调用点必然把第一个任务算进 activeCount。
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

// ── ACI 接线：真实工具 + 真实 aci-executor + 记录型 inner ───────────────────

function makeCatalog(tools: AciToolDef[]): AciCatalog {
  const byName = new Map(tools.map((t) => [t.name, t]));
  return Object.freeze({
    get: (n: string) => byName.get(n),
    all: () => Object.freeze([...tools]) as ReadonlyArray<AciToolDef>,
  });
}

/** inner executor：把 batch 派发给工具 handler（前景臂各自阻塞到终态）。 */
function makeHandlerExecutor(tool: AciToolDef, conversationId: string): Executor {
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
              err instanceof ToolExecutionError ? err.message : "execution_failed";
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

    // 一个 batch = 同一 assistant 消息里的两条 tool_use（wait 省略 = 前景）。
    const results = await aciExec.executeAll([
      { id: "tu1", name: "spawn_subagent", input: { task: "A" } },
      { id: "tu2", name: "spawn_subagent", input: { task: "B" } },
    ]);

    assert.equal(results.length, 2);
    const handoffA = okHandoff(results[0]!);
    const handoffB = okHandoff(results[1]!);

    // 两个不同 task_id，各自随信封交回父侧。
    assert.ok(typeof handoffA.task_id === "string" && handoffA.task_id.length > 0);
    assert.ok(typeof handoffB.task_id === "string" && handoffB.task_id.length > 0);
    assert.notEqual(handoffA.task_id, handoffB.task_id);

    // 两个 worker 子进程，各领一个 task_id（spawn 工厂侧对应）。
    assert.equal(records.length, 2);
    const ids = new Set(records.map((r) => r.taskId));
    assert.equal(ids.size, 2);
    assert.ok(ids.has(handoffA.task_id));
    assert.ok(ids.has(handoffB.task_id));

    // 同 wave 并发：第二个 spawn 的调用点第一个任务仍在飞 →
    // activeCount === 2，且轨迹里 done 事件全部晚于两次 spawn。
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

    // 前景臂互斥位由既有测试认证（foreground-drain-exclusion.test.ts）；
    // 此处只钉轨迹形态，不重复断言。
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

    // turn 1：前景 spawn A —— 本回合 handler 阻塞到 A 终态才返回。
    const turn1 = await aciExec.executeAll([
      { id: "tu1", name: "spawn_subagent", input: { task: "A" } },
    ]);
    const handoffA = okHandoff(turn1[0]!);
    assert.equal(handoffA.status, "ok");
    // 回合 1 结束时轨迹只有 spawn+done，没有第二个进程。
    assert.deepEqual(
      trajectory.map((e) => `${e.kind}:${e.task}`),
      ["spawn:A", "done:A"]
    );

    // turn 2：前景 spawn B —— 只能在 A 已交差之后被派出。
    const turn2 = await aciExec.executeAll([
      { id: "tu2", name: "spawn_subagent", input: { task: "B" } },
    ]);
    const handoffB = okHandoff(turn2[0]!);
    assert.equal(handoffB.status, "ok");

    assert.deepEqual(
      trajectory.map((e) => `${e.kind}:${e.task}`),
      ["spawn:A", "done:A", "spawn:B", "done:B"]
    );
    // 跨回合的第二条 activeCount 只算到自己（前一任务已出账）。
    const spawnB = trajectory[2] as { activeCount: number };
    assert.equal(spawnB.activeCount, 1);
    assert.notEqual(handoffA.task_id, handoffB.task_id);
  });
});
