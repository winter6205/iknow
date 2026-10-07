/**
 * ADR-0046 — direct-call hydration for builtins retired by schema overflow.
 *
 * Pinned invariants:
 *   - A builtin retired by schema overflow (`retireBuiltin` stamps
 *     `aci.lazy: true`) takes the same hydrate path as `mcp__` tools when
 *     called directly: `discover(name)` this round -> schema appended to next
 *     round's `visibleSchemas()` tail; input passes schema -> execute directly;
 *     no `tool_search` prerequisite.
 *   - The decision is `def.aci.lazy === true && !isDiscovered(name)` (never by
 *     name prefix). Core tools are never lazy (`CORE_TOOL_NAMES` is pruned in
 *     the retirement-candidate derivation) -> they never enter the hydrate branch.
 *   - Resident (non-lazy) builtins are unaffected: the gate skips discover and
 *     proceeds straight to the permission layer.
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

/** Deferrable builtin (retirement-candidate shape): required input
 *  `conversation_id`, handler returns "traced:<id>". */
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

/** Core-tool shape (never deferrable / never lazy). */
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

/** Wire a permission runtime whose registry face reads the aci-registry
 *  catalog live (after retireBuiltin, catalog.get returns the new def stamped lazy:true). */
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
    // First round: both schemas are in the visible prefix (not retired yet).
    expect(registry.visibleSchemas().map((t) => t.name)).toContain(
      "query_trace"
    );
    // Overflow retirement: stamps aci.lazy:true -> schema leaves the visible set.
    registry.retireBuiltin(["query_trace"]);
    expect(registry.visibleSchemas().map((t) => t.name)).not.toContain(
      "query_trace"
    );
    // Core tools' schemas remain (retirement never touches them).
    expect(registry.visibleSchemas().map((t) => t.name)).toContain("bash");

    const { perm, discoverCalls } = wire(registry);
    const call: ToolCall = {
      id: "sc4-1",
      name: "query_trace",
      input: { conversation_id: "c-1" },
    };
    const gate = await perm.gateOne(call, undefined);
    // Key: no tool_search prerequisite — a direct call proceeds immediately.
    assert.equal(gate.kind, "proceed");
    if (gate.kind === "proceed") {
      assert.equal(gate.def?.name, "query_trace");
    }
    // Hydration side effect: discover(name) this round.
    assert.deepEqual(discoverCalls, ["query_trace"]);
    expect(registry.isDiscovered("query_trace")).toBe(true);
    // Next round: the schema is appended to the visibleSchemas tail.
    expect(registry.visibleSchemas().map((t) => t.name)).toContain(
      "query_trace"
    );

    // Once it proceeds, the handler really runs; its output goes verbatim into the ok payload.
    const result = await perm.runAllowed(
      call,
      gate.kind === "proceed" ? gate.def : undefined
    );
    assert.equal(result.kind, "ok");
    if (result.kind === "ok") {
      const block = result.payload[0];
      assert.equal(block?.type, "text");
      if (block?.type === "text") {
        assert.equal(block.text, "traced:c-1");
      }
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
    // The discover side effect still fires (schema visible next round, so the model can fill input).
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
    // not retired -> still resident
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
