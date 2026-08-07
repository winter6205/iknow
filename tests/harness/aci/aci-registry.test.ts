/**
 * ACI 原型 Layer 0：aci-registry 单元测试。
 * 覆盖：visibleSchemas 过滤 lazy / discover 命中与未命中 / inner 可用。
 */

import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { createAciRegistry } from "../../../src/harness/aci/aci-registry.ts";
import type { AciToolDef } from "../../../src/harness/aci/types.ts";

interface MakeToolOpts {
  readonly name: string;
  readonly lazy?: boolean;
}

function makeTool(opts: MakeToolOpts): AciToolDef {
  const { name, lazy = false } = opts;
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
      ...(lazy ? { lazy: true } : {}),
    },
  });
}

describe("createAciRegistry — visibleSchemas 过滤 lazy", () => {
  it("非 lazy 工具出现在 visibleSchemas，lazy 工具不出现", () => {
    const reg = createAciRegistry([
      makeTool({ name: "bash" }),
      makeTool({ name: "read_file" }),
      makeTool({ name: "grep", lazy: true }), // lazy stub — registry 协议
    ]);
    const visible = reg.visibleSchemas();
    const names = visible.map((t) => t.name);
    assert.ok(names.includes("bash"));
    assert.ok(names.includes("read_file"));
    assert.ok(!names.includes("grep"));
    assert.equal(visible.length, 2);
  });

  it("全部非 lazy → visibleSchemas 包含所有工具", () => {
    const reg = createAciRegistry([
      makeTool({ name: "a" }),
      makeTool({ name: "b" }),
    ]);
    assert.equal(reg.visibleSchemas().length, 2);
  });

  it("全部 lazy → visibleSchemas 为空", () => {
    const reg = createAciRegistry([
      makeTool({ name: "a", lazy: true }),
      makeTool({ name: "b", lazy: true }),
    ]);
    assert.equal(reg.visibleSchemas().length, 0);
  });
});

describe("createAciRegistry — discover", () => {
  it("命中已注册工具（含 lazy）", () => {
    const reg = createAciRegistry([
      makeTool({ name: "bash" }),
      makeTool({ name: "grep", lazy: true }),
    ]);
    const found = reg.discover("grep");
    assert.ok(found !== undefined);
    assert.equal(found!.name, "grep");
  });

  it("未注册工具 → undefined", () => {
    const reg = createAciRegistry([makeTool({ name: "bash" })]);
    assert.equal(reg.discover("nonexistent"), undefined);
  });
});

describe("createAciRegistry — catalog", () => {
  it("catalog.get 命中与未命中", () => {
    const reg = createAciRegistry([makeTool({ name: "bash" })]);
    assert.ok(reg.catalog.get("bash") !== undefined);
    assert.equal(reg.catalog.get("nope"), undefined);
  });

  it("catalog.all 返回全量（含 lazy）", () => {
    const reg = createAciRegistry([
      makeTool({ name: "bash" }),
      makeTool({ name: "grep", lazy: true }),
    ]);
    assert.equal(reg.catalog.all().length, 2);
  });
});

describe("createAciRegistry — 装配期三闸门（#224 Gate 1 / Gate 2）", () => {
  it("Gate 1：tool_search 标 lazy=true → 抛 RegistryConstructionError", () => {
    assert.throws(
      () =>
        createAciRegistry([
          makeTool({ name: "bash" }),
          makeTool({ name: "tool_search", lazy: true }),
        ]),
      (err: unknown) =>
        err instanceof Error &&
        err.message.includes("bootstrap") &&
        err.message.includes("lazy=true")
    );
  });

  it("Gate 2：工具名以 mcp__ 开头 → 抛 RegistryConstructionError", () => {
    assert.throws(
      () => createAciRegistry([makeTool({ name: "mcp__foo" })]),
      (err: unknown) =>
        err instanceof Error &&
        err.message.includes("mcp__") &&
        err.message.includes("mcp__foo")
    );
  });

  it("Gate 2（正例）：名字含 mcp__ 但不以其开头 → 不抛", () => {
    const reg = createAciRegistry([makeTool({ name: "my_mcp_tool" })]);
    assert.equal(reg.visibleSchemas().length, 1);
  });
});

describe("createAciRegistry — discovered set（#224）", () => {
  it("discover() 命中 lazy 工具后，visibleSchemas 从下一轮起包含它", () => {
    const reg = createAciRegistry([
      makeTool({ name: "a" }),
      makeTool({ name: "X", lazy: true }),
    ]);
    // 初始：lazy 工具不在 visibleSchemas
    const before = reg.visibleSchemas().map((t) => t.name);
    assert.ok(!before.includes("X"));

    // discover("X") 命中 → 标记 discovered
    const hit = reg.discover("X");
    assert.ok(hit !== undefined);

    // 标记后：X 进入 visibleSchemas，且插入序 = tools 顺序（a 在前，X 在后）
    const after = reg.visibleSchemas().map((t) => t.name);
    assert.deepEqual(after, ["a", "X"]);
  });

  it("discover() 未注册名 → 返回 undefined，visibleSchemas 不变", () => {
    const reg = createAciRegistry([
      makeTool({ name: "a" }),
      makeTool({ name: "X", lazy: true }),
    ]);
    const before = reg.visibleSchemas();
    const miss = reg.discover("nonexistent");
    assert.equal(miss, undefined);
    assert.deepEqual(reg.visibleSchemas(), before);
  });

  it("行为中性：全非 lazy 时 visibleSchemas == !lazy 过滤 == registry.list() 同名", () => {
    const tools = [
      makeTool({ name: "a" }),
      makeTool({ name: "b" }),
      makeTool({ name: "c" }),
    ];
    const reg = createAciRegistry(tools);
    const viaVisibleSchema = reg.visibleSchemas().map((t) => t.name);
    const viaLazyFilter = tools.filter((t) => !t.aci.lazy).map((t) => t.name);
    const viaRegistryList = reg.inner.list().map((t) => t.name);
    assert.deepEqual(viaVisibleSchema, viaLazyFilter);
    assert.deepEqual(viaVisibleSchema, viaRegistryList);
  });
});

describe("createAciRegistry — inner 可用", () => {
  it("inner.get 返回 ToolDef（协议 registry 正常工作）", () => {
    const reg = createAciRegistry([makeTool({ name: "bash" })]);
    const def = reg.inner.get("bash");
    assert.ok(def !== undefined);
    assert.equal(def!.name, "bash");
  });

  it("inner.list 返回所有注册工具", () => {
    const reg = createAciRegistry([
      makeTool({ name: "a" }),
      makeTool({ name: "b" }),
    ]);
    assert.equal(reg.inner.list().length, 2);
  });

  it("inner.getValidator 返回已编译 validator（ajv 正常工作）", () => {
    const reg = createAciRegistry([makeTool({ name: "bash" })]);
    const validator = reg.inner.getValidator("bash");
    assert.ok(validator !== undefined);
    // 合法输入通过
    assert.equal(validator!({ q: "hello" }), true);
    // 非法输入（额外字段）被拒绝
    assert.equal(validator!({ q: "hello", extra: 1 }), false);
  });

  it("重复工具名 → 构造期抛出 RegistryConstructionError", () => {
    assert.throws(
      () =>
        createAciRegistry([
          makeTool({ name: "dup" }),
          makeTool({ name: "dup" }),
        ]),
      (err: unknown) =>
        err instanceof Error && err.message.includes("duplicate")
    );
  });
});
