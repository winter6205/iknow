/**
 * Skill-index delta injection before the model call
 * (`specs/skill-index-increment.md` / ADR-0098).
 *
 * Invariants pinned here (SC numbers name the criterion in each test title):
 *   - SC1 no new skill → zero appends (messages length unchanged, last entry
 *     is still this turn's query);
 *   - SC2 new skill → the **last** user text in messages is an
 *     `<available_skills>` block containing **only** that new name (with full
 *     description); this turn's query sits before it;
 *   - SC3 the same new name is not appended again in the second round;
 *   - SC4 after compact, no re-append just because "the delta vanished from
 *     messages";
 *   - SC7 a slash envelope (skill-load) carries the body but the name has not
 *     entered the ledger → the next round still appends the delta;
 *   - rescan failure → no injection; ledger persist failure → no injection;
 *   - injected messages go through `pendingInjected.record` → flushed with
 *     the next commit batch (the commit-discipline rule).
 *
 * Dual-track assert (`.claude/rules/test.md` "Trace as the integration-test
 * assert surface"): this suite records the turn sequence via `trace` (real
 * `createJsonlTraceService` + `createJsonlTraceReader` double read) against a
 * `createNoopTraceService` baseline deepEqual — trace observation never
 * changes harness behavior itself.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, it } from "vitest";
import assert from "node:assert/strict";

import { run } from "../../src/harness/loop-engine.ts";
import type {
  AnthropicNativeMessage,
  LoopEngineDeps,
} from "../../src/harness/index.ts";
import { createRegistry } from "../../src/harness/tools/registry.ts";
import { createExecutor } from "../../src/harness/tools/executor.ts";
import { createStubModel } from "../../src/harness/stubs/stub-model.ts";
import { createStubTool } from "../../src/harness/stubs/stub-tool.ts";
import { assistantResult } from "../cli/_fixtures.ts";
import { createSkillIndexLedger } from "../../src/harness/skill/index-ledger.ts";
import { createSkillRescanner } from "../../src/harness/skill/rescan.ts";
import { resolvePluginCatalog } from "../../src/harness/plugin/roots.ts";
import { computeSkillIndexDelta } from "../../src/harness/skill/index-delta.ts";
import type { SkillIndexDeltaSeam } from "../../src/harness/loop-engine.ts";
import { createJsonlTraceService } from "../../src/harness/trace/jsonl.ts";
import { PromptTooLongError } from "../../src/harness/errors.ts";
import { createNoopTraceService } from "../../src/harness/trace/noop.ts";
import { createJsonlTraceReader } from "../../src/traceserver/reader.ts";
import {
  buildHarnessEngine,
  type BuiltEngine,
} from "../../src/harness/build-engine.ts";
import { createNoAskUser } from "../../src/harness/permission/ask-user.ts";
import type { IknowEnv } from "../../src/config/env.ts";

const tempDirs: string[] = [];

afterAll(async () => {
  for (const dir of tempDirs) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function makeRoot(tag: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `iknow-skill-delta-loop-${tag}-`));
  tempDirs.push(dir);
  return dir;
}

/** Plant a user-level skill (`<userHome>/.iknow/skills/<name>/SKILL.md`). */
async function plantSkill(
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

/**
 * A fully-assembled delta seam: rescans the live skill roots and persists the
 * entry ledger (both are the real production modules) — structurally the
 * same shape `build-engine` will inject. No decision logic is mocked.
 *
 * Per the assembly contract, the seam reads the conversation anchor from its
 * own `delta(conversationId)` **call argument**. This fixture serves a single
 * conversation (`conversationId` has a default), so each call resolves to the
 * same pre-built ledger. A different anchor would land on a different ledger
 * (production `createSkillIndexDeltaSeam` owns that mapping; this helper
 * makes it explicit — a wrong anchor fails the test loudly instead of
 * silently reusing state).
 */
async function makeDeltaSeam(
  fixture: Fixture,
  initialNames: readonly string[] = [],
  conversationId = "conv-loop-delta"
): Promise<{
  seam: SkillIndexDeltaSeam;
  /** Conversation anchors received on each seam call (call order) — contract: = deps.conversationId. */
  anchors: Array<string | undefined>;
  /** The conversation anchor that must also be injected into deps (the seam resolves the per-conversation ledger through it). */
  conversationId: string;
  ledgerNames: () => readonly string[];
}> {
  const ledger = await createSkillIndexLedger({
    projectDir: fixture.projectDir,
    conversationId,
    initialNames,
    isIndexedName: () => true,
  });
  const rescanner = createSkillRescanner({
    userHome: fixture.userHome,
    projectIdentityRoot: fixture.projectIdentityRoot,
    env: {},
  });
  // Anchors are only recorded, never asserted inside the seam — an error
  // thrown by the seam would be swallowed by loop-engine into "no listing
  // this turn", failing as an unexplained missing listing.
  const anchors: Array<string | undefined> = [];
  return {
    seam: {
      delta: (anchor) => {
        anchors.push(anchor);
        return computeSkillIndexDelta({ rescanner, ledger });
      },
    },
    anchors,
    conversationId,
    ledgerNames: () => ledger.snapshot(),
  };
}

const tool = createStubTool({ name: "alpha", next: () => "result-a" });
const registry = createRegistry([tool]);

function baseDeps(
  adapter: LoopEngineDeps["adapter"],
  extra: Partial<LoopEngineDeps> = {}
): LoopEngineDeps {
  return {
    adapter,
    executor: createExecutor(registry),
    registry,
    maxTurns: 5,
    ...extra,
  };
}

/** All user texts in messages (appearance order, text blocks joined). */
function userTexts(messages: ReadonlyArray<AnthropicNativeMessage>): string[] {
  const out: string[] = [];
  for (const m of messages) {
    if (m.role !== "user") continue;
    if (m.content.some((b) => b.type === "tool_result")) continue;
    out.push(
      m.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n")
    );
  }
  return out;
}

const isListing = (text: string): boolean =>
  text.startsWith("<available_skills>");

/** Env for the build-engine seam cases (same recipe as the sibling harness suites). */
function makeEnv(apiKey: string): IknowEnv {
  return {
    llm: {
      baseUrl: "http://127.0.0.1:9999",
      model: "test-model",
      fallback: [],
      apiKey,
      maxOutputTokens: 1024,
      timeoutMs: 60_000,
      temperature: 0,
      thinking: "off",
      thinkingEffort: "",
      stream: "on",
    },
    chat: { showThinking: false },
    web: { searchUrl: undefined, proxy: undefined },
    compress: { contextWindow: 200_000, thresholdTokens: undefined },
    mcp: { connectTimeoutMs: 60_000 },
    subagent: { taskTimeoutMs: undefined },
  };
}

const builtEngines: BuiltEngine[] = [];

afterAll(async () => {
  for (const built of builtEngines.splice(0)) {
    await built.shutdown?.();
  }
});

// ---------------------------------------------------------------------------
// Assembly seam (build-engine): optional, same-module, per-conversation leaf —
// the "production wiring really connects" half of SC2/SC3 (the decision and
// injection proofs on the loop side are the suites below).
// ---------------------------------------------------------------------------

describe("T5 装配缝 — build-engine 的 skillIndexDelta（可选 seam）", () => {
  it("chat + todoDir 注入 → 缝在场且真rescan:装配后新建的技能经缝贴出（initialNames 只含开场冻表名）", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "iknow-skill-delta-build-"));
    tempDirs.push(tmp);
    const userHome = join(tmp, "home");
    const todoDir = join(tmp, "todos");
    await mkdir(userHome, { recursive: true });
    await mkdir(todoDir, { recursive: true });
    // The opening frozen table already contains alpha (scanned at assembly).
    await plantSkill(userHome, "alpha", "description: Alpha skill");

    const built = await buildHarnessEngine({
      env: makeEnv("sk-skill-delta-t5"),
      askUser: createNoAskUser(),
      surface: "chat",
      todoDir,
      userHome,
      cwd: tmp,
      skipCountTokens: true,
    });
    builtEngines.push(built);

    const seam = built.deps.skillIndexDelta;
    assert.ok(seam !== undefined, "chat + todoDir → 缝必须在场");

    // SC1 "the opening frozen table is byte-stable": pull the delta twice
    // (once after beta is surfaced) — the system frozen table must be
    // byte-identical in between and must **not** contain beta afterwards
    // (the table freezes at assembly; deltas only travel through messages).
    const systemBefore = await built.deps.system?.();
    assert.ok(systemBefore !== undefined);
    assert.match(systemBefore, /^alpha: Alpha skill$/m, "开场冻表含 alpha");
    // The rescan holder is surfaced to the host's reload face (plugin-root
    // swaps land on the same instance).
    assert.ok(
      built.skillRescanner !== undefined,
      "non-ask 装配必须透出同一个 rescan 持有者"
    );
    assert.deepEqual(
      built.skillRescanner.pluginSkillDirs(),
      [],
      "未解析插件根 → 空列表（不是 undefined）"
    );

    // Frozen-table names never appear as delta (they entered at open) —
    // initialNames comes from the assembly-time holder.
    const first = await seam.delta("conv-build-1");
    assert.deepEqual(first.added, [], "开场冻表名不算新建");

    // A skill created after assembly (mid-session) → the next delta pull must
    // surface it (the assembly-side face of SC2).
    await plantSkill(userHome, "beta", "description: Beta skill");
    const second = await seam.delta("conv-build-1");
    assert.deepEqual(second.added, ["beta"]);
    assert.equal(
      second.text,
      "<available_skills>\nbeta: Beta skill\n</available_skills>"
    );

    // The same name is not re-surfaced in round two (assembly-side face of
    // SC3: the per-conversation persisted ledger takes effect).
    const third = await seam.delta("conv-build-1");
    assert.deepEqual(third.added, [], "同一会话第二轮无新建");

    // Switching conversations = a different ledger (a different on-disk file),
    // but frozen-table names have already entered at open for **every**
    // conversation (one engine's system table is shared across conversations)
    // — so only beta counts as "new" for that conversation.
    const otherConv = await seam.delta("conv-build-2");
    assert.deepEqual(
      otherConv.added,
      ["beta"],
      "换锚 → 另一份史（冻表名除外）"
    );
    assert.deepEqual(
      await seam.delta("conv-build-2"),
      { added: [], text: "" },
      "新会话的史同样落盘、第二轮不再贴"
    );

    // After beta's rescan + two surfacing rounds, the frozen table is still
    // byte-identical to the opening one and still excludes beta — "the delta
    // never edits the frozen table" is the other half of SC1.
    const systemAfter = await built.deps.system?.();
    assert.equal(
      systemAfter,
      systemBefore,
      "冻表字节在增量注入前后必须逐字节不变（SC1）"
    );
    assert.doesNotMatch(
      systemAfter!,
      /beta/,
      "会话内新建的技能绝不进冻表（只走 messages 增量）"
    );
  });

  it("todoDir 缺席（ask 形态 / 未锚装配）→ 缝缺席、rescan 缝也缺席（零行为变化）", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "iknow-skill-delta-build-"));
    tempDirs.push(tmp);
    const userHome = join(tmp, "home");
    const todoDir = join(tmp, "todos");
    await mkdir(userHome, { recursive: true });

    const ask = await buildHarnessEngine({
      env: makeEnv("sk-skill-delta-t5"),
      askUser: createNoAskUser(),
      surface: "ask",
      todoDir,
      userHome,
      cwd: tmp,
      skipCountTokens: true,
    });
    builtEngines.push(ask);
    assert.equal(ask.deps.skillIndexDelta, undefined, "ask 不装缝");
    assert.equal(ask.skillRescanner, undefined, "ask 不透 rescan 缝");

    const chat = await buildHarnessEngine({
      env: makeEnv("sk-skill-delta-t5"),
      askUser: createNoAskUser(),
      surface: "chat",
      userHome,
      cwd: tmp,
      skipCountTokens: true,
    });
    builtEngines.push(chat);
    assert.equal(
      chat.deps.skillIndexDelta,
      undefined,
      "chat 未注入 todoDir → 无落点 → 缝缺席"
    );
  });
});

