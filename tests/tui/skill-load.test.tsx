/** @jsxImportSource @opentui/react */
/**
 * tests/tui/skill-load.test.tsx
 *
 * `/skill-name [prompt]` load-and-send — TuiApp end-to-end.
 *
 * Two assemblies:
 *   - stub bridge (makeDeps + real inflight registry, hub makes no real network requests)
 *     + stub skillCatalog (one skill `echo`, dir pointing at a tmp fixture dir,
 *     SKILL.md = frontmatter + body) — verifies the skill-load envelope and render projection;
 *   - real scanner + `createSkillCatalog` (`plantPluginSkillFixture`, pluginSkillDirs
 *     namespace) — verifies that spec tui-skill-slash-catalog's bare-name alias projection
 *     holds in the TUI end-to-end (bare-name and canonical-name paths share one envelope).
 * createSkillBody runs the real harness assembly (same call path as app.tsx); assertions
 * pin that the sent text equals the skill-load envelope (`[skill-load name="..."]` + body).
 *
 * Sent text goes through bridge.postMessage → run() encodeUserText and becomes the whole
 * user message; tests read the on-disk session file directly to assert model-history text
 * (deterministic injection, not relying on model initiative). The user echo shows the
 * trimmed form 「[加载技能 echo]」 ("[loaded skill echo]").
 *
 * Constraints: session-state.ts untouched; existing tests not deleted / not skipped.
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

/** frame wait: mockInput bytes parse asynchronously via stdin, so poll renderOnce. */
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

