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
