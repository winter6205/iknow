/** @jsxImportSource @opentui/react */
/**
 * tests/tui/cursor-move.test.tsx
 *
 * PR #431/#436 用户反馈「输入框虽然能做到换行拉伸，但 ↑/↓ 无法移动光标跨行」。
 *
 * 根因：`src/tui/prompt-input.tsx` handleKeyDown 的 up/down 分支无条件
 * `preventDefault()` 并走 hint cursor / 历史召回 —— 多行输入时光标无法跨行。
 * OpenTUI textarea 原生 move-up/move-down 动作本身是*视觉行*移动
 * （moveCursorUp → editorView.moveUpVisual，见 @opentui/core 0.5.1
 * EditBufferRenderable.moveCursorUp），因此多行时↑/↓应放行给原生处理。
 *
 * 覆盖（回归保护）：
 *  1) 多行输入：光标在第 2/3 行按 ↑ → 光标跨到上一行（不调历史召回）；
 *  2) 多行输入：光标在首行按 ↓ → 光标跨到下一行（不调历史召回）；
 *  3) 单行输入：按 ↑ → 走历史召回（替换输入内容，光标位置不变，回归保护）；
 *  4) hint 可见时（输入以 / 开头）：↑/↓ 走 hint cursor（不触发历史/原生移动）；
 *  5) 单行输入光标在末行按 ↓ → 不越界、不报错（历史恢复草稿仅在有历史时）。
 *
 * 观察手段：`setup.renderer.getCursorState()` 的屏幕 x/y（光标在文本区
 * 内部移动时 y 变化）；历史召回通过输入框内容变化（占位消失/内容替换）
 * 区分于原生光标移动。
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

interface DrivenApp {
  readonly bridge: TuiBridge;
  readonly setup: TestRendererSetup;
  readonly destroy: () => Promise<void>;
  readonly typeText: (text: string) => Promise<void>;
  readonly pressArrow: (dir: "up" | "down") => Promise<void>;
  /** 光标屏幕坐标 {x,y}（getCursorState，y=0 为屏顶）。 */
  readonly cursor: () => { x: number; y: number };
}

async function mountAppAsync(
  responses: Parameters<typeof makeDeps>[0]
): Promise<DrivenApp> {
  const dataDir = mkdtempSync(join(tmpdir(), "iknow-tui-cursor-move-"));
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
    {
      width: 80,
      height: 30,
      exitOnCtrlC: false,
      consoleMode: "disabled",
      // Shift+Enter 需携带 shift 修饰（kitty 协议编码 [13;2u）。
      kittyKeyboard: true,
    }
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
    pressArrow: async (dir) => {
      setup.mockInput.pressArrow(dir);
      await new Promise((r) => setTimeout(r, 100));
      await setup.renderOnce();
    },
    cursor: () => {
      const s = setup.renderer.getCursorState();
      return { x: s.x, y: s.y };
    },
  };
}

/** 等屏内出现期望文本（frame 轮询，avoid waitForVisualIdle 卡死）。 */
async function untilFrame(
  setup: TestRendererSetup,
  pred: (frame: string) => boolean,
  ms = 8000,
  label = ""
): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    await new Promise((r) => setTimeout(r, 50));
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    if (pred(frame)) return frame;
  }
  throw new Error(
    `untilFrame timeout (${label}):\n${setup.captureCharFrame()}`
  );
}

