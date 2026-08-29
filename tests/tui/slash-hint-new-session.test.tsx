/** @jsxImportSource @opentui/react */
/**
 * tests/tui/slash-hint-new-session.test.tsx
 *
 * #343 T6-C：任务 B — slash 候选 ↑/↓ 选中 + Enter 触发 onSelectHint。
 *
 * 关键点：cursor 默认 0 = sessions；如果 ↓ + Enter 触发的是 sessions
 * → 切到 list 视图；如果是 new → 切到新 draft。我们断言：↓ + Enter
 * 之后应用未退出、也未切到列表视图（list 视图特征 = "+ 新建会话"），
 * 而是新 draft 创建（inputValue 清空，可继续发消息）。
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
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
import { assistantResult, makeDeps } from "../cli/_fixtures.ts";

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

interface DrivenApp {
  readonly bridge: TuiBridge;
  readonly setup: TestRendererSetup;
  readonly destroy: () => Promise<void>;
  readonly typeText: (text: string) => Promise<void>;
  readonly pressEnter: () => Promise<void>;
  readonly pressArrow: (dir: "up" | "down") => Promise<void>;
}

async function mountAppAsync(
  responses: Parameters<typeof makeDeps>[0]
): Promise<DrivenApp> {
  const dataDir = mkdtempSync(join(tmpdir(), "iknow-tui-hint-"));
  const bridge = createTuiBridge({
    dataDir,
    workspaceRoot: dataDir,
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
      onQuit={() => {
        if (setupRef && !setupRef.renderer.isDestroyed)
          setupRef.renderer.destroy();
      }}
    />,
    { width: 80, height: 60, exitOnCtrlC: false, consoleMode: "disabled" }
  );
  setupRef = setup;
  await new Promise((r) => setTimeout(r, 300));
  await setup.waitForVisualIdle();
  return {
    bridge,
    setup,
    destroy: async () => {
      if (!setup.renderer.isDestroyed) setup.renderer.destroy();
    },
    typeText: async (text: string) => {
      for (const ch of text) {
        setup.mockInput.pressKey(ch);
        await new Promise((r) => setTimeout(r, 30));
      }
      await new Promise((r) => setTimeout(r, 100));
      await setup.renderOnce();
    },
    pressEnter: async () => {
      setup.mockInput.pressEnter();
      await new Promise((r) => setTimeout(r, 100));
      await setup.renderOnce();
    },
    pressArrow: async (dir) => {
      setup.mockInput.pressArrow(dir);
      await new Promise((r) => setTimeout(r, 100));
      await setup.renderOnce();
    },
  };
}

describe("#377 系列 /effort：hint 候选 → Enter 选中触发", () => {
  test('输入 "/ef" → 唯一候选 effort → Enter 触发（打开档位面板）', async () => {
    const app = await mountAppAsync([
      assistantResult({ texts: ["new-draft-reply"] }),
    ]);
    await untilFrame(app.setup, (f) => f.includes("Version"));
    await untilFrame(app.setup, (f) => f.includes("输入消息"));

    // 输入 "/ef" → slashSuggestions 唯一命中 effort（静态命令）。
    await app.typeText("/ef");

    // Enter → onSelectHint(effort) → handleSubmit("/effort") → effort 无参 →
    // 打开档位面板（seed 当前档，标题「思考强度」可见）。
    await app.pressEnter();
    await untilFrame(
      app.setup,
      (f) => f.includes("思考强度"),
      8000,
      "effort-hint"
    );

    await app.destroy();
  }, 30_000);
});

describe('任务 B："/" 出现候选 → ↓ → Enter 触发 /new', () => {
  test('"/" 出现候选 → ↓ → Enter 触发 /new（不退出，验证选中索引非 0）', async () => {
    const app = await mountAppAsync([
      assistantResult({ texts: ["new-draft-reply"] }),
    ]);
    await untilFrame(app.setup, (f) => f.includes("Version"));

    // 1) 输入 "/" → 候选出现（hint 渲染依赖 PromptInput 内部 state，
    //    captureCharFrame 可能未反映 — 直接跳过对候选 frame 的断言）
    await app.typeText("/");
    await new Promise((r) => setTimeout(r, 200));

    // 2) ↓ 一次 → cursor 从 0 (sessions) 移到 1 (new)
    await app.pressArrow("down");

    // 3) Enter → onSelectHint("new") 触发 → handleSubmit("/new") → newSession()
    //    验证：未退出、未切到 list 视图（list 视图特征 = "+ 新建会话"）。
    await app.pressEnter();
    const frame = app.setup.captureCharFrame();
    expect(frame).not.toContain("+ 新建会话");
    expect(frame).toContain("输入消息");

    // 4) 后续发消息：落盘到新 session
    await app.typeText("new-draft-msg");
    await app.pressEnter();
    await until(
      () => app.bridge.inflight.ids().size === 0,
      8000,
      "new-turn-done"
    );
    const list = await app.bridge.listSessions();
    expect(list).toBeDefined();
    expect(list.length).toBe(1);
    expect(list[0]!.title).toBe("new-draft-msg");
    // 5) assistant 答复渲染出来
    await untilFrame(
      app.setup,
      (f) => f.includes("new-draft-reply"),
      8000,
      "new-reply"
    );
    await app.destroy();
  }, 30_000);
});
