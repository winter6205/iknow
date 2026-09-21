/** @jsxImportSource @opentui/react */
/**
 * tests/tui/render-smoke.test.tsx — render smoke (bun:test).
 *
 * Covers the "empty" boundary of the testing strategy: an empty session (zero
 * messages) renders the root skeleton = banner + input box without crashing;
 * the first frame contains the banner eye glyph + version line.
 */
import { expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { TuiHarness } from "./_fixtures.js";
import { VERSION } from "../../src/tui/banner.js";

/** First frame: banner eye glyph (braille sample char) + title + version line. */
test("首帧含 banner 眼字形与版本行", async () => {
  const setup = await testRender(<TuiHarness />, { width: 100, height: 26 });
  await setup.renderOnce();
  const frame = setup.captureCharFrame();
  // eye-glyph sample: a braille char from EYE_LINES (⣠ appears on the eye outline's second row).
  // banner and messages share the scrollbox; the info bar still carries the Version/VERSION line.
  expect(frame).toContain("⣠");
  expect(frame).toContain("Version");
  expect(frame).toContain(VERSION);
  await setup.renderer.destroy();
});

/** Empty-session frame = banner + input box (rounded border), no crash. */
test("空会话帧含 banner 与输入框且无崩溃", async () => {
  const setup = await testRender(<TuiHarness />, { width: 100, height: 26 });
  await setup.renderOnce();
  const frame = setup.captureCharFrame();
  // banner frame and input box both use rounded borders (borderStyle="rounded").
  expect(frame).toContain("╭");
  // input placeholder present (ASCII/CJK placeholder, Chinese 「输入消息」).
  expect(frame).toContain("输入消息");
  await setup.renderer.destroy();
});

/** Narrow-terminal fallback: single line `◆ iknow <version>`, no crash. */
test("窄终端 banner 降级为单行不崩", async () => {
  // 40 cols still fits the 32-col eye; this smoke only asserts no crash + border/input box still present.
  // The ultra-narrow single-line contract lives in banner-lines.test.ts (cols=20).
  const setup = await testRender(<TuiHarness />, { width: 40, height: 40 });
  await setup.renderOnce();
  const frame = setup.captureCharFrame();
  expect(frame).toContain("╭");
  expect(frame).toContain("输入消息");
  await setup.renderer.destroy();
});
