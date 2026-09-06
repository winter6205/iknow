/**
 * T4 / ADR-0046 §3 + spec disclosure-index-align SC4 — schema 退场内建件
 * 直呼加载。
 *
 * 钉住的不变式:
 *   - schema 溢出退场(`retireBuiltin` stamp `aci.lazy: true`)的内建件被
 *     直呼时,走与 `mcp__` 相同的 hydrate 路径:本轮 `discover(name)` →
 *     下一轮 `visibleSchemas()` 尾部追加该 schema;input 通过 schema →
 *     直接执行;不要求先 `tool_search`。
 *   - 判定依据 = `def.aci.lazy === true && !isDiscovered(name)`(不看名字
 *     前缀)。核心七件永不 lazy(`CORE_TOOL_NAMES` 在退场候选 derivation
 *     层被剔除)→ 天然不进 hydrate 分支。
 *   - 常驻(非 lazy)内建件不受影响:闸门不调 discover,直接按权限层放行。
 */
import { describe, it, expect } from "vitest";
import assert from "node:assert/strict";

import { createAciRegistry } from "../../../src/harness/aci/aci-registry.js";
import { createPermissionRuntime } from "../../../src/harness/permission/permission-executor.js";
import { createPermissionPolicy } from "../../../src/harness/permission/policy.js";
import { createExecutor } from "../../../src/harness/tools/executor.js";
import { createRegistry } from "../../../src/harness/tools/registry.js";
import { CORE_TOOL_NAMES } from "../../../src/harness/aci/tool-overflow.js";
import type { AciToolDef } from "../../../src/harness/aci/types.js";
import type { ToolCall } from "../../../src/harness/tools/types.js";

/** deferrable 内建件(退场候选形态):必填 input `conversation_id`,
 *  handler 返 "traced:<id>"。 */
function makeDeferrableBuiltin(name: string): AciToolDef {
  return Object.freeze({
    name,
    description: `builtin ${name}`,
    inputSchema: {
      type: "object",
      properties: { conversation_id: { type: "string", minLength: 1 } },
      required: ["conversation_id"],
      additionalProperties: false,
    },
    handler: async (input: unknown) =>
      `traced:${(input as { conversation_id: string }).conversation_id}`,
    aci: Object.freeze({
      category: "read-only" as const,
      isConcurrencySafe: true,
      interruptBehavior: "cancel" as const,
      timeoutTier: "fast" as const,
      deferrable: true,
    }),
  });
}

/** 核心件形态(永不 deferrable / 永不 lazy)。 */
function makeCoreBuiltin(name: string): AciToolDef {
  return Object.freeze({
    name,
    description: `core ${name}`,
    inputSchema: { type: "object", additionalProperties: false },
    handler: async () => "core-ok",
    aci: Object.freeze({
      category: "read-only" as const,
      isConcurrencySafe: true,
      interruptBehavior: "cancel" as const,
      timeoutTier: "fast" as const,
    }),
  });
}

/** 装配 permission runtime,registry 面从 aci-registry 的 catalog 现读
 *  (retireBuiltin 后 catalog.get 返回带 lazy:true 的新 def)。 */
function wire(registry: ReturnType<typeof createAciRegistry>) {
  const discoverCalls: string[] = [];
  const perm = createPermissionRuntime({
    inner: createExecutor(
      createRegistry(registry.catalog.all() as ReadonlyArray<AciToolDef>)
    ),
    registry: {
      list: () => registry.catalog.all(),
      get: (name: string) => registry.catalog.get(name),
    },
    policy: createPermissionPolicy(),
    askUser: async () => true,
    isDiscovered: (name: string) => registry.isDiscovered(name),
    discover: (name: string) => {
      discoverCalls.push(name);
      registry.discover(name);
    },
  });
  return { perm, discoverCalls };
}

