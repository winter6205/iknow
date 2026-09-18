/** @jsxImportSource @opentui/react */
/**
 * tests/tui/skill-load.test.tsx
 *
 * #337 Phase C：/skill-name [提示词] 加载发送 — TuiApp 端到端。
 *
 * 装配（两种）：
 *   - stub bridge（makeDeps + 真实 inflight registry，hub 不发真实网络请求）
 *     + stub skillCatalog（1 个 skill `echo`，dir 指向 tmp fixture 目录，
 *     SKILL.md = frontmatter + 正文）—— 验 skill-load 信封与渲染投影；
 *   - 真实 scanner + `createSkillCatalog`（`plantPluginSkillFixture`，
 *     pluginSkillDirs 命名空间）—— 验 spec tui-skill-slash-catalog 的裸名
 *     别名投影在 TUI 端到端（裸名/规范名两条路径同一 envelope）。
 * createSkillBody 走真实 harness 装配（app.tsx 同款调用路径），断言
 * 「发送文本 = [skill-load name="..."]\n<正文>」。
 *
 * 发送文本经 bridge.postMessage → run() encodeUserText 整段成为 user message；
 * 测试直接读落盘会话文件断言模型历史文本（确定性注入，不依赖模型主动性）。
 * user echo 显示精简形态「[加载技能 echo]」。
 *
 * 约束：不改 session-state.ts（Phase D 管 view 扩展）；不删 / 不 skip 既有测试。
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testRender } from "@opentui/react/test-utils";
import type { TestRendererSetup } from "@opentui/core/testing";
import { TuiApp, createToolEventSink } from "../../src/tui/app.js";
import {
  createInflightRegistry,
  createTuiBridge,
  type TuiBridge,
} from "../../src/tui/hub-bridge.js";
import { createTuiAskUserBridge } from "../../src/tui/ask-user.js";
import { createPermissionModeContext } from "../../src/harness/permission/index.js";
import { createSessionGrants } from "../../src/harness/permission/session-grants.js";
import {
  createSkillCatalog,
  type SkillCatalog,
} from "../../src/harness/skill/catalog.js";
import { createSkillScanner } from "../../src/harness/skill/scanner.js";
import { createSkillTool } from "../../src/harness/aci/tools/skill.js";
import { createRegistry } from "../../src/harness/tools/registry.js";
import { createExecutor } from "../../src/harness/tools/executor.js";
import type { LoopEngineDeps } from "../../src/harness/index.js";
import { assistantResult, makeDeps } from "../cli/_fixtures.ts";
import { createStubModel } from "../../src/harness/stubs/stub-model.js";

/** 帧等待：mockInput 字节经 stdin 异步解析，需轮询 renderOnce。 */
async function untilFrame(
  setup: TestRendererSetup,
  pred: (frame: string) => boolean,
  ms = 8000
): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    await new Promise((r) => setTimeout(r, 50));
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    if (pred(frame)) return frame;
  }
  throw new Error(`untilFrame timeout:\n${setup.captureCharFrame()}`);
}