// ---------------------------------------------------------------------------
// SC11 — plugin / MCP changes never auto skill-diff. A package goes live only
// via **explicit reload or a new session**:
//   - without reload: plugin-package and MCP-config changes on disk → the
//     delta stays empty (no pre-turn diff);
//   - after an explicit reload (the host swaps roots on the same engine via
//     `setPluginSkillDirs`), the extra model-index-eligible names still travel
//     the same delta path (the system frozen table is not edited).
// ---------------------------------------------------------------------------

describe("T8 — plugin / MCP 不自动 skill-diff（SC11）", () => {
  it("会话内新装插件包 + 改 MCP 配置都不产生 delta；显式 reload 后新合格 skill 走 T5", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "iknow-skill-delta-t8-"));
    tempDirs.push(tmp);
    const userHome = join(tmp, "home");
    const todoDir = join(tmp, "todos");
    const pluginRoot = join(tmp, "plugins");
    const installed = join(tmp, "installed", "plugX");
    await mkdir(userHome, { recursive: true });
    await mkdir(todoDir, { recursive: true });
    await mkdir(pluginRoot, { recursive: true });
    await mkdir(join(userHome, ".iknow"), { recursive: true });

    // At assembly: the plugin root exists but is **empty** (no package
    // installed yet) → the frozen root list is empty.
    const built = await buildHarnessEngine({
      env: makeEnv("sk-skill-delta-t8"),
      askUser: createNoAskUser(),
      surface: "chat",
      todoDir,
      userHome,
      cwd: tmp,
      skipCountTokens: true,
      // settings.plugins.roots = explicit plugin roots (test seam; otherwise the default probes this machine's ~/.iknow/plugins).
      settings: { plugins: { roots: [pluginRoot] } },
    });
    builtEngines.push(built);

    const seam = built.deps.skillIndexDelta;
    assert.ok(seam !== undefined, "chat + todoDir → 缝必须在场");
    assert.ok(built.skillRescanner !== undefined, "rescan 持有者必须透出");
    assert.deepEqual(
      built.skillRescanner.pluginSkillDirs(),
      [],
      "装配期无包 → 冻结根列表为空"
    );

    // Mid-session: install a new plugin package (the ledger supplies the exact
    // name + installPath, and `skills/` holds one **described** =
    // model-index-eligible skill).
    await writeFile(
      join(pluginRoot, "installed_plugins.json"),
      JSON.stringify({
        version: 1,
        plugins: { "plugX@local": [{ scope: "user", installPath: installed }] },
      }),
      "utf8"
    );
    // Plugin skill landing spot = `<installPath>/skills/<name>/SKILL.md` (the
    // scanner's plugin root points straight at `skills/`, unlike the user-level
    // `.iknow/skills/`).
    const pluginSkillDir = join(installed, "skills", "plugin-skill");
    await mkdir(pluginSkillDir, { recursive: true });
    await writeFile(
      join(pluginSkillDir, "SKILL.md"),
      "---\nname: plugin-skill\ndescription: From plugX\n---\n\nbody\n",
      "utf8"
    );
    // Also change the MCP config (the skill seam never reads mcp.json; neither
    // change may produce a delta).
    await writeFile(
      join(userHome, ".iknow", "mcp.json"),
      JSON.stringify({
        mcpServers: { ghost: { command: "node", args: ["-e", "0"] } },
      }),
      "utf8"
    );

    // SC11's main clause: without reload, neither the newly installed package
    // nor the MCP change enters the pre-turn diff.
    assert.deepEqual(
      await seam.delta("conv-t8"),
      { added: [], text: "" },
      "未 reload：新装插件包不产生 skill 索引 delta"
    );
    assert.deepEqual(
      built.skillRescanner.pluginSkillDirs(),
      [],
      "未 reload → rescan 缝持有的 plugin 根列表不被自动重解析"
    );

    // Non-vacuity premise: the package is on disk and really resolvable — the
    // empty delta above can only be attributed to "no root swap", not to
    // "the package is missing / unresolvable".
    const { enabled } = await resolvePluginCatalog({
      roots: [pluginRoot],
      plugins: {},
    });
    assert.deepEqual(
      enabled.map((p) => p.name),
      ["plugX"],
      "前提：包在盘上且解析得出来"
    );

    // Explicit reload: the host swaps the **complete** freshly resolved root
    // list into the same engine instance.
    const reloadedDirs = enabled.map((p) => ({
      dir: join(p.root, "skills"),
      plugin: p.name,
    }));
    built.skillRescanner.setPluginSkillDirs(reloadedDirs);

    // After the swap: a newly eligible skill travels the same delta path
    // (reload side of SC8).
    const after = await seam.delta("conv-t8");
    assert.deepEqual(after.added, ["plugX:plugin-skill"]);
    assert.equal(
      after.text,
      "<available_skills>\nplugX:plugin-skill: From plugX\n</available_skills>"
    );

    // The other half of "never edit the system frozen table": reload only
    // affects the delta face; the frozen table excludes the new name.
    const systemAfter = await built.deps.system?.();
    assert.doesNotMatch(
      systemAfter!,
      /plugX:plugin-skill/,
      "reload 后的新技能只走 messages 增量，绝不进 system 冻表"
    );
  });
});

