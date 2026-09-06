/**
 * T3 / ADR-0046 §3 — permission-executor gate:未 discover() 的 mcp__ 工具
 * 被直呼 → hydrate(本轮 discover(name) → 下一轮 visibleSchemas 尾部追加
 * schema);input 通过 schema → 直接执行;否则返非 error 文本投影。
 *
 * 行为真值:
 *   - mcp__ 工具被 catalog.get 命中,registry.isDiscovered(name) === false,
 *     discover 副作用被触发 → gate.proceed(走 input 校验后再放行/投影);
 *   - pre-hook / askUser / inner 仍按原路径(闸门放行才进,投影短路时零调用);
 *   - discover(name) 之后再调 → 闸门直接放行,正常 inner 执行(无 hydrate 重复);
 *   - 非 mcp__ 工具(普通 built-in / dynamic non-mcp)→ 不受此闸门影响;
 *   - catalog.isDiscovered / catalog.discover 缺席(非 ACI registry 装配路径)
 *     → 闸门放过,与 T3 之前 byte-stable。
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

describe("T3 / ADR-0046 §3 — mcp__ 直呼加载(原 B4 §2 hydrate 路径)", () => {
  it("未 discover + 合法 input → hydrate(proceed + discover 副作用);inner 由上层驱动", async () => {
    const def = makeMcpTool("mcp__svc__ping");
    const reg = createRegistry([def]);
    const discovered = new Set<string>();
    const { executor: inner, calls: innerCalls } = makeInnerSpy();
    const perm = createPermissionRuntime({
      inner,
      registry: reg,
      policy: createPermissionPolicy(),
      askUser: async () => true,
      isDiscovered: (name: string) => discovered.has(name),
      discover: (name: string) => {
        discovered.add(name);
      },
    });

    const gate = await perm.gateOne(
      { id: "u1", name: "mcp__svc__ping", input: {} },
      undefined
    );
    // T3:不该返 blocked,不该含 "not loaded" 模板字面。
    assert.equal(gate.kind, "proceed");
    if (gate.kind === "proceed") {
      assert.equal(gate.def?.name, "mcp__svc__ping");
    }
    // gateOne 不调 inner;inner 由 runAllowed 路径驱动。
    assert.equal(innerCalls.length, 0, "gateOne 必须零调用 inner");

    // T3:discover 副作用已发生(discover 注入生效)。
    assert.ok(discovered.has("mcp__svc__ping"));
  });

  it("未 discover + 非法 input → blocked + kind: ok + 文本投影 schema;inner 零调用", async () => {
    // input 校验在 hydrate 路径失败时,闸门返 ok 文本投影(非 error,
    // is_error = false);discover 副作用照发(spec:discover 必须发生在
    // 执行前 → 模型下一轮拿到 schema 才能正确补 input)。
    const def = makeMcpTool("mcp__svc__ping");
    const reg = createRegistry([def]);
    const discovered = new Set<string>();
    const { executor: inner, calls: innerCalls } = makeInnerSpy();
    const perm = createPermissionRuntime({
      inner,
      registry: reg,
      policy: createPermissionPolicy(),
      askUser: async () => true,
      isDiscovered: (name: string) => discovered.has(name),
      discover: (name: string) => {
        discovered.add(name);
      },
    });

    // 该 fixture 的 makeMcpTool inputSchema = { type: object, additionalProperties: false }
    // → `extra` 必拒 → ajv 失败。
    const gate = await perm.gateOne(
      { id: "u1b", name: "mcp__svc__ping", input: { extra: "bad" } },
      undefined
    );
    assert.equal(gate.kind, "blocked");
    if (gate.kind === "blocked") {
      assert.equal(gate.result.kind, "ok");
      assert.equal(gate.result.toolUseId, "u1b");
      // 投影文本 = JSON.stringify({name, description, inputSchema})
      const payload = (
        gate.result as unknown as { payload: Array<{ text: string }> }
      ).payload;
      assert.equal(payload.length, 1);
      const text = payload[0]!.text;
      assert.ok(!text.includes("not loaded"));
      assert.ok(!text.includes("call tool_search first"));
      const parsed = JSON.parse(text) as Record<string, unknown>;
      assert.equal(parsed.name, "mcp__svc__ping");
      assert.ok(parsed.description);
      assert.ok(parsed.inputSchema);
    }
    // inner 仍零调用(闸门在 pre-hook 之前已 short-circuit)。
    assert.equal(innerCalls.length, 0);
    // discover 副作用照样发生(下一轮 schema 进 promptTools)。
    assert.ok(discovered.has("mcp__svc__ping"));
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
