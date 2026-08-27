/**
 * F-4 parentTurnId 填实 — `ctx.turnId` 从 executor 透到 handler。
 *
 * `conversationId` 回答「哪个会话」，`turnId` 回答「哪一回合」。前者装配期定死、
 * 后者每回合翻新，所以它只能顺着 `executeAll` 走 —— 工具（`spawn_subagent`）
 * 是在回合的工具阶段里被调用的，那是它唯一能拿到当前回合身份的地方。
 *
 * 覆盖三层包装：基础 executor / permission 包装 / violation 包装。
 */

import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { createRegistry } from "../../../src/harness/tools/registry.ts";
import { createExecutor } from "../../../src/harness/tools/executor.ts";
import { createPermissionExecutor } from "../../../src/harness/permission/permission-executor.ts";
import { createPermissionPolicy } from "../../../src/harness/permission/policy.ts";
import { wrapWithViolationHook } from "../../../src/harness/sandbox/violation-executor.ts";
import type {
  Executor,
  ToolExecutionContext,
} from "../../../src/harness/tools/types.ts";

function makeProbe(): {
  executor: Executor;
  seen: Array<ToolExecutionContext | undefined>;
} {
  const seen: Array<ToolExecutionContext | undefined> = [];
  const registry = createRegistry([
    {
      name: "probe",
      description: "records the execution context it was handed",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      handler: (_input, ctx) => {
        seen.push(ctx);
        return "ok";
      },
    },
  ]);
  return { executor: createExecutor(registry), seen };
}

const CALL = { id: "call-1", name: "probe", input: {} };

describe("Executor.executeAll — turnId 透传到 ToolExecutionContext", () => {
  it("基础 executor: 第 6 参 turnId 进 ctx.turnId", async () => {
    const probe = makeProbe();
    await probe.executor.executeAll(
      [CALL],
      undefined,
      undefined,
      "conv-1",
      undefined,
      "turn-42"
    );
    assert.equal(probe.seen[0]?.turnId, "turn-42");
    assert.equal(probe.seen[0]?.conversationId, "conv-1");
  });

  it("turnId 缺席 → ctx 上该键缺席 (既有装配零行为变化)", async () => {
    const probe = makeProbe();
    await probe.executor.executeAll([CALL], undefined, undefined, "conv-1");
    assert.ok(probe.seen[0] !== undefined);
    assert.ok(!("turnId" in probe.seen[0]!));
  });

  it("permission 包装转发 turnId", async () => {
    const probe = makeProbe();
    const wrapped = createPermissionExecutor({
      inner: probe.executor,
      registry: createRegistry([]),
      policy: createPermissionPolicy(),
      askUser: async () => true,
    });
    await wrapped.executeAll(
      [CALL],
      undefined,
      undefined,
      "conv-1",
      undefined,
      "turn-43"
    );
    assert.equal(probe.seen[0]?.turnId, "turn-43");
  });

  it("violation 包装转发 turnId", async () => {
    const probe = makeProbe();
    const wrapped = wrapWithViolationHook({
      inner: probe.executor,
      onKill: () => {},
    });
    await wrapped.executeAll(
      [CALL],
      undefined,
      undefined,
      "conv-1",
      undefined,
      "turn-44"
    );
    assert.equal(probe.seen[0]?.turnId, "turn-44");
  });
});
