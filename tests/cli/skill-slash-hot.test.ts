/**
 * spec skill-index-increment SC8 —— CLI slash 候选「当场热」。
 *
 * 钉住的不变式（人侧可观察的结果，不是「某处调了 rescan」这种实现细节）：
 * 装配之后新出现在技能根里的可加载条目，在**下一条** slash 输入上就能命中，
 * 不必等下一个 turn；`loadable()` 面（含无 description 条目）的语义在热路径
 * 上与装配期一致。
 *
 * 四条覆盖面：
 *   1. 正常路径：rescan 缝在场 → 装配后新装的技能当场可加载，信封 byte 与
 *      `buildSkillLoadText` 同源；
 *   2. 对照组：同一行在**没有** rescan 缝的会话上必须 miss —— 否则钉不住
 *      「热」来自重扫而不是别的东西（防伪覆盖）；
 *   3. 失败路径：rescan 抛 typed `SkillRescanError`（根不可读）→ 退回缓存
 *      catalog（已装技能不因一次 IO 故障变 unknown command），降级在 stderr
 *      可见；
 *   4. 空输入：空行不触发重扫（无谓 IO 不进 REPL 编辑路径）。
 *
 * 真实 SessionStore（temp dir）+ 真实 conversationId（不预存会话文件）——
 * 与 tests/cli 既有纪律一致；不写真实 ~/.iknow。
 */
import { afterAll, describe, it } from "vitest";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  processChatLine,
  type ChatLineContext,
} from "../../src/cli/chat-session.ts";
import { createSkillCatalog } from "../../src/harness/skill/catalog.ts";
import { createSkillRescanner } from "../../src/harness/skill/rescan.ts";
import { createSkillScanner } from "../../src/harness/skill/scanner.ts";
import {
  buildSkillLoadText,
  createSkillBody,
} from "../../src/harness/skill/body.ts";
import {
  CURRENT_SCHEMA_VERSION,
  SessionStore,
} from "../../src/session-api/store/index.ts";
import { assistantResult, makeCtx } from "./_fixtures.ts";
import { captureStderrOf } from "../_helpers/capture-stderr.ts";

const roots: string[] = [];

