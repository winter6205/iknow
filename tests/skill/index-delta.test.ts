/**
 * Skill-index delta computation (`specs/skill-index-increment.md` / ADR-0098).
 *
 * Invariants pinned here (sources in parentheses):
 *   - delta = `model index − index-entry history`, containing only **newly
 *     created** names; rendered with the **full description**, never degraded
 *     by the opening 10% downshift (SC2 / ADR-0098).
 *   - nothing new → empty text, empty added (module-side half of SC1).
 *   - same name is not re-posted in round two (SC3) — the decision reads only
 *     the on-disk history, not messages.
 *   - no re-post after compact (SC4) — expressed as "a new ledger instance
 *     loading the on-disk history while the frozen table no longer contains
 *     the name"; the same `computeSkillIndexDelta` still returns empty.
 *   - rescan failure → typed `SkillRescanError` propagates, **never a partial
 *     delta** (spec Input-contract exception column).
 *   - persistence failure → typed `SkillIndexLedgerError` propagates, the
 *     caller gets no text (module-level guarantee: "appending to messages is
 *     never treated as entered").
 *
 * Failure injection always uses real IO (unreadable root → EACCES / leaf
 * directory segment occupied by a file → ENOTDIR), no fs mocks: the contract
 * is "no half-baked upload on real failure", provable only on a real disk.
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
/** Permission-restore closures — read-only dirs must be restored or afterEach's rm cannot clean them. */
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

/** Plant a user-level skill (`<userHome>/.iknow/skills/<name>/SKILL.md`). */
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

/** The rescan seam (current skill roots = this fixture's user root). */
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
    // Text form = `skillsSegment` output (reuse the renderer, no second assembly line).
    expect(isSkillIndexDeltaText(delta.text)).toBe(true);
  });

  it("完整 description：超长描述不因 10% 降档被剥成裸名（ADR-0098）", async () => {
    const fixture = await makeFixture("full-desc");
    // Long description (< scanner's 1536 cap, but far beyond the size the name-stripping downshift typically hits).
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
    // Frozen table already contains alpha → nothing new.
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
    // After compact: the frozen projection no longer contains alpha (the delta in
    // messages was compressed away), but reloading the entry history in the same
    // session still yields no re-post.
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
    // Failure writes no entry history: after fixing the root, the same ledger can still post this new entry.
    expect(ledger.snapshot()).toEqual([]);
  });

  it("落盘失败（叶子目录段被占成文件）→ 抛 SkillIndexLedgerError，调用方拿不到文本", async () => {
    const fixture = await makeFixture("write-fail");
    await plantUserSkill(fixture.userHome, "alpha", "description: Alpha");
    const ledger = await ledgerFor(fixture, []);
    // After loading, replace `<projectDir>/<conversationId>` with a plain file →
    // the atomic write's mkdir hits ENOTDIR (construction-time reads already
    // passed, so read_failed is not triggered).
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
    // In-memory set unchanged — appending to messages must not count as entered.
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
