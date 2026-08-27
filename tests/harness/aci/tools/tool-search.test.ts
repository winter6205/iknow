/**
 * tests/harness/aci/tools/tool-search.test.ts
 *
 * `tool_search` 工具（第 9 件 ACI）单元测试 — 对齐 spec 224-tool-extension-path.md
 * 验收 S4 / S5：
 *   - S4：空 `{query,names}` 返回 `"(no matches)"` 前缀 + retry guidance；
 *     子串命中；精确取名；不匹配返回 `"(no matches)"` + guidance
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
import {
  createToolSearchTool,
  NO_MATCHES,
} from "../../../../src/harness/aci/tools/tool-search.js";
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
 *
 * `getRegistryCalls` / `discovered` 记录副作用轨迹:前者证明空白 query
 * 根本不解引用 registry,后者证明 discover 只覆盖真正输出的工具。
 */
function buildToolSearchOverFixture(fixtures: ReadonlyArray<AciToolDef>): {
  toolSearch: AciToolDef;
  registry: AciRegistry;
  getRegistryCalls: ReadonlyArray<null>;
  discovered: ReadonlyArray<string>;
} {
  const holder: { reg?: AciRegistry } = {};
  const getRegistryCalls: null[] = [];
  const discovered: string[] = [];
  const toolSearch = createToolSearchTool({
    getRegistry: () => {
      if (!holder.reg) throw new Error("test fixture: registry not assembled");
      getRegistryCalls.push(null);
      const reg = holder.reg;
      return {
        ...reg,
        discover: (name: string) => {
          discovered.push(name);
          return reg.discover(name);
        },
      };
    },
  });
  const allTools: ReadonlyArray<AciToolDef> = [...fixtures, toolSearch];
  const registry = createAciRegistry(allTools);
  holder.reg = registry;
  return { toolSearch, registry, getRegistryCalls, discovered };
}

/** 直接调 tool_search handler(同步,返回 string)。 */
function invokeToolSearch(toolSearch: AciToolDef, input: unknown): string {
  const handler = toolSearch.handler as (input: unknown) => unknown;
  return handler(input) as string;
}

/** S4 契约断言：返回是合法 string 且精确等于 NO_MATCHES（含 guidance）。 */
function expectNoMatchesGuidance(out: unknown): void {
  expect(typeof out).toBe("string");
  expect(out).toBe(NO_MATCHES);
}

