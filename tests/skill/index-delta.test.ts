/**
 * T5 (`specs/skill-index-increment.md` / ADR-0098) — 技能索引增量判定。
 *
 * 本文件钉住的不变式（出处见括号）：
 *   - 增量 = `模型索引 − 索引进场史`，只含**新建**名；渲染带**完整
 *     description**，不过开场 10% 降档（SC2 / ADR-0098）。
 *   - 无新建 → 空文本、空 added（SC1 的模块级半边）。
 *   - 同名第二轮不重贴（SC3）—— 判定只读落盘史，不读 messages。
 *   - compact 之后不重贴（SC4）—— 用「新 ledger 实例载入落盘史 + 冻表已
 *     不含该名」表达；同一个 `computeSkillIndexDelta` 仍返回空。
 *   - rescan 失败 → typed `SkillRescanError` 上抛，**不返回残缺 delta**
 *     （spec Input-contract exception 列）。
 *   - 落盘失败 → typed `SkillIndexLedgerError` 上抛，调用方拿不到文本
 *     （「不把 messages 追加当成已进场」的模块级保证）。
 *
 * 失败注入一律走真实 IO（不可读根 → EACCES / 把叶子目录段占成文件 →
 * ENOTDIR），不 mock fs：契约是「真故障时不上抛半成品」，只有真盘子能证明。
 */
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  SKILL_INDEX_DELTA_PREFIX,
  computeSkillIndexDelta,
  isSkillIndexDeltaText,
} from "../../src/harness/skill/index-delta.js";
import { createSkillIndexLedger } from "../../src/harness/skill/index-ledger.js";
import { createSkillRescanner } from "../../src/harness/skill/rescan.js";
import { SkillRescanError } from "../../src/harness/skill/rescan.js";

const roots: string[] = [];
/** 权限位恢复闭包 —— 只读目录不恢复则 afterEach 的 rm 清不掉。 */
const restores: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const restore of restores.splice(0)) await restore().catch(() => {});
  await Promise.all(
    roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))
  );
});

async function makeRoot(tag: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `iknow-index-delta-${tag}-`));
  roots.push(dir);
  return dir;
}

/** 落一个 user 级 skill（`<userHome>/.iknow/skills/<name>/SKILL.md`）。 */
async function plantUserSkill(
  userHome: string,
  name: string,
  frontmatter: string
): Promise<void> {
  const dir = join(userHome, ".iknow", "skills", name);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "SKILL.md"),
    `---\nname: ${name}\n${frontmatter}\n---\n\nbody\n`,
    "utf8"
  );
}

interface Fixture {
  readonly root: string;
  readonly userHome: string;
  readonly projectIdentityRoot: string;
  readonly projectDir: string;
}

async function makeFixture(tag: string): Promise<Fixture> {
  const root = await makeRoot(tag);
  const userHome = join(root, "home");
  const projectIdentityRoot = join(root, "project");
  const projectDir = join(root, "sessions");
  await mkdir(userHome, { recursive: true });
  await mkdir(projectIdentityRoot, { recursive: true });
  await mkdir(projectDir, { recursive: true });
  return { root, userHome, projectIdentityRoot, projectDir };
}

/** rescan 缝（现行技能根 = 该 fixture 的 user root）。 */
function rescannerFor(fixture: Fixture) {
  return createSkillRescanner({
    userHome: fixture.userHome,
    projectIdentityRoot: fixture.projectIdentityRoot,
    env: {},
  });
}

const CONVERSATION = "conv-delta-1";

async function ledgerFor(
  fixture: Fixture,
  initialNames: readonly string[],
  conversationId = CONVERSATION
) {
  return createSkillIndexLedger({
    projectDir: fixture.projectDir,
    conversationId,
    initialNames,
    isIndexedName: () => true,
  });
}

