/**
 * skill/scanner.ts × plugin skill 接线单测（plans/global-plugins-loading.md §4.2 / §12 T1）。
 *
 * 覆盖:
 *   - 插件 skill 进 catalog, 规范名 + 裸名都可 get;
 *   - all/available/search listing 不重复（plugin 与同名 builtin 不互相干扰）;
 *   - 裸名别名冲突 → 丢别名（catalog 内部管理, scanner 入口不 warn）;
 *   - 无 pluginSkillDirs → 行为与今日逐字节一致（既有 scanner.test.ts 不变）;
 *   - IKNOW_SKILL_DIRS > 插件 优先级（design §4.2: 后者覆盖前者）。
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
    // canonical + bare alias 两条路径都命中同一 entry
    expect(catalog.get("plugA:code-review")).toBe(entry);
    expect(catalog.get("code-review")).toBe(entry);
    // listing 不重复
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
    // frontmatter name 与目录名相同
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
    // 插件内的 frontmatter name 与 env 中的 skill frontmatter name 都是
    // 裸名 `shared`,但插件 skill 的 entry.name 被 namespace 拼装成规范名
    // `plugA:shared`（≠ env 的 `shared`）→ index 用 name 作 key,两条 entry
    // 都保留（互不覆盖）。env 仅在裸名/规范名完全相同时才覆盖插件。
    await fixture(
      root,
      "plugA/skills/shared",
      "---\nname: shared\ndescription: from plugin\n---\nbody"
    );
    // IKNOW_SKILL_DIRS 路径是 skill **父目录**,含一个 `shared/` 子目录。
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

    // name 互不相同 → 都保留
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

    // 两个规范名都在 (canonical 互不冲突)
    expect(entries).toHaveLength(2);
    const catalog = createSkillCatalog(entries);
    // 裸名 audit → 先到者 (plugA) 赢
    expect(catalog.get("audit")?.namespace).toBe("plugA");
    // 规范名各自命中
    expect(catalog.get("plugA:audit")?.namespace).toBe("plugA");
    expect(catalog.get("plugB:audit")?.namespace).toBe("plugB");
    // review C5: 裸名冲突时 scanner warn 一次（spec §4.2「只留规范
    // 名 + warn」）；warn 文案锚 'audit' 与两 plugin 名。
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
    // 两个 entry 共存：user 的 name="shared"（裸名）和 plugin 的
    // name="plugA:shared"（规范名）—— entry.name 不同 → 两个并存。
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
    // 裸名 'shared' 命中 user entry（先注册的赢）
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
