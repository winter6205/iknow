/**
 * T5 (`specs/skill-index-increment.md` / ADR-0098) — 送模型前的技能索引增量。
 *
 * 本文件钉住的不变式（SC 出处见每条测名）：
 *   - SC1 无新建 → 零追加（messages 长度不变、末条仍是本轮 query）；
 *   - SC2 有新建 → messages **最末**一条 user 文本为 `<available_skills>`
 *     且**只含**该新 name（含完整 description）；本轮 query / 栏在它前面；
 *   - SC3 同一新 name 第二轮不再追加；
 *   - SC4 compact 之后不因「messages 里增量不见了」再追加；
 *   - SC7 slash 信封（skill-load）装了正文，该 name 未进场 → 下一轮仍补 delta；
 *   - rescan 失败 → 不注入；落盘失败 → 不注入；
 *   - 注入消息经 `pendingInjected.record` → 随下一批 commit flush（#888 纪律）。
 *
 * 双轨 assert（`.claude/rules/test.md`「Trace as the integration-test assert
 * surface」）：本套件用 `trace` 记录 turn 序（真实 `createJsonlTraceService` +
 * `createJsonlTraceReader` 双读），另配 `createNoopTraceService` 基线
 * deepEqual —— trace 观测不改变 harness 行为本身。
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

/** 落一个 user 级 skill（`<userHome>/.iknow/skills/<name>/SKILL.md`）。 */
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
 * 真装配的增量缝：rescan 现行技能根 + 落盘进场史（T4/T6 两个真模块），
 * 与生产 `build-engine` 将来注入的形态同构 —— 不 mock 任何判定。
 *
 * 会话锚按装配缝的契约从 `delta(conversationId)` **调用参数**取：本 fixture
 * 只服务单会话（`conversationId` 给了默认值），因此锚在调用期解析成同一个
 * 已建好的 ledger；换个锚会落到另一份 ledger 上（生产 `build-engine` 的
 * `createSkillIndexDeltaSeam` 负责该映射，本助手把它显式化 —— 传错锚即
 * 测试失败，而不是静默复用）。
 */