/** plant one skill fixture: SKILL.md (frontmatter + body) + stub catalog. */
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
 * spec tui-skill-slash-catalog SC1/SC2 (route A): plugin skill fixture — goes through the
 * **real** scanner + catalog (`pluginSkillDirs` namespace → canonical `<plugin>:<name>` +
 * bareIndex bare-name alias), not a hand-written stub catalog. This way app.tsx's alias
 * projection (`stripNamespace` + `catalog.get(bare) === entry` uniqueness criterion) is
 * exercised end-to-end: bare name loads, canonical name loads, display stays canonical.
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
     * override harness deps (registry / executor / adapter) so the real skill() tool is
     * assembled in the same pool as this turn.
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
      // warm-up: press one harmless key first to start the mockInput parser.
      setup.mockInput.pressKey("/");
      await new Promise((r) => setTimeout(r, 100));
      await setup.renderOnce();
      // clear the warm-up key (press Backspace several times).
      for (let i = 0; i < 5; i++) {
        setup.mockInput.pressBackspace();
        await new Promise((r) => setTimeout(r, 30));
      }
      // the content actually to be typed.
      for (const ch of text) {
        setup.mockInput.pressKey(ch);
        await new Promise((r) => setTimeout(r, 30));
      }
      // let the React state update land.
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
 * Wait for this skill-load turn to hit disk (first user envelope + model reply complete),
 * then read back the first user text. The empty-inflight check races (reads 0 before the
 * submission enters the registry); the on-disk write is the authoritative signal.
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

    // the on-disk write is the authoritative signal: the empty-inflight check races (mark only at
    // postMessage; reads 0 before the submission enters the registry). the existing helpers in this
    // file already follow this discipline; same source here.
    const userText = await awaitSkillLoadEnvelope(app);

    // on-disk session file: first user message in model history = full skill-load sent text.
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

    // the screen always shows only the `loading skill <name>` chip + remainder (if any);
    // the SKILL body never enters the ❯ bubble — sharing one projection with the echo
    // (the render layer strips the body).
    await untilFrame(
      app.setup,
      (f) => f.includes("loading skill echo"),
      8000,
      "chip"
    );
    expect(app.setup.captureCharFrame()).toContain("❯ 帮我做 X");
    expect(app.setup.captureCharFrame()).toContain("回声完成");
    // the on-disk envelope still carries the body (model history is byte-stable; the session-api side is untouched),
    // but the screen doesn't draw it — locking `screen does not contain SKILL body`.
    expect(app.setup.captureCharFrame().includes("# 回声技能")).toBe(false);
    expect(app.setup.captureCharFrame().includes("<skill_files>")).toBe(false);

    await app.destroy();
    await fx.cleanup();
  }, 30_000);

  test("#377 D：turn 运行中 echo 显示精简占位「[加载技能 echo]」，不泄漏技能正文（turn 完成落盘全文替换）", async () => {
    const fx = await plantSkillFixture();
    // delayMs stretches the stub-model step: leaves time between 「echo trimmed」 and "turn finished"
    // to assert the in-flight shape.
    const app = await mountAppAsync(
      fx.catalog,
      [assistantResult({ texts: ["回声完成"] })],
      { delayMs: 500 }
    );
    await untilFrame(app.setup, (f) => f.includes("Version"));
    await untilFrame(app.setup, (f) => f.includes("输入消息"));

    await app.typeText("/echo 帮我做 X");
    await app.pressEnter();

    // in flight (not finished): the echo shares one chip projection with the post-turnFinished state
    // (the render layer strips the body). displayText and the on-disk envelope share the buildSkillLoadText
    // shape, one render path → on screen it's always chip-only / chip+remainder.
    await untilFrame(
      app.setup,
      (f) => f.includes("loading skill echo"),
      8000,
      "chip-running"
    );
    const runFrame = app.setup.captureCharFrame();
    expect(runFrame).toContain("loading skill echo");
    expect(runFrame).toContain("❯ 帮我做 X");
    expect(runFrame.includes("回声技能")).toBe(false); // frontmatter description of the body must not leak
    expect(runFrame.includes("<skill_files>")).toBe(false);

    // wait for the turn to finish → the on-disk write is the authoritative signal (the empty-inflight
    // check races: mark only at postMessage; reads 0 before the submission enters the registry). the
    // existing helpers in this file already follow this discipline; same source here. The first user
    // text read back is unused this round, so no return value is taken.
    await awaitSkillLoadEnvelope(app);

    // finished state: the on-disk envelope replaces the echo; same render projection → screen still
    // shows only chip + remainder, the body never enters the ❯ bubble.
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
    // the gate only covers the ACI skill() handler; slash is pre-run user-input
    // injection and always goes through full createSkillBody assembly. Behavioral assertion
    // (not structural): the real skill() tool and the stub-model are assembled into the same
    // registry/executor (same pool as production); turn 1 lets the model call skill("echo") so
    // the full-text tool_result lands in visible history; turn 2 the user slashes /echo → the
    // on-disk envelope must still carry the full assembly text (# body + Base directory +
    // </skill_files>). If the slash path were wrongly wired into the short-circuit base
    // (ctx.messages / wave map), the envelope would become a short receipt — this test fails.
    const fx = await plantSkillFixture();
    const registry = createRegistry([createSkillTool({ catalog: fx.catalog })]);
    const deps: LoopEngineDeps = {
      adapter: createStubModel({
        responses: [
          // turn 1: model calls skill("echo") → full-text tool_result enters history.
          assistantResult({
            texts: ["已加载技能"],
            toolCalls: [{ id: "s1", name: "skill", input: { name: "echo" } }],
          }),
          // turn 1 wrap-up (the stub-model's tool loop consumes the second entry in the same turn).
          assistantResult({ texts: ["按正文执行"] }),
          // turn 2 (slash skill-load turn) wrap-up.
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

    // turn 1: send a message directly, the stub-model script triggers skill("echo"). The turn
    // finishes fast and polling may skip the running instant — wait directly for the tool_result on disk.
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

    // turn 2: slash skill-load — the gate is present (skill() assembled in the same pool), slash must not short-circuit.
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

    // on-disk session: the last user message (skill-load envelope) still carries the full assembly text.
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
    // a short receipt must not replace the body inside the envelope.
    expect(envelope).not.toContain("already in context");

    // full-chain consistency: the assembly body in the slash envelope equals the ACI skill() output byte-for-byte
    // for the same input (all three paths share one createSkillBody). tool_result body segment = envelope minus
    // header minus remainder.
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
    // completion lands via React state; capturing immediately reads a pre-completion frame (root cause of existing flakiness).
    // switched to polling until the completion appears — assertions unchanged, only the frame-read race removed.
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

    // not indexed: skill-load does not fire, and no turn either.
    expect((await app.bridge.listSessions()).length).toBe(0);

    await app.destroy();
    await fx.cleanup();
  }, 30_000);

  test("SC1：裸名 /using-agent-skills 与规范名加载**同一条目**（落盘信封恒 canonical，两臂逐字节相同）", async () => {
    const fx = await plantPluginSkillFixture();
    // prove it on the real catalog side first: canonical + bare hit the same entry (unique alias holds).
    expect(fx.catalog.get("using-agent-skills")).toBe(
      fx.catalog.get("arthurpower:using-agent-skills")
    );

    // bare-name arm: typed bare name → envelope canonical, remainder not eaten by canonical length.
    const app = await mountAppAsync(fx.catalog, [
      assistantResult({ texts: ["技能已加载"] }),
    ]);
    await untilFrame(app.setup, (f) => f.includes("Version"));
    await untilFrame(app.setup, (f) => f.includes("输入消息"));

    await app.typeText("/using-agent-skills 帮我调度");
    await app.pressEnter();
    const bareText = await awaitSkillLoadEnvelope(app);
    expect((await app.bridge.listSessions()).length).toBe(1);
    // the envelope's name is the canonical name (not the bare name the user typed) — catalog.get can find it.
    expect(
      bareText.startsWith(
        '[skill-load name="arthurpower:using-agent-skills"]\n'
      )
    ).toBe(true);
    expect(bareText).toContain("# 技能调度");
    expect(bareText.endsWith("帮我调度")).toBe(true);
    // the on-screen chip is canonical too.
    await untilFrame(
      app.setup,
      (f) => f.includes("loading skill arthurpower:using-agent-skills"),
      8000,
      "bare-chip"
    );
    await app.destroy();

    // canonical arm: rerun with the same fixture (same skill dir), the envelope is byte-identical
    // — the two input paths must converge to the same assembly + the same remainder split.
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
    // host vocabulary visible on screen: the /compact line and the Ctrl+C footnote.
    expect(frame).toContain("/compact");
    // not a skill load: no chip, no indexing.
    expect(frame.includes("loading skill")).toBe(false);
    expect((await app.bridge.listSessions()).length).toBe(0);

    await app.destroy();
    await fx.cleanup();
  }, 30_000);

  // spec skill-index-increment SC5/SC6: entries without description and with
  // `disable-model-invocation` take the same human-side slash envelope path — the on-screen chip and the
  // on-disk envelope are byte-shape-identical to described skills (differing only in name/body); the
  // assembly body is no longer rejected by eligibility. fixture hand-builds the catalog: the two
  // entries are constructed off the scanner path, so here they're built directly by semantics (same shape as product assembly).
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
    // go through the real scanner: no description → entry.description undefined;
    // `disable-model-invocation: true` → entry.disabled true. Hand-building the entry
    // would bypass these two semantic bits.
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
        // the on-disk write is the authoritative signal: the empty-inflight check reads 0 before the submission enters the registry.
        const userText = await awaitSkillLoadEnvelope(app);
        expect((await app.bridge.listSessions()).length).toBe(1);
        // the envelope is always canonical shape + assembly body (createSkillBody product).
        expect(userText.startsWith(`[skill-load name="${spec.name}"]\n`)).toBe(
          true
        );
        expect(userText).toContain(spec.text);
        expect(userText).toContain(`Base directory: ${join(root, spec.name)}`);
        // the screen does not draw the body (same discipline as the existing chip projection).
        expect(app.setup.captureCharFrame().includes(spec.text)).toBe(false);

        await app.destroy();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);
});
