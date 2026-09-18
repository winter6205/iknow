/**
 * skill/rescan.ts × 可加载面「当时热」+ 自动 diff 覆盖现行 scan 根
 * （spec `skill-index-increment` T6 / SC8 / SC11；assumption 9 / 10）。
 *
 * 覆盖:
 *   - rescan 覆盖现行 scan() 全部技能根（user / project / IKNOW_SKILL_DIRS / plugin）;
 *   - 已 scan 根下新落 SKILL.md → 下一次 rescan 立刻可见（无 description 条目进
 *     可加载面、不进模型索引）;
 *   - 每次 rescan 返回新 catalog，旧实例不被改写;
 *   - plugin 根**只在显式换血后**进可见集 —— 未换血时磁盘上插件包变化看不见
 *     （SC11 的结构性证据：缝不读 installed_plugins.json）;
 *   - 真 IO 故障（不可读根目录 / 不可读 SKILL.md）→ typed SkillRescanError;
 *   - 缺目录 / 缺文件（ENOENT）仍是合法空态，不抛。
 */
import { chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createSkillRescanner,
  SkillRescanError,
} from "../../src/harness/skill/rescan.js";
import type { PluginSkillDir } from "../../src/harness/skill/scanner.js";
import {
  resolvePluginCatalog,
  resolvePluginRoots,
} from "../../src/harness/plugin/roots.js";

const roots: string[] = [];
/** 权限位恢复闭包 —— 只读目录不恢复则 afterEach 的 rm 清不掉。 */
const restores: Array<() => Promise<void>> = [];

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

const sortedNames = (entries: ReadonlyArray<{ name: string }>): string[] =>
  entries.map(({ name }) => name).sort((a, b) => a.localeCompare(b));

/** root 绕过权限位 → EACCES 不可复现（同 store/boundary.test.ts 纪律）。 */
const runningAsRoot = (): boolean =>
  typeof process.getuid === "function" && process.getuid() === 0;

