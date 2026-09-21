/**
 * SC8 (serve / hub side "slash candidates hot in place") — `SessionHub.listSkills`
 * must fetch the loadable surface at CALL time, not read an assembly-time
 * snapshot (spec `specs/skill-index-increment.md` SC8; ADR-0098).
 *
 * Covers:
 *   - production serve shape (hub with `workspaceRoot` → session root = boundRoot
 *     → per-root engine path): the skill surface is published, listSkills is
 *     non-empty, and a SKILL.md planted after assembly is visible on the very
 *     next listSkills call (no waiting for the next turn);
 *   - after the active engine switches (session B on another root), listSkills
 *     follows the active engine and stays hot;
 *   - rescan failure (EACCES → typed `SkillRescanError`) → fall back to the
 *     assembly-time cached loadable surface (the human-side slash list never
 *     empties due to one IO fault, and failure is never pinned as permanent
 *     degradation);
 *   - seam absent (injected deps / buildEngine seam returning only a catalog) →
 *     old behavior byte-for-byte unchanged.
 *
 * The assertion surface is the public `listSkills()` DTO (the layer hosts
 * consume) — no private-field probing, otherwise tests would stay green even
 * when "hot" is invisible on the API.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionHub } from "../../src/session-api/hub.ts";
import {
  CURRENT_SCHEMA_VERSION,
  SessionStore,
} from "../../src/session-api/store/index.ts";
import { createNoAskUser } from "../../src/harness/permission/ask-user.ts";
import { createSkillCatalog } from "../../src/harness/skill/catalog.ts";
import {
  createSkillRescanner,
  SkillRescanError,
} from "../../src/harness/skill/rescan.ts";
import type { SkillRescanner } from "../../src/harness/skill/rescan.ts";
import { createSkillScanner } from "../../src/harness/skill/scanner.ts";
import { assistantResult, makeDeps } from "../cli/_fixtures.ts";
import { installTestSettingsSource } from "../_helpers/install-test-settings-source.ts";

let baseDir: string;
let settingsSource: ReturnType<typeof installTestSettingsSource>;
const restores: Array<() => Promise<void>> = [];

beforeAll(async () => {
  baseDir = await mkdtemp(join(tmpdir(), "iknow-skills-hot-"));
  settingsSource = installTestSettingsSource();
});

afterAll(async () => {
  for (const restore of restores.splice(0)) await restore().catch(() => {});
  await rm(baseDir, { recursive: true, force: true });
  settingsSource.restore();
});

/** Plant `<name>/SKILL.md` one level under root (the scanner's directory convention). */
async function plantSkill(
  root: string,
  name: string,
  matter = `name: ${name}`
): Promise<void> {
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "SKILL.md"), `---\n${matter}\n---\nbody\n`, "utf8");
}

async function makeStore(): Promise<SessionStore> {
  return new SessionStore(
    await mkdtemp(join(baseDir, "store-")),
    process.cwd()
  );
}

async function makeBoundSession(
  store: SessionStore,
  root: string,
  conversationId: string
): Promise<void> {
  const now = new Date().toISOString();
  await store.save({
    id: conversationId,
    file: {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      conversation_id: conversationId,
      messages: [],
      jsonMode: false,
      turnCount: 0,
      updatedAt: now,
      title: "",
      cwd: root,
      workspaceRoot: root,
      sanitized_at: now,
      checkpoints: [],
    },
  });
}

async function withSkillRoot<T>(
  dir: string,
  run: () => Promise<T>
): Promise<T> {
  const prev = process.env.IKNOW_SKILL_DIRS;
  process.env.IKNOW_SKILL_DIRS = dir;
  try {
    return await run();
  } finally {
    if (prev === undefined) delete process.env.IKNOW_SKILL_DIRS;
    else process.env.IKNOW_SKILL_DIRS = prev;
  }
}

const namesOf = (skills: readonly { readonly name: string }[]): string[] =>
  skills.map((s) => s.name).sort((a, b) => a.localeCompare(b));

const runningAsRoot = (): boolean =>
  typeof process.getuid === "function" && process.getuid() === 0;

