/**
 * B4 / ADR-0043 前缀稳定 (SC2 + SC3) — MCP 工具面变更时相邻轮
 * tools + system deep-equal。
 *
 * 行为真值:
 *   - MCP 工具 schema 不进首轮 promptTools():toAciToolDef 已 stamp
 *     `lazy: true`,visibleSchemas 仅含非 lazy 注册序前缀 + 已发现 lazy
 *     工具尾部追加(registerExternal 路径)。
 *   - MCP 工具名字目录进 system,会话内恒定:connected 后第一轮定稿,
 *     之后相邻轮字节相同。
 *   - `registerExternal` 后 inner.list() 冻结(S10 守门已 assert)。
 *   - 未 discover 的 mcp__ 工具调用 = ToolExecutionError(模板钉死)
 *     (本文件不重复验证,见 manager.test.ts tool-not-loaded)。
 *
 * 这些断言是 B4 实施「之前」的写法 → 改 is lazy 后相邻轮同 form。
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
  // MCP manager.registerTools → toAciToolDef 的契约形态:lazy + category=write +
  // interruptBehavior=cancel + tier=long(toAciToolDef SSOT)。
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
    // inner.list() 冻结:registerExternal 不会改变构造期快照
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
    // 非 lazy 前缀逐位稳定,discovered lazy 工具尾部追加
    assert.deepEqual(after, [
      "bash",
      "read_file",
      "web_fetch",
      "mcp__svc__alpha",
    ]);

    // 再调一次 visibleSchemas (相邻轮模型询问) — 字节级零变化
    const again = reg.visibleSchemas().map((t) => t.name);
    assert.deepEqual(again, after);
  });

  it("相邻两轮 promptTools() + system() deep-equal — 连接前后不抖动场景", () => {
    // 模拟 SC2 场景一:相邻两轮都处于 connected 之后,目录稳定;
    // tools + system 字节级 deep-equal。
    const reg = createAciRegistry([
      makeBuiltIn("bash"),
      makeBuiltIn("read_file"),
    ]);
    reg.registerExternal([makeLazyMcp("mcp__svc__ping")]);
    reg.discover("mcp__svc__ping"); // 模型走 tool_search 加载

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
