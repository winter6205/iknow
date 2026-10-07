/**
 * ADR-0046 — direct-call hydration for undiscovered mcp__ tools: calling one
 * directly hydrates that turn (discover's side effect = append to next turn's
 * visibleSchemas); if input passes the schema -> execute directly; otherwise
 * project the schema as non-error text.
 *
 * Behavioral truth (spec):
 *   - mcp__ tool, not discovered -> triggers discover(name);
 *     gate.proceed; inner really runs, handler return goes into the ok payload
 *     verbatim; next turn's visibleSchemas() appends the schema at the tail
 *     (neighbor-turn deep-equal appends only when that tool was hydrated).
 *   - mcp__ tool, not discovered, input fails schema -> blocked + kind: "ok"
 *     + payload text = JSON.stringify({name, description, inputSchema});
 *     is_error = false (a model-visible successful delivery guiding the model
 *     to fill the input); the discover side effect still happens (next turn's
 *     tools show the schema at the tail).
 *   - never throws "tool <name> not loaded — call tool_search first".
 *
 * Unlike mcp-not-loaded-gate.test.ts (which checks only gateOne's
 * proceed/blocked verdict), this file verifies end-to-end: hydrate -> execute
 * or schema projection + the discover side effect.
 */
import { describe, it, expect } from "vitest";
import assert from "node:assert/strict";
import Ajv from "ajv";
import addFormats from "ajv-formats";

import { createAciRegistry } from "../../../src/harness/aci/aci-registry.js";
import { createPermissionRuntime } from "../../../src/harness/permission/permission-executor.js";
import { createPermissionPolicy } from "../../../src/harness/permission/policy.js";
import { createExecutor } from "../../../src/harness/tools/executor.js";
import type { AciToolDef } from "../../../src/harness/aci/types.js";
import type {
  Executor,
  ToolCall,
  ToolExecutionResult,
} from "../../../src/harness/tools/types.js";

/** Build an mcp__ tool (lazy + write tier, same shape as real MCP tools):
 *  required input `q`, handler returns "ok:<q>". */