afterEach(async () => {
  for (const restore of restores.splice(0)) await restore().catch(() => {});
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

describe("createSkillRescanner", () => {
  it("空目录 → 空 catalog（不抛；缺根与空根都是合法态）", async () => {
    const root = await mkdtemp(join(tmpdir(), "iknow-rescan-"));
    roots.push(root);
    const home = join(root, "home");
    const rescanner = createSkillRescanner({
      userHome: home,
      projectIdentityRoot: join(root, "project"),
      env: {},
    });

    // 三根全缺（home 都还没建）→ 空集，不抛。
    expect((await rescanner.rescan()).loadable()).toEqual([]);
    // 根存在但为空 → 同样空集，不抛。
    await mkdir(join(home, ".iknow", "skills"), { recursive: true });
    const catalog = await rescanner.rescan();
    expect(catalog.loadable()).toEqual([]);
    expect(catalog.modelIndex()).toEqual([]);
  });

  it("rescan 覆盖现行 scan() 全部技能根：user / project / env / plugin", async () => {
    const root = await mkdtemp(join(tmpdir(), "iknow-rescan-"));
    roots.push(root);
    const home = join(root, "home");
    const projectRoot = join(root, "project");
    const extra = join(root, "extra");
    const pluginSkills = join(root, "plug", "skills");
    await fixture(
      join(home, ".iknow", "skills"),
      "from-user",
      "---\nname: from-user\ndescription: user root\n---\nbody"
    );
    await fixture(
      join(projectRoot, ".iknow", "skills"),
      "from-project",
      "---\nname: from-project\ndescription: project root\n---\nbody"
    );
    await fixture(
      extra,
      "from-env",
      "---\nname: from-env\ndescription: env root\n---\nbody"
    );
    await fixture(
      pluginSkills,
      "from-plugin",
      "---\nname: from-plugin\ndescription: plugin root\n---\nbody"
    );

    const rescanner = createSkillRescanner({
      userHome: home,
      projectIdentityRoot: projectRoot,
      env: { IKNOW_SKILL_DIRS: extra },
      pluginSkillDirs: [{ dir: pluginSkills, plugin: "plug" }],
    });

    const catalog = await rescanner.rescan();
    expect(sortedNames(catalog.loadable())).toEqual([
      "from-env",
      "from-project",
      "from-user",
      "plug:from-plugin",
    ]);
    expect(sortedNames(catalog.modelIndex())).toEqual([
      "from-env",
      "from-project",
      "from-user",
      "plug:from-plugin",
    ]);
  });

  it("沿用 scan() 的根优先级：插件覆盖 user，env IKNOW_SKILL_DIRS 覆盖插件", async () => {
    const root = await mkdtemp(join(tmpdir(), "iknow-rescan-"));
    roots.push(root);
    const home = join(root, "home");
    const extra = join(root, "extra");
    const pluginSkills = join(root, "plug", "skills");
    await fixture(
      join(home, ".iknow", "skills"),
      "shared",
      "---\nname: shared\ndescription: user\n---\nbody"
    );
    await fixture(
      pluginSkills,
      "shared",
      "---\nname: shared\ndescription: plugin\n---\nbody"
    );
    await fixture(
      extra,
      "shared",
      "---\nname: shared\ndescription: env\n---\nbody"
    );

    const rescanner = createSkillRescanner({
      userHome: home,
      projectIdentityRoot: join(root, "project"),
      env: { IKNOW_SKILL_DIRS: extra },
      pluginSkillDirs: [{ dir: pluginSkills, plugin: "plug" }],
    });

    // 同名 user/env 只剩一条，描述 = 最高优先级根（env）；插件条目 canonical
    // 名不同（`plug:shared`），是另一条 —— 证明 rescan 走的是 scan() 本身
    // 的根序与覆盖纪律，而不是「把各根结果并起来」的近似实现。
    const catalog = await rescanner.rescan();
    expect(sortedNames(catalog.loadable())).toEqual(["plug:shared", "shared"]);
    expect(catalog.get("shared")).toMatchObject({ description: "env" });
    expect(catalog.get("plug:shared")).toMatchObject({
      description: "plugin",
    });
  });

  it("已 scan 根下新落 SKILL.md → 下一次 rescan 可见（无 description 进可加载面、不进模型索引）", async () => {
    const root = await mkdtemp(join(tmpdir(), "iknow-rescan-"));
    roots.push(root);
    const home = join(root, "home");
    const userSkills = join(home, ".iknow", "skills");
    await fixture(
      userSkills,
      "alpha",
      "---\nname: alpha\ndescription: Alpha\n---\nbody"
    );
    const rescanner = createSkillRescanner({
      userHome: home,
      projectIdentityRoot: join(root, "project"),
      env: {},
    });
    expect(sortedNames((await rescanner.rescan()).loadable())).toEqual([
      "alpha",
    ]);

    // 会话开始后新装的技能：无 description = 人侧可加载、不进模型索引。
    await fixture(userSkills, "human-only", "---\nname: human-only\n---\nbody");
    const after = await rescanner.rescan();

    expect(sortedNames(after.loadable())).toEqual(["alpha", "human-only"]);
    expect(sortedNames(after.modelIndex())).toEqual(["alpha"]);
    expect(after.get("human-only")).toMatchObject({ name: "human-only" });
  });

  it("每次 rescan 返回新实例：旧 catalog 不被后续扫描改写", async () => {
    const root = await mkdtemp(join(tmpdir(), "iknow-rescan-"));
    roots.push(root);
    const userSkills = join(root, "home", ".iknow", "skills");
    await fixture(
      userSkills,
      "alpha",
      "---\nname: alpha\ndescription: Alpha\n---\nbody"
    );
    const rescanner = createSkillRescanner({
      userHome: join(root, "home"),
      projectIdentityRoot: join(root, "project"),
      env: {},
    });

    const first = await rescanner.rescan();
    await fixture(
      userSkills,
      "later",
      "---\nname: later\ndescription: Later\n---\nbody"
    );
    const second = await rescanner.rescan();

    expect(second).not.toBe(first);
    expect(sortedNames(second.loadable())).toEqual(["alpha", "later"]);
    // 旧实例是当时的快照：新技能不进它，也不反过来被清空。
    expect(sortedNames(first.loadable())).toEqual(["alpha"]);
    expect(first.get("later")).toBeUndefined();
    expect(second.get("later")).toBeDefined();
  });

  it("未换血 → 插件包变化看不见；显式 setPluginSkillDirs 后 rescan 才看见", async () => {
    const root = await mkdtemp(join(tmpdir(), "iknow-rescan-"));
    roots.push(root);
    const pluginRoot = join(root, "plugins");
    const installed = join(root, "installed", "plugB");
    await mkdir(pluginRoot, { recursive: true });
    await writeFile(
      join(pluginRoot, "installed_plugins.json"),
      JSON.stringify({
        version: 1,
        plugins: { "plugB@local": [{ scope: "user", installPath: installed }] },
      }),
      "utf8"
    );
    await fixture(
      join(installed, "skills"),
      "late-skill",
      "---\nname: late-skill\ndescription: late\n---\nbody"
    );

    // 非空洞前提：走真实的插件发现链，这个包**确实**在盘上、**确实**
    // 被解析得出来 —— 所以下面的「看不见」只可能归因于根列表没换血，
    // 而不是包本身有问题。userHome 必须指向 fixture，否则默认根
    // `<home>/.iknow/plugins` 会把本机已装的插件也扫进来。
    const sandboxHome = join(root, "home");
    const { enabled } = await resolvePluginCatalog({
      roots: resolvePluginRoots({
        pluginRoots: [pluginRoot],
        env: {},
        userHome: sandboxHome,
      }),
    });
    expect(enabled.map((p) => p.name)).toEqual(["plugB"]);
    const reloadedDirs: PluginSkillDir[] = enabled.map((p) => ({
      dir: join(p.root, "skills"),
      plugin: p.name,
    }));

    const rescanner = createSkillRescanner({
      userHome: sandboxHome,
      projectIdentityRoot: join(root, "project"),
      env: {},
      pluginSkillDirs: [],
    });
    // 缝不自己读 ledger：插件包与新 SKILL.md 都在盘上，未换血 → 不可见。
    expect((await rescanner.rescan()).loadable()).toEqual([]);
    expect((await rescanner.rescan()).loadable()).toEqual([]);

    // host 显式 reload：把这一轮重新解析出的根列表整体换血。
    rescanner.setPluginSkillDirs(reloadedDirs);
    expect(rescanner.pluginSkillDirs()).toEqual([
      { dir: join(installed, "skills"), plugin: "plugB" },
    ]);
    expect(sortedNames((await rescanner.rescan()).loadable())).toEqual([
      "plugB:late-skill",
    ]);

    // 置换语义 = 整体替换（不是合并）：再次换血回空 → 该插件根退出可见集。
    rescanner.setPluginSkillDirs([]);
    expect((await rescanner.rescan()).loadable()).toEqual([]);
  });

  it("根目录不可读（EACCES）→ typed SkillRescanError，不返回残缺 catalog", async () => {
    if (runningAsRoot()) return;
    const root = await mkdtemp(join(tmpdir(), "iknow-rescan-"));
    roots.push(root);
    const home = join(root, "home");
    const userSkills = join(home, ".iknow", "skills");
    await fixture(
      userSkills,
      "alpha",
      "---\nname: alpha\ndescription: Alpha\n---\nbody"
    );
    const rescanner = createSkillRescanner({
      userHome: home,
      projectIdentityRoot: join(root, "project"),
      env: {},
    });
    const healthy = await rescanner.rescan();
    expect(sortedNames(healthy.loadable())).toEqual(["alpha"]);

    await chmod(userSkills, 0o000);
    restores.push(() => chmod(userSkills, 0o755));

    const error: unknown = await rescanner.rescan().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SkillRescanError);
    const typed = error as SkillRescanError;
    expect(typed.kind).toBe("rescan_failed");
    expect(typed.faults).toHaveLength(1);
    expect(typed.faults[0]).toMatchObject({
      kind: "root_unreadable",
      path: userSkills,
      code: "EACCES",
    });
    expect(typed.faults[0]!.cause.length).toBeGreaterThan(0);

    // 故障不改任何既有状态：健康 catalog 仍是当时快照；恢复后 rescan 照常。
    expect(sortedNames(healthy.loadable())).toEqual(["alpha"]);
    for (const restore of restores.splice(0)) await restore();
    expect(sortedNames((await rescanner.rescan()).loadable())).toEqual([
      "alpha",
    ]);
  });

  it("SKILL.md 不可读 → typed（不静默当成该技能不存在）", async () => {
    if (runningAsRoot()) return;
    const root = await mkdtemp(join(tmpdir(), "iknow-rescan-"));
    roots.push(root);
    const extra = join(root, "extra");
    const skillDir = await fixture(
      extra,
      "locked",
      "---\nname: locked\ndescription: Locked\n---\nbody"
    );
    const rescanner = createSkillRescanner({
      userHome: join(root, "home"),
      projectIdentityRoot: join(root, "project"),
      env: { IKNOW_SKILL_DIRS: extra },
    });

    await chmod(join(skillDir, "SKILL.md"), 0o000);
    restores.push(() => chmod(join(skillDir, "SKILL.md"), 0o644));

    const error: unknown = await rescanner.rescan().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SkillRescanError);
    expect((error as SkillRescanError).faults[0]).toMatchObject({
      kind: "file_unreadable",
      path: join(skillDir, "SKILL.md"),
      code: "EACCES",
    });
  });

  it("根路径是文件（ENOTDIR）→ typed：不是「缺目录」空态，是坏根", async () => {
    const root = await mkdtemp(join(tmpdir(), "iknow-rescan-"));
    roots.push(root);
    const home = join(root, "home");
    // `~/.iknow/skills` 被一个同名文件占位 —— EOF 之外的坏根形态。
    await mkdir(join(home, ".iknow"), { recursive: true });
    await writeFile(join(home, ".iknow", "skills"), "not a directory", "utf8");
    const rescanner = createSkillRescanner({
      userHome: home,
      projectIdentityRoot: join(root, "project"),
      env: {},
    });

    const error: unknown = await rescanner.rescan().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SkillRescanError);
    expect((error as SkillRescanError).faults[0]).toMatchObject({
      kind: "root_unreadable",
      path: join(home, ".iknow", "skills"),
      code: "ENOTDIR",
    });
  });

  it("typed 错误不吞 warn 面：故障仍按既有文案 warn 一次（两条纪律共存）", async () => {
    if (runningAsRoot()) return;
    const root = await mkdtemp(join(tmpdir(), "iknow-rescan-"));
    roots.push(root);
    const extra = join(root, "extra");
    await fixture(
      extra,
      "alpha",
      "---\nname: alpha\ndescription: Alpha\n---\nbody"
    );
    const warn = vi.fn();
    const rescanner = createSkillRescanner({
      userHome: join(root, "home"),
      projectIdentityRoot: join(root, "project"),
      env: { IKNOW_SKILL_DIRS: extra },
      warn,
    });
    expect(sortedNames((await rescanner.rescan()).loadable())).toEqual([
      "alpha",
    ]);
    expect(warn).not.toHaveBeenCalled();

    await chmod(extra, 0o000);
    restores.push(() => chmod(extra, 0o755));

    await expect(rescanner.rescan()).rejects.toBeInstanceOf(SkillRescanError);
    // 装配期观测面（warn）与 rescan 缝的 typed 出口同时成立。
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      `skill scan skipped directory: ${extra}`
    );
  });

  it("目录里没有 SKILL.md（ENOENT）不是故障：跳过该子目录，不抛", async () => {
    const root = await mkdtemp(join(tmpdir(), "iknow-rescan-"));
    roots.push(root);
    const extra = join(root, "extra");
    await mkdir(join(extra, "not-a-skill"), { recursive: true });
    await fixture(
      extra,
      "real-skill",
      "---\nname: real-skill\ndescription: ok\n---\nbody"
    );
    const rescanner = createSkillRescanner({
      userHome: join(root, "home"),
      projectIdentityRoot: join(root, "project"),
      env: { IKNOW_SKILL_DIRS: extra },
    });

    expect(sortedNames((await rescanner.rescan()).loadable())).toEqual([
      "real-skill",
    ]);
  });
});
