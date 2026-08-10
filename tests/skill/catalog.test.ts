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

describe("createSkillCatalog", () => {
  it("indexes all entries while availability is described, enabled, and name-sorted", () => {
    const catalog = createSkillCatalog([
      entry({ name: "Zulu" }),
      entry({ name: "alpha" }),
      entry({ name: "hidden", disabled: true }),
      entry({ name: "undocumented", description: undefined }),
    ]);

    expect(catalog.all()).toHaveLength(4);
    expect(catalog.get("hidden")?.disabled).toBe(true);
    expect(catalog.available().map(({ name }) => name)).toEqual([
      "alpha",
      "Zulu",
    ]);
    expect(catalog.getBodyPath("alpha")).toBe("/skills/alpha/SKILL.md");
    expect(catalog.getBodyPath("missing")).toBeUndefined();
  });

  it("searches name and description case-insensitively and excludes disabled or undocumented skills", () => {
    const catalog = createSkillCatalog([
      entry({ name: "Debugger", description: "Find ROOT Causes" }),
      entry({ name: "writer", description: "Writes reports" }),
      entry({ name: "secret-root", description: "hidden", disabled: true }),
      entry({ name: "root-no-docs", description: undefined }),
    ]);

    expect(catalog.search("root").map(({ name }) => name)).toEqual([
      "Debugger",
    ]);
    expect(catalog.search("WRIT").map(({ name }) => name)).toEqual(["writer"]);
  });
});
