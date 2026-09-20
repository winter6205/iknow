/**
 * ADR-0043 prefix stability — across MCP tool-surface changes, adjacent turns'
 * tools + system must stay deep-equal.
 *
 * Behavioral ground truth:
 *   - MCP tool schemas never enter the first turn's promptTools():
 *     toAciToolDef stamps `lazy: true`, so visibleSchemas holds only the
 *     non-lazy registration-order prefix plus discovered lazy tools appended
 *     at the tail (registerExternal path).
 *   - The MCP tool name directory lives in system and is constant within a
 *     session: finalized on the first turn after connected; later adjacent
 *     turns are byte-identical.
 *   - After `registerExternal`, inner.list() is frozen.
 *   - Invoking an undiscovered mcp__ tool = ToolExecutionError (verified in
 *     manager.test.ts tool-not-loaded, not repeated here).
 */
import assert from "node:assert/strict";
import { describe, it } from "vitest";

import { createAciRegistry } from "../../../src/harness/aci/aci-registry.js";
import type { AciToolDef } from "../../../src/harness/aci/types.js";

function makeBuiltIn(name: string): AciToolDef {
  return Object.freeze({
    name,
    description: `built-in ${name}`,
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    handler: async () => "ok",
    aci: {
      category: "read-only" as const,
      isConcurrencySafe: true,
      interruptBehavior: "cancel" as const,
      timeoutTier: "fast" as const,
    },
  });
}

function makeLazyMcp(name: string): AciToolDef {
  // Contract shape of MCP manager.registerTools → toAciToolDef: lazy +
  // category=write + interruptBehavior=cancel + tier=long (toAciToolDef SSOT).
  return Object.freeze({
    name,
    description: `mcp ${name}`,
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    handler: async () => "ok",
    aci: {
      category: "write" as const,
      isConcurrencySafe: false,
      interruptBehavior: "cancel" as const,
      timeoutTier: "long" as const,
      lazy: true,
    },
  });
}

describe("MCP 工具面变更时 prefix deep-equal (SC2 / ADR-0043)", () => {
  it("registerExternal 注册的 mcp__ 工具默认 lazy,不进首轮 visibleSchemas", () => {
    const reg = createAciRegistry([
      makeBuiltIn("bash"),
      makeBuiltIn("read_file"),
    ]);
    reg.registerExternal([makeLazyMcp("mcp__svc__ping")]);

    const before = reg.visibleSchemas().map((t) => t.name);
    assert.deepEqual(before, ["bash", "read_file"]);
    // inner.list() is frozen: registerExternal never changes the construction-time snapshot
    assert.equal(reg.inner.list().length, 2);
  });

  it("discover 后 mcp__ 工具尾部追加,非 lazy 注册序前缀逐位不变", () => {
    const reg = createAciRegistry([
      makeBuiltIn("bash"),
      makeBuiltIn("read_file"),
      makeBuiltIn("web_fetch"),
    ]);
    reg.registerExternal([
      makeLazyMcp("mcp__svc__alpha"),
      makeLazyMcp("mcp__svc__beta"),
    ]);

    reg.discover("mcp__svc__alpha");

    const after = reg.visibleSchemas().map((t) => t.name);
    // Non-lazy prefix stable position-by-position; discovered lazy tools append at the tail
    assert.deepEqual(after, [
      "bash",
      "read_file",
      "web_fetch",
      "mcp__svc__alpha",
    ]);

    // Call visibleSchemas again (next-turn model query) — zero byte-level change
    const again = reg.visibleSchemas().map((t) => t.name);
    assert.deepEqual(again, after);
  });

  it("相邻两轮 promptTools() + system() deep-equal — 连接前后不抖动场景", () => {
    // Both adjacent turns sit after connected with a stable directory;
    // tools + system are byte-level deep-equal.
    const reg = createAciRegistry([
      makeBuiltIn("bash"),
      makeBuiltIn("read_file"),
    ]);
    reg.registerExternal([makeLazyMcp("mcp__svc__ping")]);
    reg.discover("mcp__svc__ping"); // the model loads it via tool_search

    const toolsTurn1 = reg.visibleSchemas();
    const systemTurn1 =
      "<mcp_name_directory>\nsvc: ping\n</mcp_name_directory>";
    const turns = [
      { tools: toolsTurn1, system: systemTurn1 },
      { tools: reg.visibleSchemas(), system: systemTurn1 },
    ];
    const first = turns[0];
    for (let i = 1; i < turns.length; i++) {
      assert.deepEqual(turns[i], first, `turn ${i} 不与 turn 0 字节级一致`);
    }
  });
});