async function until(
  cond: () => boolean | Promise<boolean>,
  ms = 8000,
  label = ""
): Promise<void> {
  const start = Date.now();
  while (!(await cond())) {
    if (Date.now() - start > ms) throw new Error(`until timeout: ${label}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

interface SkillFixture {
  readonly root: string;
  readonly skillDir: string;
  readonly catalog: SkillCatalog;
  readonly cleanup: () => Promise<void>;
}

/** 铺一个 skill fixture：SKILL.md（frontmatter + 正文）+ stub catalog。 */
async function plantSkillFixture(): Promise<SkillFixture> {
  const root = await mkdtemp(join(tmpdir(), "iknow-tui-skill-load-"));
  const skillDir = join(root, "echo");
  await mkdir(skillDir, { recursive: true });
  await writeFile(
    join(skillDir, "SKILL.md"),
    [
      "---",
      "name: echo",
      "description: 回声技能（echoes your message）",
      "---",
      "# 回声技能",
      "",
      "当用户要求回声时，原样返回输入内容。",
      "",
      "## 规则",
      "- 只做回声，不做其他操作。",
    ].join("\n"),
    "utf8"
  );
  const entry = {
    name: "echo",
    description: "回声技能（echoes your message）",
    dir: skillDir,
    disabled: false,
  };
  const catalog: SkillCatalog = {
    search: (q) =>
      String(entry.name).includes(q) && !entry.disabled ? [entry] : [],
    get: (name) => (name === entry.name ? entry : undefined),
    all: () => [entry],
    available: () => [entry],
    getBodyPath: () => join(skillDir, "SKILL.md"),
  };
  return {
    root,
    skillDir,
    catalog,
    cleanup: async () => {
      await rm(root, { recursive: true, force: true });
    },
  };
}

/**
 * spec tui-skill-slash-catalog SC1/SC2（route A）：插件技能 fixture —— 走
 * **真实** scanner + catalog（`pluginSkillDirs` 命名空间 → canonical
 * `<plugin>:<name>` + bareIndex 裸名别名），而不是手写 stub catalog。这样
 * app.tsx 的别名投影（`stripNamespace` + `catalog.get(bare) === entry` 唯一性
 * 判据）被端到端点到：裸名能加载、规范名能加载、展示仍 canonical。
 */
async function plantPluginSkillFixture(): Promise<SkillFixture> {
  const root = await mkdtemp(join(tmpdir(), "iknow-tui-skill-bare-"));
  const skillsRoot = join(root, "arthurpower", "skills");
  const skillDir = join(skillsRoot, "using-agent-skills");
  await mkdir(skillDir, { recursive: true });
  await writeFile(
    join(skillDir, "SKILL.md"),
    [
      "---",
      "name: using-agent-skills",
      "description: 技能调度（dispatch skills）",
      "---",
      "# 技能调度",
      "",
      "按任务派发合适技能。",
    ].join("\n"),
    "utf8"
  );
  const entries = await createSkillScanner({
    userHome: join(root, "home"),
    projectIdentityRoot: join(root, "project"),
    env: {},
    pluginSkillDirs: [{ dir: skillsRoot, plugin: "arthurpower" }],
  }).scan();
  const catalog = createSkillCatalog(entries);
  return {
    root,
    skillDir,
    catalog,
    cleanup: async () => {
      await rm(root, { recursive: true, force: true });
    },
  };
}

interface DrivenApp {
  readonly bridge: TuiBridge;
  readonly setup: TestRendererSetup;
  readonly destroy: () => Promise<void>;
  readonly typeText: (text: string) => Promise<void>;
  readonly pressEnter: () => Promise<void>;
  readonly pressTab: () => Promise<void>;
}

async function mountAppAsync(
  catalog: SkillCatalog,
  responses: Parameters<typeof makeDeps>[0],
  opts: {
    readonly delayMs?: number;
    /**
     * skill-body-short-circuit T3 (SC4)：覆盖 harness deps（registry /
     * executor / adapter），让真实 skill() 工具与本轮 turn 同池装配。
     */
    readonly depsOverride?: LoopEngineDeps;
  } = {}
): Promise<DrivenApp> {
  const dataDir = mkdtempSync(join(tmpdir(), "iknow-tui-skillload-data-"));
  const bridge = createTuiBridge({
    dataDir,
    workspaceRoot: dataDir,
    deps:
      opts.depsOverride ??
      makeDeps(responses, {
        ...(opts.delayMs ? { delayMs: opts.delayMs } : {}),
      }),
    inflight: createInflightRegistry(),
  });
  const askBridge = createTuiAskUserBridge();
  const toolEventSink = createToolEventSink();
  const permissionMode = createPermissionModeContext("default");
  const sessionGrants = createSessionGrants();
  let setupRef: TestRendererSetup | undefined;
  const setup = await testRender(
    <TuiApp
      bridge={bridge}
      askBridge={askBridge}
      toolEventSink={toolEventSink}
      cwd="/tmp/proj"
      dataDir={dataDir}
      permissionMode={permissionMode}
      sessionGrants={sessionGrants}
      skillCatalog={catalog}
      onQuit={() => {
        if (setupRef && !setupRef.renderer.isDestroyed)
          setupRef.renderer.destroy();
      }}
    />,
    { width: 100, height: 40, exitOnCtrlC: false, consoleMode: "disabled" }
  );
  setupRef = setup;
  await new Promise((r) => setTimeout(r, 500));
  await setup.waitForVisualIdle();
  await setup.waitForVisualIdle();
  return {
    bridge,
    setup,
    destroy: async () => {
      if (!setup.renderer.isDestroyed) setup.renderer.destroy();
    },
    typeText: async (text: string) => {
      // 预热：先按一个无害键让 mockInput 解析器启动。
      setup.mockInput.pressKey("/");
      await new Promise((r) => setTimeout(r, 100));
      await setup.renderOnce();
      // 清掉预热键（按 Backspace 多次）。
      for (let i = 0; i < 5; i++) {
        setup.mockInput.pressBackspace();
        await new Promise((r) => setTimeout(r, 30));
      }
      // 真正要输入的内容。
      for (const ch of text) {
        setup.mockInput.pressKey(ch);
        await new Promise((r) => setTimeout(r, 30));
      }
      // 让 React 状态更新落地。
      await new Promise((r) => setTimeout(r, 100));
      await setup.renderOnce();
    },
    pressEnter: async () => {
      setup.mockInput.pressEnter();
      await new Promise((r) => setTimeout(r, 100));
      await setup.renderOnce();
    },
    pressTab: async () => {
      setup.mockInput.pressTab();
      await new Promise((r) => setTimeout(r, 100));
      await setup.renderOnce();
    },
  };
}

/**
 * 等本次 skill-load turn 落盘（首条 user 信封 + 模型回复齐）后回读首条 user
 * 文本。inflight 空判有竞态（提交尚未进 registry 时就读到 0），落盘是权威
 * 信号。
 */
async function awaitSkillLoadEnvelope(app: DrivenApp): Promise<string> {
  await until(
    async () => {
      const list = await app.bridge.listSessions();
      if (list.length === 0) return false;
      const f = await app.bridge.loadSessionFile(list[0]!.conversation_id);
      return f.messages.some((m) => m.role === "assistant");
    },
    8000,
    "skill-load-persisted"
  );
  const list = await app.bridge.listSessions();
  const file = await app.bridge.loadSessionFile(list[0]!.conversation_id);
  const first = file.messages[0]!;
  return first.content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

describe("Phase C: /skill-name 加载发送", () => {
  test("输入 /echo 帮我做 X + Enter → 发送文本含 skill-load 头 + 正文 + remainder；echo 与发送文本一致（状态机纪律：turnFinished 权威刷新）", async () => {
    const fx = await plantSkillFixture();
    const app = await mountAppAsync(fx.catalog, [
      assistantResult({ texts: ["回声完成"] }),
    ]);
    await untilFrame(app.setup, (f) => f.includes("Version"));
    await untilFrame(app.setup, (f) => f.includes("输入消息"));

    await app.typeText("/echo 帮我做 X");
    await app.pressEnter();

    // 落盘是权威信号：inflight 空判有竞态（postMessage 才 mark，提交尚未进
    // registry 时就读到 0）。本文件既有 helper 已按此纪律写，此处同源。
    const userText = await awaitSkillLoadEnvelope(app);

    // 落盘会话文件：模型历史第一条 user 消息 = 完整 skill-load 发送文本。
    const list = await app.bridge.listSessions();
    expect(list.length).toBe(1);
    const sessionId = list[0]!.conversation_id;
    const file = await app.bridge.loadSessionFile(sessionId);
    expect(file.messages.length).toBeGreaterThan(0);
    const first = file.messages[0]!;
    expect(first.role).toBe("user");
    expect(userText.startsWith('[skill-load name="echo"]\n')).toBe(true);
    expect(userText).toContain("# 回声技能");
    expect(userText).toContain("Base directory: " + fx.skillDir);
    expect(userText).toContain("<skill_files>");
    expect(userText.endsWith("帮我做 X")).toBe(true);

    // plans/tui-chrome-interaction.md T5：屏幕永远只显示 `loading skill <name>`
    // 芯片 + remainder（若有），SKILL 正文不进 ❯ 气泡 —— 与 echo 共享同
    // 一投影（render 层剥 body）。
    await untilFrame(
      app.setup,
      (f) => f.includes("loading skill echo"),
      8000,
      "chip"
    );
    expect(app.setup.captureCharFrame()).toContain("❯ 帮我做 X");
    expect(app.setup.captureCharFrame()).toContain("回声完成");
    // 落盘 envelope 仍含正文（模型历史字节级稳定，session-api 侧不动），
    // 但屏上不画 —— 锁 `screen 不含 SKILL body`。
    expect(app.setup.captureCharFrame().includes("# 回声技能")).toBe(false);
    expect(app.setup.captureCharFrame().includes("<skill_files>")).toBe(false);

    await app.destroy();
    await fx.cleanup();
  }, 30_000);

  test("#377 D：turn 运行中 echo 显示精简占位「[加载技能 echo]」，不泄漏技能正文（turn 完成落盘全文替换）", async () => {
    const fx = await plantSkillFixture();
    // delayMs 拉长 stub-model 步进：让「echo 精简 → turn 完成」之间有时间
    // 断言运行中形态。
    const app = await mountAppAsync(
      fx.catalog,
      [assistantResult({ texts: ["回声完成"] })],
      { delayMs: 500 }
    );
    await untilFrame(app.setup, (f) => f.includes("Version"));
    await untilFrame(app.setup, (f) => f.includes("输入消息"));

    await app.typeText("/echo 帮我做 X");
    await app.pressEnter();

    // 运行中（未完成）：echo 与 turnFinished 后共享同一 chip 投影（render
    // 层剥 body）。plans T5：displayText 与落盘 envelope 共用 buildSkillLoadText
    // 形态，render 路径一致 → 屏上始终是 chip-only / chip+remainder。
    await untilFrame(
      app.setup,
      (f) => f.includes("loading skill echo"),
      8000,
      "chip-running"
    );
    const runFrame = app.setup.captureCharFrame();
    expect(runFrame).toContain("loading skill echo");
    expect(runFrame).toContain("❯ 帮我做 X");
    expect(runFrame.includes("回声技能")).toBe(false); // 正文 frontmatter description 不泄漏
    expect(runFrame.includes("<skill_files>")).toBe(false);

    // 等 turn 完成 → 落盘是权威信号（inflight 空判有竞态：postMessage 才
    // mark，提交尚未进 registry 时就读到 0）。本文件既有 helper 已按此纪律
    // 写，此处同源；读回的第一个 user 文本本轮不用，故不接返回值。
    await awaitSkillLoadEnvelope(app);

    // 完成态：落盘 envelope 替换 echo；render 同一投影 → 屏上仍只 chip +
    // remainder，正文永进 ❯ 气泡。
    await untilFrame(
      app.setup,
      (f) => f.includes("loading skill echo"),
      8000,
      "chip-after"
    );
    const finalFrame = app.setup.captureCharFrame();
    expect(finalFrame).toContain("loading skill echo");
    expect(finalFrame).toContain("❯ 帮我做 X");
    expect(finalFrame.includes("回声技能")).toBe(false);
    expect(finalFrame.includes("<skill_files>")).toBe(false);

    await app.destroy();
    await fx.cleanup();
  }, 30_000);

  test("SC4 slash 不闸：同会话模型已调 skill() 且全文在史 → slash envelope 仍灌装配全文", async () => {
    // spec skill-body-short-circuit.md SC4：闸只罩 ACI skill() handler；
    // slash 是 pre-run 用户输入注入，永远走 createSkillBody 全量装配。
    // 行为断言（非结构性）：真实 skill() 工具与 stub-model 装配进同一
    // registry/executor（生产同池），第一回合让模型调 skill("echo") 把全文
    // tool_result 落进可见历史；第二回合用户 slash /echo → 落盘 envelope
    // 必须仍含 337 装配形态全文（# body + Base directory + </skill_files>）。
    // 若 slash 路径被误接进短路基（ctx.messages / wave map），信封会变成
    // 短回执——本测试即失败。
    const fx = await plantSkillFixture();
    const registry = createRegistry([createSkillTool({ catalog: fx.catalog })]);
    const deps: LoopEngineDeps = {
      adapter: createStubModel({
        responses: [
          // 回合 1：模型调 skill("echo") → 全文 tool_result 入史。
          assistantResult({
            texts: ["已加载技能"],
            toolCalls: [{ id: "s1", name: "skill", input: { name: "echo" } }],
          }),
          // 回合 1 收尾（stub-model 的 tool loop 同回合消费第二条）。
          assistantResult({ texts: ["按正文执行"] }),
          // 回合 2（slash skill-load turn）收尾。
          assistantResult({ texts: ["slash 完成"] }),
        ],
      }),
      executor: createExecutor(registry),
      registry,
      maxTurns: 5,
    };
    const app = await mountAppAsync(fx.catalog, [], { depsOverride: deps });
    await untilFrame(app.setup, (f) => f.includes("Version"));
    await untilFrame(app.setup, (f) => f.includes("输入消息"));

    // 回合 1：直接发消息，stub-model 脚本化触发 skill("echo")。turn 很快
    // 完成，polling 可能跳过 running 瞬间 —— 直接等落盘的 tool_result 出现。
    await app.typeText("加载 echo 技能");
    await app.pressEnter();
    await until(
      async () => {
        const list = await app.bridge.listSessions();
        if (list.length === 0) return false;
        const f = await app.bridge.loadSessionFile(list[0]!.conversation_id);
        return f.messages.some((m) =>
          m.content.some((b) => b.type === "tool_result")
        );
      },
      8000,
      "tool-result-persisted"
    );

    // 回合 2：slash skill-load —— 闸在场（skill() 同池装配），slash 不得短路。
    await app.typeText("/echo 帮我做 X");
    await app.pressEnter();
    await until(
      async () => {
        const list = await app.bridge.listSessions();
        const f = await app.bridge.loadSessionFile(list[0]!.conversation_id);
        return f.messages.some(
          (m) =>
            m.role === "assistant" &&
            m.content.some(
              (b) =>
                b.type === "text" &&
                (b as { text: string }).text === "slash 完成"
            )
        );
      },
      8000,
      "slash-turn-done"
    );

    // 落盘会话：最后一条 user 消息（skill-load envelope）仍含装配全文。
    const list = await app.bridge.listSessions();
    expect(list.length).toBe(1);
    const sessionId = list[0]!.conversation_id;
    const file = await app.bridge.loadSessionFile(sessionId);
    const userTexts = file.messages
      .filter((m) => m.role === "user")
      .map((m) =>
        m.content
          .filter((b): b is { type: "text"; text: string } => b.type === "text")
          .map((b) => b.text)
          .join("\n")
      );
    const envelope = userTexts.find((t) =>
      t.startsWith('[skill-load name="echo"]\n')
    );
    expect(envelope).toBeDefined();
    expect(envelope).toContain("# 回声技能");
    expect(envelope).toContain("Base directory: " + fx.skillDir);
    expect(envelope).toContain("<skill_files>");
    expect(envelope!.endsWith("帮我做 X")).toBe(true);
    // 短回执不得顶替正文出现在信封里。
    expect(envelope).not.toContain("already in context");

    // 全链一致性：slash 信封里的装配正文与 ACI skill() 同输入字节相等
    // （SC6 三路径同一 createSkillBody）。tool_result 的正文段 = 信封去头
    // 去 remainder。
    const envelopeBody = envelope!.slice(
      '[skill-load name="echo"]\n'.length,
      envelope!.lastIndexOf("\n\n帮我做 X")
    );
    const toolResultText = file.messages
      .flatMap((m) => m.content)
      .filter((b) => b.type === "tool_result")
      .flatMap((b) => {
        if (b.type !== "tool_result") return [];
        return Array.isArray(b.content)
          ? (b.content as Array<{ type?: string; text?: string }>)
          : [];
      })
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join("\n");
    expect(toolResultText).toContain("# 回声技能");
    expect(toolResultText).toBe(envelopeBody);

    await app.destroy();
    await fx.cleanup();
  }, 30_000);

  test("Tab 补全：/ec + Tab → /echo ", async () => {
    const fx = await plantSkillFixture();
    const app = await mountAppAsync(fx.catalog, []);
    await untilFrame(app.setup, (f) => f.includes("Version"));
    await untilFrame(app.setup, (f) => f.includes("输入消息"));

    await app.typeText("/ec");
    await app.pressTab();
    // 补全经 React 状态落地，立即 capture 会读到补全前的帧（既有 flaky 根因）。
    // 改为轮询到补全出现 —— 断言不变，只去掉读帧竞态。
    await untilFrame(
      app.setup,
      (f) => f.includes("/echo"),
      8000,
      "tab-complete"
    );

    await app.destroy();
    await fx.cleanup();
  }, 30_000);

  test("/unknown → 走 unknown 命令 notice（非 skill）", async () => {
    const fx = await plantSkillFixture();
    const app = await mountAppAsync(fx.catalog, []);
    await untilFrame(app.setup, (f) => f.includes("Version"));
    await untilFrame(app.setup, (f) => f.includes("输入消息"));

    await app.typeText("/unknown");
    await app.pressEnter();
    await untilFrame(app.setup, (f) => f.includes("未知命令"), 8000, "unknown");

    // 未建档：skill-load 不触发，也无 turn。
    expect((await app.bridge.listSessions()).length).toBe(0);

    await app.destroy();
    await fx.cleanup();
  }, 30_000);

  test("SC1：裸名 /using-agent-skills 与规范名加载**同一条目**（落盘信封恒 canonical，两臂逐字节相同）", async () => {
    const fx = await plantPluginSkillFixture();
    // 真实 catalog 侧先自证：canonical + bare 命中同一 entry（唯一别名成立）。
    expect(fx.catalog.get("using-agent-skills")).toBe(
      fx.catalog.get("arthurpower:using-agent-skills")
    );

    // 裸名臂：typed 裸名 → 信封 canonical，remainder 不被 canonical 长度吃掉。
    const app = await mountAppAsync(fx.catalog, [
      assistantResult({ texts: ["技能已加载"] }),
    ]);
    await untilFrame(app.setup, (f) => f.includes("Version"));
    await untilFrame(app.setup, (f) => f.includes("输入消息"));

    await app.typeText("/using-agent-skills 帮我调度");
    await app.pressEnter();
    const bareText = await awaitSkillLoadEnvelope(app);
    expect((await app.bridge.listSessions()).length).toBe(1);
    // 信封的 name 是规范名（不是用户 typed 的裸名）—— catalog.get 拿得到。
    expect(
      bareText.startsWith(
        '[skill-load name="arthurpower:using-agent-skills"]\n'
      )
    ).toBe(true);
    expect(bareText).toContain("# 技能调度");
    expect(bareText.endsWith("帮我调度")).toBe(true);
    // 屏上 chip 同样 canonical。
    await untilFrame(
      app.setup,
      (f) => f.includes("loading skill arthurpower:using-agent-skills"),
      8000,
      "bare-chip"
    );
    await app.destroy();

    // canonical 臂：同一 fixture（同一 skill 目录）再跑一次，信封逐字节相同
    // —— 两条输入路径必须收敛到同一装配 + 同一 remainder 切法。
    const canonicalApp = await mountAppAsync(fx.catalog, [
      assistantResult({ texts: ["技能已加载"] }),
    ]);
    await untilFrame(canonicalApp.setup, (f) => f.includes("Version"));
    await untilFrame(canonicalApp.setup, (f) => f.includes("输入消息"));
    await canonicalApp.typeText("/arthurpower:using-agent-skills 帮我调度");
    await canonicalApp.pressEnter();
    const canonicalText = await awaitSkillLoadEnvelope(canonicalApp);
    await canonicalApp.destroy();

    expect(canonicalText).toBe(bareText);

    await fx.cleanup();
  }, 30_000);

  test("SC2：/help 仍开宿主帮助（裸名与 canonical 都不抢），且不建档", async () => {
    const fx = await plantPluginSkillFixture();
    const app = await mountAppAsync(fx.catalog, []);
    await untilFrame(app.setup, (f) => f.includes("Version"));
    await untilFrame(app.setup, (f) => f.includes("输入消息"));

    await app.typeText("/help");
    await app.pressEnter();
    const frame = await untilFrame(
      app.setup,
      (f) => f.includes("Ctrl+C"),
      8000,
      "host-help"
    );
    // 宿主词表在屏：/compact 行与 Ctrl+C 尾注。
    expect(frame).toContain("/compact");
    // 不是 skill 加载：无 chip、无建档。
    expect(frame.includes("loading skill")).toBe(false);
    expect((await app.bridge.listSessions()).length).toBe(0);

    await app.destroy();
    await fx.cleanup();
  }, 30_000);

  // spec skill-index-increment SC5/SC6（T3）：无 description 与
  // `disable-model-invocation` 的条目走同一人侧 slash 信封路径 —— 屏幕芯片、
  // 落盘 envelope 与有描述技能逐字节同形（只差 name/正文），装配正文不再
  // 因资格拒。fixture 手搓 catalog：两条款目由 scanner 之外的路径构造不会
  // 有 disabled/无描述的分叉，此处直接按语义构造（与 product 装配同形）。
  test("SC5/SC6：无 description 与 disable 的条目同一条 slash 路径信封加载", async () => {
    const root = await mkdtemp(join(tmpdir(), "iknow-tui-skill-loadable-"));
    const bodies = [
      { name: "no-desc", matter: "name: no-desc", text: "# 无描述技能" },
      {
        name: "manual-only",
        matter:
          "name: manual-only\ndescription: 仅人侧\ndisable-model-invocation: true",
        text: "# 手动技能",
      },
    ] as const;
    const entries = [] as Array<{
      name: string;
      description?: string;
      dir: string;
      disabled: boolean;
    }>;
    for (const spec of bodies) {
      const dir = join(root, spec.name);
      await mkdir(dir, { recursive: true });
      await writeFile(
        join(dir, "SKILL.md"),
        `---\n${spec.matter}\n---\n${spec.text}\n`,
        "utf8"
      );
    }
    // 走真实 scanner：无 description → entry.description undefined；
    // `disable-model-invocation: true` → entry.disabled true。手搓 entry
    // 会把这两个语义位绕过。
    entries.push(
      ...(await createSkillScanner({
        userHome: join(root, "home"),
        projectIdentityRoot: join(root, "project"),
        env: { IKNOW_SKILL_DIRS: root },
      }).scan())
    );
    expect(entries.map((e) => e.name).sort()).toEqual([
      "manual-only",
      "no-desc",
    ]);
    const byName = new Map(entries.map((e) => [e.name, e]));
    expect(byName.get("no-desc")!.description).toBeUndefined();
    expect(byName.get("manual-only")!.disabled).toBe(true);
    const catalog = createSkillCatalog(entries);

    try {
      for (const spec of bodies) {
        const app = await mountAppAsync(catalog, [
          assistantResult({ texts: ["完成"] }),
        ]);
        await untilFrame(app.setup, (f) => f.includes("Version"));
        await untilFrame(app.setup, (f) => f.includes("输入消息"));

        await app.typeText(`/${spec.name}`);
        await app.pressEnter();
        // 落盘是权威信号：inflight 空判会在提交尚未进 registry 时读到 0。
        const userText = await awaitSkillLoadEnvelope(app);
        expect((await app.bridge.listSessions()).length).toBe(1);
        // 信封恒 canonical 形态 + 装配正文（createSkillBody 产物）。
        expect(userText.startsWith(`[skill-load name="${spec.name}"]\n`)).toBe(
          true
        );
        expect(userText).toContain(spec.text);
        expect(userText).toContain(`Base directory: ${join(root, spec.name)}`);
        // 屏幕不画正文（与既有 chip 投影同纪律）。
        expect(app.setup.captureCharFrame().includes(spec.text)).toBe(false);

        await app.destroy();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);
});