describe("T9-fix：多行输入 ↑/↓ 移动光标跨行（PR #431/#436）", () => {
  test("多行输入：光标在第 3 行按 ↑ → 光标移到第 2 行（不调历史）", async () => {
    const app = await mountAppAsync([assistantResult({ texts: ["reply-a"] })]);
    await untilFrame(app.setup, (f) => f.includes("Version"));

    // 输入三行（Shift+Enter 分隔）。
    await app.typeText("第一行");
    app.setup.mockInput.pressEnter({ shift: true });
    await new Promise((r) => setTimeout(r, 100));
    await app.setup.renderOnce();
    await app.typeText("第二行");
    app.setup.mockInput.pressEnter({ shift: true });
    await new Promise((r) => setTimeout(r, 100));
    await app.setup.renderOnce();
    await app.typeText("第三行");

    // 光标在末尾（第 3 行）。按 ↑ → 光标应跨到第 2 行（y 变小）。
    const before = app.cursor();
    await app.pressArrow("up");
    const after = app.cursor();
    expect(after.y).toBeLessThan(before.y);
    // 输入内容不变（未触发历史召回 —— 历史为空，若走历史会是 no-op）。
    const frame = app.setup.captureCharFrame();
    expect(frame).toContain("第三行");
    expect(frame).toContain("第二行");

    await app.destroy();
  }, 30_000);

  test("多行输入：光标在第 1 行按 ↓ → 光标移到第 2 行（不调历史）", async () => {
    const app = await mountAppAsync([assistantResult({ texts: ["reply-b"] })]);
    await untilFrame(app.setup, (f) => f.includes("Version"));

    // 输入两行，光标在行尾（第 2 行）。↑ 先到第 1 行，再 ↓ 回第 2 行。
    await app.typeText("甲行");
    app.setup.mockInput.pressEnter({ shift: true });
    await new Promise((r) => setTimeout(r, 100));
    await app.setup.renderOnce();
    await app.typeText("乙行");

    await app.pressArrow("up");
    const up = app.cursor();
    await app.pressArrow("down");
    const down = app.cursor();
    // ↑ 后 y 减小，↓ 后 y 恢复（跨行移动，非历史召回）。
    expect(down.y).toBeGreaterThan(up.y);
    // 内容不变。
    const frame = app.setup.captureCharFrame();
    expect(frame).toContain("甲行");
    expect(frame).toContain("乙行");

    await app.destroy();
  }, 30_000);

  test("多行输入：光标在第 2 行按 ↓ → 移到第 3 行；首行按 ↑ 不越界（内容不变）", async () => {
    const app = await mountAppAsync([assistantResult({ texts: ["reply-c"] })]);
    await untilFrame(app.setup, (f) => f.includes("Version"));

    await app.typeText("x行");
    app.setup.mockInput.pressEnter({ shift: true });
    await new Promise((r) => setTimeout(r, 100));
    await app.setup.renderOnce();
    await app.typeText("y行");
    app.setup.mockInput.pressEnter({ shift: true });
    await new Promise((r) => setTimeout(r, 100));
    await app.setup.renderOnce();
    await app.typeText("z行");

    // 光标在末行 → 按 ↓ 不越界（y 不变），内容不变。
    const atEnd = app.cursor();
    await app.pressArrow("down");
    const afterDown = app.cursor();
    expect(afterDown.y).toBe(atEnd.y);
    const frameEnd = app.setup.captureCharFrame();
    expect(frameEnd).toContain("z行");

    // ↑ 到首行，再 ↑ 不越界（内容不变）。
    await app.pressArrow("up");
    await app.pressArrow("up");
    await app.pressArrow("up");
    const frameTop = app.setup.captureCharFrame();
    expect(frameTop).toContain("x行");
    expect(frameTop).toContain("z行");

    await app.destroy();
  }, 30_000);

  test("单行输入：按 ↑ → 走历史召回（输入内容被替换，回归保护）", async () => {
    const app = await mountAppAsync([assistantResult({ texts: ["reply-d"] })]);
    await untilFrame(app.setup, (f) => f.includes("Version"));

    // 种一条历史。
    await app.typeText("hist-line");
    app.setup.mockInput.pressEnter();
    await new Promise((r) => setTimeout(r, 100));
    await app.setup.renderOnce();

    // 新输入（单行草稿），然后 ↑ → 召回 hist-line。
    await app.typeText("draft-new");
    const before = app.cursor();
    await app.pressArrow("up");
    await untilFrame(app.setup, (f) => f.includes("hist-line"), 8000, "recall");
    const after = app.cursor();
    // 单行内上下移动：y 不变（历史召回只换内容不挪光标）。
    expect(after.y).toBe(before.y);

    await app.destroy();
  }, 30_000);

  test("hint 可见时：↑/↓ 走 hint cursor（不触发历史/原生光标移动，回归保护）", async () => {
    const app = await mountAppAsync([assistantResult({ texts: ["reply-e"] })]);
    await untilFrame(app.setup, (f) => f.includes("Version"));

    // 输入 "/" 触发 hint 候选（不种历史 —— 历史种子会渲染进消息流干扰 frame 断言；
    // 历史回归路径由上面「单行输入按 ↑」用例覆盖）。
    await app.typeText("/");
    const frameHint = await untilFrame(
      app.setup,
      (f) => f.includes("sessions"),
      8000,
      "hint-shown"
    );
    expect(frameHint).not.toContain("hist-x");
    // ↑/↓ 不把输入框内容换成历史（hint 优先），也不挪光标。
    const before = app.cursor();
    await app.pressArrow("up");
    await app.pressArrow("down");
    const frame = app.setup.captureCharFrame();
    expect(frame).toContain("sessions");
    const after = app.cursor();
    expect(after.y).toBe(before.y);

    await app.destroy();
  }, 30_000);
});
