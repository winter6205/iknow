/**
 * tests/tui/fence-display-cap.test.ts — 围栏显示窗纯函数 5 类边界。
 *
 * spec EXIT：empty / 非法窗宽退回 32 / overflow 只留窗内行 + N /
 * concurrent 两次调用互不影响 / 非数组或非字符串行 → TypeError。
 */
import { describe, expect, test } from "bun:test";
import {
  FENCE_DISPLAY_WINDOW,
  clipFenceDisplayLines,
} from "../../src/tui/fence-display-cap.js";

describe("clipFenceDisplayLines", () => {
  test("empty：空数组不溢出", () => {
    expect(clipFenceDisplayLines([])).toEqual({
      visible: [],
      hiddenLineCount: 0,
    });
  });

  test("empty：空字符串单行仍可见且无溢出", () => {
    expect(clipFenceDisplayLines([""])).toEqual({
      visible: [""],
      hiddenLineCount: 0,
    });
  });

  test("1–32 行全挂、无溢出", () => {
    const lines = Array.from({ length: FENCE_DISPLAY_WINDOW }, (_, i) =>
      String(i)
    );
    expect(clipFenceDisplayLines(lines)).toEqual({
      visible: lines,
      hiddenLineCount: 0,
    });
  });

  test("negative：非法窗宽退回 32", () => {
    const lines = Array.from({ length: 40 }, (_, i) => `L${i}`);
    for (const window of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const clipped = clipFenceDisplayLines(lines, window);
      expect(clipped.visible).toHaveLength(FENCE_DISPLAY_WINDOW);
      expect(clipped.hiddenLineCount).toBe(8);
    }
  });

  test("overflow：远超 32 行只产出窗内行 + 有限正整数 N", () => {
    const lines = Array.from({ length: 1000 }, (_, i) => `ROW_${i}`);
    const clipped = clipFenceDisplayLines(lines);
    expect(clipped.visible).toEqual(lines.slice(0, FENCE_DISPLAY_WINDOW));
    expect(clipped.hiddenLineCount).toBe(1000 - FENCE_DISPLAY_WINDOW);
    expect(Number.isFinite(clipped.hiddenLineCount)).toBe(true);
    expect(clipped.hiddenLineCount).toBeGreaterThan(0);
  });

  test("concurrent：两次调用互不影响", () => {
    const a = Array.from({ length: 40 }, (_, i) => `A${i}`);
    const b = Array.from({ length: 10 }, (_, i) => `B${i}`);
    const first = clipFenceDisplayLines(a);
    const second = clipFenceDisplayLines(b);
    expect(first.visible).toEqual(a.slice(0, FENCE_DISPLAY_WINDOW));
    expect(first.hiddenLineCount).toBe(8);
    expect(second.visible).toEqual(b);
    expect(second.hiddenLineCount).toBe(0);
    expect(clipFenceDisplayLines(a).visible[0]).toBe("A0");
  });

  test("exception：非数组抛 TypeError", () => {
    expect(() => clipFenceDisplayLines("not-lines")).toThrow(TypeError);
  });

  test("exception：含非字符串元素抛 TypeError", () => {
    expect(() => clipFenceDisplayLines(["ok", 1])).toThrow(TypeError);
  });
});
