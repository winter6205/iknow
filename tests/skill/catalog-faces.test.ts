import { describe, expect, it } from "vitest";
import {
  createSkillCatalog,
  type SkillEntry,
} from "../../src/harness/skill/catalog.js";

function entry(
  overrides: Partial<SkillEntry> & Pick<SkillEntry, "name">
): SkillEntry {
  return {
    description: "default",
    dir: `/skills/${overrides.name}`,
    disabled: false,
    ...overrides,
  };
}

/**
 * The four entry classes from spec `skill-index-increment` Input-contract:
 * qualifying / disabled / no description / both combined; plus one plugin
 * canonical — its bare-name alias must never appear duplicated in any face.
 */
const FIXTURE: readonly SkillEntry[] = [
  entry({ name: "zulu" }),
  entry({ name: "alpha", description: "Alpha" }),
  entry({ name: "frozen", disabled: true }),
  entry({ name: "undocumented", description: undefined }),
  entry({ name: "boot-notes", description: undefined, disabled: true }),
  entry({
    name: "plugA:code-review",
    description: "review",
    namespace: "plugA",
  }),
];

const names = (entries: readonly SkillEntry[]): string[] =>
  entries.map(({ name }) => name);

const sortedNames = (entries: readonly SkillEntry[]): string[] =>
  names(entries).sort((a, b) => a.localeCompare(b));

describe("skill catalog faces（技能模型索引 vs 可加载技能面）", () => {
  it("empty：无条目 → 两面都是空数组", () => {
    const catalog = createSkillCatalog([]);

    expect(catalog.modelIndex()).toEqual([]);
    expect(catalog.loadable()).toEqual([]);
  });

  it("合格条目进模型索引（name 排序）；可加载面 = 全部 canonical 条目", () => {
    const catalog = createSkillCatalog(FIXTURE);

    expect(names(catalog.modelIndex())).toEqual([
      "alpha",
      "plugA:code-review",
      "zulu",
    ]);
    expect(sortedNames(catalog.loadable())).toEqual([
      "alpha",
      "boot-notes",
      "frozen",
      "plugA:code-review",
      "undocumented",
      "zulu",
    ]);
    // loadable face = all canonical entries; all() keeps insertion order while
    // loadable() sorts by name, so compare set equality by name, not order.
    expect(sortedNames(catalog.loadable())).toEqual(sortedNames(catalog.all()));
  });

  it("disable 条目（含叠加无 description）：只在可加载面，get 仍取到", () => {
    const catalog = createSkillCatalog(FIXTURE);

    expect(names(catalog.loadable())).toContain("boot-notes");
    expect(names(catalog.loadable())).toContain("frozen");
    expect(names(catalog.modelIndex())).not.toContain("boot-notes");
    expect(names(catalog.modelIndex())).not.toContain("frozen");
    expect(catalog.get("frozen")?.disabled).toBe(true);
    expect(catalog.get("boot-notes")?.disabled).toBe(true);
  });

  it("无 description 条目：只在可加载面，get 仍取到", () => {
    const catalog = createSkillCatalog(FIXTURE);

    expect(names(catalog.loadable())).toContain("undocumented");
    expect(names(catalog.modelIndex())).not.toContain("undocumented");
    expect(catalog.get("undocumented")?.description).toBeUndefined();
  });

  it("两面关系可判定：模型索引 ⊆ 可加载面，差集恰为不合格条目", () => {
    const catalog = createSkillCatalog(FIXTURE);

    const loadable = catalog.loadable();
    for (const e of catalog.modelIndex()) expect(loadable).toContain(e);

    const inIndex = new Set(names(catalog.modelIndex()));
    const outsideIndex = loadable.filter((e) => !inIndex.has(e.name));
    expect(sortedNames(outsideIndex)).toEqual([
      "boot-notes",
      "frozen",
      "undocumented",
    ]);
    for (const e of outsideIndex) {
      expect(e.disabled || e.description === undefined).toBe(true);
    }
  });

  it("plugin canonical + 裸名别名：两面都只出 canonical 一条", () => {
    const catalog = createSkillCatalog([
      entry({
        name: "plugA:code-review",
        description: "review",
        namespace: "plugA",
      }),
    ]);

    expect(names(catalog.loadable())).toEqual(["plugA:code-review"]);
    expect(names(catalog.modelIndex())).toEqual(["plugA:code-review"]);
    expect(catalog.get("code-review")).toBe(catalog.get("plugA:code-review"));
  });

  it("available() 是模型索引面的别名，不是可加载面", () => {
    const catalog = createSkillCatalog(FIXTURE);

    expect(catalog.available()).toEqual(catalog.modelIndex());
    expect(names(catalog.available())).not.toContain("frozen");
    expect(names(catalog.available())).not.toContain("undocumented");
  });

  it("两面每次都返回新数组：改动返回值不污染 catalog 内部状态", () => {
    const catalog = createSkillCatalog(FIXTURE);
    const loadable = catalog.loadable();
    const index = catalog.modelIndex();
    const all = catalog.all();

    loadable.splice(0, loadable.length);
    index.splice(0, index.length);
    all.pop();

    expect(sortedNames(catalog.loadable())).toEqual([
      "alpha",
      "boot-notes",
      "frozen",
      "plugA:code-review",
      "undocumented",
      "zulu",
    ]);
    expect(names(catalog.modelIndex())).toEqual([
      "alpha",
      "plugA:code-review",
      "zulu",
    ]);
    expect(catalog.loadable()).not.toBe(loadable);
    expect(catalog.modelIndex()).not.toBe(index);
  });
});
