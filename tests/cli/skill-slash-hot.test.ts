/**
 * Spec skill-index-increment SC8 — CLI slash candidates go "hot in place".
 *
 * Pinned invariant (an operator-observable outcome, not an implementation
 * detail like "rescan is called somewhere"): a loadable entry that appears in
 * a skill root after assembly must hit on the **next** slash input without
 * waiting for the next turn; the `loadable()` surface (including
 * description-less entries) keeps the same semantics on the hot path as at
 * assembly time.
 *
 * Four coverage faces:
 *   1. happy path: rescan seam present → a skill installed after assembly is
 *      loadable in place, envelope bytes same-source as `buildSkillLoadText`;
 *   2. control: the same line must miss on a session **without** the rescan
 *      seam — otherwise "hot" could come from something other than the rescan
 *      (anti-false-coverage);
 *   3. failure path: rescan throws a typed `SkillRescanError` (unreadable
 *      root) → fall back to the cached catalog (installed skills never become
 *      unknown commands due to one IO failure), degradation visible on stderr;
 *   4. empty input: blank lines never trigger a rescan (pointless IO must stay
 *      out of the REPL edit path).
 *
 * Real SessionStore (temp dir) + real conversationId (no pre-stored session
 * file) — per the existing tests/cli discipline; never writes to ~/.iknow.
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

/** Writes a real skill directory (the scanner only recognizes `<root>/<name>/SKILL.md`). */
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
  /** The one env object shared by scanner / rescanner (process.env in production). */
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
 * Assemble a session with the same shape as the CLI production wiring: the
 * assembly-time catalog is scanned exactly once — that is the frozen snapshot;
 * with `withRescanner !== false` the rescan seam is attached too (production
 * passes `built.skillRescanner` from cli.ts). Only skills written before the
 * call land in the assembly-time snapshot.
 */
function makeCtxFor(
  roots: Roots,
  opts: {
    readonly conversationId: string;
    /** false → no rescan seam (control group: assembly-time frozen surface). */
    readonly withRescanner?: boolean;
  },
  bootEntries: Awaited<
    ReturnType<ReturnType<typeof createSkillScanner>["scan"]>
  >
): ChatLineContext {
  const ctx = makeCtx({
    // If the skill name misses, this line falls into the unknown branch and never runs the engine; only a hit needs it.
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

/** Assembly-time scan (same shape as the build-engine call site: one scan → createSkillCatalog). */
function bootScan(roots: Roots) {
  return createSkillScanner({
    userHome: roots.userHome,
    projectIdentityRoot: roots.projectIdentityRoot,
    env: roots.env,
  }).scan();
}

/** Text of the first user message (the model-visible skill-load envelope). */
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

    // A loadable entry that appears only after assembly: no description —
    // lands on the loadable() surface but outside modelIndex() (SC5's operator-side face).
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
    // boot is already in the assembly-time snapshot → the first line must load (the hot-path success branch).
    const first = await processChatLine({ line: "/boot", ctx });
    assert.equal(first.ranQuery, true, `首行必须可加载：${first.stderr}`);
    assert.equal(ctx.state.messages.length > 0, true);

    // Swap the skill root for an unreadable path (ENOTDIR, not ENOENT) → rescan throws SkillRescanError.
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
    // The cached catalog was neither cleared nor replaced by an empty surface.
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
    // /quit is also a static-word-list line: a rescan cannot observably change its result.
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

    // The new root after rebind: a skill root different from the old one (the session file already points to it).
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

    // The bundle returned by the production wiring (cli.ts rebuildDeps): catalog and rescanner on the same stage.
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

    // By design, rebind detection only runs on the **engine-line** path (slash
    // lines don't read the store — convergence fix). Trigger the swap with a query line first.
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
