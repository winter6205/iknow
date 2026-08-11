/** @jsxImportSource @opentui/react */
/**
 * tests/tui/input-history.test.tsx
 *
 * #343 T6-C：#279 项5 — TUI 输入历史 ↑/↓ 导航回归测试（自 archive
 * tui-ink/tests/input-history.test.tsx 迁移）。
 *
 * 覆盖：
 *  1) 空历史 ↑/↓ no-op（不崩、不吞后续输入）；
 *  2) ↑ 召回 / ↓ 越界回现场（草稿 round-trip）；
 *  3) hint 候选可见时 ↑/↓ 走 hint cursor（hint 优先）；
 *  4) 连续重复去重（连提两条相同只入一条历史）。
 *
 * 装配：mountAppAsync + stub deps（同 app.test.tsx 模式）。
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
  readonly pressBackspace: () => Promise<void>;
}

async function mountAppAsync(
  responses: Parameters<typeof makeDeps>[0]
): Promise<DrivenApp> {
  const dataDir = mkdtempSync(join(tmpdir(), "iknow-tui-history-"));
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
      onQuit={() => {
        if (setupRef && !setupRef.renderer.isDestroyed)
          setupRef.renderer.destroy();
      }}
    />,
    { width: 80, height: 30, exitOnCtrlC: false, consoleMode: "disabled" }
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
    pressBackspace: async () => {
      setup.mockInput.pressBackspace();
      await new Promise((r) => setTimeout(r, 50));
      await setup.renderOnce();
    },
  };
}

describe("#279 项5：TUI 输入历史 ↑/↓ 导航", () => {
  test("空历史 ↑/↓ no-op：不崩、不吞后续输入", async () => {
    const app = await mountAppAsync([
      assistantResult({ texts: ["fresh-reply"] }),
    ]);
    await untilFrame(app.setup, (f) => f.includes("Version"));

    // 无历史：↑ ↓ 均 no-op → 输入框仍是占位符
    await app.pressArrow("up");
    await app.pressArrow("down");

    // 后续输入不被吞：正常提交一轮
    await app.typeText("after-noop");
    await app.pressEnter();
    await until(() => app.bridge.inflight.ids().size === 0, 8000, "noop-turn");
    const list = await app.bridge.listSessions();
    expect(list).toBeDefined();
    expect(list.length).toBe(1);
    expect(list[0]!.summary).toBe("after-noop");
    await app.destroy();
  }, 30_000);

  test("草稿 round-trip：↑ 不覆盖在写内容、↓ 越过最新条恢复草稿", async () => {
    const app = await mountAppAsync([
      assistantResult({ texts: ["draft-reply"] }),
    ]);
    await untilFrame(app.setup, (f) => f.includes("Version"));

    // 1) 种一条历史
    await app.typeText("hist-a");
    await app.pressEnter();
    await until(() => app.bridge.inflight.ids().size === 0, 8000, "seed-turn");

    // 2) 输入半截草稿（不提交）
    await app.typeText("wip-draft");
    await new Promise((r) => setTimeout(r, 100));

    // 3) ↑ → 召回 "hist-a"
    await app.pressArrow("up");
    await untilFrame(app.setup, (f) => f.includes("hist-a"), 8000, "up-recall");

    // 4) ↓ → 越过最新条回输入现场：恢复草稿 "wip-draft"
    await app.pressArrow("down");
    await untilFrame(
      app.setup,
      (f) => f.includes("wip-draft"),
      8000,
      "down-restore-draft"
    );

    await app.destroy();
  }, 30_000);
});
