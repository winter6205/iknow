/**
 * 回归测试：MCP 动态注册工具经 permission-executor 可执行。
 *
 * 背景（#337）：MCP 扩展源通过 `reg.registerExternal(defs)` 动态注册
 * `mcp__` 前缀工具。早期的 `createAciCatalog.get` 用构造期快照
 * `byName`，导致：
 *   1. permission-executor 把动态工具当作 catalog miss → 直接 delegate
 *      inner；
 *   2. 而 inner（来自 `createExecutor(reg.inner)`）也是构造期快照，
 *      没有动态工具 → 返 `tool_not_found`。
 *
 * 修复后契约：registerExternal 注册的 mcp__ 工具必须经
 * `executor.executeAll` 真实可执行（handler 被调、payload 含 marker）。
 *
 * 本测试断言三个稳定阶段：
 *   - 构造后/注册前：executeAll 同名 mcp__ 工具 → tool_not_found（红路径）
 *   - registerExternal 后：executeAll 同名 → kind="ok" + marker（绿路径）
 *   - 注册前的 catalog.get(name) === undefined；注册后 === dyn def
 *
 * 不修改任何 src/ 文件；只用 vitest + stub def + 本地 handler。
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

/** marker：handler 被真实调用时由 ok payload 携带。 */
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
 * 构造一个 inner executor：在执行时从 catalog 动态查 def（模拟真实的
 * loop-engine 行为，关键差别是 lookup 是 call-time 而非构造期）。
 * 这样 registerExternal 追加的 mcp__ 工具，inner 也能解析。
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

    // 关键观察：catalog.get 此刻确实取不到（动态源为空）
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
    // 决定性断言：handler 未被调、payload 无 marker、kind === tool_not_found
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

    // 模拟 MCP manager 的 T1 缝：registerExternal 动态注册 mcp__ 工具
    const dyn = makeDynamicMcpTool("mcp__server__dyn", DYNAMIC_MARKER);
    reg.registerExternal([dyn]);

    // 注册后 catalog.get 应命中动态 def（这是修复后的契约）
    const hit = reg.catalog.get("mcp__server__dyn");
    assert.ok(hit, "registerExternal 后 catalog.get 必须命中动态 def");
    assert.equal(hit!.aci.category, "read-only");

    const results = await executor.executeAll([
      { id: "u2", name: "mcp__server__dyn", input: {} },
    ]);

    assert.equal(results.length, 1);
    const r = results[0]!;
    // 决定性断言：handler 必须被真实调用、payload 必须含 marker
    //   这同时证明：(a) catalog.get 在 executeAll 路径上是动态的；
    //               (b) permission-executor 没把 mcp__ 当作 miss delegate；
    //               (c) inner 经 catalog 也能解析到 handler。
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
    // 这条断言锁定动态源的"注册即查询"对称性，防止 catalog.get 默默
    // 返回另一个被冻结的副本（registration 实际写的是这个 Map 吗？）。
    const reg = createAciRegistry([makeStaticReadOnlyTool("read_file")]);
    const dyn = makeDynamicMcpTool("mcp__server__dyn", DYNAMIC_MARKER);

    reg.registerExternal([dyn]);

    const got = reg.catalog.get("mcp__server__dyn");
    assert.ok(got, "动态 get 必须返回非 undefined");
    assert.equal(got!.name, dyn.name);
    assert.equal(got!.description, dyn.description);
    // handler 身份相等（同一引用）—— handler 是动态工具的核心执行单元
    assert.equal(got!.handler, dyn.handler);
    assert.equal(got!.aci.category, dyn.aci.category);
  });
});