describe("computeSkillIndexDelta — 只追加新建行", () => {
  it("SC2 半边：新增有 description 的技能 → added 只含该名、文本只含该行 + 完整 description", async () => {
    const fixture = await makeFixture("new-row");
    await plantUserSkill(fixture.userHome, "alpha", "description: Alpha skill");
    const ledger = await ledgerFor(fixture, []);

    const delta = await computeSkillIndexDelta({
      rescanner: rescannerFor(fixture),
      ledger,
    });

    expect(delta.added).toEqual(["alpha"]);
    expect(delta.text).toBe(
      "<available_skills>\nalpha: Alpha skill\n</available_skills>"
    );
    // 文本形态 = `skillsSegment` 产物（复用渲染，不新写第二套）。
    expect(isSkillIndexDeltaText(delta.text)).toBe(true);
  });

  it("完整 description：超长描述不因 10% 降档被剥成裸名（ADR-0098）", async () => {
    const fixture = await makeFixture("full-desc");
    // 长描述（< scanner 1536 上限，但远超「降档剥名」的典型体量）。
    const long = "L".repeat(600);
    await plantUserSkill(fixture.userHome, "longform", `description: ${long}`);
    const ledger = await ledgerFor(fixture, []);

    const delta = await computeSkillIndexDelta({
      rescanner: rescannerFor(fixture),
      ledger,
    });

    expect(delta.text).toContain(`longform: ${long}`);
    expect(delta.text).not.toBe(
      "<available_skills>\nlongform\n</available_skills>"
    );
  });

  it("SC1 半边：无新建 → added 空、text 空串（调用方零追加）", async () => {
    const fixture = await makeFixture("no-fresh");
    await plantUserSkill(fixture.userHome, "alpha", "description: Alpha");
    // 冻表已含 alpha → 无新建。
    const ledger = await ledgerFor(fixture, ["alpha"]);

    const delta = await computeSkillIndexDelta({
      rescanner: rescannerFor(fixture),
      ledger,
    });

    expect(delta.added).toEqual([]);
    expect(delta.text).toBe("");
  });

  it("SC3 半边：同名第二轮不再贴（判定只读落盘史，不读 messages）", async () => {
    const fixture = await makeFixture("second-round");
    await plantUserSkill(fixture.userHome, "alpha", "description: Alpha");
    const ledger = await ledgerFor(fixture, []);
    const rescanner = rescannerFor(fixture);

    const first = await computeSkillIndexDelta({ rescanner, ledger });
    const second = await computeSkillIndexDelta({ rescanner, ledger });

    expect(first.added).toEqual(["alpha"]);
    expect(second.added).toEqual([]);
    expect(second.text).toBe("");
  });

  it("SC4 半边：新 ledger 实例载入落盘史后仍不重贴（compact 吃掉增量也一样）", async () => {
    const fixture = await makeFixture("compact");
    await plantUserSkill(fixture.userHome, "alpha", "description: Alpha");
    const first = await computeSkillIndexDelta({
      rescanner: rescannerFor(fixture),
      ledger: await ledgerFor(fixture, []),
    });
    expect(first.added).toEqual(["alpha"]);
    // compact 后：冻表投影已不含 alpha（messages 里的增量被压掉），
    // 但同一 session 重新载入进场史 —— 仍是不重贴。
    const restored = await ledgerFor(fixture, []);
    const afterCompact = await computeSkillIndexDelta({
      rescanner: rescannerFor(fixture),
      ledger: restored,
    });

    expect(afterCompact.added).toEqual([]);
    expect(afterCompact.text).toBe("");
    expect(restored.has("alpha")).toBe(true);
  });

  it("只收模型索引面：无 description / disable 的条目既不进 added 也不进文本", async () => {
    const fixture = await makeFixture("faces");
    await plantUserSkill(fixture.userHome, "documented", "description: Doc");
    await plantUserSkill(fixture.userHome, "undocumented", "source: local");
    await plantUserSkill(
      fixture.userHome,
      "frozen",
      "description: Frozen\ndisable-model-invocation: true"
    );
    const ledger = await ledgerFor(fixture, []);

    const delta = await computeSkillIndexDelta({
      rescanner: rescannerFor(fixture),
      ledger,
    });

    expect(delta.added).toEqual(["documented"]);
    expect(delta.text).not.toContain("undocumented");
    expect(delta.text).not.toContain("frozen");
  });

  it("多条新建：按 name 升序渲染在同一个段里", async () => {
    const fixture = await makeFixture("many");
    await plantUserSkill(fixture.userHome, "zulu", "description: Z");
    await plantUserSkill(fixture.userHome, "alpha", "description: A");
    const ledger = await ledgerFor(fixture, []);

    const delta = await computeSkillIndexDelta({
      rescanner: rescannerFor(fixture),
      ledger,
    });

    expect(delta.added).toEqual(["alpha", "zulu"]);
    expect(delta.text).toBe(
      "<available_skills>\nalpha: A\nzulu: Z\n</available_skills>"
    );
  });
});