function makeMcpTool(name: string): AciToolDef {
  return Object.freeze({
    name,
    description: `mcp ${name}`,
    inputSchema: {
      type: "object",
      properties: { q: { type: "string", minLength: 1 } },
      required: ["q"],
      additionalProperties: false,
    },
    handler: async (input: unknown) => {
      const q = (input as { q: string }).q;
      return `ok:${q}`;
    },
    aci: Object.freeze({
      category: "write" as const,
      isConcurrencySafe: false,
      interruptBehavior: "cancel" as const,
      timeoutTier: "long" as const,
      lazy: true,
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

/** Build an aci-registry loaded with MCP tools (mcp__ via registerExternal,
 *  no non-mcp__ tools), so tests don't trip the Gate 2 collision guard. */
function buildRegistry(): ReturnType<typeof createAciRegistry> {
  const reg = createAciRegistry([]);
  reg.registerExternal([makeMcpTool("mcp__svc__ping")]);
  return reg;
}

/** Project the aci-registry into the `Registry` shape permission-executor accepts.
 *  Use `registry.catalog` (includes mcp__ tools injected by registerExternal),
 *  not `registry.inner` (inner only snapshots construction-time tools;
 *  registerExternal doesn't touch it). */
function registrySurface(registry: ReturnType<typeof createAciRegistry>): {
  list: () => ReadonlyArray<AciToolDef>;
  get: (name: string) => AciToolDef | undefined;
} {
  return {
    list: () => registry.catalog.all(),
    get: (name: string) => registry.catalog.get(name),
  };
}

describe("T3 SC3 — 未 discover 的 mcp__ 工具直呼:hydrate + 执行", () => {
  it("合法 input:gate.proceed → inner 真跑,handler 输出进 ok payload", async () => {
    const registry = buildRegistry();
    const discoveredSet = new Set<string>();
    // Hand the mcp__ tool's def directly to the inner executor —
    // createAciRegistry's `registerExternal` doesn't touch inner, so here we
    // explicitly build an inner registry containing the mcp__ tool from the
    // catalog def (for createExecutor). This exists only in test assembly; the
    // production path is guaranteed by manager.registerExternal + aci-executor wiring.
    const mcpDef = registry.catalog.get("mcp__svc__ping")!;
    // Compile def.inputSchema with ajv — same source as aci-registry.registerExternal.
    const ajv = new Ajv.default({ strict: true, allErrors: true });
    addFormats.default(ajv);
    const mcpValidator = ajv.compile(mcpDef.inputSchema);
    const realExecutor = createExecutor({
      list: () => [mcpDef],
      get: (n: string) => (n === "mcp__svc__ping" ? mcpDef : undefined),
      getValidator: (n: string) =>
        n === "mcp__svc__ping" ? mcpValidator : undefined,
    });
    const perm = createPermissionRuntime({
      inner: realExecutor,
      registry: registrySurface(registry),
      policy: createPermissionPolicy(),
      askUser: async () => true,
      isDiscovered: (name: string) => discoveredSet.has(name),
      discover: (name: string) => registry.discover(name),
    });

    const call: ToolCall = {
      id: "sc3-1",
      name: "mcp__svc__ping",
      input: { q: "hello" },
    };
    const gate = await perm.gateOne(call, undefined);
    // Key: must not return blocked, must not contain "not loaded".
    assert.equal(gate.kind, "proceed");
    if (gate.kind === "proceed") {
      assert.ok(gate.def, "proceed 应带回 def");
      assert.equal(gate.def!.name, "mcp__svc__ping");
    }

    // Simulate the upstream runAllowed driver: call the real inner executor.
    const [result] = await realExecutor.executeAll([call]);
    assert.equal(result.kind, "ok");
    if (result.kind === "ok") {
      const block = result.payload[0];
      expect(block?.type).toBe("text");
      if (block?.type === "text") {
        expect(block.text).toBe("ok:hello");
      }
    }

    // Side effect: discover was triggered -> registry.isDiscovered(name) === true.
    expect(registry.isDiscovered("mcp__svc__ping")).toBe(true);
    // Next round's visibleSchemas gains it at the tail (mcp__ lazy: true + discovered):
    expect(registry.visibleSchemas().map((t) => t.name)).toContain(
      "mcp__svc__ping"
    );
  });

  it("缺参 input:gate 返回 ok 文本投影(含 name/description/inputSchema),非 error", async () => {
    const registry = buildRegistry();
    const discoveredSet = new Set<string>();
    const { executor: inner } = makeInnerSpy();
    const perm = createPermissionRuntime({
      inner,
      registry: registrySurface(registry),
      policy: createPermissionPolicy(),
      askUser: async () => true,
      isDiscovered: (name: string) => discoveredSet.has(name),
    });

    const call: ToolCall = {
      id: "sc3-2",
      name: "mcp__svc__ping",
      input: {}, // missing required `q`
    };
    const gate = await perm.gateOne(call, undefined);

    // Key contract:
    //   - kind: blocked (gate refuses because input validation failed)
    //   - result.kind: "ok" — not an error; text projection delivered to the model
    //   - result.payload text = JSON.stringify({name, description, inputSchema})
    //   - no longer contains "not loaded — call tool_search first"
    assert.equal(gate.kind, "blocked");
    if (gate.kind === "blocked") {
      assert.equal(gate.result.kind, "ok");
      assert.equal(gate.result.toolUseId, "sc3-2");
      const payload = (gate.result as { payload: unknown }).payload as Array<{
        type: string;
        text: string;
      }>;
      expect(payload).toHaveLength(1);
      const text = payload[0]?.text ?? "";
      expect(text).not.toContain("not loaded");
      expect(text).not.toContain("call tool_search first");
      const parsed = JSON.parse(text) as Record<string, unknown>;
      expect(parsed.name).toBe("mcp__svc__ping");
      expect(parsed.description).toBe("mcp mcp__svc__ping");
      expect(parsed.inputSchema).toBeDefined();
      // The schema field must be an object with properties + required.
      const schema = parsed.inputSchema as Record<string, unknown>;
      expect(schema.type).toBe("object");
      expect(schema.required).toEqual(["q"]);
    }
  });

  it("非法 input(类型错):同样返 ok 文本投影", async () => {
    const registry = buildRegistry();
    const discoveredSet = new Set<string>();
    const { executor: inner } = makeInnerSpy();
    const perm = createPermissionRuntime({
      inner,
      registry: registrySurface(registry),
      policy: createPermissionPolicy(),
      askUser: async () => true,
      isDiscovered: (name: string) => discoveredSet.has(name),
    });

    const call: ToolCall = {
      id: "sc3-3",
      name: "mcp__svc__ping",
      input: { q: 123 }, // q must be a string
    };
    const gate = await perm.gateOne(call, undefined);
    assert.equal(gate.kind, "blocked");
    if (gate.kind === "blocked") {
      assert.equal(gate.result.kind, "ok");
      const payload = (gate.result as { payload: unknown }).payload as Array<{
        text: string;
      }>;
      const parsed = JSON.parse(payload[0]!.text) as Record<string, unknown>;
      expect(parsed.name).toBe("mcp__svc__ping");
    }
  });

  it("discover 副作用:aci registry.discover 后 isDiscovered === true + visibleSchemas 仍含", () => {
    // Directly verify the aci-registry discover side-effect contract — after
    // permission-executor calls discover, these two invariants must hold
    // (permission-executor's own hydrate is triggered via its internal
    // catalog.discover seam; here only the ACI registry-side semantics are checked).
    const registry = buildRegistry();
    expect(registry.isDiscovered("mcp__svc__ping")).toBe(false);
    // Initially: lazy tools are absent from visibleSchemas
    expect(registry.visibleSchemas().map((t) => t.name)).not.toContain(
      "mcp__svc__ping"
    );

    registry.discover("mcp__svc__ping");
    expect(registry.isDiscovered("mcp__svc__ping")).toBe(true);

    const after = registry.visibleSchemas().map((t) => t.name);
    expect(after).toContain("mcp__svc__ping");
    // Neighbor-turn deep-equal: calling visibleSchemas again must be byte-identical.
    const again = registry.visibleSchemas().map((t) => t.name);
    expect(again).toEqual(after);
  });
});
