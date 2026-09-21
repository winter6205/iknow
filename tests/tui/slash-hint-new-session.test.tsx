/** @jsxImportSource @opentui/react */
/**
 * tests/tui/slash-hint-new-session.test.tsx
 *
 * Slash candidates ↑/↓ selection + Enter firing onSelectHint.
 *
 * Key point: cursor default 0 = sessions; if ↓ + Enter triggers sessions → switches to the
 * list view; if new → switches to a new draft. We assert: after ↓ + Enter the app has not
 * exited and has not switched to the list view (list view marker = `+ 新建会话`, "new session"),
 * but a new draft is created (inputValue cleared, can keep sending messages).
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

    // "/ef" → slashSuggestions unique hit effort (static command).
    await app.typeText("/ef");

    // Enter → onSelectHint(effort) → handleSubmit("/effort") → bare /effort →
    // opens the tier panel (seeded with current tier; title 「思考强度」 ("thinking effort") visible).
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

    // 1) type "/" → candidates appear (hint rendering depends on PromptInput
    //    internal state, may not show in captureCharFrame — skip asserting on the candidate frame)
    await app.typeText("/");
    await new Promise((r) => setTimeout(r, 200));

    // 2) ↓ once → cursor moves from 0 (sessions) to 1 (new)
    await app.pressArrow("down");

    // 3) Enter → onSelectHint("new") → handleSubmit("/new") → newSession()
    //    verify: no exit, no switch to list view (list-view marker = "+ 新建会话" ("new session")).
    await app.pressEnter();
    const frame = app.setup.captureCharFrame();
    expect(frame).not.toContain("+ 新建会话");
    expect(frame).toContain("输入消息");

    // 4) send a follow-up message: lands in the new session
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
    // 5) the assistant reply renders
    await untilFrame(
      app.setup,
      (f) => f.includes("new-draft-reply"),
      8000,
      "new-reply"
    );
    await app.destroy();
  }, 30_000);
});
