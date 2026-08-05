/**
 * tests/tui/mouse.test.ts
 *
 * 鼠标滚轮支持（任务 A 行级）：parseMouseEvents + enableMouseScroll 单测。
 *
 * 覆盖：
 *  - 滚轮上滚 SGR 序列：\x1b[<64;x;yM → wheelUp=1
 *  - 滚轮下滚 SGR 序列：\x1b[<65;x;yM → wheelDown=1
 *  - 多个滚轮事件在一个 chunk 内累加
 *  - 滚轮释放（button=64, terminator=m）不计入 counts（避免双计数）
 *  - 普通键盘 ANSI（PgUp \x1b[5~）不被识别为 mouse
 *  - 鼠标按下（非滚轮，button=0/1/2）不计入 counts，但被吞掉不传给 ink
 *  - 跨滚轮与普通字符的混合 chunk：rest 只保留非 mouse 部分
 *  - enableMouseScroll：非 TTY stdout = no-op；TTY stdout 写 DECSET 1000/1006
 *  - enableMouseScroll cleanup：调用后写 DECRST 1000/1006；幂等
 */
import { describe, expect, it } from "vitest";
import { PassThrough } from "node:stream";
import { enableMouseScroll, parseMouseEvents } from "../../src/tui/mouse.js";

describe("parseMouseEvents（#146 行级滚动）", () => {
  it("滚轮上滚 SGR 序列 → wheelUp=1", () => {
    const r = parseMouseEvents("\x1b[<64;10;5M");
    expect(r.wheelUp).toBe(1);
    expect(r.wheelDown).toBe(0);
  });

  it("滚轮下滚 SGR 序列 → wheelDown=1", () => {
    const r = parseMouseEvents("\x1b[<65;10;5M");
    expect(r.wheelDown).toBe(1);
    expect(r.wheelUp).toBe(0);
  });

  it("多个滚轮事件累加", () => {
    const r = parseMouseEvents("\x1b[<64;1;1M\x1b[<64;2;2M\x1b[<65;3;3M");
    expect(r.wheelUp).toBe(2);
    expect(r.wheelDown).toBe(1);
  });

  it("滚轮释放（terminator=m）不计入 counts，避免双计数", () => {
    // 滚轮按下 + 释放配对：只按一次
    const r = parseMouseEvents("\x1b[<64;1;1M\x1b[<64;1;1m");
    expect(r.wheelUp).toBe(1);
    expect(r.wheelDown).toBe(0);
  });

  it("普通键盘 ANSI 不被识别为 mouse", () => {
    // PgUp = \x1b[5~ ；上箭头 = \x1b[A ；Enter = \r
    const r = parseMouseEvents("\x1b[5~\x1b[A\r");
    expect(r.wheelUp).toBe(0);
    expect(r.wheelDown).toBe(0);
    // 整段都应保留在 rest（让 ink useInput 继续解析）
    expect(r.rest).toBe("\x1b[5~\x1b[A\r");
  });

  it("鼠标按下（button=0/1/2）不计入滚轮 counts，但被吞掉", () => {
    // 鼠标左键按下 button=0，按下 = M
    const r = parseMouseEvents("\x1b[<0;1;1M");
    expect(r.wheelUp).toBe(0);
    expect(r.wheelDown).toBe(0);
    // SGR 鼠标协议字节应被剥离（不被 ink 误解析为键盘序列）
    expect(r.consumed).toBe("\x1b[<0;1;1M");
    expect(r.rest).toBe("");
  });

  it("滚轮事件 + 普通字符混合：rest 只保留非 mouse 部分", () => {
    // 先一个 wheel up，再一个 'a' 字符
    const r = parseMouseEvents("\x1b[<64;1;1Ma");
    expect(r.wheelUp).toBe(1);
    expect(r.rest).toBe("a");
  });

  it("空字符串 → 全零", () => {
    const r = parseMouseEvents("");
    expect(r.wheelUp).toBe(0);
    expect(r.wheelDown).toBe(0);
    expect(r.consumed).toBe("");
    expect(r.rest).toBe("");
  });

  it("SGR 序列中的 button 大数字（如 100/200）不误计为 64/65", () => {
    // 终端有时会发出 button=0 + 32/64 修饰位（如拖动 = 32 + 0 = 32）
    const r = parseMouseEvents("\x1b[<32;1;1M");
    expect(r.wheelUp).toBe(0);
    expect(r.wheelDown).toBe(0);
  });

  it("SGR 序列坐标合法", () => {
    // 大坐标（终端右下角）
    const r = parseMouseEvents("\x1b[<64;200;50M");
    expect(r.wheelUp).toBe(1);
  });
});

describe("enableMouseScroll（#146 行级滚动）", () => {
  it("非 TTY stdout → no-op，cleanup 也 no-op", () => {
    const stream = new PassThrough();
    // 强制 isTTY=false
    Object.defineProperty(stream, "isTTY", { value: false });
    const cleanup = enableMouseScroll(stream);
    // 不应写任何字节到非 TTY 流
    expect(stream.writableLength).toBe(0);
    cleanup(); // 幂等不抛
  });

  it("TTY stdout 启用时写 DECSET 1000h + 1006h", () => {
    const stream = new PassThrough();
    Object.defineProperty(stream, "isTTY", { value: true });
    const writes: string[] = [];
    const originalWrite = stream.write.bind(stream);
    stream.write = ((chunk: string | Buffer): boolean => {
      writes.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
      return originalWrite(chunk);
    }) as typeof stream.write;
    const cleanup = enableMouseScroll(stream);
    expect(writes.join("")).toContain("\x1b[?1000h");
    expect(writes.join("")).toContain("\x1b[?1006h");
    cleanup();
  });

  it("TTY stdout cleanup 写 DECRST 1000l + 1006l", () => {
    const stream = new PassThrough();
    Object.defineProperty(stream, "isTTY", { value: true });
    const writes: string[] = [];
    const originalWrite = stream.write.bind(stream);
    stream.write = ((chunk: string | Buffer): boolean => {
      writes.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
      return originalWrite(chunk);
    }) as typeof stream.write;
    const cleanup = enableMouseScroll(stream);
    writes.length = 0; // 清掉启用时的字节
    cleanup();
    expect(writes.join("")).toContain("\x1b[?1000l");
    expect(writes.join("")).toContain("\x1b[?1006l");
  });

  it("cleanup 幂等：多次调用只写一次关闭序列", () => {
    const stream = new PassThrough();
    Object.defineProperty(stream, "isTTY", { value: true });
    const writes: string[] = [];
    const originalWrite = stream.write.bind(stream);
    stream.write = ((chunk: string | Buffer): boolean => {
      writes.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
      return originalWrite(chunk);
    }) as typeof stream.write;
    const cleanup = enableMouseScroll(stream);
    writes.length = 0;
    cleanup();
    cleanup();
    cleanup();
    // DECRST 应只出现一次
    const joined = writes.join("");
    const lCount = (joined.match(/\x1b\[\?1000l/g) ?? []).length;
    expect(lCount).toBe(1);
  });
});