describe("computeSkillIndexDelta — 失败分型（不贴残缺 delta）", () => {
  it("rescan 失败（不可读根）→ 抛 SkillRescanError，不返回任何文本", async () => {
    const fixture = await makeFixture("rescan-fail");
    const skillRoot = join(fixture.userHome, ".iknow", "skills");
    await mkdir(skillRoot, { recursive: true });
    await chmod(skillRoot, 0o000);
    restores.push(() => chmod(skillRoot, 0o755));
    const ledger = await ledgerFor(fixture, []);

    await expect(
      computeSkillIndexDelta({ rescanner: rescannerFor(fixture), ledger })
    ).rejects.toBeInstanceOf(SkillRescanError);
    // 失败不写进场史：下次修好根之后同一 ledger 仍能贴出这条新建。
    expect(ledger.snapshot()).toEqual([]);
  });

  it("落盘失败（叶子目录段被占成文件）→ 抛 SkillIndexLedgerError，调用方拿不到文本", async () => {
    const fixture = await makeFixture("write-fail");
    await plantUserSkill(fixture.userHome, "alpha", "description: Alpha");
    const ledger = await ledgerFor(fixture, []);
    // 载入之后再把 `<projectDir>/<conversationId>` 占成普通文件 →
    // 原子写的 mkdir ENOTDIR（构造期读盘这时已走过，不撞 read_failed）。
    await rm(join(fixture.projectDir, CONVERSATION), {
      recursive: true,
      force: true,
    });
    await writeFile(
      join(fixture.projectDir, CONVERSATION),
      "not a dir",
      "utf8"
    );

    await expect(
      computeSkillIndexDelta({ rescanner: rescannerFor(fixture), ledger })
    ).rejects.toMatchObject({ kind: "write_failed" });
    // 内存集不变 —— messages 追加不得被当成已进场。
    expect(ledger.snapshot()).toEqual([]);
    expect(ledger.has("alpha")).toBe(false);
  });
});

describe("isSkillIndexDeltaText — 隐藏谓词（生产者本家）", () => {
  it("渲染产物命中；正文提到段标题（非行首）不误伤", () => {
    expect(
      isSkillIndexDeltaText("<available_skills>\nalpha: A\n</available_skills>")
    ).toBe(true);
    expect(
      isSkillIndexDeltaText(
        "  \n<available_skills>\nalpha\n</available_skills>"
      )
    ).toBe(true);
    expect(isSkillIndexDeltaText("真实问题")).toBe(false);
    expect(
      isSkillIndexDeltaText("为什么 transcript 里有 <available_skills>？")
    ).toBe(false);
  });

  it("前缀常量与 skillsSegment 段标题同源（单一字面量）", () => {
    expect(SKILL_INDEX_DELTA_PREFIX).toBe("<available_skills>");
  });
});
