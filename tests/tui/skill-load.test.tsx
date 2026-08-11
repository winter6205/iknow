/** @jsxImportSource @opentui/react */
/**
 * tests/tui/skill-load.test.tsx
 *
 * #337 Phase C：/skill-name [提示词] 加载发送 — TuiApp 端到端。
 *
 * 装配：stub bridge（makeDeps + 真实 inflight registry，hub 不发真实网络
 * 请求）+ stub skillCatalog（1 个 skill `echo`，dir 指向 tmp fixture 目录，
 * SKILL.md = frontmatter + 正文）。createSkillBody 走真实 harness 装配
 * （app.tsx 同款调用路径），断言「发送文本 = [skill-load name="echo"]\n<正文>」。
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
import type { SkillCatalog } from "../../src/harness/skill/catalog.js";
import { assistantResult, makeDeps } from "../cli/_fixtures.ts";

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
  responses: Parameters<typeof makeDeps>[0]
): Promise<DrivenApp> {
  const dataDir = mkdtempSync(join(tmpdir(), "iknow-tui-skillload-data-"));
  const bridge = createTuiBridge({
    dataDir,
    deps: makeDeps(responses),
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

describe("Phase C: /skill-name 加载发送", () => {
  test("输入 /echo 帮我做 X + Enter → 发送文本含 skill-load 头 + 正文 + remainder；echo 与发送文本一致（状态机纪律：turnFinished 权威刷新）", async () => {
    const fx = await plantSkillFixture();
    const app = await mountAppAsync(fx.catalog, [
      assistantResult({ texts: ["回声完成"] }),
    ]);
    await untilFrame(app.setup, (f) => f.includes("Version"));
    await untilFrame(app.setup, (f) => f.includes("type message"));

    await app.typeText("/echo 帮我做 X");
    await app.pressEnter();

    // turn 完成 → inflight 清空
    await until(
      () => app.bridge.inflight.ids().size === 0,
      8000,
      "skill-turn-done"
    );

    // 落盘会话文件：模型历史第一条 user 消息 = 完整 skill-load 发送文本。
    const list = await app.bridge.listSessions();
    expect(list.length).toBe(1);
    const sessionId = list[0]!.conversation_id;
    const file = await app.bridge.loadSessionFile(sessionId);
    expect(file.messages.length).toBeGreaterThan(0);
    const first = file.messages[0]!;
    expect(first.role).toBe("user");
    const userText =
      first.content
        .filter((b): b is { type: "text"; text: string } => b.type === "text")
        .map((b) => b.text)
        .join("\n") ?? "";
    expect(userText.startsWith('[skill-load name="echo"]\n')).toBe(true);
    expect(userText).toContain("# 回声技能");
    expect(userText).toContain("Base directory: " + fx.skillDir);
    expect(userText).toContain("<skill_files>");
    expect(userText.endsWith("帮我做 X")).toBe(true);

    // echo 与发送文本一致：对话区用户消息显示完整 skill-load 头（turnFinished
    // 权威刷新后显示的就是落盘全文）。
    await untilFrame(
      app.setup,
      (f) => f.includes('[skill-load name="echo"]'),
      8000,
      "echo-full"
    );
    expect(app.setup.captureCharFrame()).toContain("帮我做 X");
    expect(app.setup.captureCharFrame()).toContain("回声完成");

    await app.destroy();
    await fx.cleanup();
  }, 30_000);

  test("Tab 补全：/ec + Tab → /echo ", async () => {
    const fx = await plantSkillFixture();
    const app = await mountAppAsync(fx.catalog, []);
    await untilFrame(app.setup, (f) => f.includes("Version"));
    await untilFrame(app.setup, (f) => f.includes("type message"));

    await app.typeText("/ec");
    await app.pressTab();
    const frame = app.setup.captureCharFrame();
    expect(frame).toContain("/echo");

    await app.destroy();
    await fx.cleanup();
  }, 30_000);

  test("/unknown → 走 unknown 命令 notice（非 skill）", async () => {
    const fx = await plantSkillFixture();
    const app = await mountAppAsync(fx.catalog, []);
    await untilFrame(app.setup, (f) => f.includes("Version"));
    await untilFrame(app.setup, (f) => f.includes("type message"));

    await app.typeText("/unknown");
    await app.pressEnter();
    await untilFrame(app.setup, (f) => f.includes("未知命令"), 8000, "unknown");

    // 未建档：skill-load 不触发，也无 turn。
    expect((await app.bridge.listSessions()).length).toBe(0);

    await app.destroy();
    await fx.cleanup();
  }, 30_000);
});