// ---------------------------------------------------------------------------
// SC1 / SC2 / SC3 — append only new entries, placed at the very end of messages
// ---------------------------------------------------------------------------

describe("T5 技能索引增量注入 — SC1/SC2/SC3", () => {
  it("SC2：新增有 description 的技能 → 下一轮 messages 最末一条 user 文本只含该新 name（完整 description），冻表不含该行", async () => {
    const fixture = await makeFixture("sc2");
    await plantSkill(fixture.userHome, "alpha", "description: Alpha skill");
    const { seam, anchors, conversationId } = await makeDeltaSeam(fixture);

    // Model round one: call one tool (opens a second model-call window so the
    // "next round" is observable).
    const adapter = createStubModel({
      responses: [
        assistantResult({
          texts: [],
          toolCalls: [{ id: "a", name: "alpha", input: {} }],
        }),
        assistantResult({ texts: ["done"], toolCalls: [] }),
      ],
    });
    const { result } = await run(
      "go",
      baseDeps(adapter, { skillIndexDelta: seam, conversationId })
    );

    const texts = userTexts(result.messages);
    // Last user text = the delta listing (after this turn's query).
    const last = texts[texts.length - 1]!;
    assert.equal(
      last,
      "<available_skills>\nalpha: Alpha skill\n</available_skills>",
      "messages 最末一条 user 文本必须只含新建行 + 完整 description"
    );
    assert.equal(texts[0], "go", "本轮 query 仍在增量之前（最末 = delta）");
    // The frozen table (system) is not loop-engine's business — but the
    // injection path only touches messages: after round one, messages hold no
    // second listing besides the opening query.
    assert.equal(
      texts.filter(isListing).length,
      1,
      "只有一条 listing 被注入（不是每轮重复）"
    );
    // The anchor the seam receives = deps.conversationId (once per model call)
    // — the only source of "the ledger lands per conversation"; a wrong anchor
    // would read another conversation's ledger.
    assert.deepEqual(
      anchors,
      [conversationId, conversationId],
      "两次模型调用各取一次增量，锚都必须是 deps.conversationId"
    );
  });

  it("SC1：无新建 → 零追加（messages 里没有任何 listing；末条仍是本轮 query）", async () => {
    const fixture = await makeFixture("sc1");
    await plantSkill(fixture.userHome, "alpha", "description: Alpha skill");
    // The frozen table already contains alpha → the ledger starts with it → no new entries.
    const { seam, conversationId } = await makeDeltaSeam(fixture, ["alpha"]);

    const adapter = createStubModel({
      responses: [
        assistantResult({
          texts: [],
          toolCalls: [{ id: "a", name: "alpha", input: {} }],
        }),
        assistantResult({ texts: ["done"], toolCalls: [] }),
      ],
    });
    const { result } = await run(
      "go",
      baseDeps(adapter, { skillIndexDelta: seam, conversationId })
    );

    const texts = userTexts(result.messages);
    assert.deepEqual(texts, ["go"], "无新建 → 只有本轮 query，零 listing");
    assert.equal(texts.filter(isListing).length, 0);
  });

  it("SC3：同一新 name 第二轮不再追加（跨两次 run，落盘史生效）", async () => {
    const fixture = await makeFixture("sc3");
    await plantSkill(fixture.userHome, "alpha", "description: Alpha skill");
    const { seam, conversationId } = await makeDeltaSeam(fixture);

    const firstAdapter = createStubModel({
      responses: [assistantResult({ texts: ["first"], toolCalls: [] })],
    });
    // Both runs share one conversation anchor (two rounds of the same session)
    // — matching serve's per-run runDeps shape.
    const first = await run(
      "one",
      baseDeps(firstAdapter, { skillIndexDelta: seam, conversationId })
    );
    assert.equal(
      userTexts(first.result.messages).filter(isListing).length,
      1,
      "第一轮贴出新建行"
    );

    const secondAdapter = createStubModel({
      responses: [assistantResult({ texts: ["second"], toolCalls: [] })],
    });
    const second = await run(
      "two",
      baseDeps(secondAdapter, { skillIndexDelta: seam, conversationId })
    );
    assert.deepEqual(
      userTexts(second.result.messages),
      ["two"],
      "第二轮同一 name 不再追加（判定读落盘史，不读 messages）"
    );
  });

  it("SC3 恢复路径：新 ledger 实例载入落盘史 → 同一 name 仍不追加", async () => {
    const fixture = await makeFixture("sc3-resume");
    await plantSkill(fixture.userHome, "alpha", "description: Alpha skill");
    const first = await makeDeltaSeam(fixture);
    const adapter = createStubModel({
      responses: [assistantResult({ texts: ["first"], toolCalls: [] })],
    });
    await run(
      "one",
      baseDeps(adapter, {
        skillIndexDelta: first.seam,
        conversationId: first.conversationId,
      })
    );
    assert.deepEqual(first.ledgerNames(), ["alpha"]);

    // Session restore: a fresh ledger over the same projectDir /
    // conversationId auto-loads the history. One anchor spans both runs —
    // after restore loop-engine still passes the same anchor.
    const restored = await makeDeltaSeam(fixture);
    assert.deepEqual(restored.ledgerNames(), ["alpha"], "落盘史被载回");
    const secondAdapter = createStubModel({
      responses: [assistantResult({ texts: ["second"], toolCalls: [] })],
    });
    const second = await run(
      "two",
      baseDeps(secondAdapter, {
        skillIndexDelta: restored.seam,
        conversationId: restored.conversationId,
      })
    );
    assert.deepEqual(userTexts(second.result.messages), ["two"]);
  });
});

