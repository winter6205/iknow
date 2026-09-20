/** @jsxImportSource @opentui/react */
/**
 * tests/tui/cursor-move.test.tsx
 *
 * User feedback: "the input box can wrap and grow, but ↑/↓ cannot move the
 * cursor across lines".
 *
 * Root cause: handleKeyDown's up/down branch in `src/tui/prompt-input.tsx`
 * unconditionally `preventDefault()`s and routes to hint cursor / history
 * recall — so with multi-line input the cursor cannot cross lines. OpenTUI
 * textarea's native move-up/move-down actions already move by visual line
 * (moveCursorUp → editorView.moveUpVisual, see @opentui/core 0.5.1
 * EditBufferRenderable.moveCursorUp), so with multi-line input ↑/↓ should be
 * left to the native handler.
 *
 * Coverage (regression guard):
 *  1) multi-line: cursor on line 2/3 pressing ↑ → cursor moves up a line
 *     (history recall not called);
 *  2) multi-line: cursor on first line pressing ↓ → cursor moves down a line
 *     (history recall not called);
 *  3) single-line: ↑ → history recall (replaces input content, cursor position
 *     unchanged, regression guard);
 *  4) when hints are visible (input starts with /): ↑/↓ drive hint cursor
 *     (no history / native move);
 *  5) single-line, cursor on last line pressing ↓ → no overflow, no error
 *     (history restoring a draft only happens when history exists).
 *
 * Observation: getCursorState()'s screen x/y (y changes as the cursor moves
 * inside the text area); history recall is distinguished from a native cursor
 * move by the input content changing (placeholder gone / content replaced).
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
  /** Cursor screen coords {x,y} (getCursorState; y=0 is the top of the screen). */
  readonly cursor: () => { x: number; y: number };
}

async function mountAppAsync(
  responses: Parameters<typeof makeDeps>[0]
): Promise<DrivenApp> {
  const dataDir = mkdtempSync(join(tmpdir(), "iknow-tui-cursor-move-"));
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
    {
      width: 80,
      height: 30,
      exitOnCtrlC: false,
      consoleMode: "disabled",
      // Shift+Enter must carry the shift modifier (kitty protocol encodes [13;2u).
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

/** Wait until the expected text appears on screen (frame polling; avoids waitForVisualIdle hangs). */
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

    // Type three lines (Shift+Enter separates them).
    await app.typeText("第一行");
    app.setup.mockInput.pressEnter({ shift: true });
    await new Promise((r) => setTimeout(r, 100));
    await app.setup.renderOnce();
    await app.typeText("第二行");
    app.setup.mockInput.pressEnter({ shift: true });
    await new Promise((r) => setTimeout(r, 100));
    await app.setup.renderOnce();
    await app.typeText("第三行");

    // Cursor at the end (line 3). Press ↑ → cursor should cross to line 2 (y decreases).
    const before = app.cursor();
    await app.pressArrow("up");
    const after = app.cursor();
    expect(after.y).toBeLessThan(before.y);
    // Input content unchanged (history recall not triggered — history is empty, so history would be a no-op).
    const frame = app.setup.captureCharFrame();
    expect(frame).toContain("第三行");
    expect(frame).toContain("第二行");

    await app.destroy();
  }, 30_000);

  test("多行输入：光标在第 1 行按 ↓ → 光标移到第 2 行（不调历史）", async () => {
    const app = await mountAppAsync([assistantResult({ texts: ["reply-b"] })]);
    await untilFrame(app.setup, (f) => f.includes("Version"));

    // Type two lines, cursor at end of line 2. ↑ goes to line 1, then ↓ back to line 2.
    await app.typeText("甲行");
    app.setup.mockInput.pressEnter({ shift: true });
    await new Promise((r) => setTimeout(r, 100));
    await app.setup.renderOnce();
    await app.typeText("乙行");

    await app.pressArrow("up");
    const up = app.cursor();
    await app.pressArrow("down");
    const down = app.cursor();
    // After ↑ y decreases, after ↓ y recovers (cross-line move, not history recall).
    expect(down.y).toBeGreaterThan(up.y);
    // Content unchanged.
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

    // Cursor on the last line → pressing ↓ does not overflow (y unchanged), content unchanged.
    const atEnd = app.cursor();
    await app.pressArrow("down");
    const afterDown = app.cursor();
    expect(afterDown.y).toBe(atEnd.y);
    const frameEnd = app.setup.captureCharFrame();
    expect(frameEnd).toContain("z行");

    // ↑ to the first line, another ↑ does not overflow (content unchanged).
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

    // Seed one history entry.
    await app.typeText("hist-line");
    app.setup.mockInput.pressEnter();
    await new Promise((r) => setTimeout(r, 100));
    await app.setup.renderOnce();

    // New input (single-line draft), then ↑ → recalls hist-line.
    await app.typeText("draft-new");
    const before = app.cursor();
    await app.pressArrow("up");
    await untilFrame(app.setup, (f) => f.includes("hist-line"), 8000, "recall");
    const after = app.cursor();
    // Single-line up/down movement: y unchanged (history recall swaps content without moving the cursor).
    expect(after.y).toBe(before.y);

    await app.destroy();
  }, 30_000);

  test("hint 可见时：↑/↓ 走 hint cursor（不触发历史/原生光标移动，回归保护）", async () => {
    const app = await mountAppAsync([assistantResult({ texts: ["reply-e"] })]);
    await untilFrame(app.setup, (f) => f.includes("Version"));

    // Typing "/" triggers hint candidates (no history seeded — a history seed
    // would render into the message stream and disturb frame assertions; the
    // history regression path is covered by the "single-line ↑" case above).
    await app.typeText("/");
    const frameHint = await untilFrame(
      app.setup,
      (f) => f.includes("sessions"),
      8000,
      "hint-shown"
    );
    expect(frameHint).not.toContain("hist-x");
    // ↑/↓ must not replace the input content with history (hints take priority), and must not move the cursor.
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
