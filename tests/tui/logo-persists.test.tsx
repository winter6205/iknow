/** @jsxImportSource @opentui/react */
/**
 * tests/tui/logo-persists.test.tsx — #343 T1：多帧渲染后 banner 眼字形仍在。
 *
 * 旧 ink 时代的回归语义：scrollback 重绘 / 多次 render 不应把启动 banner
 * 冲掉。OpenTUI 下连续 renderOnce 模拟多帧，逐帧断言眼字形与版本行存在。
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
