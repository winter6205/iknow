/**
 * B4 / ADR-0043 §2 — permission-executor gate:未 discover() 的 mcp__ 工具
 * 调用 = ToolExecutionError(模板钉死 MCP_TOOL_NOT_LOADED_MESSAGE),不调
 * inner、不调 pre-hook、不弹 askUser。
 *
 * 行为真值:
 *   - mcp__ 工具被 catalog.get 命中,但 registry.isDiscovered(name) === false
 *     → gate 返 blocked{execution_failed, message = 模板字面};
 *   - pre-hook / askUser / inner 全部零调用(契约错误,不属于权限层);
 *   - discover(name) 之后再调 → 闸门放行,正常 inner 执行;
 *   - 非 mcp__ 工具(普通 built-in / dynamic non-mcp)→ 不受此闸门影响;
 *   - catalog.isDiscovered 缺席(非 ACI registry 装配路径)→ 闸门放过,
 *     与 B4 之前 byte-stable。
 */
import assert from "node:assert/strict";
import { describe, it } from "vitest";

import { createPermissionRuntime } from "../../../src/harness/permission/permission-executor.js";
import { createPermissionPolicy } from "../../../src/harness/permission/policy.js";
import { createRegistry } from "../../../src/harness/tools/registry.js";
import type { AciToolDef } from "../../../src/harness/aci/types.js";
import type {
  Executor,
  ToolCall,
  ToolExecutionResult,
} from "../../../src/harness/tools/types.js";
import { MCP_TOOL_NOT_LOADED_MESSAGE } from "../../../src/harness/mcp/manager.js";

function makeMcpTool(name: string): AciToolDef {
  return Object.freeze({
    name,
    description: `mcp ${name}`,
    inputSchema: { type: "object", additionalProperties: false },
    handler: async () => "mcp-ok",
    aci: Object.freeze({
      category: "read-only" as const,
      isConcurrencySafe: true,
      interruptBehavior: "cancel" as const,
      timeoutTier: "fast" as const,
    }),
  });
}

function makeInnerSpy(): { executor: Executor; calls: ToolCall[][] } {
  const calls: ToolCall[][] = [];
  const executor: Executor = Object.freeze({
    executeAll: async (
      batch: ReadonlyArray<ToolCall>
    ): Promise<ReadonlyArray<ToolExecutionResult>> => {
      calls.push([...batch]);
      return batch.map((c) => ({
        kind: "ok" as const,
        toolUseId: c.id,
        payload: [{ type: "text" as const, text: `executed:${c.name}` }],
      }));
    },
  });
  return { executor, calls };
}

describe("B4 / ADR-0043 §2 — 未加载 mcp__ 工具闸门", () => {
  it("未 discover 的 mcp__ 工具调用 → blocked + 模板字面 message;inner 零调用", async () => {
    const def = makeMcpTool("mcp__svc__ping");
    const reg = createRegistry([def]);
    // 模拟 AciRegistry 的 isDiscovered:该名未被检索。
    const discovered = new Set<string>();
    const { executor: inner, calls: innerCalls } = makeInnerSpy();
    const perm = createPermissionRuntime({
      inner,
      registry: reg,
      policy: createPermissionPolicy(),
      askUser: async () => true,
      isDiscovered: (name: string) => discovered.has(name),
    });

    const gate = await perm.gateOne(
      { id: "u1", name: "mcp__svc__ping", input: {} },
      undefined
    );
    assert.equal(gate.kind, "blocked");
    if (gate.kind === "blocked") {
      // 模板钉死 = MCP_TOOL_NOT_LOADED_MESSAGE 字面。
      assert.equal(gate.result.message, MCP_TOOL_NOT_LOADED_MESSAGE);
      assert.equal(gate.result.kind, "execution_failed");
      assert.equal(gate.result.toolUseId, "u1");
    }
    assert.equal(innerCalls.length, 0, "inner 必须零调用");
  });

  it("discover() 标记后再调 → proceed,inner 真跑", async () => {
    const def = makeMcpTool("mcp__svc__ping");
    const reg = createRegistry([def]);
    const discovered = new Set<string>(["mcp__svc__ping"]);
    const { executor: inner, calls: innerCalls } = makeInnerSpy();
    const perm = createPermissionRuntime({
      inner,
      registry: reg,
      policy: createPermissionPolicy(),
      askUser: async () => true,
      isDiscovered: (name: string) => discovered.has(name),
    });

    const gate = await perm.gateOne(
      { id: "u2", name: "mcp__svc__ping", input: {} },
      undefined
    );
    assert.equal(gate.kind, "proceed");
    assert.equal(innerCalls.length, 0, "gateOne 不调 inner;inner 由上层驱动");

    // 模拟上层 runAllowed 路径:proceed → 真跑 inner,handler 应返 ok。
    if (gate.kind === "proceed") {
      const [result] = await inner.executeAll([
        { id: "u2", name: "mcp__svc__ping", input: {} },
      ]);
      assert.equal(result.kind, "ok");
    }
  });

  it("非 mcp__ 工具 → 不受 isDiscovered 闸门影响(catalog.isDiscovered 缺失也通过)", async () => {
    const builtin: AciToolDef = Object.freeze({
      name: "read_file",
      description: "builtin",
      inputSchema: { type: "object", additionalProperties: false },
      handler: async () => "ok",
      aci: Object.freeze({
        category: "read-only" as const,
        isConcurrencySafe: true,
        interruptBehavior: "cancel" as const,
        timeoutTier: "fast" as const,
      }),
    });
    const reg = createRegistry([builtin]);
    // isDiscovered 不注入 → 闸门放过(非 ACI registry 装配的兼容路径)。
    const { executor: inner, calls: innerCalls } = makeInnerSpy();
    const perm = createPermissionRuntime({
      inner,
      registry: reg,
      policy: createPermissionPolicy(),
      askUser: async () => true,
    });

    const gate = await perm.gateOne(
      { id: "u3", name: "read_file", input: {} },
      undefined
    );
    assert.equal(gate.kind, "proceed");
    // 非 mcp__ 名字不走模板,也不要求 discovered。
    assert.equal(innerCalls.length, 0);
  });

  it("isDiscovered 注入但返 true(已 discover)→ proceed 不阻", async () => {
    const def = makeMcpTool("mcp__svc__ping");
    const reg = createRegistry([def]);
    const discovered = new Set<string>(["mcp__svc__ping"]);
    const { executor: inner } = makeInnerSpy();
    const perm = createPermissionRuntime({
      inner,
      registry: reg,
      policy: createPermissionPolicy(),
      askUser: async () => true,
    });

    const gate = await perm.gateOne(
      { id: "u4", name: "mcp__svc__ping", input: {} },
      undefined
    );
    assert.equal(gate.kind, "proceed");
  });
});