async function makeDeltaSeam(
  fixture: Fixture,
  initialNames: readonly string[] = [],
  conversationId = "conv-loop-delta"
): Promise<{
  seam: SkillIndexDeltaSeam;
  /** 该缝每次被调用时收到的会话锚（按调用序）—— 契约：= deps.conversationId。 */
  anchors: Array<string | undefined>;
  /** 必须同时注入 deps 的会话锚（缝按它解析 per-conversation 进场史）。 */
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
  // 锚只记录、不在缝内 assert —— 缝抛出的错会被 loop-engine 的吞咽臂
  // 变成「本轮不贴」，测试会以一个看不出原因的 listing 缺失失败。
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

/** messages 里全部 user 文本（按出现序，text block 连接）。 */
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

/** build-engine 缝用例的 env（与 agent-status-bar / disclosure-index-align 同法）。 */
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
// 装配缝（build-engine）：可选、同门、per-conversation 叶子 —— SC2/SC3 的
// 「生产形态真的接得上」那一半（判定与注入在循环侧的证明见上）。
// ---------------------------------------------------------------------------

describe("T5 装配缝 — build-engine 的 skillIndexDelta（可选 seam）", () => {
  it("chat + todoDir 注入 → 缝在场且真rescan:装配后新建的技能经缝贴出（initialNames 只含开场冻表名）", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "iknow-skill-delta-build-"));
    tempDirs.push(tmp);
    const userHome = join(tmp, "home");
    const todoDir = join(tmp, "todos");
    await mkdir(userHome, { recursive: true });
    await mkdir(todoDir, { recursive: true });
    // 开场冻表里已有 alpha（装配期扫描到）。
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

    // SC1「开场冻表字节不变」：取两次增量（含一次贴出 beta 之后）——
    // system 冻表在两次之间必须逐字节相同，且 rollout 后**不含** beta
    // （冻表是装配期冻结的，增量只走 messages）。
    const systemBefore = await built.deps.system?.();
    assert.ok(systemBefore !== undefined);
    assert.match(systemBefore, /^alpha: Alpha skill$/m, "开场冻表含 alpha");
    // rescan 持有者透出给 host 的 reload 面（plugin 根换血落在同一台上）。
    assert.ok(
      built.skillRescanner !== undefined,
      "non-ask 装配必须透出同一个 rescan 持有者"
    );
    assert.deepEqual(
      built.skillRescanner.pluginSkillDirs(),
      [],
      "未解析插件根 → 空列表（不是 undefined）"
    );

    // 冻表名不在增量里（开场已进场）—— initialNames 来自装配期 holder。
    const first = await seam.delta("conv-build-1");
    assert.deepEqual(first.added, [], "开场冻表名不算新建");

    // 装配后（会话内）新建的技能 → 下一次取增量必须贴出来（SC2 的装配面）。
    await plantSkill(userHome, "beta", "description: Beta skill");
    const second = await seam.delta("conv-build-1");
    assert.deepEqual(second.added, ["beta"]);
    assert.equal(
      second.text,
      "<available_skills>\nbeta: Beta skill\n</available_skills>"
    );

    // 同一 name 第二轮不再贴（SC3 的装配面：per-conversation 落盘史生效）。
    const third = await seam.delta("conv-build-1");
    assert.deepEqual(third.added, [], "同一会话第二轮无新建");

    // 换会话 = 另一份进场史（另一个落点文件），但冻表名对**每个**会话都是
    // 开场已进场（同一台引擎的 system 冻表对所有会话相同）—— 故只有 beta
    // 是那个会话的「新建」。
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

    // 走过 beta 的 rescan + 两次贴出后，冻表字节仍与开场逐字节相同，
    // 且仍不含 beta —— 「增量不改冻表」是 SC1 的另一半。
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
// T8 / SC11 — plugin / MCP 不自动 skill-diff。整包靠**显式 reload 或新会话**：
//   - 未 reload：插件包与 MCP 配置在盘上变化 → delta 恒为空（不进 turn 前 diff）；
//   - 显式 reload（host 在同一台 engine 的 `setPluginSkillDirs` 换血）后，
//     多出来的**模型索引**名仍走同一条 T5 delta（不改 system 冻表）。
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

    // 装配期：插件根在场但**空**（包还没装）→ 冻结的根列表为空。
    const built = await buildHarnessEngine({
      env: makeEnv("sk-skill-delta-t8"),
      askUser: createNoAskUser(),
      surface: "chat",
      todoDir,
      userHome,
      cwd: tmp,
      skipCountTokens: true,
      // settings.plugins.roots = 显式插件根（测试缝；否则默认探本机 ~/.iknow/plugins）。
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

    // 会话进行中：新装一个插件包（ledger 给出精确名 + installPath，
    // `skills/` 下有一个**有 description** = 模型索引合格的技能）。
    await writeFile(
      join(pluginRoot, "installed_plugins.json"),
      JSON.stringify({
        version: 1,
        plugins: { "plugX@local": [{ scope: "user", installPath: installed }] },
      }),
      "utf8"
    );
    // 插件 skill 落点 = `<installPath>/skills/<name>/SKILL.md`（scanner 的
    // plugin 根直指 `skills/`，与 user 级 `.iknow/skills/` 不同）。
    const pluginSkillDir = join(installed, "skills", "plugin-skill");
    await mkdir(pluginSkillDir, { recursive: true });
    await writeFile(
      join(pluginSkillDir, "SKILL.md"),
      "---\nname: plugin-skill\ndescription: From plugX\n---\n\nbody\n",
      "utf8"
    );
    // 同时改 MCP 配置（skill 缝不读 mcp.json，两件事必须都不产生 delta）。
    await writeFile(
      join(userHome, ".iknow", "mcp.json"),
      JSON.stringify({
        mcpServers: { ghost: { command: "node", args: ["-e", "0"] } },
      }),
      "utf8"
    );

    // SC11 主句：未 reload → 新装的包与 MCP 变化都不进 turn 前 diff。
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

    // 非空洞前提：包在盘上、确实解析得出来 —— 上面那个空 delta 只可能
    // 归因于「没换血」，不是「包不存在 / 解析不出来」。
    const { enabled } = await resolvePluginCatalog({
      roots: [pluginRoot],
      plugins: {},
    });
    assert.deepEqual(
      enabled.map((p) => p.name),
      ["plugX"],
      "前提：包在盘上且解析得出来"
    );

    // 显式 reload：host 把这一轮重新解析出的**完整**根列表整体换血到同一台。
    const reloadedDirs = enabled.map((p) => ({
      dir: join(p.root, "skills"),
      plugin: p.name,
    }));
    built.skillRescanner.setPluginSkillDirs(reloadedDirs);

    // 换血后：新合格 skill 走同一条 T5 delta（SC8 的 reload 侧）。
    const after = await seam.delta("conv-t8");
    assert.deepEqual(after.added, ["plugX:plugin-skill"]);
    assert.equal(
      after.text,
      "<available_skills>\nplugX:plugin-skill: From plugX\n</available_skills>"
    );

    // 「不改 system 冻表」的另一半：reload 只影响 delta 面，冻表不含新名。
    const systemAfter = await built.deps.system?.();
    assert.doesNotMatch(
      systemAfter!,
      /plugX:plugin-skill/,
      "reload 后的新技能只走 messages 增量，绝不进 system 冻表"
    );
  });
});

// ---------------------------------------------------------------------------
// SC1 / SC2 / SC3 — 只追加新建 + 落位 messages 最末
// ---------------------------------------------------------------------------

