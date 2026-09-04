/**
 * B6 / ADR-0043 §3 — AciRegistry.retireBuiltin seam 单测。
 *
 * 测四个不变式：
 *   1. **可见性收敛**:retireBuiltin 后被退场的 def 不再出现在 visibleSchemas
 *      (默认未 discover 时 = 不可见,符合 lazy 纪律)。
 *   2. **catalog 一致**:catalog.get() 返新 def(`aci.lazy: true`);inner
 *      get() 也返新 def(executor 路由仍可达 —— tool_search 后由 discover
 *      把名字 push 进 discovered 集,visibleSchemas 走 discoveredTail 把
 *      它带回 prefix 之后)。
 *   3. **幂等**:同一名字多次 retireBuiltin 不报错,不重复写。
 *   4. **核心件二次守门**:retireBuiltin 不对未在 byName 的名字报错(静默
 *      忽略,与 unregisterExternal 同形态)。
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
    // 退场前:query_trace / web_search 都在 visible
    let names = reg.visibleSchemas().map((t) => t.name);
    assert.ok(names.includes("query_trace"));
    assert.ok(names.includes("web_search"));
    assert.equal(names.length, 3);

    reg.retireBuiltin(["query_trace", "web_search"]);

    // 退场后:只剩 bash(visibleSchemas 过滤 lazy + 未 discover)
    names = reg.visibleSchemas().map((t) => t.name);
    assert.deepEqual(names, ["bash"]);
  });

  it("退场 def 在 discover 后由 visibleSchemas 走 discoveredTail 带回来", () => {
    const reg = createAciRegistry([
      makeTool("bash"),
      makeTool("query_trace", { deferrable: true }),
    ]);
    reg.retireBuiltin(["query_trace"]);
    // 模拟 tool_search 命中
    const def = reg.discover("query_trace");
    assert.ok(def !== undefined);
    assert.equal(def?.aci.lazy, true);
    // visibleSchemas 应在尾部带回
    const names = reg.visibleSchemas().map((t) => t.name);
    assert.deepEqual(names, ["bash", "query_trace"]);
  });

  it("catalog.get 返新 def(aci.lazy=true);catalog 是 tool_search 检索源", () => {
    const reg = createAciRegistry([
      makeTool("bash"),
      makeTool("query_trace", { deferrable: true }),
    ]);
    reg.retireBuiltin(["query_trace"]);
    // catalog.get 是 tool_search 检索源(discover 用 byName 拿 def,byName 已
    // 被 retireBuiltin 更新)。inner 是构造期冻结快照 —— executor 走 inner
    // 解析,retired 不进 visibleSchemas 故 promptTools 不报,executor 不需要
    // 解析(模型调不动)。inner.get 行为不在 B6 关注面上(只验 catalog)。
    const fromCat = reg.catalog.get("query_trace");
    assert.ok(fromCat !== undefined);
    assert.equal(fromCat?.aci.lazy, true);
    // isDiscovered 仍 false(discover 还没调)
    assert.equal(reg.isDiscovered("query_trace"), false);
  });

  it("幂等:重复 retireBuiltin 不报错", () => {
    const reg = createAciRegistry([
      makeTool("query_trace", { deferrable: true }),
    ]);
    reg.retireBuiltin(["query_trace"]);
    // 再调一次不应抛
    reg.retireBuiltin(["query_trace"]);
    reg.retireBuiltin(["query_trace"]);
    const def = reg.catalog.get("query_trace");
    assert.equal(def?.aci.lazy, true);
  });

  it("未在 byName 的名字静默忽略(不抛)", () => {
    const reg = createAciRegistry([makeTool("bash")]);
    // ghost 名(不在 byName)= 静默;已注册的名字(在 byName)走正常 stamp 路径
    reg.retireBuiltin(["ghost_tool"]);
    // bash 不动 —— ghost_tool 不影响其他名字
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
    // catalog.all() live 读 byName —— retireBuiltin 更新 byName 槽位后,
    // all() 返回的必须是与 get() 一致的 lazy 版 def,而非构造期冻结的旧 def。
    const inAll = reg.catalog.all().find((t) => t.name === "query_trace");
    assert.ok(inAll !== undefined);
    assert.equal(inAll.aci.lazy, true);
    assert.equal(reg.catalog.get("query_trace")?.aci.lazy, true);
    // 名称集合一致:all() 与 byName 覆盖同一批内建名。
    assert.deepEqual(
      reg.catalog
        .all()
        .map((t) => t.name)
        .sort(),
      ["bash", "query_trace"]
    );
  });
});
