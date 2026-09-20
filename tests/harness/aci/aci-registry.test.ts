/**
 * ACI Layer 0: aci-registry unit tests.
 * Covers: visibleSchemas lazy filtering / discover hit and miss / inner availability.
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
      makeTool({ name: "grep", lazy: true }), // lazy stub — registry protocol
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
  it("discover() 命中 lazy 工具后，visibleSchemas 尾部追加（非 lazy 注册序前缀不动）", () => {
    // b is lazy and registered before c — old behavior re-inserted it in
    // registration order [a, b, c]; new behavior appends at the tail →
    // [a, c, b] (the non-lazy prefix stays position-stable).
    const reg = createAciRegistry([
      makeTool({ name: "a" }),
      makeTool({ name: "b", lazy: true }),
      makeTool({ name: "c" }),
    ]);
    // initially: the lazy tool is absent from visibleSchemas
    const before = reg.visibleSchemas().map((t) => t.name);
    assert.deepEqual(before, ["a", "c"]);

    // discover("b") hits → marks it discovered
    const hit = reg.discover("b");
    assert.ok(hit !== undefined);

    // after marking: b is appended at the tail, non-lazy prefix [a, c] unchanged
    const after = reg.visibleSchemas().map((t) => t.name);
    assert.deepEqual(after, ["a", "c", "b"]);
  });

  it("多个 lazy 工具按 discovery 顺序追加到尾部", () => {
    const reg = createAciRegistry([
      makeTool({ name: "a" }),
      makeTool({ name: "l1", lazy: true }),
      makeTool({ name: "b" }),
      makeTool({ name: "l2", lazy: true }),
    ]);
    // deliberately discover against registration order — append order = discovery order
    reg.discover("l2");
    reg.discover("l1");
    assert.deepEqual(
      reg.visibleSchemas().map((t) => t.name),
      ["a", "b", "l2", "l1"]
    );
  });

  it("相邻两轮无新 discovery → visible 前缀逐位不变（KV cache 前缀稳定）", () => {
    const reg = createAciRegistry([
      makeTool({ name: "a" }),
      makeTool({ name: "X", lazy: true }),
      makeTool({ name: "c" }),
      makeTool({ name: "Y", lazy: true }),
    ]);
    reg.discover("X");
    const turn1 = reg.visibleSchemas().map((t) => t.name);
    assert.deepEqual(turn1, ["a", "c", "X"]);

    // the next adjacent turn: no new discovery
    const turn2 = reg.visibleSchemas().map((t) => t.name);
    // the first N items are equal position by position (N = turn1 length)
    assert.deepEqual(turn2.slice(0, turn1.length), turn1);
    assert.deepEqual(turn2, turn1);

    // discovering one more grows only the tail; the prefix stays position-stable
    reg.discover("Y");
    const turn3 = reg.visibleSchemas().map((t) => t.name);
    assert.deepEqual(turn3.slice(0, turn2.length), turn2);
    assert.deepEqual(turn3, ["a", "c", "X", "Y"]);
  });

  it("discover() 命中非 lazy 工具 → 不挪位，注册序前缀逐位不变（tool_search 全量命中路径）", () => {
    // tool_search calls discover() over every tool (including non-lazy); if an
    // already-discovered non-lazy tool were moved to the tail, a single search
    // would break the KV cache prefix.
    const reg = createAciRegistry([
      makeTool({ name: "a" }),
      makeTool({ name: "b" }),
      makeTool({ name: "X", lazy: true }),
      makeTool({ name: "c" }),
    ]);
    reg.discover("b"); // hits non-lazy
    reg.discover("X"); // hits lazy
    assert.deepEqual(
      reg.visibleSchemas().map((t) => t.name),
      ["a", "b", "c", "X"] // b keeps its registration slot; only lazy X is appended
    );
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
    // valid input passes
    assert.equal(validator!({ q: "hello" }), true);
    // invalid input (extra field) is rejected
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