describe("SC8 — serve per-root 引擎路径的 slash 候选当场热", () => {
  it("绑根 hub 首次 listSkills 非空；装配期之后新落的 SKILL.md 下一次 listSkills 立即可见", async () => {
    const skillRoot = join(baseDir, "hot-env");
    await plantSkill(skillRoot, "alpha", "name: alpha\ndescription: Alpha");

    await withSkillRoot(skillRoot, async () => {
      const store = await makeStore();
      // Production serve shape: serve.ts passes productRoot as workspaceRoot →
      // constructor boundRoot = that root → listSkills → ensureDeps() → per-root engine.
      const root = await mkdtemp(join(baseDir, "root-"));
      await makeBoundSession(store, root, "conv-hot");
      const hub = new SessionHub({
        store,
        askUser: createNoAskUser(),
        surface: "serve",
        workspaceRoot: root,
        productRoot: root,
      });

      const before = await hub.listSkills();
      assert.deepEqual(namesOf(before), ["alpha"]);

      // Planted mid-session (after assembly) — no description = human-loadable, not in the model index.
      await plantSkill(skillRoot, "beta");

      // SC8 core claim: visible on the very next listSkills, no need to wait for the next turn.
      const after = await hub.listSkills();
      assert.deepEqual(namesOf(after), ["alpha", "beta"]);
      // One facet of SC9: an entry without description has the key absent (not filled with "").
      const beta = after.find((s) => s.name === "beta");
      assert.ok(beta !== undefined, "新条目必须在可加载面");
      assert.equal(
        Object.prototype.hasOwnProperty.call(beta, "description"),
        false,
        "无 description 条目不得携带 description 键"
      );

      await hub.shutdown();
    });
  });

  it("会话切到另一根后 listSkills 跟活跃引擎走，仍热", async () => {
    const rootA = await mkdtemp(join(baseDir, "root-sw-a-"));
    const rootB = await mkdtemp(join(baseDir, "root-sw-b-"));
    const store = await makeStore();
    await makeBoundSession(store, rootA, "conv-a");
    await makeBoundSession(store, rootB, "conv-b");
    const skillDirA = join(rootA, "plug", "skills");
    const skillDirB = join(rootB, "plug", "skills");
    await plantSkill(skillDirA, "only-a", "name: only-a\ndescription: A");
    await plantSkill(skillDirB, "only-b", "name: only-b\ndescription: B");
    const rescannerFor = (root: string, dir: string) =>
      createSkillRescanner({
        userHome: join(baseDir, "empty-home"),
        projectIdentityRoot: root,
        env: {},
        pluginSkillDirs: [{ dir, plugin: "plug" }],
      });
    const hub = new SessionHub({
      store,
      askUser: createNoAskUser(),
      surface: "serve",
      workspaceRoot: rootA,
      productRoot: rootA,
      buildEngine: async (engineRoot) => {
        const rescanner =
          engineRoot === rootB
            ? rescannerFor(rootB, skillDirB)
            : rescannerFor(rootA, skillDirA);
        return {
          deps: makeDeps([assistantResult({ texts: [`from:${engineRoot}`] })]),
          skillCatalog: await rescanner.rescan(),
          skillRescanner: rescanner,
        };
      },
    });

    // boundRoot = rootA → the first engine.
    assert.deepEqual(namesOf(await hub.listSkills()), ["plug:only-a"]);

    // Session B lives on another root: postMessage makes its engine the active one.
    const res = await hub.postMessage({ conversationId: "conv-b", text: "hi" });
    assert.equal(res.turn.answer.finalText, `from:${rootB}`);
    assert.deepEqual(
      namesOf(await hub.listSkills()),
      ["plug:only-b"],
      "listSkills 必须读活跃引擎的可加载面"
    );

    // After the root switch, "hot in place" still holds.
    await plantSkill(skillDirB, "late-b", "name: late-b\ndescription: late");
    assert.deepEqual(namesOf(await hub.listSkills()), [
      "plug:late-b",
      "plug:only-b",
    ]);

    // Switch back to the ALREADY CACHED first engine (getOrBuildEngine's hit
    // branch): the active surface must follow back to rootA's seam — otherwise
    // listSkills would pass off rootB's candidates as rootA's.
    const back = await hub.postMessage({
      conversationId: "conv-a",
      text: "hi",
    });
    assert.equal(back.turn.answer.finalText, `from:${rootA}`);
    assert.deepEqual(
      namesOf(await hub.listSkills()),
      ["plug:only-a"],
      "hit 分支必须把 skill 面切回该引擎（不是留在上一台的）"
    );

    await hub.shutdown();
  });
});

