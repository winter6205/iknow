/**
 * #503 T10 / ADR-0022 — bash network:true ask hint + 字段透传。
 *
 * 覆盖：
 *   1. permission-executor 在 network bash 上把 askUser ctx 的 summaryHint
 *      改为 `[请求宿主网络] <命令摘要>`（命令过长时沿用 summarizeInput 的
 *      截断风格），并把 `network: true` 透传到 ctx。
 *   2. 命令含 `<<<SECRET_N>>>` 占位符（#406 roundtrip 产物）→ hint 追加
 *      `[secret 警告] 命令含 secret 占位符，批准后真值可能随命令出站`。
 *   3. 非 network bash / 其他工具走原 summarizeInput JSON 路径（零变化），
 *      且 ctx.network 缺省（executor 不传）。
 *
 * 集成驱动：通过 createPermissionExecutor + askUser spy 捕获 ctx —— 同时
 * 锁定 hint 文案 + 字段透传，不导出内部 helper。
 */

import { describe, it } from "vitest";
import assert from "node:assert/strict";

import {
  createPermissionExecutor,
  type HookErrorEvent,
} from "../../../src/harness/permission/permission-executor.js";
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

describe("#503 T10 — bash network hint + askUser ctx.network 透传", () => {
  it("network bash → askUser ctx.summaryHint 含 [请求宿主网络] 标记 + 命令摘要", async () => {
    const capture: AskCapture = { ctx: undefined as never, calls: 0 };
    const executor = createPermissionExecutor({
      inner: makeInnerOk(),
      registry: makeRegistry(makeBashTool()),
      policy: createPermissionPolicy(),
      askUser: makeCapturingAsk(capture),
    });
    await executor.executeAll([
      {
        id: "u1",
        name: "bash",
        input: {
          command: "curl http://127.0.0.1:3000/api",
          network: true,
        },
      },
    ]);
    assert.equal(capture.calls, 1, "askUser should have been called once");
    assert.ok(capture.ctx.summaryHint.includes("[请求宿主网络]"));
    assert.ok(
      capture.ctx.summaryHint.includes("curl http://127.0.0.1:3000/api")
    );
    assert.equal(capture.ctx.network, true);
  });

  it("network bash 命令含 <<<SECRET_1>>> → hint 追加 [secret 警告] + 占位符保留", async () => {
    const capture: AskCapture = { ctx: undefined as never, calls: 0 };
    const executor = createPermissionExecutor({
      inner: makeInnerOk(),
      registry: makeRegistry(makeBashTool()),
      policy: createPermissionPolicy(),
      askUser: makeCapturingAsk(capture),
    });
    const command =
      'curl -H "Authorization: Bearer <<<SECRET_1>>>" http://api.example.com';
    await executor.executeAll([
      { id: "u1", name: "bash", input: { command, network: true } },
    ]);
    assert.ok(capture.ctx.summaryHint.includes("[secret 警告]"));
    assert.ok(capture.ctx.summaryHint.includes("<<<SECRET_1>>>"));
    assert.ok(capture.ctx.summaryHint.includes("命令含 secret 占位符"));
    assert.equal(capture.ctx.network, true);
  });

  it("network bash 无占位符 → hint 不含 [secret 警告]", async () => {
    const capture: AskCapture = { ctx: undefined as never, calls: 0 };
    const executor = createPermissionExecutor({
      inner: makeInnerOk(),
      registry: makeRegistry(makeBashTool()),
      policy: createPermissionPolicy(),
      askUser: makeCapturingAsk(capture),
    });
    await executor.executeAll([
      {
        id: "u1",
        name: "bash",
        input: { command: "curl http://localhost:8080", network: true },
      },
    ]);
    assert.equal(capture.ctx.summaryHint.includes("[secret 警告]"), false);
    assert.equal(capture.ctx.summaryHint.includes("secret"), false);
  });

  it("长命令沿用 summarizeInput 截断风格（80 字符封顶带省略号）", async () => {
    const capture: AskCapture = { ctx: undefined as never, calls: 0 };
    const executor = createPermissionExecutor({
      inner: makeInnerOk(),
      registry: makeRegistry(makeBashTool()),
      policy: createPermissionPolicy(),
      askUser: makeCapturingAsk(capture),
    });
    const longCmd = "curl " + "x".repeat(120);
    await executor.executeAll([
      { id: "u1", name: "bash", input: { command: longCmd, network: true } },
    ]);
    assert.ok(capture.ctx.summaryHint.endsWith("..."));
    // 摘要总长度：标记 + 截断命令(80) + 尾省略号已在 80 内
    // 标记 "[请求宿主网络] " 9 字符 + 80 字符 trim+省略 = 89
    assert.ok(
      capture.ctx.summaryHint.length <= 90,
      `hint too long: ${capture.ctx.summaryHint.length}`
    );
  });

  it("非 network bash（network 缺省）→ 走原 summarizeInput JSON 路径，ctx.network 缺省", async () => {
    const capture: AskCapture = { ctx: undefined as never, calls: 0 };
    const executor = createPermissionExecutor({
      inner: makeInnerOk(),
      registry: makeRegistry(makeBashTool()),
      policy: createPermissionPolicy(),
      askUser: makeCapturingAsk(capture),
    });
    await executor.executeAll([
      { id: "u1", name: "bash", input: { command: "ls" } },
    ]);
    assert.equal(capture.ctx.summaryHint, '{"command":"ls"}');
    assert.equal(capture.ctx.network, undefined);
  });

  it("network:false bash → 走原 summarizeInput JSON 路径，ctx.network 缺省", async () => {
    const capture: AskCapture = { ctx: undefined as never, calls: 0 };
    const executor = createPermissionExecutor({
      inner: makeInnerOk(),
      registry: makeRegistry(makeBashTool()),
      policy: createPermissionPolicy(),
      askUser: makeCapturingAsk(capture),
    });
    await executor.executeAll([
      { id: "u1", name: "bash", input: { command: "ls", network: false } },
    ]);
    assert.equal(capture.ctx.summaryHint, '{"command":"ls","network":false}');
    assert.equal(capture.ctx.network, undefined);
  });

  it("network:true bash + askUser 拒绝 → execution_failed [user_denied]，inner 零调用", async () => {
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
      {
        id: "u1",
        name: "bash",
        input: { command: "curl x", network: true },
      },
    ]);
    assert.equal(result.length, 1);
    assert.equal(result[0]!.kind, "execution_failed");
    if (result[0]!.kind === "execution_failed") {
      assert.ok(result[0]!.message.startsWith("[user_denied]"));
    }
    assert.equal(innerCalls, 0);
  });
});

// HookErrorEvent 仅用于锁定 export（在 T10 没有显式钩子测试，但导出符号
// 不应变性感；TS 编译期即验证）。此处留空以避免 unused import 警告。
const _typeAssert: HookErrorEvent = { phase: "pre", message: "" };
void _typeAssert;
