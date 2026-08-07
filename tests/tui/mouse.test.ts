/**
 * tests/tui/mouse.test.ts
 *
 * SGR 鼠标序列守卫（app 已移除鼠标捕获，跟随 upstream 改由终端原生
 * scrollback 接管滚轮）：仅保留 isSgrMouseSequence 单测。
 *
 * 覆盖：
 *  - 滚轮上滚 SGR 序列剥 ESC 后形态：\x1b[<64;x;yM → "[<64;x;yM" 命中
 *  - 滚轮下滚 SGR 序列剥 ESC 后形态：\x1b[<65;x;yM → 命中
 *  - 普通键盘 ANSI（PgUp \x1b[5~ / 上箭头 \x1b[A）不命中
 *  - 非 SGR 文本不命中
 */
import { describe, expect, it } from "vitest";
import { isSgrMouseSequence } from "../../src/tui/mouse.js";

// 说明：isSgrMouseSequence 收到的是 ink useInput 剥 ESC 后的形态
// （ink use-input.js:97-99 slice(1) 剥 ESC），所以入参是 "[<...M/m"。
describe("isSgrMouseSequence（#189 输入守卫）", () => {
  it("滚轮上滚 SGR 序列（剥 ESC 后）→ 命中", () => {
    expect(isSgrMouseSequence("[<64;10;5M")).toBe(true);
  });

  it("滚轮下滚 SGR 序列（剥 ESC 后）→ 命中", () => {
    expect(isSgrMouseSequence("[<65;10;5M")).toBe(true);
  });

  it("释放形态（小写 m 终止）也命中", () => {
    expect(isSgrMouseSequence("[<64;10;5m")).toBe(true);
  });

  it("普通键盘 ANSI 不命中", () => {
    // PgUp = \x1b[5~；上箭头 = \x1b[A；剥 ESC 后形态为 "[5~" / "[A"
    expect(isSgrMouseSequence("[5~")).toBe(false);
    expect(isSgrMouseSequence("[A")).toBe(false);
  });

  it("普通文本 / 空串不命中", () => {
    expect(isSgrMouseSequence("hello")).toBe(false);
    expect(isSgrMouseSequence("")).toBe(false);
  });

  it("残缺 SGR（缺终止符或坐标）不命中", () => {
    expect(isSgrMouseSequence("[<64;10;5")).toBe(false);
    expect(isSgrMouseSequence("[<64;10")).toBe(false);
    expect(isSgrMouseSequence("[<64")).toBe(false);
  });
});
