/**
 * F-4 parentTurnId 填实 — graph 节点派发路径。
 *
 * graph 是 `manager.spawn` 的第二个写侧入口（第一个是 `spawn_subagent` 工具）。
 * 派发方给出归属回合时，该回合身份必须同时出现在两处：
 *   - 节点 def → manager 的 spawn / state_change / stop 三类 record；
 *   - executor 自己发的 `subagent_step` dispatch / settle 两条。
 * 否则按 `?parent_turn_id=` 下钻只能捞到半张编排图。
 *
 * 没有归属回合（当前 `/graph run` 是回合之外的 slash 命令）→ 两处都缺席该键。
 */

import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { createNoopTraceService } from "../../../src/harness/trace/noop.ts";
import type {
  SubagentStepRecord,
  TraceService,
} from "../../../src/harness/trace/types.ts";
import type {
  SubAgentDefinition,
  SubAgentManager,
} from "../../../src/harness/subagent/manager.ts";
import {
  createSubAgentNodeExecutor,
  type NodePlan,
} from "../../../src/harness/graph/node-executor.ts";

function recordingTrace(): {
  steps: SubagentStepRecord[];
  trace: TraceService;
} {
  const steps: SubagentStepRecord[] = [];
  const trace: TraceService = {
    ...createNoopTraceService(),
    async recordSubagentStep(record) {
      steps.push(record);
      return record.id;
    },
  };
  return { steps, trace };
}

function fakeManager(): {
  manager: SubAgentManager;
  defs: SubAgentDefinition[];
} {
  const defs: SubAgentDefinition[] = [];
  const manager = {
    spawn: (def: SubAgentDefinition) => {
      defs.push(def);
      return { taskId: `task-${defs.length}` };
    },
    waitFor: async () => ({
      status: "ok" as const,
      summary: "s",
      result: "r",
    }),
  } as unknown as SubAgentManager;
  return { manager, defs };
}

const plans: Readonly<Record<string, NodePlan>> = { a: { task: "task-a" } };

describe("createSubAgentNodeExecutor — parentTurnId", () => {
  it("传 parentTurnId → 节点 def 与 subagent_step 两条都带上它", async () => {
    const { steps, trace } = recordingTrace();
    const { manager, defs } = fakeManager();

    const exec = createSubAgentNodeExecutor({
      manager,
      plans,
      trace,
      parentTurnId: "turn-graph-1",
    });
    const outcome = await exec("a");

    assert.deepEqual(outcome, { status: "done", output: "r" });
    assert.equal(defs.length, 1);
    assert.equal(defs[0]!.parentTurnId, "turn-graph-1");
    assert.equal(steps.length, 2);
    for (const s of steps) assert.equal(s.parentTurnId, "turn-graph-1");
  });

  it("不传 parentTurnId → def 与 step 上该键缺席 (Postel)", async () => {
    const { steps, trace } = recordingTrace();
    const { manager, defs } = fakeManager();

    const exec = createSubAgentNodeExecutor({ manager, plans, trace });
    await exec("a");

    assert.ok(!("parentTurnId" in defs[0]!));
    for (const s of steps) assert.ok(!("parentTurnId" in s));
  });
});
