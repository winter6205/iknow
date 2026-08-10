/**
 * tests/harness/aci/tools/skill-search.test.ts
 *
 * `skill_search` 工具（第 23 件 ACI，#337 T5）单元测试 — 对齐 spec
 * 337-skill-mcp-extension.md § Code Style + T5 acceptance：
 *   - inputSchema `{query: string required}`
 *   - handler 返回 string,每行 `JSON.stringify({name, description})`
 *   - 空 query / 无匹配 → `"(no matches)"`(对齐 tool_search 语义)
 *   - 大小写不敏感子串匹配 name/description
 *   - 检索源不含 disabled(SC3/SC5)
 *   - aci 元数据：read-only / lazy:false / timeoutTier:fast
 *
 * **fixture 形态**：手工 entries（makeSkill helper）+ `createSkillCatalog`,
 * 不经 scanner 真实扫描 —— scanner 已由 T2 catalog/scanner.test.ts 锁。
 */
import { describe, expect, it } from "vitest";
import {
  createSkillCatalog,
  type SkillEntry,
} from "../../../../src/harness/skill/catalog.js";
import { createSkillSearchTool } from "../../../../src/harness/aci/tools/skill-search.js";
import type { AciToolDef } from "../../../../src/harness/aci/types.js";

function makeSkill(
  overrides: Partial<SkillEntry> & Pick<SkillEntry, "name" | "dir">
): SkillEntry {
  return {
    description: "default",
    disabled: false,
    ...overrides,
  };
}

function invokeSearch(tool: AciToolDef, input: unknown): string {
  const handler = tool.handler as (input: unknown) => unknown;
  return handler(input) as string;
}

describe("skill_search — 元数据 (G1 Q1 / T5 acceptance 2)", () => {
  it("name === 'skill_search'", () => {
    const tool = createSkillSearchTool({
      catalog: createSkillCatalog([]),
    });
    expect(tool.name).toBe("skill_search");
  });

  it("aci: read-only / lazy:false / timeoutTier:fast", () => {
    const tool = createSkillSearchTool({
      catalog: createSkillCatalog([]),
    });
    expect(tool.aci.category).toBe("read-only");
    expect(tool.aci.lazy).toBe(false);
    expect(tool.aci.timeoutTier).toBe("fast");
  });

  it("inputSchema: { query: string required, additionalProperties:false }", () => {
    const tool = createSkillSearchTool({
      catalog: createSkillCatalog([]),
    });
    expect(tool.inputSchema).toMatchObject({
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
      additionalProperties: false,
    });
  });
});

describe("skill_search — 大小写不敏感子串匹配 name/description", () => {
  it("query 'ROOT' 大小写不敏感命中 description 'Find ROOT Causes'", () => {
    const catalog = createSkillCatalog([
      makeSkill({
        name: "Debugger",
        dir: "/skills/Debugger",
        description: "Find ROOT Causes",
      }),
      makeSkill({
        name: "writer",
        dir: "/skills/writer",
        description: "Writes reports",
      }),
    ]);
    const tool = createSkillSearchTool({ catalog });
    const out = invokeSearch(tool, { query: "ROOT" });
    const names = out.split("\n").map((l) => JSON.parse(l).name as string);
    expect(names).toEqual(["Debugger"]);
  });

  it("query 'debug' 命中 name(子串)", () => {
    const catalog = createSkillCatalog([
      makeSkill({
        name: "Debugger",
        dir: "/skills/Debugger",
        description: "Find ROOT Causes",
      }),
    ]);
    const tool = createSkillSearchTool({ catalog });
    const out = invokeSearch(tool, { query: "debug" });
    const parsed = out.split("\n").map((l) => JSON.parse(l));
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({ name: "Debugger" });
  });

  it("命中 name + description 都满足时只返回一条", () => {
    const catalog = createSkillCatalog([
      makeSkill({
        name: "alpha-search",
        dir: "/skills/alpha-search",
        description: "search the alpha registry",
      }),
    ]);
    const tool = createSkillSearchTool({ catalog });
    const out = invokeSearch(tool, { query: "search" });
    const lines = out.split("\n");
    expect(lines).toHaveLength(1);
  });

  it("多命中 → 多行 JSON(每行 {name, description})", () => {
    const catalog = createSkillCatalog([
      makeSkill({
        name: "foo_one",
        dir: "/skills/foo_one",
        description: "vtool aa",
      }),
      makeSkill({
        name: "foo_two",
        dir: "/skills/foo_two",
        description: "vtool bb",
      }),
      makeSkill({
        name: "bar",
        dir: "/skills/bar",
        description: "other",
      }),
    ]);
    const tool = createSkillSearchTool({ catalog });
    const out = invokeSearch(tool, { query: "foo" });
    const lines = out.split("\n");
    expect(lines).toHaveLength(2);
    const parsed = lines.map((l) => JSON.parse(l));
    const names = parsed.map((p) => p.name).sort();
    expect(names).toEqual(["foo_one", "foo_two"]);
  });
});

