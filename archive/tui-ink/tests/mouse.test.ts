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
  enableSgrMouseReport,
  isSgrMouseSequence,
  parseMouseAllEvents,
  parseMouseEvents,
  wheelScrollStep,
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

describe("enableSgrMouseReport（DECSET 1000/1006/1002）", () => {
  it("TTY stdout：写启用序列 1000h+1006h+1002h；cleanup 写关闭", () => {
    const out = fakeStdout();
    const writes: string[] = [];
    out.on("data", (c) => writes.push(String(c)));

    const disable = enableSgrMouseReport(out);
    const enableJoined = writes.join("");
    expect(enableJoined).toContain("\x1b[?1000h");
    expect(enableJoined).toContain("\x1b[?1006h");
    // #238 drag 模式（1002h）让 app 捕获鼠标拖动事件。
    expect(enableJoined).toContain("\x1b[?1002h");

    disable();
    const fullJoined = writes.join("");
    expect(fullJoined).toContain("\x1b[?1000l");
    expect(fullJoined).toContain("\x1b[?1006l");
    expect(fullJoined).toContain("\x1b[?1002l");
  });

  it("cleanup 幂等：多次调用只写一次 DECRST", () => {
    const out = fakeStdout();
    const writes: string[] = [];
    out.on("data", (c) => writes.push(String(c)));

    const disable = enableSgrMouseReport(out);
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
    const disable = enableSgrMouseReport(s as unknown as NodeJS.WriteStream);
    expect(writes.join("")).toBe("");
    disable();
    expect(writes.join("")).toBe("");
  });
});

describe("parseMouseAllEvents（SGR 全解析：#238 drag）", () => {
  it("左键按下（button=0, M）→ 事件含坐标 + pressed=true", () => {
    expect(parseMouseAllEvents("\x1b[<0;10;5M")).toEqual([
      { button: 0, x: 10, y: 5, pressed: true },
    ]);
  });

  it("左键拖动（button=32, M）→ 坐标更新 + pressed=true", () => {
    expect(parseMouseAllEvents("\x1b[<32;20;8M")).toEqual([
      { button: 32, x: 20, y: 8, pressed: true },
    ]);
  });

  it("释放（button=3, m 终止）→ pressed=false", () => {
    expect(parseMouseAllEvents("\x1b[<3;20;8m")).toEqual([
      { button: 3, x: 20, y: 8, pressed: false },
    ]);
  });

  it("一次 chunk 多个事件 → 全量累计（顺序保留）", () => {
    const events = parseMouseAllEvents(
      "\x1b[<0;10;5M\x1b[<32;11;5M\x1b[<32;13;7M\x1b[<3;13;7m"
    );
    expect(events).toEqual([
      { button: 0, x: 10, y: 5, pressed: true },
      { button: 32, x: 11, y: 5, pressed: true },
      { button: 32, x: 13, y: 7, pressed: true },
      { button: 3, x: 13, y: 7, pressed: false },
    ]);
  });

  it("滚轮事件也全量返回（不丢弃 button=64/65）", () => {
    expect(parseMouseAllEvents("\x1b[<64;1;1M")).toEqual([
      { button: 64, x: 1, y: 1, pressed: true },
    ]);
  });

  it("非 string / 空串 → []", () => {
    expect(parseMouseAllEvents("")).toEqual([]);
  });

  it("普通键盘 ANSI 不误判 → []", () => {
    expect(parseMouseAllEvents("\x1b[5~\x1b[A")).toEqual([]);
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

describe("wheelScrollStep（滚轮步长 SSOT）", () => {
  it("viewportRows=30 → 15（floor(30/2)）", () => {
    expect(wheelScrollStep(30)).toBe(15);
  });

  it("viewportRows=31 → 15（floor 截断）", () => {
    expect(wheelScrollStep(31)).toBe(15);
  });

  it("viewportRows=1 → 1（下限防呆，防 0 步长）", () => {
    expect(wheelScrollStep(1)).toBe(1);
  });

  it("viewportRows=0 / 负数 / NaN → 1（无测得视口时最小步长）", () => {
    expect(wheelScrollStep(0)).toBe(1);
    expect(wheelScrollStep(-5)).toBe(1);
    expect(wheelScrollStep(Number.NaN)).toBe(1);
  });

  it("回归锁：#88f4ac5 clamp 端点回归——步长永远是半屏 floor，非 MAX_SAFE", () => {
    // 顶部跳变（MAX_SAFE_INTEGER）已由 Home 键承担；滚轮步长必须是有界小步。
    expect(wheelScrollStep(30)).toBeLessThan(30);
    // floor(MAX_SAFE_INTEGER / 2) = 4503599627370495（JS 浮点截断）
    expect(wheelScrollStep(Number.MAX_SAFE_INTEGER)).toBe(4503599627370495);
  });
});
