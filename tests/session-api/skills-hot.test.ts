/**
 * SC8（serve / hub 侧「slash 侧当场热」）—— `SessionHub.listSkills` 必须在
 * **调用期**取可加载面，而不是读装配期快照（spec
 * `specs/skill-index-increment.md` T6 / SC8；ADR-0098）。
 *
 * 覆盖:
 *   - 生产 serve 形态（hub 带 `workspaceRoot` → 会话根即 boundRoot → per-root
 *     引擎路径）发布 skill 面：listSkills 非空，且装配期之后新落的 SKILL.md
 *     下一次 listSkills 立刻可见（不必等下一 turn）；
 *   - 活跃引擎切换（会话 B 在另一根）后 listSkills 跟活跃引擎走，仍热；
 *   - rescan 失败（EACCES → typed `SkillRescanError`）→ 退回装配期缓存的可
 *     加载面（人侧 slash 不因一次 IO 故障变空，且不钉成永久降级）；
 *   - 缝缺席（注入 deps / buildEngine 缝只回 catalog）→ 旧行为逐字节不变。
 *
 * 断言面是公开的 `listSkills()` DTO（hosts 消费的那一层）—— 不探私有字段，
 * 否则「热」在 API 上不可见时测试仍会绿。
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

/** root 下架一层 `<name>/SKILL.md`（scanner 的目录约定）。 */
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
      // 生产 serve 形态：serve.ts 把 productRoot 同时作 workspaceRoot 传入 →
      // 构造器 boundRoot = 该根 → listSkills → ensureDeps() → per-root 引擎。
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

      // 会话中途落盘（装配期之后）——无 description = 人侧可加载、不进模型索引。
      await plantSkill(skillRoot, "beta");

      // SC8 主句：不必等下一 turn，下一次 listSkills 当场可见。
      const after = await hub.listSkills();
      assert.deepEqual(namesOf(after), ["alpha", "beta"]);
      // SC9 面的一份：无 description 条目 description 缺席（不补 ""）。
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

    // boundRoot = rootA → 第一台引擎。
    assert.deepEqual(namesOf(await hub.listSkills()), ["plug:only-a"]);

    // 会话 B 在另一根：postMessage 把它变成活跃引擎。
    const res = await hub.postMessage({ conversationId: "conv-b", text: "hi" });
    assert.equal(res.turn.answer.finalText, `from:${rootB}`);
    assert.deepEqual(
      namesOf(await hub.listSkills()),
      ["plug:only-b"],
      "listSkills 必须读活跃引擎的可加载面"
    );

    // 换根之后「当场热」仍然成立。
    await plantSkill(skillDirB, "late-b", "name: late-b\ndescription: late");
    assert.deepEqual(namesOf(await hub.listSkills()), [
      "plug:late-b",
      "plug:only-b",
    ]);

    // 切回**已缓存**的第一台引擎（getOrBuildEngine 的 hit 分支）：活跃面必须
    // 跟着回到 rootA 的缝 —— 否则 listSkills 会拿 rootB 的候选冒充 rootA 的。
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

      // 会话中途落盘的人侧技能（无 description）。
      await plantSkill(skillRoot, "beta");

      // 候选面先看见它……
      assert.ok(
        (await hub.listSkills()).some((s) => s.name === "beta"),
        "新条目必须在候选面"
      );
      // ……正文面必须能点动它（同一现行面；装配期快照会让这里 404）。
      const { body } = await hub.loadSkillBody("beta");
      assert.ok(body.includes("body"), "新条目正文必须可读");
      await hub.shutdown();
    });
  });
});

describe("SC8 — rescan 失败退回缓存可加载面", () => {
  it("根目录 EACCES → listSkills 仍返回装配期缓存面（不空、不上抛），恢复后重新热", async () => {
    if (runningAsRoot()) return; // root 绕过权限位 → EACCES 不可复现
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

      // 装配期之后根目录变得不可读 → rescan 抛 typed SkillRescanError。
      await chmod(skillRoot, 0o000);
      restores.push(() => chmod(skillRoot, 0o755));

      // 人侧是宽松面：候选保留缓存快照，不因一次 IO 故障变空、不上抛。
      assert.deepEqual(namesOf(await hub.listSkills()), ["alpha"]);

      // 恢复后可读 → 再次热起来（失败没有被钉成永久降级）。
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

      // 编程错误必须可见：契约只有 typed SkillRescanError 才允许退缓存。
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
