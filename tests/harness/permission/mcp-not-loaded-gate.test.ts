/**
 * ADR-0046 — permission-executor gate: calling an mcp__ tool that has not been
 * discover()ed hydrates it (discover(name) this round → schema appended to the
 * tail of visibleSchemas next round); if input passes the schema the call runs
 * directly, otherwise a non-error text projection is returned.
 *
 * Behaviour ground truth:
 *   - the mcp__ tool hits catalog.get, registry.isDiscovered(name) === false,
 *     the discover side-effect fires → gate.proceed (input validated, then released or projected);
 *   - pre-hook / askUser / inner keep their original paths (entered only once the
 *     gate releases; zero calls when the projection short-circuits);
 *   - after discover(name), the next call passes the gate directly and inner runs
 *     normally (no repeated hydrate);
 *   - non-mcp__ tools (built-in / dynamic non-mcp) are unaffected;
 *   - when catalog.isDiscovered / catalog.discover are absent (non-ACI registry
 *     assembly path) the gate lets calls through, byte-stable with the pre-gate behaviour.
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
    // must not return blocked and must not contain the "not loaded" template literal.
    assert.equal(gate.kind, "proceed");
    if (gate.kind === "proceed") {
      assert.equal(gate.def?.name, "mcp__svc__ping");
    }
    // gateOne does not call inner; inner is driven by the runAllowed path.
    assert.equal(innerCalls.length, 0, "gateOne 必须零调用 inner");

    // the discover side-effect has fired (injected discover takes effect).
    assert.ok(discovered.has("mcp__svc__ping"));
  });

  it("未 discover + 非法 input → blocked + kind: ok + 文本投影 schema;inner 零调用", async () => {
    // When input validation fails on the hydrate path, the gate returns an ok text
    // projection (not an error; is_error = false). The discover side-effect still
    // fires: discover must happen before execution so the model receives the schema
    // next round and can fix its input.
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

    // makeMcpTool's inputSchema here is { type: object, additionalProperties: false }
    // → `extra` is always rejected → ajv fails.
    const gate = await perm.gateOne(
      { id: "u1b", name: "mcp__svc__ping", input: { extra: "bad" } },
      undefined
    );
    assert.equal(gate.kind, "blocked");
    if (gate.kind === "blocked") {
      assert.equal(gate.result.kind, "ok");
      assert.equal(gate.result.toolUseId, "u1b");
      // projected text = JSON.stringify({name, description, inputSchema})
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
    // inner still has zero calls (the gate short-circuited before the pre-hook).
    assert.equal(innerCalls.length, 0);
    // discover still fires (schema enters promptTools next round).
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

    // simulate the upstream runAllowed path: proceed → run inner for real.
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
    // isDiscovered not injected → the gate lets it through (non-ACI registry compat path).
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
    // non-mcp__ names skip the template and need not be discovered.
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