describe("T5 技能索引增量注入 — SC1/SC2/SC3", () => {
  it("SC2：新增有 description 的技能 → 下一轮 messages 最末一条 user 文本只含该新 name（完整 description），冻表不含该行", async () => {
    const fixture = await makeFixture("sc2");
    await plantSkill(fixture.userHome, "alpha", "description: Alpha skill");
    const { seam, anchors, conversationId } = await makeDeltaSeam(fixture);

    // 模型第一轮：调一次工具（制造第二个模型调用窗口，便于观察「下一轮」）。
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
    // 最后一条 user 文本 = 增量 listing（在本轮 query 之后）。
    const last = texts[texts.length - 1]!;
    assert.equal(
      last,
      "<available_skills>\nalpha: Alpha skill\n</available_skills>",
      "messages 最末一条 user 文本必须只含新建行 + 完整 description"
    );
    assert.equal(texts[0], "go", "本轮 query 仍在增量之前（最末 = delta）");
    // 冻表（system）不在 loop-engine 手上 —— 但注入路径只碰 messages:
    // 第一轮之后 messages 里除首条 query 外没有第二条 listing。
    assert.equal(
      texts.filter(isListing).length,
      1,
      "只有一条 listing 被注入（不是每轮重复）"
    );
    // 缝收到的会话锚 = deps.conversationId（两次模型调用各一次）—— 这是
    // 「进场史按会话落点」的唯一来源，锚错了会读到别的会话的史。
    assert.deepEqual(
      anchors,
      [conversationId, conversationId],
      "两次模型调用各取一次增量，锚都必须是 deps.conversationId"
    );
  });

  it("SC1：无新建 → 零追加（messages 里没有任何 listing；末条仍是本轮 query）", async () => {
    const fixture = await makeFixture("sc1");
    await plantSkill(fixture.userHome, "alpha", "description: Alpha skill");
    // 冻表已含 alpha → 进场史初值含它 → 无新建。
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
    // 两次 run 用同一会话锚（同一 session 的两轮）—— 与 serve 的 per-run
    // runDeps 形态一致。
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

    // session 恢复：新建 ledger（同 projectDir / conversationId）自动载入史。
    // 同一会话锚跨两次 run —— 恢复后 loop-engine 拿到的锚仍是它。
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
// SC4 — compact 之后不重挂 listing
// ---------------------------------------------------------------------------

describe("T5 技能索引增量注入 — SC4 (compact 后不重贴)", () => {
  it("reactive compact 重试那一拍：增量判定仍读落盘史 → delta 空、**不**产生第二条 listing", async () => {
    const fixture = await makeFixture("sc4");
    await plantSkill(fixture.userHome, "alpha", "description: Alpha skill");
    const { seam, conversationId, ledgerNames } = await makeDeltaSeam(fixture);

    // 每次 `delta()` 的返回值按调用序记下 —— 判定面（第二个模型调用看到
    // 的 added）直接可见，不必从 messages 反推（compact 可能把第一条
    // 注入的 listing 留在尾部，从 messages 数看不出「有没有重贴」）。
    const deltaResults: Array<readonly string[]> = [];
    const spySeam: SkillIndexDeltaSeam = {
      delta: async (anchor) => {
        const out = await seam.delta(anchor);
        deltaResults.push(out.added);
        return out;
      },
    };

    // 第一次模型调用抛 PromptTooLongError（reactive 触发）→ 压缩后重试。
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
          // full-compact 摘要轮：空文本 → placeholder 压缩产物。
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

    // 够长的 prior，让 reactive 压缩有东西可压（尾部保留策略生效）。
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
    // 只被追加过一次：全部 commit 批里 listing 恰一条。
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
// SC7 / 失败处置
// ---------------------------------------------------------------------------

describe("T5 技能索引增量注入 — SC7 / 失败处置", () => {
  it("SC7：slash 信封（skill-load）装了正文但 name 未进场 → 下一轮仍补 delta", async () => {
    const fixture = await makeFixture("sc7");
    await plantSkill(fixture.userHome, "alpha", "description: Alpha skill");
    // 进场史空（slash 信封不写史 —— T4 明确不提供信封侧写入通道）。
    const { seam, conversationId, ledgerNames } = await makeDeltaSeam(
      fixture,
      []
    );
    assert.deepEqual(ledgerNames(), [], "slash 过之后史仍为空");

    const adapter = createStubModel({
      responses: [assistantResult({ texts: ["ok"], toolCalls: [] })],
    });
    // 本轮 query 就是 skill-load 信封形态（slash 装载后模型看到的正文）。
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
    // 载入之后把目录段占成文件 → 原子写 ENOTDIR。
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
// #888 纪律：注入消息随下一批 commit flush
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
// 双轨：真实 trace 记录 vs NoopTrace 基线
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

    // 两条 run 各自独立 session（进场史只落一次，第二次就不贴了 —— 那正是
    // SC3；本用例要比的是「同一输入下 trace 观测不改变行为」）。
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
    // 第二轨：真读盘 —— trace 文件含本 run 的 turn 记录（reader.query 的
    // kind 过滤是消费面 SSOT，不自己解析 JSONL）。
    const reader = createJsonlTraceReader({
      filePath: join(traceDir, "with-trace.jsonl"),
    });
    const turns = reader.query({ recordType: "turn" });
    assert.ok(turns.records.length > 0, "真 trace 服务必须写出 turn 记录");
  });
});
