/**
 * parentTurnId wiring — graph node dispatch path.
 *
 * graph is the second write-side caller of `manager.spawn` (first is the
 * `spawn_subagent` tool). When the dispatcher supplies an owning turn, that
 * turn identity must appear in both places:
 *   - the node def → manager's spawn / state_change / stop records;
 *   - the executor's own two `subagent_step` records (dispatch / settle).
 * Otherwise `?parent_turn_id=` drill-down only sees half the orchestration graph.
 *
 * No owning turn (current `/graph run` is a slash command outside a turn) → the key is absent in both places.
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
