/** @jsxImportSource @opentui/react */
/**
 * tests/tui/render-smoke.test.tsx — #343 T1 渲染 smoke（bun:test）。
 *
 * 覆盖 specs/321 Testing Strategy「empty」边界：空会话（零消息）根骨架渲染
 * = banner + 输入框，无崩溃；首帧含 banner 眼字形 + 版本行。
 */
import { expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { TuiHarness } from "./_fixtures.js";
import { VERSION } from "../../src/tui/banner.js";

/** 首帧：banner 眼字形（braille 取样字符）+ title + 版本行。 */
test("首帧含 banner 眼字形与版本行", async () => {
  const setup = await testRender(<TuiHarness />, { width: 100, height: 26 });
  await setup.renderOnce();
  const frame = setup.captureCharFrame();
  // 眼字形取样：EYE_LINES 中的 braille 字符（⣠ 出现在第二行眼轮廓）。
  // #321 方案 B：banner 与消息同处 scrollbox；info 栏依然挂 Version/VERSION 行。
  expect(frame).toContain("⣠");
  expect(frame).toContain("Version");
  expect(frame).toContain(VERSION);
  await setup.renderer.destroy();
});

/** 空会话帧 = banner + 输入框（圆角线框）不崩。 */
test("空会话帧含 banner 与输入框且无崩溃", async () => {
  const setup = await testRender(<TuiHarness />, { width: 100, height: 26 });
  await setup.renderOnce();
  const frame = setup.captureCharFrame();
  // banner 外框与输入框都是圆角线框（borderStyle="rounded"）。
  expect(frame).toContain("╭");
  // 输入框占位提示存在（#377 起全 ASCII/CJK 占位，中文「输入消息」）。
  expect(frame).toContain("输入消息");
  await setup.renderer.destroy();
});

/** 窄终端降级：单行 `◆ iknow <version>`，不崩。 */
test("窄终端 banner 降级为单行不崩", async () => {
  // cols 40 < BANNER_MIN_COLS → renderBannerLines 返回单行 bannerShortLine。
  // 注意：scrollbox stickyStart="bottom" 会把首行 banner 顶出视口外，本 smoke
  // 只断言不崩 + 圆角线框/输入框仍在。窄终端短 banner 内容断言在
  // banner-lines.test.ts 单测中（不依赖 scrollbox 渲染）。
  const setup = await testRender(<TuiHarness />, { width: 40, height: 40 });
  await setup.renderOnce();
  const frame = setup.captureCharFrame();
  expect(frame).toContain("╭");
  expect(frame).toContain("输入消息");
  await setup.renderer.destroy();
});
