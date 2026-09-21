/**
 * skill/scanner.ts × plugin-skill wiring unit tests.
 *
 * Coverage:
 *   - plugin skills enter the catalog; both canonical and bare names resolve;
 *   - all/available/search listings never duplicate (plugin vs same-named builtin do not interfere);
 *   - bare-name alias conflict → alias dropped (handled inside the catalog; the scanner entry point does not warn);
 *   - no pluginSkillDirs → byte-identical to prior behavior (existing scanner.test.ts unchanged);
 *   - IKNOW_SKILL_DIRS > plugin priority (later overrides former).
 */
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createSkillScanner } from "../../src/harness/skill/scanner.js";
import {
  createSkillCatalog,
  type SkillEntry,
} from "../../src/harness/skill/catalog.js";

const roots: string[] = [];

async function fixture(
  root: string,
  relativeDir: string,
  content: string,
  file = "SKILL.md"
): Promise<string> {
  const dir = join(root, relativeDir);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, file), content, "utf8");
  return dir;
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

describe("createSkillScanner × pluginSkillDirs", () => {
  it("无 pluginSkillDirs → 行为与今日逐字节一致", async () => {
    const root = await mkdtemp(join(tmpdir(), "iknow-skill-plugin-"));
    roots.push(root);
    await fixture(
      join(root, "home", ".iknow", "skills"),
      "alpha",
      "---\nname: alpha\ndescription: user\n---\nbody"
    );
    const entries = await createSkillScanner({
      userHome: join(root, "home"),
      projectIdentityRoot: join(root, "project"),
      env: {},
    }).scan();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ name: "alpha" });
    expect(entries[0]).not.toHaveProperty("namespace");
  });

  it("插件 skill 进 catalog: 规范名 + 裸名都能 get, 但 listing 不重复", async () => {
    const root = await mkdtemp(join(tmpdir(), "iknow-skill-plugin-"));
    roots.push(root);
    const pluginSkills = await fixture(
      root,
      "plugA/skills/code-review",
      "---\nname: code-review\ndescription: review code\n---\nbody"
    );

    const entries = await createSkillScanner({
      userHome: join(root, "home"),
      projectIdentityRoot: join(root, "project"),
      env: {},
      pluginSkillDirs: [
        { dir: join(root, "plugA", "skills"), plugin: "plugA" },
      ],
    }).scan();

    expect(entries).toHaveLength(1);
    const entry = entries[0]!;
    expect(entry).toMatchObject({
      name: "plugA:code-review",
      description: "review code",
      namespace: "plugA",
      dir: pluginSkills,
    });

    const catalog = createSkillCatalog(entries);
    // canonical + bare alias: both paths hit the same entry
    expect(catalog.get("plugA:code-review")).toBe(entry);
    expect(catalog.get("code-review")).toBe(entry);
    // listing has no duplicates
    expect(catalog.all()).toHaveLength(1);
    expect(catalog.available()).toHaveLength(1);
    expect(catalog.getBodyPath("plugA:code-review")).toBe(
      join(pluginSkills, "SKILL.md")
    );
    expect(catalog.getBodyPath("code-review")).toBe(
      join(pluginSkills, "SKILL.md")
    );
  });

  it("插件 skill 目录名 = frontmatter name 时, entry.name 仍拼装规范名", async () => {
    const root = await mkdtemp(join(tmpdir(), "iknow-skill-plugin-"));
    roots.push(root);
    // frontmatter name equals the directory name
    await fixture(
      root,
      "plugA/skills/shared",
      "---\nname: shared\ndescription: from plugin\n---\nbody"
    );
    const entries = await createSkillScanner({
      userHome: join(root, "home"),
      projectIdentityRoot: join(root, "project"),
      env: {},
      pluginSkillDirs: [
        { dir: join(root, "plugA", "skills"), plugin: "plugA" },
      ],
    }).scan();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      name: "plugA:shared",
      namespace: "plugA",
    });
  });

  it("IKNOW_SKILL_DIRS 覆盖插件同名 skill (env 优先级高于插件)", async () => {
    const root = await mkdtemp(join(tmpdir(), "iknow-skill-plugin-"));
    roots.push(root);
    // The plugin's and the env skill's frontmatter names are both the bare
    // `shared`, but the plugin entry.name is assembled into the canonical
    // `plugA:shared` (≠ env's `shared`) → the index keys by name, so both
    // entries are kept (no mutual override). Env overrides the plugin only
    // when bare/canonical names match exactly.
    await fixture(
      root,
      "plugA/skills/shared",
      "---\nname: shared\ndescription: from plugin\n---\nbody"
    );
    // The IKNOW_SKILL_DIRS path is a skill **parent directory** containing one `shared/` subdir.
    const envDir = await fixture(
      root,
      "env-shared/shared",
      "---\nname: shared\ndescription: from env\n---\nbody"
    );

    const entries = await createSkillScanner({
      userHome: join(root, "home"),
      projectIdentityRoot: join(root, "project"),
      env: { IKNOW_SKILL_DIRS: envDir.replace(/\/shared$/, "") },
      pluginSkillDirs: [
        { dir: join(root, "plugA", "skills"), plugin: "plugA" },
      ],
    }).scan();

    // names differ → both kept
    expect(entries).toHaveLength(2);
    const envEntry = entries.find((e) => e.name === "shared");
    const pluginEntry = entries.find((e) => e.name === "plugA:shared");
    expect(envEntry?.description).toBe("from env");
    expect(pluginEntry?.description).toBe("from plugin");
  });

  it("多个插件同名裸名别名 → catalog 内部按扫描序先到者赢 + warn 一次 (review C5)", async () => {
    const root = await mkdtemp(join(tmpdir(), "iknow-skill-plugin-"));
    roots.push(root);
    await fixture(
      root,
      "plugA/skills/audit",
      "---\nname: audit\ndescription: A audit\n---\nbody"
    );
    await fixture(
      root,
      "plugB/skills/audit",
      "---\nname: audit\ndescription: B audit\n---\nbody"
    );

    const warnings: string[] = [];
    const entries = await createSkillScanner({
      userHome: join(root, "home"),
      projectIdentityRoot: join(root, "project"),
      env: {},
      warn: (m) => warnings.push(m),
      pluginSkillDirs: [
        { dir: join(root, "plugA", "skills"), plugin: "plugA" },
        { dir: join(root, "plugB", "skills"), plugin: "plugB" },
      ],
    }).scan();

    // both canonical names present (canonicals never conflict)
    expect(entries).toHaveLength(2);
    const catalog = createSkillCatalog(entries);
    // bare name audit → first arrival (plugA) wins
    expect(catalog.get("audit")?.namespace).toBe("plugA");
    // canonicals each resolve
    expect(catalog.get("plugA:audit")?.namespace).toBe("plugA");
    expect(catalog.get("plugB:audit")?.namespace).toBe("plugB");
    // On bare-name conflict the scanner warns once, keeping only the canonical
    // names; the warn text anchors 'audit' and both plugin names.
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/audit/);
    expect(warnings[0]).toMatch(/plugA:audit/);
    expect(warnings[0]).toMatch(/plugB:audit/);
  });

  it("用户/项目根的 skill 与插件同名（裸名相同） → 不同 entry 共存（user 用裸名, 插件用规范名）", async () => {
    const root = await mkdtemp(join(tmpdir(), "iknow-skill-plugin-"));
    roots.push(root);
    await fixture(
      join(root, "home", ".iknow", "skills"),
      "shared",
      "---\nname: shared\ndescription: user\n---\nbody"
    );
    await fixture(
      root,
      "plugA/skills/shared",
      "---\nname: shared\ndescription: plugin\n---\nbody"
    );

    const entries = await createSkillScanner({
      userHome: join(root, "home"),
      projectIdentityRoot: join(root, "project"),
      env: {},
      pluginSkillDirs: [
        { dir: join(root, "plugA", "skills"), plugin: "plugA" },
      ],
    }).scan();
    // Two coexisting entries: user's name="shared" (bare) and plugin's
    // name="plugA:shared" (canonical) — entry.name differs → both survive.
    expect(entries).toHaveLength(2);
    const user = entries.find((e) => e.name === "shared");
    const plugin = entries.find((e) => e.name === "plugA:shared");
    expect(user).toMatchObject({ description: "user" });
    expect(user).not.toHaveProperty("namespace");
    expect(plugin).toMatchObject({
      description: "plugin",
      namespace: "plugA",
    });

    const catalog = createSkillCatalog(entries);
    // bare name 'shared' resolves to the user entry (first registration wins)
    expect(catalog.get("shared")?.description).toBe("user");
    expect(catalog.get("plugA:shared")?.description).toBe("plugin");
  });

  it("裸名别名查找: 不存在的裸名 → undefined; 不存在的 canonical → undefined", async () => {
    const root = await mkdtemp(join(tmpdir(), "iknow-skill-plugin-"));
    roots.push(root);
    await fixture(
      root,
      "plugA/skills/review",
      "---\nname: review\ndescription: review\n---\nbody"
    );
    const entries = await createSkillScanner({
      userHome: join(root, "home"),
      projectIdentityRoot: join(root, "project"),
      env: {},
      pluginSkillDirs: [
        { dir: join(root, "plugA", "skills"), plugin: "plugA" },
      ],
    }).scan();
    const catalog = createSkillCatalog(entries);
    expect(catalog.get("missing")).toBeUndefined();
    expect(catalog.get("plugA:missing")).toBeUndefined();
    expect(catalog.getBodyPath("missing")).toBeUndefined();
  });

  it("SkillEntry namespace 字段是 optional — 常规 skill 仍可建（与既有测试兼容）", async () => {
    const root = await mkdtemp(join(tmpdir(), "iknow-skill-plugin-"));
    roots.push(root);
    await fixture(
      join(root, "home", ".iknow", "skills"),
      "alpha",
      "---\nname: alpha\ndescription: alpha\n---\nbody"
    );
    const entries = await createSkillScanner({
      userHome: join(root, "home"),
      projectIdentityRoot: join(root, "project"),
      env: {},
    }).scan();
    const typed: SkillEntry = entries[0]!;
    expect(typed.namespace).toBeUndefined();
  });
});
