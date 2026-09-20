/**
 * Regression test: MCP dynamically registered tools are executable through
 * the permission-executor.
 *
 * Background: MCP extension sources register `mcp__`-prefixed tools
 * dynamically via `reg.registerExternal(defs)`. Early `createAciCatalog.get`
 * used a construction-time snapshot of `byName`, which caused:
 *   1. the permission-executor treated dynamic tools as catalog misses →
 *      delegating straight to inner;
 *   2. but inner (from `createExecutor(reg.inner)`) was also a construction-
 *      time snapshot without the dynamic tools → returned `tool_not_found`.
 *
 * Post-fix contract: mcp__ tools registered via registerExternal must be
 * genuinely executable through `executor.executeAll` (handler invoked,
 * payload carries a marker).
 *
 * This test asserts three stable stages:
 *   - after construction / before registration: executeAll on the same
 *     mcp__ tool → tool_not_found (red-path control)
 *   - after registerExternal: executeAll on the same tool → kind="ok" + marker
 *   - catalog.get(name) === undefined before registration; === dyn def after
 *
 * Touches no src/ files; uses only vitest + stub defs + a local handler.
 */

import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { createAciRegistry } from "../../../src/harness/aci/aci-registry.ts";
import { createAciExecutor } from "../../../src/harness/aci/aci-executor.ts";
import { createPermissionPolicy } from "../../../src/harness/aci/permission.ts";
import type { AciCatalog, AciToolDef } from "../../../src/harness/aci/types.ts";
import type {
  Executor,
  ToolCall,
  ToolExecutionResult,
} from "../../../src/harness/tools/types.ts";

/** Marker: carried by the ok payload only when the handler truly ran. */
const DYNAMIC_MARKER = "dynamic-ok";

function makeStaticReadOnlyTool(name: string): AciToolDef {
  return Object.freeze({
    name,
    description: `static ${name}`,
    inputSchema: { type: "object", properties: {} },
    handler: async () => "static-ok",
    aci: Object.freeze({
      category: "read-only" as const,
      isConcurrencySafe: true,
      interruptBehavior: "cancel" as const,
      timeoutTier: "fast" as const,
    }),
  });
}

function makeDynamicMcpTool(name: string, marker: string): AciToolDef {
  return Object.freeze({
    name,
    description: `dynamic ${name}`,
    inputSchema: { type: "object", properties: {} },
    handler: async () => marker,
    aci: Object.freeze({
      category: "read-only" as const,
      isConcurrencySafe: true,
      interruptBehavior: "cancel" as const,
      timeoutTier: "fast" as const,
    }),
  });
}

/**
 * Build an inner executor that looks up defs from the catalog at execution
 * time (modeling real loop-engine behavior; the key difference is call-time
 * lookup instead of construction-time). This way mcp__ tools appended by
 * registerExternal resolve in inner too.
 */
function makeCatalogBackedInner(catalog: AciCatalog): Executor {
  return Object.freeze({
    executeAll: async (
      calls: ReadonlyArray<ToolCall>
    ): Promise<ReadonlyArray<ToolExecutionResult>> => {
      const out: ToolExecutionResult[] = [];
      for (const c of calls) {
        const def = catalog.get(c.name);
        if (!def) {
          out.push({
            kind: "tool_not_found",
            toolUseId: c.id,
            toolName: c.name,
          });
          continue;
        }
        const payload = await def.handler(c.input, { signal: undefined });
        out.push({
          kind: "ok",
          toolUseId: c.id,
          payload: [{ type: "text", text: String(payload) }],
        });
      }
      return out;
    },
  });
}

