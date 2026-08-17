/**
 * tests/harness/aci/tools/tool-search.test.ts
 *
 * `tool_search` 工具（第 9 件 ACI）单元测试 — 对齐 spec 224-tool-extension-path.md
 * 验收 S4 / S5：
 *   - S4：空 `{query,names}` 返回 `"(no matches)"`；子串命中；精确取名；
 *     不匹配返回 `"(no matches)"`
 *   - S5：handler 返回 string；每行 JSON.parse → `{name, description, inputSchema}`
 *     不含 `aci` 泄漏
 *   - ajv input 校验：合法 schema + 拒非法类型 + 拒 additionalProperties
 *     (S4 / D9)
 *
 * 装配形态：复刻 registry.ts 的 holder 模式 —— 用 `makeTool` 装配 fixture
 * registry,tool_search 的 `getRegistry` 解引用该 fixture 闭包,跑完后
 * `assembled.reg = fixtureReg` 让 tool_search 内部可见。
 */
import { describe, expect, it } from "vitest";
import { createAciRegistry } from "../../../../src/harness/aci/aci-registry.js";
import { createToolSearchTool } from "../../../../src/harness/aci/tools/tool-search.js";
import type {
  AciRegistry,
  AciToolDef,
} from "../../../../src/harness/aci/types.js";

/** 复刻 aci-registry.test.ts 的 makeTool fixture:纯 read-only stub。 */
function makeTool(name: string, description = `fixture ${name}`): AciToolDef {
  return Object.freeze({
    name,
    description,
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
    },
  });
}

/**
 * 装配 fixture registry + tool_search(holder 模式):
 * `getRegistry` 闭包捕获 `holder`,tool_search 实际被调用时
 * `holder.reg` 已被赋值,正常返回。
 */
function buildToolSearchOverFixture(fixtures: ReadonlyArray<AciToolDef>): {
  toolSearch: AciToolDef;
  registry: AciRegistry;
} {
  const holder: { reg?: AciRegistry } = {};
  const toolSearch = createToolSearchTool({
    getRegistry: () => {
      if (!holder.reg) throw new Error("test fixture: registry not assembled");
      return holder.reg;
    },
  });
  const allTools: ReadonlyArray<AciToolDef> = [...fixtures, toolSearch];
  const registry = createAciRegistry(allTools);
  holder.reg = registry;
  return { toolSearch, registry };
}

/** 直接调 tool_search handler(同步,返回 string)。 */
function invokeToolSearch(toolSearch: AciToolDef, input: unknown): string {
  const handler = toolSearch.handler as (input: unknown) => unknown;
  return handler(input) as string;
}

describe('tool_search — S4:空参 / 不匹配 → "(no matches)"', () => {
  it('空 {} → 返回 "(no matches)"(ajv 接受,handler 判定)', () => {
    const { toolSearch } = buildToolSearchOverFixture([
      makeTool("alpha"),
      makeTool("beta"),
    ]);
    expect(invokeToolSearch(toolSearch, {})).toBe("(no matches)");
  });

  it('query 空串 + names 空数组 → "(no matches)"', () => {
    const { toolSearch } = buildToolSearchOverFixture([makeTool("alpha")]);
    expect(invokeToolSearch(toolSearch, { query: "", names: [] })).toBe(
      "(no matches)"
    );
  });

  it('names 是非字符串元素数组 → "(no matches)"(fallback,handler 不抛)', () => {
    const { toolSearch } = buildToolSearchOverFixture([makeTool("alpha")]);
    expect(invokeToolSearch(toolSearch, { names: [1, 2] })).toBe(
      "(no matches)"
    );
  });

  it('query 不匹配任何 name/description → "(no matches)"', () => {
    const { toolSearch } = buildToolSearchOverFixture([
      makeTool("alpha", "first tool"),
      makeTool("beta", "second tool"),
    ]);
    expect(invokeToolSearch(toolSearch, { query: "gamma" })).toBe(
      "(no matches)"
    );
  });

  it('names 精确取名无命中 → "(no matches)"', () => {
    const { toolSearch } = buildToolSearchOverFixture([makeTool("alpha")]);
    expect(invokeToolSearch(toolSearch, { names: ["nope"] })).toBe(
      "(no matches)"
    );
  });
});

