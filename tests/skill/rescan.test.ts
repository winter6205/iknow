/**
 * skill/rescan.ts × loadable-face "hot at load time" + auto-diff over current scan roots
 * (spec `skill-index-increment` SC8 / SC11; assumption 9 / 10).
 *
 * Coverage:
 *   - rescan covers every scan() skill root (user / project / IKNOW_SKILL_DIRS / plugin);
 *   - a SKILL.md dropped under an already-scanned root → visible on the next rescan
 *     (no-description entries enter the loadable face, not the model index);
 *   - every rescan returns a new catalog; old instances are never rewritten;
 *   - plugin roots enter the visible set **only after an explicit swap** — without a
 *     swap, on-disk plugin package changes are invisible (structural evidence of SC11:
 *     the seam never reads installed_plugins.json);
 *   - real IO faults (unreadable root dir / unreadable SKILL.md) → typed SkillRescanError;
 *   - missing dir / missing file (ENOENT) remains a legal empty state, no throw.
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
/** Permission-restore closures — read-only dirs must be restored or afterEach's rm cannot clean them. */
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

/** Running as root bypasses permission bits → EACCES is not reproducible (same discipline as store/boundary.test.ts). */
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

    // All three roots missing (even home is unbuilt) → empty set, no throw.
    expect((await rescanner.rescan()).loadable()).toEqual([]);
    // Roots exist but empty → likewise empty set, no throw.
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

    // Same-named user/env entries collapse to one, description = highest-priority root (env);
    // the plugin entry has a different canonical name (`plug:shared`) and stays separate —
    // proving rescan follows scan()'s own root order and override discipline rather than an
    // approximate "union all roots" implementation.
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

    // A skill installed after the session started: no description = human-side loadable only, not in the model index.
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
    // The old instance is a point-in-time snapshot: new skills do not enter it, and it is not emptied in turn.
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

    // Non-vacuous premise: going through the real plugin discovery chain, this package
    // **is** on disk and **is** resolvable — so the "invisible" below can only be
    // attributed to the root list not being swapped, not to a broken package. userHome
    // must point into the fixture, or the default root `<home>/.iknow/plugins` would
    // also scan this machine's installed plugins.
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
    // The seam never reads the ledger itself: the plugin package and its new SKILL.md are both on disk, but without a swap → invisible.
    expect((await rescanner.rescan()).loadable()).toEqual([]);
    expect((await rescanner.rescan()).loadable()).toEqual([]);

    // Explicit host reload: swap the whole root list with this round's re-resolved roots.
    rescanner.setPluginSkillDirs(reloadedDirs);
    expect(rescanner.pluginSkillDirs()).toEqual([
      { dir: join(installed, "skills"), plugin: "plugB" },
    ]);
    expect(sortedNames((await rescanner.rescan()).loadable())).toEqual([
      "plugB:late-skill",
    ]);

    // Replacement semantics = wholesale replace (not merge): swapping back to empty → that plugin root leaves the visible set.
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

    // Failure changes no existing state: the healthy catalog stays its snapshot; after recovery rescan works as usual.
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
    // `~/.iknow/skills` occupied by a same-named file — a bad-root shape beyond EOF.
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
    // The assembly-time observation surface (warn) and the rescan seam's typed exit both hold.
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