describe("T4 SC4 — schema 退场内建件直呼:hydrate + 执行", () => {
  it("退场件(lazy:true)未 discover + 合法 input → proceed + discover 副作用;下一轮 schema 尾部追加", async () => {
    const registry = createAciRegistry([
      makeDeferrableBuiltin("query_trace"),
      makeCoreBuiltin("bash"),
    ]);
    // 首轮 schema 都在可见前缀(未退场)。
    expect(registry.visibleSchemas().map((t) => t.name)).toContain(
      "query_trace"
    );
    // 溢出退场:stamp aci.lazy:true → schema 撤出可见集。
    registry.retireBuiltin(["query_trace"]);
    expect(registry.visibleSchemas().map((t) => t.name)).not.toContain(
      "query_trace"
    );
    // SC4:核心件 schema 仍在(退场不碰核心七件)。
    expect(registry.visibleSchemas().map((t) => t.name)).toContain("bash");

    const { perm, discoverCalls } = wire(registry);
    const call: ToolCall = {
      id: "sc4-1",
      name: "query_trace",
      input: { conversation_id: "c-1" },
    };
    const gate = await perm.gateOne(call, undefined);
    // 关键:不要求先 tool_search —— 直呼即放行。
    assert.equal(gate.kind, "proceed");
    if (gate.kind === "proceed") {
      assert.equal(gate.def?.name, "query_trace");
    }
    // hydrate 副作用:本轮 discover(name)。
    assert.deepEqual(discoverCalls, ["query_trace"]);
    expect(registry.isDiscovered("query_trace")).toBe(true);
    // 下一轮 visibleSchemas 尾部追加该 schema。
    expect(registry.visibleSchemas().map((t) => t.name)).toContain(
      "query_trace"
    );

    // 放行后真跑:handler 输出原样进 ok payload。
    const result = await perm.runAllowed(
      call,
      gate.kind === "proceed" ? gate.def : undefined
    );
    assert.equal(result.kind, "ok");
    if (result.kind === "ok") {
      expect(result.payload[0]?.text).toBe("traced:c-1");
    }
  });

  it("退场件缺参 input → 非 error 文本投影(name/description/inputSchema),不提 tool_search", async () => {
    const registry = createAciRegistry([makeDeferrableBuiltin("get_record")]);
    registry.retireBuiltin(["get_record"]);
    const { perm, discoverCalls } = wire(registry);

    const gate = await perm.gateOne(
      { id: "sc4-2", name: "get_record", input: {} },
      undefined
    );
    assert.equal(gate.kind, "blocked");
    if (gate.kind === "blocked") {
      assert.equal(gate.result.kind, "ok"); // is_error = false
      const payload = (
        gate.result as unknown as { payload: Array<{ text: string }> }
      ).payload;
      const text = payload[0]!.text;
      assert.ok(!text.includes("not loaded"));
      assert.ok(!text.includes("tool_search"));
      const parsed = JSON.parse(text) as Record<string, unknown>;
      assert.equal(parsed.name, "get_record");
      assert.equal(parsed.description, "builtin get_record");
      assert.ok(parsed.inputSchema);
    }
    // discover 副作用照发(下一轮 schema 可见,模型能补 input)。
    assert.deepEqual(discoverCalls, ["get_record"]);
  });

  it("已 discover 的退场件再调 → 不重复 hydrate,直接放行", async () => {
    const registry = createAciRegistry([makeDeferrableBuiltin("web_fetch")]);
    registry.retireBuiltin(["web_fetch"]);
    registry.discover("web_fetch");
    const { perm, discoverCalls } = wire(registry);

    const gate = await perm.gateOne(
      { id: "sc4-3", name: "web_fetch", input: { conversation_id: "x" } },
      undefined
    );
    assert.equal(gate.kind, "proceed");
    assert.deepEqual(discoverCalls, [], "已 discover → 闸门不再调 discover");
  });

  it("常驻(非 lazy)内建件 → 不进 hydrate 分支,discover 零调用", async () => {
    const registry = createAciRegistry([makeDeferrableBuiltin("query_trace")]);
    // 不 retire → 仍常驻。
    const { perm, discoverCalls } = wire(registry);

    const gate = await perm.gateOne(
      { id: "sc4-4", name: "query_trace", input: { conversation_id: "y" } },
      undefined
    );
    assert.equal(gate.kind, "proceed");
    assert.deepEqual(discoverCalls, []);
    expect(registry.isDiscovered("query_trace")).toBe(false);
  });

  it("核心七件永不 lazy:retireBuiltin 名单外 → schema 常驻,闸门零 hydrate", async () => {
    const cores = [...CORE_TOOL_NAMES].map((n) => makeCoreBuiltin(n));
    const registry = createAciRegistry([
      ...cores,
      makeDeferrableBuiltin("web_search"),
    ]);
    registry.retireBuiltin(["web_search"]);
    const visible = registry.visibleSchemas().map((t) => t.name);
    for (const core of CORE_TOOL_NAMES) {
      expect(visible, `核心件 ${core} schema 应仍在首轮 tools[]`).toContain(
        core
      );
    }
    const { perm, discoverCalls } = wire(registry);
    const gate = await perm.gateOne(
      { id: "sc4-5", name: "bash", input: {} },
      undefined
    );
    assert.equal(gate.kind, "proceed");
    assert.deepEqual(discoverCalls, []);
  });
});
