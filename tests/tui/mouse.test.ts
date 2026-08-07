/**
 * tests/tui/mouse.test.ts
 *
 * 鼠标滚轮捕获单测：SGR 协议（DECSET 1000 + 1006）。
 *
 * 覆盖：
 *  - parseMouseEvents：滚轮上滚 \x1b[<64;x;yM → wheelUp=1；下滚 \x1b[<65;x;yM
 *    → wheelDown=1；释放（小写 m）不计数；一次 chunk 多个事件累计；
 *    非滚轮 button（0/1/2/32/35）忽略；普通键盘 ANSI 不误判；空串/非 string
 *    全零不 throw。
 *  - enableMouseScroll：TTY stdout 写 DECSET 1000h+1006h；cleanup 写 DECRST
 *    1000l+1006l；幂等（多次调用只写一次）；非 TTY = no-op。
 *  - isSgrMouseSequence：ink useInput 剥 ESC 后守卫。
 */
import { describe, expect, it } from "vitest";
import { PassThrough } from "node:stream";
import {
  enableMouseScroll,
  isSgrMouseSequence,
  parseMouseEvents,
} from "../../src/tui/mouse.js";

function fakeStdout(): NodeJS.WriteStream & { isTTY: boolean } {
  const s = new PassThrough() as PassThrough & { isTTY: boolean };
  s.isTTY = true;
  return s as unknown as NodeJS.WriteStream & { isTTY: boolean };
}

describe("parseMouseEvents（SGR 滚轮解析）", () => {
  it("滚轮上滚（button=64, M 终止）→ wheelUp=1", () => {
    expect(parseMouseEvents("\x1b[<64;10;5M")).toEqual({
      wheelUp: 1,
      wheelDown: 0,
    });
  });

  it("滚轮下滚（button=65, M 终止）→ wheelDown=1", () => {
    expect(parseMouseEvents("\x1b[<65;10;5M")).toEqual({
      wheelUp: 0,
      wheelDown: 1,
    });
  });

  it("一次 chunk 多个滚轮事件 → 累计", () => {
    // 上滚 2 次 + 下滚 1 次
    expect(
      parseMouseEvents("\x1b[<64;10;5M\x1b[<64;11;5M\x1b[<65;12;5M")
    ).toEqual({ wheelUp: 2, wheelDown: 1 });
  });

  it("释放事件（小写 m 终止）不计数", () => {
    // 滚轮在部分终端以 m（release）上报；不应双计数。
    expect(parseMouseEvents("\x1b[<64;10;5m\x1b[<65;10;5m")).toEqual({
      wheelUp: 0,
      wheelDown: 0,
    });
  });

  it("非滚轮 button（鼠标键/拖动/辅助）忽略", () => {
    // button=0/1/2 = 左中右；32/35 = 按下+释放的移动对
    expect(
      parseMouseEvents(
        "\x1b[<0;10;5M\x1b[<1;10;5M\x1b[<2;10;5M\x1b[<32;10;5M\x1b[<35;10;5m"
      )
    ).toEqual({ wheelUp: 0, wheelDown: 0 });
  });

  it("普通键盘 ANSI（PgUp \x1b[5~ / 上箭头 \x1b[A）不误判", () => {
    expect(parseMouseEvents("\x1b[5~\x1b[A")).toEqual({
      wheelUp: 0,
      wheelDown: 0,
    });
  });

  it("空串 / 非 string 全零不 throw", () => {
    expect(parseMouseEvents("")).toEqual({ wheelUp: 0, wheelDown: 0 });
    expect(parseMouseEvents("hello")).toEqual({ wheelUp: 0, wheelDown: 0 });
  });
});

describe("enableMouseScroll（DECSET 1000/1006）", () => {
  it("TTY stdout：写启用序列 1000h+1006h；cleanup 写关闭 1000l+1006l", () => {
    const out = fakeStdout();
    const writes: string[] = [];
    out.on("data", (c) => writes.push(String(c)));

    const disable = enableMouseScroll(out);
    const enableJoined = writes.join("");
    expect(enableJoined).toContain("\x1b[?1000h");
    expect(enableJoined).toContain("\x1b[?1006h");

    disable();
    const fullJoined = writes.join("");
    expect(fullJoined).toContain("\x1b[?1000l");
    expect(fullJoined).toContain("\x1b[?1006l");
  });

  it("cleanup 幂等：多次调用只写一次 DECRST", () => {
    const out = fakeStdout();
    const writes: string[] = [];
    out.on("data", (c) => writes.push(String(c)));

    const disable = enableMouseScroll(out);
    disable();
    disable();
    disable();
    const lCount = (writes.join("").match(/\x1b\[\?1006l/g) ?? []).length;
    expect(lCount).toBe(1);
  });

  it("非 TTY stdout：no-op（不写、cleanup 无副作用）", () => {
    const s = new PassThrough() as PassThrough & { isTTY: boolean };
    s.isTTY = false;
    const writes: string[] = [];
    s.on("data", (c) => writes.push(String(c)));
    const disable = enableMouseScroll(s as unknown as NodeJS.WriteStream);
    expect(writes.join("")).toBe("");
    disable();
    expect(writes.join("")).toBe("");
  });
});

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
