/**
 * ADR-0043 — AciRegistry.retireBuiltin seam unit tests.
 *
 * Four invariants:
 *   1. **Visibility convergence**: after retireBuiltin the retired def is gone
 *      from visibleSchemas (not yet discovered = invisible, per lazy discipline).
 *   2. **Catalog consistency**: catalog.get() returns the new def (`aci.lazy: true`);
 *      the executor routing stays reachable — after tool_search, discover() pushes
 *      the name into the discovered set and visibleSchemas brings it back via
 *      discoveredTail after the prefix.
 *   3. **Idempotence**: repeated retireBuiltin of the same name neither throws nor
 *      double-writes.
 *   4. **Silent miss**: retireBuiltin does not throw for names absent from byName
 *      (ignored quietly, same shape as unregisterExternal).
 */

import { describe, it } from "vitest";
import assert from "node:assert/strict";

import { createAciRegistry } from "../../../src/harness/aci/aci-registry.ts";
import type { AciToolDef } from "../../../src/harness/aci/types.ts";

function makeTool(
  name: string,
  overrides: Partial<{ deferrable: boolean; lazy: boolean }> = {}
): AciToolDef {
  return Object.freeze({
    name,
    description: `test ${name}`,
    inputSchema: {
      type: "object",
      properties: { q: { type: "string" } },
      additionalProperties: false,
    },
    handler: async () => "ok",
    aci: {
      category: "read-only" as const,
      isConcurrencySafe: true,
      interruptBehavior: "cancel" as const,
      timeoutTier: "fast" as const,
      ...(overrides.deferrable ? { deferrable: true } : {}),
      ...(overrides.lazy ? { lazy: true } : {}),
    },
  });
}

describe("AciRegistry.retireBuiltin — B6 退场 seam", () => {
  it("retireBuiltin 后退场 def 退出 visibleSchemas(默认未 discover)", () => {
    const reg = createAciRegistry([
      makeTool("bash"),
      makeTool("query_trace", { deferrable: true }),
      makeTool("web_search", { deferrable: true }),
    ]);
    // before retiring: query_trace / web_search are both visible
    let names = reg.visibleSchemas().map((t) => t.name);
    assert.ok(names.includes("query_trace"));
    assert.ok(names.includes("web_search"));
    assert.equal(names.length, 3);

    reg.retireBuiltin(["query_trace", "web_search"]);

    // after retiring: only bash remains (visibleSchemas filters lazy + undiscovered)
    names = reg.visibleSchemas().map((t) => t.name);
    assert.deepEqual(names, ["bash"]);
  });

  it("退场 def 在 discover 后由 visibleSchemas 走 discoveredTail 带回来", () => {
    const reg = createAciRegistry([
      makeTool("bash"),
      makeTool("query_trace", { deferrable: true }),
    ]);
    reg.retireBuiltin(["query_trace"]);
    // simulate a tool_search hit
    const def = reg.discover("query_trace");
    assert.ok(def !== undefined);
    assert.equal(def?.aci.lazy, true);
    // visibleSchemas should bring it back at the tail
    const names = reg.visibleSchemas().map((t) => t.name);
    assert.deepEqual(names, ["bash", "query_trace"]);
  });

  it("catalog.get 返新 def(aci.lazy=true);catalog 是 tool_search 检索源", () => {
    const reg = createAciRegistry([
      makeTool("bash"),
      makeTool("query_trace", { deferrable: true }),
    ]);
    reg.retireBuiltin(["query_trace"]);
    // catalog.get is tool_search's retrieval source (discover() resolves the def
    // via byName, which retireBuiltin has already updated). inner is a frozen
    // construction-time snapshot — retired tools never enter visibleSchemas, so
    // the model cannot invoke them and the executor need not resolve them;
    // inner.get behavior is out of scope here (only the catalog is verified).
    const fromCat = reg.catalog.get("query_trace");
    assert.ok(fromCat !== undefined);
    assert.equal(fromCat?.aci.lazy, true);
    // discover() has not been called yet, so isDiscovered stays false
    assert.equal(reg.isDiscovered("query_trace"), false);
  });

  it("幂等:重复 retireBuiltin 不报错", () => {
    const reg = createAciRegistry([
      makeTool("query_trace", { deferrable: true }),
    ]);
    reg.retireBuiltin(["query_trace"]);
    // repeat calls must not throw
    reg.retireBuiltin(["query_trace"]);
    reg.retireBuiltin(["query_trace"]);
    const def = reg.catalog.get("query_trace");
    assert.equal(def?.aci.lazy, true);
  });

  it("未在 byName 的名字静默忽略(不抛)", () => {
    const reg = createAciRegistry([makeTool("bash")]);
    // a ghost name (not in byName) is silent; registered names still take the normal stamp path
    reg.retireBuiltin(["ghost_tool"]);
    // bash untouched — ghost_tool must not affect other names
    const names = reg.visibleSchemas().map((t) => t.name);
    assert.deepEqual(names, ["bash"]);
  });

  it("空数组调用不报错(no-op)", () => {
    const reg = createAciRegistry([makeTool("bash")]);
    reg.retireBuiltin([]);
    const names = reg.visibleSchemas().map((t) => t.name);
    assert.deepEqual(names, ["bash"]);
  });

  it("retireBuiltin 后 catalog.all() 与 catalog.get() 同源(不残留 stale def)", () => {
    const reg = createAciRegistry([
      makeTool("bash"),
      makeTool("query_trace", { deferrable: true }),
    ]);
    reg.retireBuiltin(["query_trace"]);
    // catalog.all() reads byName live — after retireBuiltin updates the byName
    // slot, all() must return the same lazy def as get(), not the frozen
    // construction-time def.
    const inAll = reg.catalog.all().find((t) => t.name === "query_trace");
    assert.ok(inAll !== undefined);
    assert.equal(inAll.aci.lazy, true);
    assert.equal(reg.catalog.get("query_trace")?.aci.lazy, true);
    // name sets agree: all() covers exactly the built-in names in byName.
    assert.deepEqual(
      reg.catalog
        .all()
        .map((t) => t.name)
        .sort(),
      ["bash", "query_trace"]
    );
  });
});