describe("MCP 动态注册工具经 executor 可执行（回归 #337）", () => {
  it("registerExternal 前：executeAll 同名 mcp__ 工具 → tool_not_found（红路径对照）", async () => {
    const reg = createAciRegistry([makeStaticReadOnlyTool("read_file")]);
    const inner = makeCatalogBackedInner(reg.catalog);
    const policy = createPermissionPolicy();
    const executor = createAciExecutor({
      inner,
      catalog: reg.catalog,
      policy,
      askUser: async () => true,
    });

    // Key observation: catalog.get genuinely misses right now (dynamic source empty)
    assert.equal(
      reg.catalog.get("mcp__server__dyn"),
      undefined,
      "构造期 catalog 不应包含未注册的工具"
    );

    const results = await executor.executeAll([
      { id: "u1", name: "mcp__server__dyn", input: {} },
    ]);

    assert.equal(results.length, 1);
    const r = results[0]!;
    // Decisive assertion: handler not called, payload without marker, kind === tool_not_found
    assert.equal(r.kind, "tool_not_found");
    if (r.kind === "tool_not_found") {
      assert.equal(r.toolName, "mcp__server__dyn");
      assert.equal(r.toolUseId, "u1");
    }
  });

  it("registerExternal 后：executeAll 同名 mcp__ 工具 → ok 且 payload 含 marker（绿路径）", async () => {
    const reg = createAciRegistry([makeStaticReadOnlyTool("read_file")]);
    const inner = makeCatalogBackedInner(reg.catalog);
    const policy = createPermissionPolicy();
    const executor = createAciExecutor({
      inner,
      catalog: reg.catalog,
      policy,
      askUser: async () => true,
    });

    // Modeling the MCP manager's dynamic-registration seam: registerExternal
    // registers the mcp__ tool dynamically
    const dyn = makeDynamicMcpTool("mcp__server__dyn", DYNAMIC_MARKER);
    reg.registerExternal([dyn]);

    // ADR-0043: the permission-executor requires `discover()` to have marked
    // the name before an mcp__ tool call. The test calls it once explicitly,
    // simulating the real assembly path where tool_search has already
    // retrieved this tool.
    reg.discover(dyn.name);

    // After registration catalog.get must hit the dynamic def (the post-fix contract)
    const hit = reg.catalog.get("mcp__server__dyn");
    assert.ok(hit, "registerExternal 后 catalog.get 必须命中动态 def");
    assert.equal(hit!.aci.category, "read-only");

    const results = await executor.executeAll([
      { id: "u2", name: "mcp__server__dyn", input: {} },
    ]);

    assert.equal(results.length, 1);
    const r = results[0]!;
    // Decisive assertion: the handler must genuinely be called and the payload
    // must carry the marker. This simultaneously proves:
    //   (a) catalog.get is dynamic on the executeAll path;
    //   (b) the permission-executor does not treat mcp__ as a miss to delegate;
    //   (c) inner resolves the handler through the catalog as well.
    assert.equal(r.kind, "ok");
    if (r.kind === "ok") {
      assert.equal(r.toolUseId, "u2");
      assert.ok(
        r.payload.some(
          (p) => p.type === "text" && p.text.includes(DYNAMIC_MARKER)
        ),
        `payload 应包含 marker '${DYNAMIC_MARKER}', got: ${JSON.stringify(
          r.payload
        )}`
      );
    }
  });

  it("registerExternal 后：catalog.get 的动态 hit 与 registerExternal 入参 def 身份一致", async () => {
    // This assertion locks the "register-equals-query" symmetry of the
    // dynamic source, preventing catalog.get from silently returning another
    // frozen copy (is registration really writing into this Map?).
    const reg = createAciRegistry([makeStaticReadOnlyTool("read_file")]);
    const dyn = makeDynamicMcpTool("mcp__server__dyn", DYNAMIC_MARKER);

    reg.registerExternal([dyn]);

    const got = reg.catalog.get("mcp__server__dyn");
    assert.ok(got, "动态 get 必须返回非 undefined");
    assert.equal(got!.name, dyn.name);
    assert.equal(got!.description, dyn.description);
    // handler identity equality (same reference) — the handler is the core execution unit of a dynamic tool
    assert.equal(got!.handler, dyn.handler);
    assert.equal(got!.aci.category, dyn.aci.category);
  });
});