describe("tool_search — S4:子串命中 / 精确取名", () => {
  it("query 大小写不敏感子串命中 name", () => {
    const { toolSearch } = buildToolSearchOverFixture([
      makeTool("ReadFile"),
      makeTool("write_file"),
    ]);
    const out = invokeToolSearch(toolSearch, { query: "read" });
    expect(out).toContain("ReadFile");
    expect(out).not.toContain("write_file");
  });

  it("query 大小写不敏感子串命中 description", () => {
    const { toolSearch } = buildToolSearchOverFixture([
      makeTool("alpha", "fast tool"),
      makeTool("beta", "slow tool"),
    ]);
    const out = invokeToolSearch(toolSearch, { query: "FAST" });
    expect(out).toContain("alpha");
    expect(out).not.toContain("beta");
  });

  it("query 子串匹配多个工具 → 返回多行 JSON", () => {
    const { toolSearch } = buildToolSearchOverFixture([
      makeTool("foo_one"),
      makeTool("foo_two"),
      makeTool("bar"),
    ]);
    const out = invokeToolSearch(toolSearch, { query: "foo" });
    const lines = out.split("\n");
    expect(lines).toHaveLength(2);
    const parsed = lines.map((l) => JSON.parse(l));
    const names = parsed.map((p) => p.name).sort();
    expect(names).toEqual(["foo_one", "foo_two"]);
  });

  it("names 精确取名命中(多个)", () => {
    const { toolSearch } = buildToolSearchOverFixture([
      makeTool("alpha"),
      makeTool("beta"),
      makeTool("gamma"),
    ]);
    const out = invokeToolSearch(toolSearch, { names: ["alpha", "gamma"] });
    const lines = out.split("\n");
    expect(lines).toHaveLength(2);
    const parsed = lines.map((l) => JSON.parse(l));
    expect(parsed.map((p) => p.name).sort()).toEqual(["alpha", "gamma"]);
  });

  it("discover 副作用:匹配后 catalog 内每个工具的 discover 命中", () => {
    const { toolSearch, registry } = buildToolSearchOverFixture([
      makeTool("alpha"),
      makeTool("beta"),
    ]);
    invokeToolSearch(toolSearch, { names: ["alpha", "beta"] });
    // 当前 registry.discover 是 byName 查询(无 lazy 集合也通过);
    // 验证匹配的工具都存在并可被 discover 命中。
    expect(registry.discover("alpha")?.name).toBe("alpha");
    expect(registry.discover("beta")?.name).toBe("beta");
  });
});

describe("tool_search — S5:wire 形态 = 字符串装 JSON", () => {
  it('handler 返回值 typeof === "string"', () => {
    const { toolSearch } = buildToolSearchOverFixture([makeTool("alpha")]);
    const out = invokeToolSearch(toolSearch, { names: ["alpha"] });
    expect(typeof out).toBe("string");
  });

  it("每行 JSON.parse → {name, description, inputSchema};不含 aci", () => {
    const def = makeTool("alpha", "desc alpha");
    const { toolSearch } = buildToolSearchOverFixture([def]);
    const out = invokeToolSearch(toolSearch, { names: ["alpha"] });
    const parsed = JSON.parse(out) as Record<string, unknown>;
    expect(parsed).toHaveProperty("name", "alpha");
    expect(parsed).toHaveProperty("description", "desc alpha");
    expect(parsed).toHaveProperty("inputSchema");
    // D6:不泄漏 aci 元数据 / handler。
    expect(parsed).not.toHaveProperty("aci");
    expect(parsed).not.toHaveProperty("handler");
  });

  it("多匹配时每行独立 JSON.parse,字段一致", () => {
    const { toolSearch } = buildToolSearchOverFixture([
      makeTool("a", "vtool aa"),
      makeTool("b", "vtool bb"),
    ]);
    // query "vtool" 只命中两个 fixture 的 description;tool_search 自身
    // description 不含 "vtool",不会误入。
    const out = invokeToolSearch(toolSearch, { query: "vtool" });
    const lines = out.split("\n");
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      expect(Object.keys(parsed).sort()).toEqual([
        "description",
        "inputSchema",
        "name",
      ]);
    }
  });
});

describe("tool_search — ajv input 校验 (S4 / D9)", () => {
  it("{} → 合法(ajv 接受,两字段均 optional)", () => {
    const { registry } = buildToolSearchOverFixture([makeTool("x")]);
    const validate = registry.inner.getValidator("tool_search");
    expect(validate).toBeDefined();
    expect(validate!({})).toBe(true);
  });

  it('{query: "x"} → 合法', () => {
    const { registry } = buildToolSearchOverFixture([makeTool("x")]);
    const validate = registry.inner.getValidator("tool_search")!;
    expect(validate({ query: "x" })).toBe(true);
  });

  it('{names: ["a"]} → 合法', () => {
    const { registry } = buildToolSearchOverFixture([makeTool("a")]);
    const validate = registry.inner.getValidator("tool_search")!;
    expect(validate({ names: ["a"] })).toBe(true);
  });

  it("{query: 123} → 非法(query 非 string)", () => {
    const { registry } = buildToolSearchOverFixture([makeTool("x")]);
    const validate = registry.inner.getValidator("tool_search")!;
    expect(validate({ query: 123 })).toBe(false);
  });

  it('{names: "notarray"} → 非法(names 非 array)', () => {
    const { registry } = buildToolSearchOverFixture([makeTool("x")]);
    const validate = registry.inner.getValidator("tool_search")!;
    expect(validate({ names: "notarray" })).toBe(false);
  });

  it('{query: "x", extra: 1} → 非法(additionalProperties)', () => {
    const { registry } = buildToolSearchOverFixture([makeTool("x")]);
    const validate = registry.inner.getValidator("tool_search")!;
    expect(validate({ query: "x", extra: 1 })).toBe(false);
  });

  it("schema 字段描述包含 spec 要求的两个英文短语", () => {
    // #483 D9: description must contain "pull ToolDef JSON" +
    // "Discover tools beyond the current prompt" (replaces D7 "returns
    // ToolDef JSON" / "use to find tools beyond the current prompt").
    const { toolSearch } = buildToolSearchOverFixture([makeTool("x")]);
    const desc = toolSearch.description;
    expect(desc).toContain("pull ToolDef JSON");
    expect(desc).toContain("Discover tools beyond the current prompt");
  });
});
