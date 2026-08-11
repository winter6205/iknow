/** @jsxImportSource @opentui/react */
/**
 * tests/tui/max-turns.test.tsx
 *
 * #343 T6-C：plan T6 — TUI 适配 stop_summary 呈现（maxTurns 边界归
 * archive/tui-ink/tests/max-turns.test.tsx 同语义，本测聚焦 onStream
 * stop_summary → notice 路径）。
 *
 * 流程：mount TuiApp + 单 response 模型 → 发消息 → runTurnOnce 路径：
 *   1. bridge.postMessage → hub.postMessage；
 *   2. adapter 在 streaming 路径中可下发 stop_summary 事件；
 *   3. runTurnOnce onStream 收到 stop_summary → setNotice({ lines: [text] })。
 *
 * 受限于 makeDeps 当前未暴露 maxTurns override，本测聚焦「stream 事件
 * stop_summary 渲染」语义（即 notice 收到 onStream 推来的文本）。后续
 * makeDeps 增强后可加 maxTurns=2 跨多轮验证 hub catch MaxTurnsExceeded。
 */
import { afterEach, describe, expect, test } from "bun:test";
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
}

async function mountWithStopSummary(
  stopSummaryText: string
): Promise<DrivenApp> {
  const dataDir = mkdtempSync(join(tmpdir(), "iknow-tui-max-turns-"));
  // 流式事件脚本：第 1 步发 stop_summary（模拟 maxTurns 触发的收尾摘要）。
  const deps = makeDeps([assistantResult({ texts: [""] })], {
    streamEventsByStep: [
      [
        {
          type: "stop_summary",
          text: stopSummaryText,
        },
      ],
    ],
  });
  const bridge = createTuiBridge({
    dataDir,
    deps,
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
  };
}

describe("TUI stop_summary 呈现（plan T6 / maxTurns 边界）", () => {
  const rejections: unknown[] = [];
  const listener = (reason: unknown): void => {
    rejections.push(reason);
  };
  process.on("unhandledRejection", listener);
  afterEach(() => {
    rejections.length = 0;
  });

  test("stop_summary onStream 事件 → notice 区呈现摘要文本", async () => {
    const app = await mountWithStopSummary("TUI 收尾摘要：已达上限");
    await untilFrame(app.setup, (f) => f.includes("Version"));

    await app.typeText("go");
    await app.pressEnter();
    await until(() => app.bridge.inflight.ids().size === 0, 8000, "turn-done");

    // notice 区呈现摘要文本
    await untilFrame(
      app.setup,
      (f) => f.includes("TUI 收尾摘要"),
      8000,
      "summary-notice"
    );

    await new Promise((r) => setTimeout(r, 500));
    expect(rejections).toHaveLength(0);

    await app.destroy();
  }, 30_000);

  test("清理: 移除 unhandledRejection 监探", () => {
    process.off("unhandledRejection", listener);
  });
});