describe("SC8 — 候选与正文同源（新条目必须点得动）", () => {
  it("listSkills 刚给出的新条目，loadSkillBody 立刻交付正文（不是 404）", async () => {
    const skillRoot = join(baseDir, "body-env");
    await plantSkill(skillRoot, "alpha", "name: alpha\ndescription: Alpha");

    await withSkillRoot(skillRoot, async () => {
      const store = await makeStore();
      const root = await mkdtemp(join(baseDir, "root-"));
      await makeBoundSession(store, root, "conv-body");
      const hub = new SessionHub({
        store,
        askUser: createNoAskUser(),
        surface: "serve",
        workspaceRoot: root,
        productRoot: root,
      });
      assert.deepEqual(namesOf(await hub.listSkills()), ["alpha"]);

      // Human-side skill planted mid-session (no description).
      await plantSkill(skillRoot, "beta");

      // The candidate surface sees it first…
      assert.ok(
        (await hub.listSkills()).some((s) => s.name === "beta"),
        "新条目必须在候选面"
      );
      // …and the body surface must be able to open it (same current surface; an assembly-time snapshot would 404 here).
      const { body } = await hub.loadSkillBody("beta");
      assert.ok(body.includes("body"), "新条目正文必须可读");
      await hub.shutdown();
    });
  });
});

describe("SC8 — rescan 失败退回缓存可加载面", () => {
  it("根目录 EACCES → listSkills 仍返回装配期缓存面（不空、不上抛），恢复后重新热", async () => {
    if (runningAsRoot()) return; // root bypasses permission bits → EACCES not reproducible
    const skillRoot = join(baseDir, "locked-env");
    await plantSkill(skillRoot, "alpha", "name: alpha\ndescription: Alpha");

    await withSkillRoot(skillRoot, async () => {
      const store = await makeStore();
      const root = await mkdtemp(join(baseDir, "root-"));
      await makeBoundSession(store, root, "conv-locked");
      const hub = new SessionHub({
        store,
        askUser: createNoAskUser(),
        surface: "serve",
        workspaceRoot: root,
        productRoot: root,
      });
      assert.deepEqual(namesOf(await hub.listSkills()), ["alpha"]);

      // After assembly the root becomes unreadable → rescan throws typed SkillRescanError.
      await chmod(skillRoot, 0o000);
      restores.push(() => chmod(skillRoot, 0o755));

      // The human side is a lenient surface: candidates keep the cached snapshot — one IO fault neither empties the list nor propagates.
      assert.deepEqual(namesOf(await hub.listSkills()), ["alpha"]);

      // Once readable again it goes hot again (failure was not pinned as permanent degradation).
      for (const restore of restores.splice(0)) await restore();
      await plantSkill(skillRoot, "beta");
      assert.deepEqual(namesOf(await hub.listSkills()), ["alpha", "beta"]);
      await hub.shutdown();
    });
  });
});