afterAll(async () => {
  for (const root of roots) {
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
});

/** 写一条真实技能目录（scanner 只认 `<root>/<name>/SKILL.md`）。 */
async function writeSkill(
  root: string,
  name: string,
  opts: { readonly description?: string } = {}
): Promise<void> {
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  const frontmatter = [
    `name: ${name}`,
    ...(opts.description !== undefined
      ? [`description: ${opts.description}`]
      : []),
  ].join("\n");
  await writeFile(
    join(dir, "SKILL.md"),
    `---\n${frontmatter}\n---\n# ${name}\n\n${name} 正文\n`,
    "utf8"
  );
}

interface Roots {
  readonly userHome: string;
  readonly projectIdentityRoot: string;
  readonly skillsRoot: string;
  /** 与 scanner / rescanner 共用的那一份 env 对象（生产是 process.env）。 */
  readonly env: Record<string, string | undefined>;
}

async function makeRoots(): Promise<Roots> {
  const base = await mkdtemp(join(tmpdir(), "iknow-sc8-cli-"));
  roots.push(base);
  const skillsRoot = join(base, "skills");
  await mkdir(skillsRoot, { recursive: true });
  return {
    userHome: join(base, "home"),
    projectIdentityRoot: join(base, "project"),
    skillsRoot,
    env: { IKNOW_SKILL_DIRS: skillsRoot },
  };
}

/**
 * 装配一条与 CLI 生产接线同形的会话：装配期 catalog 只扫一次 —— 正是被
 * 冻住的那份快照；`withRescanner !== false` 时再挂上 rescan 缝（生产由
 * cli.ts 传 `built.skillRescanner`）。调用前先写好的技能才进装配期快照。
 */
function makeCtxFor(
  roots: Roots,
  opts: {
    readonly conversationId: string;
    /** false → 不接 rescan 缝（对照组：装配期冻结面）。 */
    readonly withRescanner?: boolean;
  },
  bootEntries: Awaited<
    ReturnType<ReturnType<typeof createSkillScanner>["scan"]>
  >
): ChatLineContext {
  const ctx = makeCtx({
    // 技能名 miss 时这行落 unknown 分支，不会跑引擎；命中时才用得上。
    responses: [assistantResult({ texts: ["收到"] })],
    stateOverrides: { conversationId: opts.conversationId },
    checkpointStore: new SessionStore(
      join(roots.skillsRoot, "..", "data"),
      roots.projectIdentityRoot
    ),
    workspaceRoot: roots.projectIdentityRoot,
  });
  ctx.skillCatalog = createSkillCatalog(bootEntries);
  if (opts.withRescanner !== false) {
    ctx.skillRescanner = createSkillRescanner({
      userHome: roots.userHome,
      projectIdentityRoot: roots.projectIdentityRoot,
      env: roots.env,
    });
  }
  return ctx;
}

/** 装配期扫描（调用点与 build-engine 同形：一次 scan → createSkillCatalog）。 */
function bootScan(roots: Roots) {
  return createSkillScanner({
    userHome: roots.userHome,
    projectIdentityRoot: roots.projectIdentityRoot,
    env: roots.env,
  }).scan();
}

/** 首条 user 消息文本（模型可见的 skill-load 信封）。 */
function firstUserText(ctx: ChatLineContext): string {
  const message = ctx.state.messages[0];
  assert.ok(message !== undefined, "turn 必须已落一张 user 消息");
  const block = message.content[0] as { type: string; text: string };
  return block.text;
}

describe("SC8 — CLI slash 候选当场热", () => {
  it("装配后新装的可加载条目：下一条 slash 当场命中（信封与 SSOT 同源）", async () => {
    const roots = await makeRoots();
    await writeSkill(roots.skillsRoot, "boot", { description: "装配期就在" });
    const ctx = makeCtxFor(
      roots,
      { conversationId: "conv-sc8-hot" },
      await bootScan(roots)
    );

    // 装配期之后才出现的可加载条目：无 description —— 正落在 loadable()
    // 面而 modelIndex() 面之外（SC5 的人侧面）。
    await writeSkill(roots.skillsRoot, "late-skill");

    const result = await processChatLine({
      line: "/late-skill 帮我做 X",
      ctx,
    });
    assert.equal(
      result.ranQuery,
      true,
      `必须当场可加载，实际 stderr：${result.stderr}`
    );

    const entry = ctx.skillCatalog?.get("late-skill");
    assert.ok(entry !== undefined, "热 catalog 必须含新条目");
    const expected = buildSkillLoadText(
      "late-skill",
      await createSkillBody({ entry, dir: entry.dir }),
      "帮我做 X"
    );
    assert.equal(firstUserText(ctx), expected);
  });

  it("对照组：无 rescan 缝时同一行必须 miss（热的来源是重扫，不是解析变宽）", async () => {
    const roots = await makeRoots();
    const ctx = makeCtxFor(
      roots,
      { conversationId: "conv-sc8-frozen", withRescanner: false },
      await bootScan(roots)
    );
    await writeSkill(roots.skillsRoot, "late-skill");

    const miss = await processChatLine({ line: "/late-skill", ctx });
    assert.equal(miss.ranQuery, undefined);
    assert.ok(
      (miss.stderr ?? "").includes("Unknown command"),
      `无重扫缝时必须仍是 unknown，实际：${miss.stderr}`
    );
    assert.equal(ctx.state.messages.length, 0);
  });

  it("rescan 抛 typed 错：退回缓存 catalog（已装技能仍可加载），降级可见", async () => {
    const roots = await makeRoots();
    await writeSkill(roots.skillsRoot, "boot", { description: "装配期就在" });
    const ctx = makeCtxFor(
      roots,
      { conversationId: "conv-sc8-fallback" },
      await bootScan(roots)
    );
    // 装配期快照里 boot 已在 → 首行就该能加载（热路径成功那一支）。
    const first = await processChatLine({ line: "/boot", ctx });
    assert.equal(first.ranQuery, true, `首行必须可加载：${first.stderr}`);
    assert.equal(ctx.state.messages.length > 0, true);

    // 技能根换成不可读路径（ENOTDIR，非 ENOENT）→ rescan 抛 SkillRescanError。
    const notADir = join(roots.skillsRoot, "..", "skills-as-a-file");
    await writeFile(notADir, "not a directory", "utf8");
    roots.env.IKNOW_SKILL_DIRS = notADir;

    const stderr = await captureStderrOf(async () => {
      const result = await processChatLine({ line: "/boot", ctx });
      assert.equal(
        result.ranQuery,
        true,
        `IO 故障时必须退回缓存 catalog（已装技能仍可加载），实际：${result.stderr}`
      );
    });
    assert.ok(
      stderr.includes("slash 候选刷新失败"),
      `降级必须可见（stderr），实际：${stderr}`
    );
    // 缓存 catalog 没被清空 / 没被换成空面。
    assert.ok(ctx.skillCatalog?.get("boot") !== undefined);
  });

  it("空行 / 静态词表行不触发重扫（无谓 IO 不进 REPL 编辑路径）", async () => {
    let calls = 0;
    const ctx = makeCtx({ responses: [] });
    ctx.skillCatalog = createSkillCatalog([]);
    ctx.skillRescanner = {
      rescan: async () => {
        calls += 1;
        return createSkillCatalog([]);
      },
      setPluginSkillDirs: () => undefined,
      pluginSkillDirs: () => [],
    };
    const empty = await processChatLine({ line: "   ", ctx });
    assert.deepEqual(empty, { quit: false, output: "" });
    // /quit 也是静态词表行：重扫对它的结果没有可观察作用。
    const quit = await processChatLine({ line: "/quit", ctx });
    assert.equal(quit.quit, true);
    assert.equal(calls, 0, "空行 / 静态词表行都不得触发 rescan");
  });

  it("rebind 换血：重扫台与 catalog 同台 —— 新根装的技能在改绑后当场可见", async () => {
    const roots = await makeRoots();
    await writeSkill(roots.skillsRoot, "boot", { description: "旧根就在" });
    const ctx = makeCtxFor(
      roots,
      { conversationId: "conv-sc8-rebind" },
      await bootScan(roots)
    );

    // 改绑后的新根：与旧根不同的技能根（会话文件已指向它）。
    const newRootSkills = join(roots.skillsRoot, "..", "new-root-skills");
    await mkdir(newRootSkills, { recursive: true });
    await writeSkill(newRootSkills, "new-root-skill");
    const newEnv = { IKNOW_SKILL_DIRS: newRootSkills };
    const newRescanner = createSkillRescanner({
      userHome: roots.userHome,
      projectIdentityRoot: roots.projectIdentityRoot,
      env: newEnv,
    });
    const newCatalog = createSkillCatalog(
      await createSkillScanner({
        userHome: roots.userHome,
        projectIdentityRoot: roots.projectIdentityRoot,
        env: newEnv,
      }).scan()
    );

    // 生产接线（cli.ts rebuildDeps）返回的 bundle：catalog 与 rescanner 同台。
    const newRoot = join(roots.projectIdentityRoot, "worktree");
    await ctx.checkpointStore!.save({
      id: "conv-sc8-rebind",
      file: {
        schemaVersion: CURRENT_SCHEMA_VERSION,
        conversation_id: "conv-sc8-rebind",
        messages: [],
        jsonMode: true,
        turnCount: 0,
        updatedAt: new Date().toISOString(),
        title: "",
        cwd: newRoot,
        sanitized_at: new Date().toISOString(),
        checkpoints: [],
        workspaceRoot: newRoot,
      },
    });
    ctx.engineRoot = roots.projectIdentityRoot;
    ctx.rebuildDeps = async () => ({
      deps: ctx.deps,
      skillCatalog: newCatalog,
      skillRescanner: newRescanner,
    });

    // rebind 检测按设计只跑在**引擎行**路径（slash 行不读 store，收敛修复
    // 2026-08-29）—— 先用一条查询行触发换血。
    const query = await processChatLine({ line: "改绑", ctx });
    assert.equal(query.ranQuery, true);
    assert.equal(
      ctx.skillCatalog?.get("boot"),
      undefined,
      "换血后旧根的 catalog 不得还在"
    );

    const result = await processChatLine({ line: "/new-root-skill", ctx });
    assert.equal(
      result.ranQuery,
      true,
      `改绑后必须命中新根技能，实际：${result.stderr}`
    );
    assert.equal(ctx.skillCatalog?.get("new-root-skill") !== undefined, true);
  });
});