// ---------------------------------------------------------------------------
// SC4 — after compact, no re-appended listing
// ---------------------------------------------------------------------------

describe("T5 技能索引增量注入 — SC4 (compact 后不重贴)", () => {
  it("reactive compact 重试那一拍：增量判定仍读落盘史 → delta 空、**不**产生第二条 listing", async () => {
    const fixture = await makeFixture("sc4");
    await plantSkill(fixture.userHome, "alpha", "description: Alpha skill");
    const { seam, conversationId, ledgerNames } = await makeDeltaSeam(fixture);

    // Record every `delta()` return in call order — the decision face (the
    // `added` the second model call sees) is directly visible, no need to
    // reverse-infer from messages (compact may leave the first injected
    // listing in the tail; counting messages can't tell "re-appended or not").
    const deltaResults: Array<readonly string[]> = [];
    const spySeam: SkillIndexDeltaSeam = {
      delta: async (anchor) => {
        const out = await seam.delta(anchor);
        deltaResults.push(out.added);
        return out;
      },
    };

    // The first model call throws PromptTooLongError (reactive trigger) → compact, then retry.
    let attempt = 0;
    const adapter: LoopEngineDeps["adapter"] = Object.freeze({
      encodeUserText: (t: string) => ({
        role: "user",
        content: [{ type: "text", text: t }],
      }),
      encodeToolResults: () => [],
      step: async (_state, request) => {
        attempt += 1;
        if (attempt === 1) throw new PromptTooLongError("synthetic");
        if (request.tools === undefined) {
          // full-compact summary turn: empty text → placeholder compaction product.
          return assistantResult({
            texts: [],
            toolCalls: [],
            supplierStop: "success",
          });
        }
        return assistantResult({
          texts: ["done"],
          toolCalls: [],
          supplierStop: "success",
        });
      },
    });

    // Prior long enough for reactive compaction to have something to compact (tail-keep policy engages).
    const longPrior: AnthropicNativeMessage[] = Array.from(
      { length: 12 },
      (_, i) => ({
        role: "user" as const,
        content: [{ type: "text" as const, text: `prior-${i}` }],
      })
    );
    const committed: ReadonlyArray<AnthropicNativeMessage>[] = [];
    const { result } = await run(
      "go",
      baseDeps(adapter, {
        skillIndexDelta: spySeam,
        conversationId,
        commitMessages: async (messages) => {
          committed.push(messages);
        },
        compress: { contextWindow: 200_000, thresholdTokens: 10_000 },
      }),
      undefined,
      { priorMessages: longPrior }
    );

    assert.equal(result.stopReason, "completed");
    assert.equal(attempt, 3, "第一次 400 → 摘要轮 → 重试成功");
    assert.deepEqual(
      deltaResults,
      [["alpha"], []],
      "第二次判定（compact 重试那一拍）必须返回空 —— 判定读落盘史，不读 messages"
    );
    // Appended exactly once: across all commit batches there is just one listing.
    const listings = committed
      .flat()
      .filter(
        (m) =>
          m.role === "user" &&
          m.content.some(
            (b) => b.type === "text" && b.text.startsWith("<available_skills>")
          )
      );
    assert.equal(
      listings.length,
      1,
      "compact 不得让同一批 name 被再贴一遍（SC4）"
    );
    assert.deepEqual(ledgerNames(), ["alpha"], "进场史仍持有该 name");
  });
});

