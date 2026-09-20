/** @jsxImportSource @opentui/react */
/**
 * tests/tui/logo-persists.test.tsx — the banner glyph survives multi-frame renders.
 *
 * Regression semantics from the ink era: scrollback repaints / repeated
 * renders must not wipe the startup banner. Under OpenTUI, consecutive
 * renderOnce calls simulate multiple frames; each frame must still contain
 * the glyph and the version line.
 */
import { expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { TuiHarness } from "./_fixtures.js";
import { VERSION } from "../../src/tui/banner.js";

test("连续多帧渲染后 banner 眼字形与版本行仍在", async () => {
  const setup = await testRender(<TuiHarness />, { width: 100, height: 26 });
  for (let i = 0; i < 5; i++) {
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    expect(frame).toContain("⣠");
    expect(frame).toContain("Version");
    expect(frame).toContain(VERSION);
  }
  await setup.renderer.destroy();
});
