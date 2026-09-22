/**
 * parentTurnId fill-in — `spawn_subagent` writes `ctx.turnId` into def.
 *
 * The tool is the only waypoint for "which turn dispatched this subagent":
 * loop-engine knows the turn, manager knows the subagent, and only tool ctx
 * connects the two sides.
 */

import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { createSpawnSubAgentTool } from "../../src/harness/subagent/spawn-subagent-tool.ts";
import type {
  SubAgentDefinition,
  SubAgentManager,
} from "../../src/harness/subagent/manager.ts";

function recordingManager(): {
  manager: SubAgentManager;
  spawned: SubAgentDefinition[];
} {
  const spawned: SubAgentDefinition[] = [];
  const manager = {
    spawn: (def: SubAgentDefinition) => {
      spawned.push(def);
      return { taskId: `task-${spawned.length}` };
    },
    waitFor: async () => ({ status: "ok" as const, summary: "s", result: "r" }),
  } as unknown as SubAgentManager;
  return { manager, spawned };
}

describe("spawn_subagent — ctx.turnId → def.parentTurnId", () => {
  it("ctx 带 turnId → def.parentTurnId 逐字相同", async () => {
    const m = recordingManager();
    const tool = createSpawnSubAgentTool({ manager: m.manager });

    await tool.handler(
      { title: "sample title", task: "explore" },
      { conversationId: "conv-1", turnId: "turn-7" }
    );

    assert.equal(m.spawned.length, 1);
    assert.equal(m.spawned[0]!.parentTurnId, "turn-7");
  });

  it("ctx 缺 turnId → def 上该键缺席 (既有装配零行为变化)", async () => {
    const m = recordingManager();
    const tool = createSpawnSubAgentTool({ manager: m.manager });

    await tool.handler(
      { title: "sample title", task: "explore" },
      { conversationId: "conv-1" }
    );

    assert.ok(!("parentTurnId" in m.spawned[0]!));
  });
});