describe("SC8 — 只吞 typed rescan 失败，编程错误继续上抛", () => {
  it("rescanner.rescan 抛非 SkillRescanError → listSkills 上抛（不静默降级成过期目录）", async () => {
    const skillRoot = join(baseDir, "throwing-env");
    await plantSkill(skillRoot, "alpha", "name: alpha\ndescription: Alpha");

    await withSkillRoot(skillRoot, async () => {
      const store = await makeStore();
      const root = await mkdtemp(join(baseDir, "root-"));
      await makeBoundSession(store, root, "conv-throwing");
      const bug = new TypeError("rescanner 内部缺陷");
      const rescanner: SkillRescanner = {
        rescan: async () => {
          throw bug;
        },
        setPluginSkillDirs: () => {},
        pluginSkillDirs: () => [],
      };
      const hub = new SessionHub({
        store,
        askUser: createNoAskUser(),
        surface: "serve",
        workspaceRoot: root,
        buildEngine: async () => ({
          deps: makeDeps([assistantResult({ texts: ["x"] })]),
          skillRescanner: rescanner,
        }),
      });

      // Programming errors must stay visible: the contract allows cache fallback only for typed SkillRescanError.
      await assert.rejects(() => hub.listSkills(), /rescanner 内部缺陷/);
      await assert.rejects(
        () => hub.loadSkillBody("alpha"),
        /rescanner 内部缺陷/
      );
    });
  });

  it("typed SkillRescanError → 退缓存（对照臂：同一个 hub 换个实现即可吞）", async () => {
    const skillRoot = join(baseDir, "typed-env");
    await plantSkill(skillRoot, "alpha", "name: alpha\ndescription: Alpha");

    await withSkillRoot(skillRoot, async () => {
      const store = await makeStore();
      const root = await mkdtemp(join(baseDir, "root-"));
      await makeBoundSession(store, root, "conv-typed");
      const scanner = createSkillScanner({
        userHome: settingsSource.home,
        projectIdentityRoot: root,
        env: process.env,
      });
      const catalog = createSkillCatalog(await scanner.scan());
      const rescanner: SkillRescanner = {
        rescan: async () => {
          throw new SkillRescanError([
            { kind: "root_unreadable", path: skillRoot, cause: "boom" },
          ]);
        },
        setPluginSkillDirs: () => {},
        pluginSkillDirs: () => [],
      };
      const hub = new SessionHub({
        store,
        askUser: createNoAskUser(),
        surface: "serve",
        workspaceRoot: root,
        buildEngine: async () => ({
          deps: makeDeps([assistantResult({ texts: ["x"] })]),
          skillCatalog: catalog,
          skillRescanner: rescanner,
        }),
      });

      assert.deepEqual(namesOf(await hub.listSkills()), ["alpha"]);
    });
  });
});

describe("SC8 — 缝缺席保持旧行为逐字节不变", () => {
  it("注入 deps（测试路径）→ 空清单，无 rescan 参与", async () => {
    await withSkillRoot(join(baseDir, "unused-env"), async () => {
      const store = await makeStore();
      const hub = new SessionHub({
        store,
        deps: makeDeps([assistantResult({ texts: ["x"] })]),
        askUser: createNoAskUser(),
      });
      assert.deepEqual(await hub.listSkills(), []);
    });
  });

  it("buildEngine 缝只回 catalog（无 rescanner）→ 恒读装配期快照，新条目不可见", async () => {
    const skillRoot = join(baseDir, "seamless-env");
    await plantSkill(skillRoot, "alpha", "name: alpha\ndescription: Alpha");

    await withSkillRoot(skillRoot, async () => {
      const store = await makeStore();
      const root = await mkdtemp(join(baseDir, "root-"));
      await makeBoundSession(store, root, "conv-seamless");
      const scanner = createSkillScanner({
        userHome: settingsSource.home,
        projectIdentityRoot: root,
        env: process.env,
      });
      const catalog = createSkillCatalog(await scanner.scan());
      const hub = new SessionHub({
        store,
        askUser: createNoAskUser(),
        surface: "serve",
        workspaceRoot: root,
        buildEngine: async () => ({
          deps: makeDeps([assistantResult({ texts: ["x"] })]),
          skillCatalog: catalog,
        }),
      });

      assert.deepEqual(namesOf(await hub.listSkills()), ["alpha"]);
      await plantSkill(skillRoot, "beta");
      assert.deepEqual(
        namesOf(await hub.listSkills()),
        ["alpha"],
        "缝缺席 → 保持装配期快照（旧行为逐字节不变）"
      );
    });
  });
});
