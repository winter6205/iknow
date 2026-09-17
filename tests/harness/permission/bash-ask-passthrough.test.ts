/**
 * permission-executor → AskUser 单链装配契约。
 *
 * ask 决策的调用形状（ADR-0097：批准面只有一条链）：
 *   - ask 决策 → askUser 恰好被调一次,ctx 带 tool / input / summaryHint;
 *   - summaryHint 唯一来源是 summarizeInput 的 JSON 截断形态(80 字符封顶),
 *     不存在第二套按输入改写的 hint;

 *   - askUser 拒绝 → typed `[user_denied]`,inner 零调用;
 *   - askUser 抛异常 → fail-closed 拒绝(绝不能因提示面故障放行副作用)。
 *
 * 集成驱动：createPermissionExecutor + 捕获型 askUser spy。
 */

import { describe, it } from "vitest";
import assert from "node:assert/strict";

import { createPermissionExecutor } from "../../../src/harness/permission/permission-executor.js";
import { createPermissionPolicy } from "../../../src/harness/permission/policy.js";
import type { AskUser } from "../../../src/harness/permission/types.js";
import type { AciToolDef } from "../../../src/harness/aci/types.js";
import type {
  Executor,
  Registry,
  ToolCall,
  ToolExecutionResult,
  ToolDef,
} from "../../../src/harness/tools/types.js";

function makeBashTool(): AciToolDef {
  return Object.freeze({
    name: "bash",
    description: "test bash",
    inputSchema: { type: "object", additionalProperties: false },
    handler: async () => ({ code: 0, stdout: "", stderr: "" }),
    aci: Object.freeze({
      category: "execute",
      isConcurrencySafe: false,
      interruptBehavior: "cancel" as const,
      timeoutTier: "default" as const,
    }),
  });
}

function makeRegistry(def: AciToolDef): Registry {
  const all: ToolDef[] = [def];
  return Object.freeze({
    list: () => all,
    get: (name: string) => all.find((t) => t.name === name),
  });
}

function makeInnerOk(): Executor {
  return Object.freeze({
    executeAll: async (
      batch: ReadonlyArray<ToolCall>
    ): Promise<ReadonlyArray<ToolExecutionResult>> =>
      batch.map((c) => ({
        kind: "ok" as const,
        toolUseId: c.id,
        payload: [{ type: "text" as const, text: "ok" }],
      })),
  });
}

interface AskCapture {
  ctx: Parameters<AskUser>[0];
  calls: number;
}

function makeCapturingAsk(capture: AskCapture): AskUser {
  return async (ctx) => {
    capture.calls += 1;
    capture.ctx = ctx;
    return true;
  };
}

function newCapture(): AskCapture {
  return { ctx: undefined as never, calls: 0 };
}

describe("ask 决策 → AskUser 单链装配（ADR-0097 网络轴退役后）", () => {
  it("ask 决策 → askUser 恰一次,ctx 带 tool / input / summaryHint(JSON 截断形态)", async () => {
    const capture = newCapture();
    const executor = createPermissionExecutor({
      inner: makeInnerOk(),
      registry: makeRegistry(makeBashTool()),
      policy: createPermissionPolicy(),
      askUser: makeCapturingAsk(capture),
    });
    await executor.executeAll([
      { id: "u1", name: "bash", input: { command: "ls" } },
    ]);
    assert.equal(capture.calls, 1, "askUser should have been called once");
    assert.equal(capture.ctx.tool, "bash");
    assert.deepEqual(capture.ctx.input, { command: "ls" });
    assert.equal(capture.ctx.summaryHint, '{"command":"ls"}');
  });

  it("summaryHint 是唯一来源:超长命令按 80 字符 + ... 截断", async () => {
    const capture = newCapture();
    const executor = createPermissionExecutor({
      inner: makeInnerOk(),
      registry: makeRegistry(makeBashTool()),
      policy: createPermissionPolicy(),
      askUser: makeCapturingAsk(capture),
    });
    const longCmd = "curl " + "x".repeat(200);
    await executor.executeAll([
      { id: "u1", name: "bash", input: { command: longCmd } },
    ]);
    const hint = capture.ctx.summaryHint;
    assert.equal(hint.length, 80);
    assert.ok(hint.endsWith("..."));
  });

  it("命令含 <<<SECRET_N>>> 占位符 → hint 原样透出占位符(不还原真值)", async () => {
    const capture = newCapture();
    const executor = createPermissionExecutor({
      inner: makeInnerOk(),
      registry: makeRegistry(makeBashTool()),
      policy: createPermissionPolicy(),
      askUser: makeCapturingAsk(capture),
    });
    const command = 'curl -H "Authorization: Bearer <<<SECRET_1>>>" http://x';
    await executor.executeAll([{ id: "u1", name: "bash", input: { command } }]);
    assert.ok(capture.ctx.summaryHint.includes("<<<SECRET_1>>>"));
  });

  it("askUser 拒绝 → execution_failed [user_denied],inner 零调用", async () => {
    let innerCalls = 0;
    const inner: Executor = Object.freeze({
      executeAll: async (batch: ReadonlyArray<ToolCall>) => {
        innerCalls += batch.length;
        return batch.map((c) => ({
          kind: "ok" as const,
          toolUseId: c.id,
          payload: [{ type: "text" as const, text: "x" }],
        }));
      },
    });
    const executor = createPermissionExecutor({
      inner,
      registry: makeRegistry(makeBashTool()),
      policy: createPermissionPolicy(),
      askUser: async () => false,
    });
    const result = await executor.executeAll([
      { id: "u1", name: "bash", input: { command: "curl x" } },
    ]);
    assert.equal(result.length, 1);
    assert.equal(result[0]!.kind, "execution_failed");
    if (result[0]!.kind === "execution_failed") {
      assert.ok(result[0]!.message.startsWith("[user_denied]"));
    }
    assert.equal(innerCalls, 0);
  });

  it("askUser 抛异常 → fail-closed 拒绝(提示面故障不得放行副作用)", async () => {
    let innerCalls = 0;
    const inner: Executor = Object.freeze({
      executeAll: async (batch: ReadonlyArray<ToolCall>) => {
        innerCalls += batch.length;
        return batch.map((c) => ({
          kind: "ok" as const,
          toolUseId: c.id,
          payload: [{ type: "text" as const, text: "x" }],
        }));
      },
    });
    const executor = createPermissionExecutor({
      inner,
      registry: makeRegistry(makeBashTool()),
      policy: createPermissionPolicy(),
      askUser: async () => {
        throw new Error("prompt inlet unavailable");
      },
    });
    const result = await executor.executeAll([
      { id: "u1", name: "bash", input: { command: "curl x" } },
    ]);
    assert.equal(result[0]!.kind, "execution_failed");
    if (result[0]!.kind === "execution_failed") {
      assert.ok(result[0]!.message.startsWith("[user_denied]"));
    }
    assert.equal(innerCalls, 0);
  });
});
