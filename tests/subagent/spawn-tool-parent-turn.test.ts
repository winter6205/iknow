/**
 * F-4 parentTurnId 填实 — `spawn_subagent` 工具把 `ctx.turnId` 写进 def。
 *
 * 工具是「哪一回合派出了这个子代理」这条信息唯一的过路点：loop-engine 知道
 * 回合、manager 知道子代理，中间只有 tool ctx 连着两边。
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
      { task: "explore" },
      { conversationId: "conv-1", turnId: "turn-7" }
    );

    assert.equal(m.spawned.length, 1);
    assert.equal(m.spawned[0]!.parentTurnId, "turn-7");
  });

  it("ctx 缺 turnId → def 上该键缺席 (既有装配零行为变化)", async () => {
    const m = recordingManager();
    const tool = createSpawnSubAgentTool({ manager: m.manager });

    await tool.handler({ task: "explore" }, { conversationId: "conv-1" });

    assert.ok(!("parentTurnId" in m.spawned[0]!));
  });
});