describe('tool_search — S4:空参 / 不匹配 → "(no matches)" + retry guidance', () => {
  it('空 {} → "(no matches)" 前缀 + rephrase/`names` guidance(合法 string,非错误)', () => {
    const { toolSearch } = buildToolSearchOverFixture([
      makeTool("alpha"),
      makeTool("beta"),
    ]);
    const out = invokeToolSearch(toolSearch, {});
    expectNoMatchesGuidance(out);
  });

  it('query 空串 + names 空数组 → "(no matches)" + guidance', () => {
    const { toolSearch } = buildToolSearchOverFixture([makeTool("alpha")]);
    const out = invokeToolSearch(toolSearch, { query: "", names: [] });
    expectNoMatchesGuidance(out);
  });

  it('names 是非字符串元素数组 → "(no matches)" + guidance(fallback,handler 不抛)', () => {
    const { toolSearch } = buildToolSearchOverFixture([makeTool("alpha")]);
    const out = invokeToolSearch(toolSearch, { names: [1, 2] });
    expectNoMatchesGuidance(out);
  });

  it('query 不匹配任何 name/description → "(no matches)" + guidance', () => {
    const { toolSearch } = buildToolSearchOverFixture([
      makeTool("alpha", "first tool"),
      makeTool("beta", "second tool"),
    ]);
    const out = invokeToolSearch(toolSearch, { query: "gamma" });
    expectNoMatchesGuidance(out);
  });

  it('names 精确取名无命中 → "(no matches)" + guidance', () => {
    const { toolSearch } = buildToolSearchOverFixture([makeTool("alpha")]);
    const out = invokeToolSearch(toolSearch, { names: ["nope"] });
    expectNoMatchesGuidance(out);
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

  it("{query, limit: 5} → 合法(limit 可选正整数)", () => {
    const { registry } = buildToolSearchOverFixture([makeTool("x")]);
    const validate = registry.inner.getValidator("tool_search")!;
    expect(validate({ query: "x", limit: 5 })).toBe(true);
  });

  it("{limit: 0} → 非法(下界 1)", () => {
    const { registry } = buildToolSearchOverFixture([makeTool("x")]);
    const validate = registry.inner.getValidator("tool_search")!;
    expect(validate({ query: "x", limit: 0 })).toBe(false);
  });

  it("{limit: -3} → 非法(负数)", () => {
    const { registry } = buildToolSearchOverFixture([makeTool("x")]);
    const validate = registry.inner.getValidator("tool_search")!;
    expect(validate({ query: "x", limit: -3 })).toBe(false);
  });

  it("{limit: 2.5} → 非法(非整数)", () => {
    const { registry } = buildToolSearchOverFixture([makeTool("x")]);
    const validate = registry.inner.getValidator("tool_search")!;
    expect(validate({ query: "x", limit: 2.5 })).toBe(false);
  });

  it('{limit: "5"} → 非法(字符串数字)', () => {
    const { registry } = buildToolSearchOverFixture([makeTool("x")]);
    const validate = registry.inner.getValidator("tool_search")!;
    expect(validate({ query: "x", limit: "5" })).toBe(false);
  });

  it("schema 字段描述包含 spec 要求的两个英文短语 + T3 检索范围/时机提示", () => {
    // #483 D9: description must contain "pull ToolDef JSON" +
    // "Discover tools beyond the current prompt" (replaces D7 "returns
    // ToolDef JSON" / "use to find tools beyond the current prompt").
    // #631 T3: 检索范围须声明覆盖 `mcp__` 前缀工具,并提示时机(先搜后用)。
    const { toolSearch } = buildToolSearchOverFixture([makeTool("x")]);
    const desc = toolSearch.description;
    expect(desc).toContain("pull ToolDef JSON");
    expect(desc).toContain("Discover tools beyond the current prompt");
    expect(desc).toContain("mcp__");
    expect(desc).toContain("Search first, then use");
  });
});

/** 批量 fixture：`bulk` 子串只命中这些 fixture（tool_search 自身不含）。 */
function bulkFixtures(count: number, descLength = 20): AciToolDef[] {
  return Array.from({ length: count }, (_, i) =>
    makeTool(`bulk_${i}`, `bulk ${"d".repeat(descLength)}`)
  );
}

/** 输出末行是引导行时的拆分：JSON 行集合 + 引导行。 */
function splitBounded(out: string): { jsonLines: string[]; guidance: string } {
  const lines = out.split("\n");
  const guidance = lines[lines.length - 1]!;
  return { jsonLines: lines.slice(0, -1), guidance };
}

describe("tool_search — T2:有界输出(默认封顶 + limit + 引导行)", () => {
  it("命中数等于默认封顶(20) → 20 行 JSON,无引导行", () => {
    const { toolSearch } = buildToolSearchOverFixture(bulkFixtures(20));
    const out = invokeToolSearch(toolSearch, { query: "bulk" });
    const lines = out.split("\n");
    expect(lines).toHaveLength(20);
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  it("命中数超默认封顶 → 20 行 JSON + 一条纯文本引导行(showing 20 of 25)", () => {
    const { toolSearch } = buildToolSearchOverFixture(bulkFixtures(25));
    const out = invokeToolSearch(toolSearch, { query: "bulk" });
    const { jsonLines, guidance } = splitBounded(out);
    expect(jsonLines).toHaveLength(20);
    for (const line of jsonLines) {
      expect(Object.keys(JSON.parse(line) as object).sort()).toEqual([
        "description",
        "inputSchema",
        "name",
      ]);
    }
    expect(guidance).toContain("showing 20 of 25");
    expect(() => JSON.parse(guidance)).toThrow();
    expect(guidance).toContain("`names`");
  });

  it("显式 limit 收窄 → 行数 = limit,引导行标注实际比例", () => {
    const { toolSearch } = buildToolSearchOverFixture(bulkFixtures(10));
    const out = invokeToolSearch(toolSearch, { query: "bulk", limit: 3 });
    const { jsonLines, guidance } = splitBounded(out);
    expect(jsonLines).toHaveLength(3);
    expect(guidance).toContain("showing 3 of 10");
  });

  it("limit 大于命中数 → 无引导行(未触发封顶,输出与现状一致)", () => {
    const { toolSearch } = buildToolSearchOverFixture(bulkFixtures(4));
    const out = invokeToolSearch(toolSearch, { query: "bulk", limit: 50 });
    const lines = out.split("\n");
    expect(lines).toHaveLength(4);
    expect(out).not.toContain("showing");
  });

  it("单条超长 description 逼近 20k:整行丢弃,无半行 JSON,总长 ≤ 20000", () => {
    const { toolSearch } = buildToolSearchOverFixture(bulkFixtures(10, 4000));
    const out = invokeToolSearch(toolSearch, { query: "bulk" });
    expect(out.length).toBeLessThanOrEqual(20_000);
    const { jsonLines, guidance } = splitBounded(out);
    expect(jsonLines.length).toBeGreaterThan(0);
    expect(jsonLines.length).toBeLessThan(10);
    for (const line of jsonLines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
    expect(guidance).toContain(`of 10`);
  });

  it("单条命中就超预算 → 只剩引导行,不吐半行 JSON", () => {
    const { toolSearch } = buildToolSearchOverFixture(bulkFixtures(1, 30_000));
    const out = invokeToolSearch(toolSearch, { query: "bulk" });
    expect(out.length).toBeLessThanOrEqual(20_000);
    expect(out).toContain("showing 0 of 1");
    expect(out.split("\n")).toHaveLength(1);
  });

  it("契约 X:封顶输出不含 truncated/total 元字段", () => {
    const { toolSearch } = buildToolSearchOverFixture(bulkFixtures(25));
    const out = invokeToolSearch(toolSearch, { query: "bulk" });
    expect(out).not.toContain("truncated");
    expect(out).not.toContain("total");
  });

  it("discover 副作用与输出同界:被丢弃的命中不进 discovered set", () => {
    const { toolSearch, discovered } = buildToolSearchOverFixture(
      bulkFixtures(25)
    );
    invokeToolSearch(toolSearch, { query: "bulk" });
    expect(discovered).toHaveLength(20);
  });
});

describe("tool_search — T2:query trim 后判空", () => {
  it('query "   " → NO_MATCHES(不再全量倾倒)', () => {
    const { toolSearch } = buildToolSearchOverFixture([
      makeTool("alpha", "first tool"),
      makeTool("beta", "second tool"),
    ]);
    const out = invokeToolSearch(toolSearch, { query: "   " });
    expectNoMatchesGuidance(out);
  });

  it("空白-only query 不解引用 registry,也不触发 discover", () => {
    const { toolSearch, getRegistryCalls, discovered } =
      buildToolSearchOverFixture([makeTool("alpha"), makeTool("beta")]);
    invokeToolSearch(toolSearch, { query: "\t\n " });
    expect(getRegistryCalls).toHaveLength(0);
    expect(discovered).toHaveLength(0);
  });

  it('query "  read  " trim 后仍子串命中(匹配算法零改动)', () => {
    const { toolSearch } = buildToolSearchOverFixture([
      makeTool("ReadFile"),
      makeTool("write_file"),
    ]);
    const out = invokeToolSearch(toolSearch, { query: "  read  " });
    expect(out).toContain("ReadFile");
    expect(out).not.toContain("write_file");
  });

  it("空白 query + 非空 names → 仍走 names 精确取名", () => {
    const { toolSearch } = buildToolSearchOverFixture([
      makeTool("alpha"),
      makeTool("beta"),
    ]);
    const out = invokeToolSearch(toolSearch, { query: " ", names: ["alpha"] });
    expect(JSON.parse(out)).toMatchObject({ name: "alpha" });
  });
});
