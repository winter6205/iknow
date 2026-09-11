/**
 * tests/tui/scrollbar-style.test.ts
 *
 * 滚动条观感策略的纯函数边界（S2 五类：empty / negative / overflow /
 * concurrent / exception）。
 *
 * 钉住的不变式：track 恒定全透明（显形 = 回归到「与背景同色的可见轨道」）；
 * thumb 的 alpha 只在 idle / hover 两档之间取值，且 idle 严格低于 hover
 * （「平时极淡、移入显色」的可测形式）。颜色一律 8 位 hex —— 7 位 hex 或
 * 颜色名会让 OpenTUI 回落到默认不透明色，把淡出效果整条吞掉。
 */
import { expect, test } from "bun:test";
import {
  attachScrollbarHover,
  SCROLLBAR_THUMB_HOVER_ALPHA,
  SCROLLBAR_THUMB_IDLE_ALPHA,
  scrollbarThumbColor,
  scrollbarTrackColor,
  type ScrollbarHoverTarget,
} from "../../src/tui/scrollbar-style.js";

const HEX8_RE = /^#[0-9a-f]{8}$/;

function alphaOf(hex: string): number {
  return Number.parseInt(hex.slice(7, 9), 16);
}

test("track：恒定全透明（idle / hover 同值）", () => {
  const hex = scrollbarTrackColor();
  expect(hex).toMatch(HEX8_RE);
  expect(alphaOf(hex)).toBe(0);
});

test("thumb：idle 极淡、hover 显色，且 idle 严格更淡", () => {
  const idle = scrollbarThumbColor(false);
  const hovered = scrollbarThumbColor(true);
  expect(idle).toMatch(HEX8_RE);
  expect(hovered).toMatch(HEX8_RE);
  expect(alphaOf(idle)).toBe(SCROLLBAR_THUMB_IDLE_ALPHA);
  expect(alphaOf(hovered)).toBe(SCROLLBAR_THUMB_HOVER_ALPHA);
  expect(alphaOf(idle)).toBeLessThan(alphaOf(hovered));
});

test("thumb：两态 RGB 相同，只有 alpha 变化（不同色相会让 hover 像换了个控件）", () => {
  expect(scrollbarThumbColor(false).slice(0, 7)).toBe(
    scrollbarThumbColor(true).slice(0, 7)
  );
});

test("overflow：两态 alpha 都在 0–255 且为整数（越界会污染渲染缓冲）", () => {
  for (const alpha of [
    SCROLLBAR_THUMB_IDLE_ALPHA,
    SCROLLBAR_THUMB_HOVER_ALPHA,
  ]) {
    expect(Number.isInteger(alpha)).toBe(true);
    expect(alpha).toBeGreaterThanOrEqual(0);
    expect(alpha).toBeLessThanOrEqual(255);
  }
});

test("concurrent：多次调用返回同一字符串（渲染逐帧比较引用，抖动会触发重绘）", () => {
  expect(scrollbarThumbColor(true)).toBe(scrollbarThumbColor(true));
  expect(scrollbarThumbColor(false)).toBe(scrollbarThumbColor(false));
  expect(scrollbarTrackColor()).toBe(scrollbarTrackColor());
});

test("exception：target 为 null / undefined / 非对象 → 返回 no-op 卸载函数且不抛", () => {
  for (const bad of [null, undefined, 42, "x"] as const) {
    const detach = attachScrollbarHover(
      bad as ScrollbarHoverTarget | null | undefined,
      () => {
        throw new Error("不该被调用");
      }
    );
    expect(typeof detach).toBe("function");
    expect(() => detach()).not.toThrow();
  }
});

test("hover：进出各翻转一次，重复同向事件被去重", () => {
  const target: ScrollbarHoverTarget = {};
  const seen: boolean[] = [];
  const detach = attachScrollbarHover(target, (h) => seen.push(h));

  target.onMouseOver?.(undefined as never);
  target.onMouseOver?.(undefined as never); // 逐帧 move 重放：不该再通知
  target.onMouseOut?.(undefined as never);
  target.onMouseOut?.(undefined as never);
  target.onMouseOver?.(undefined as never);

  expect(seen).toEqual([true, false, true]);
  detach();
});

test("hover：detach 复位到未 hover 并清空槽（卸载后事件不再改状态）", () => {
  const target: ScrollbarHoverTarget = {};
  const seen: boolean[] = [];
  attachScrollbarHover(target, (h) => seen.push(h));
  target.onMouseOver?.(undefined as never);
  expect(seen).toEqual([true]);

  // detach 需先复位（指针已不在条上，残留 hover 会让 thumb 常亮）。
  const detach = attachScrollbarHover(target, (h) => seen.push(h));
  target.onMouseOver?.(undefined as never);
  detach();
  expect(seen).toEqual([true, true, false]);
  expect(target.onMouseOver).toBeUndefined();
  expect(target.onMouseOut).toBeUndefined();
});