// ---------------------------------------------------------------------------
// SC7 / failure handling
// ---------------------------------------------------------------------------

describe("T5 技能索引增量注入 — SC7 / 失败处置", () => {
  it("SC7：slash 信封（skill-load）装了正文但 name 未进场 → 下一轮仍补 delta", async () => {
    const fixture = await makeFixture("sc7");
    await plantSkill(fixture.userHome, "alpha", "description: Alpha skill");
    // The ledger is empty (the slash envelope never writes it — the envelope side deliberately offers no write channel).
    const { seam, conversationId, ledgerNames } = await makeDeltaSeam(
      fixture,
      []
    );
    assert.deepEqual(ledgerNames(), [], "slash 过之后史仍为空");

    const adapter = createStubModel({
      responses: [assistantResult({ texts: ["ok"], toolCalls: [] })],
    });
    // This turn's query is itself a skill-load envelope (the body the model sees after slash loading).
    const { result } = await run(
      '[skill-load name="alpha"]\n<body>\n\n继续',
      baseDeps(adapter, { skillIndexDelta: seam, conversationId })
    );

    const texts = userTexts(result.messages);
    assert.equal(texts[0]!.startsWith("[skill-load "), true, "信封在最前");
    assert.equal(
      texts[texts.length - 1],
      "<available_skills>\nalpha: Alpha skill\n</available_skills>",
      "信封 ≠ 进场史：下一轮仍补该 name 的索引增量"
    );
    assert.deepEqual(ledgerNames(), ["alpha"], "补 delta 时写入进场史");
  });

  it("rescan 失败（不可读技能根）→ 不注入、不改冻表（seam 抛错被吞咽，回合照常结束）", async () => {
    const fixture = await makeFixture("rescan-fail");
    const skillRoot = join(fixture.userHome, ".iknow", "skills");
    await mkdir(skillRoot, { recursive: true });
    const { chmod } = await import("node:fs/promises");
    await chmod(skillRoot, 0o000);
    const { seam, conversationId } = await makeDeltaSeam(fixture);

    const adapter = createStubModel({
      responses: [assistantResult({ texts: ["done"], toolCalls: [] })],
    });
    const { result } = await run(
      "go",
      baseDeps(adapter, { skillIndexDelta: seam, conversationId })
    );
    await chmod(skillRoot, 0o755).catch(() => {});

    assert.equal(result.stopReason, "completed", "rescan 失败不中断回合");
    assert.deepEqual(
      userTexts(result.messages),
      ["go"],
      "rescan 失败 → 零追加（不贴残缺 delta）"
    );
  });

  it("落盘失败 → 不注入（messages 里没有 listing；内存史仍为空）", async () => {
    const fixture = await makeFixture("write-fail");
    await plantSkill(fixture.userHome, "alpha", "description: Alpha skill");
    const { seam, conversationId, ledgerNames } = await makeDeltaSeam(fixture);
    // After loading, replace the directory segment with a file → the atomic write hits ENOTDIR.
    await rm(join(fixture.projectDir, "conv-loop-delta"), {
      recursive: true,
      force: true,
    });
    await writeFile(
      join(fixture.projectDir, "conv-loop-delta"),
      "not a dir",
      "utf8"
    );

    const adapter = createStubModel({
      responses: [assistantResult({ texts: ["done"], toolCalls: [] })],
    });
    const { result } = await run(
      "go",
      baseDeps(adapter, { skillIndexDelta: seam, conversationId })
    );

    assert.equal(result.stopReason, "completed");
    assert.deepEqual(userTexts(result.messages), ["go"], "落盘失败 → 零追加");
    assert.deepEqual(
      ledgerNames(),
      [],
      "内存史不变（未把 messages 追加当已进场）"
    );
  });
});