describe("skill_search — wire 形态 = 每行 {name, description} JSON", () => {
  it("返回 typeof === 'string'", () => {
    const catalog = createSkillCatalog([
      makeSkill({
        name: "alpha",
        dir: "/skills/alpha",
        description: "desc alpha",
      }),
    ]);
    const tool = createSkillSearchTool({ catalog });
    const out = invokeSearch(tool, { query: "alpha" });
    expect(typeof out).toBe("string");
  });

  it("每行 JSON.parse → {name, description};不含其它字段", () => {
    const catalog = createSkillCatalog([
      makeSkill({
        name: "alpha",
        dir: "/skills/alpha",
        description: "desc alpha",
      }),
    ]);
    const tool = createSkillSearchTool({ catalog });
    const out = invokeSearch(tool, { query: "alpha" });
    const parsed = JSON.parse(out) as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual(["description", "name"]);
    expect(parsed).toMatchObject({
      name: "alpha",
      description: "desc alpha",
    });
  });
});

describe("skill_search — 空 query / 无匹配 → '(no matches)'", () => {
  it("空 query → '(no matches)'", () => {
    const catalog = createSkillCatalog([
      makeSkill({
        name: "alpha",
        dir: "/skills/alpha",
        description: "desc",
      }),
    ]);
    const tool = createSkillSearchTool({ catalog });
    expect(invokeSearch(tool, { query: "" })).toBe("(no matches)");
  });

  it("query 不匹配任何 name/description → '(no matches)'", () => {
    const catalog = createSkillCatalog([
      makeSkill({
        name: "alpha",
        dir: "/skills/alpha",
        description: "first tool",
      }),
    ]);
    const tool = createSkillSearchTool({ catalog });
    expect(invokeSearch(tool, { query: "gamma" })).toBe("(no matches)");
  });

  it("空 catalog → '(no matches)'(handler 不抛)", () => {
    const catalog = createSkillCatalog([]);
    const tool = createSkillSearchTool({ catalog });
    expect(invokeSearch(tool, { query: "anything" })).toBe("(no matches)");
  });
});

describe("skill_search — disabled 不出现在检索结果(SC3)", () => {
  it("disabled skill 不出现在子串命中集合", () => {
    const catalog = createSkillCatalog([
      makeSkill({
        name: "secret-root",
        dir: "/skills/secret-root",
        description: "hidden root cause",
        disabled: true,
      }),
      makeSkill({
        name: "Debugger",
        dir: "/skills/Debugger",
        description: "Find ROOT Causes",
      }),
    ]);
    const tool = createSkillSearchTool({ catalog });
    const out = invokeSearch(tool, { query: "root" });
    const names = out
      .split("\n")
      .filter((l) => l !== "(no matches)")
      .map((l) => JSON.parse(l).name as string);
    expect(names).toEqual(["Debugger"]);
    expect(names).not.toContain("secret-root");
  });
});