// ---------------------------------------------------------------------------
// Commit discipline: injected messages flush with the next commit batch
// ---------------------------------------------------------------------------

describe("T5 注入消息的 commit 纪律（#888 同形）", () => {
  it("注入的 listing 在下一次 commit 批里（不在内存里悬空）", async () => {
    const fixture = await makeFixture("commit");
    await plantSkill(fixture.userHome, "alpha", "description: Alpha skill");
    const { seam, conversationId } = await makeDeltaSeam(fixture);

    const committed: ReadonlyArray<AnthropicNativeMessage>[] = [];
    const adapter = createStubModel({
      responses: [
        assistantResult({
          texts: [],
          toolCalls: [{ id: "a", name: "alpha", input: {} }],
        }),
        assistantResult({ texts: ["done"], toolCalls: [] }),
      ],
    });
    const { result } = await run(
      "go",
      baseDeps(adapter, {
        skillIndexDelta: seam,
        conversationId,
        commitMessages: async (messages) => {
          committed.push(messages);
        },
      })
    );

    const flat = committed.flat();
    assert.deepEqual(
      flat,
      result.messages.slice(1),
      "展平 commit 批 == 权威历史（除 query）—— 注入 listing 在批内，save 不判 fork"
    );
    assert.ok(
      flat.some((m) =>
        m.content.some(
          (b) => b.type === "text" && b.text.startsWith("<available_skills>")
        )
      ),
      "listing 确实进了 commit 流（不是被静默丢弃）"
    );
  });
});

// ---------------------------------------------------------------------------
// Dual track: real trace recording vs the NoopTrace baseline
// ---------------------------------------------------------------------------

describe("T5 双轨 assert — 索引进场不依赖也不改变 trace 观测", () => {
  it("真 trace 服务记录 turn 序；NoopTrace 基线的 messages 与 listing 逐字段 deepEqual", async () => {
    const fixture = await makeFixture("trace");
    await plantSkill(fixture.userHome, "alpha", "description: Alpha skill");
    const traceDir = join(fixture.root, "trace");
    await mkdir(traceDir, { recursive: true });

    const scripted = (): LoopEngineDeps["adapter"] =>
      createStubModel({
        responses: [assistantResult({ texts: ["done"], toolCalls: [] })],
      });

    // Each run gets its own session (the ledger lands once; the second run
    // shows no listing — that is exactly SC3; what this case compares is
    // "trace observation never changes behavior for the same input").
    const tracedSeam = await makeDeltaSeam(fixture, [], "conv-trace");
    const withTrace = await run(
      "go",
      baseDeps(scripted(), {
        skillIndexDelta: tracedSeam.seam,
        conversationId: tracedSeam.conversationId,
        trace: createJsonlTraceService({
          traceFilePath: join(traceDir, "with-trace.jsonl"),
          conversationId: "conv-trace",
        }),
      })
    );
    const noopSeam = await makeDeltaSeam(fixture, [], "conv-noop");
    const noop = await run(
      "go",
      baseDeps(scripted(), {
        skillIndexDelta: noopSeam.seam,
        conversationId: noopSeam.conversationId,
        trace: createNoopTraceService(),
      })
    );

    assert.deepEqual(
      withTrace.result.messages,
      noop.result.messages,
      "trace 观测不改变注入行为本身（NoopTrace 基线）"
    );
    // Second track: read the disk for real — the trace file contains this
    // run's turn records (reader.query's kind filter is the consumption-face
    // SSOT; don't parse JSONL by hand).
    const reader = createJsonlTraceReader({
      filePath: join(traceDir, "with-trace.jsonl"),
    });
    const turns = reader.query({ recordType: "turn" });
    assert.ok(turns.records.length > 0, "真 trace 服务必须写出 turn 记录");
  });
});
