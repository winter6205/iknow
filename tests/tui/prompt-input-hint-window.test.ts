/**
 * tests/tui/prompt-input-hint-window.test.ts
 *
 * Slash-hint scroll-window semantics: the rendered list is capped at
 * HINT_MAX_ROWS and the window only shifts when the hint cursor crosses an
 * edge — chrome on a short terminal never exceeds the reserved rows (the
 * overlap/squeeze regression on small windows).
 */
import { describe, expect, test } from "bun:test";
import { HINT_MAX_ROWS, hintWindowStart } from "../../src/tui/prompt-input.js";

const TOTAL = 16; // bare "/" → full static vocabulary

describe("hintWindowStart — slash hint 滚动窗口", () => {
  test("total ≤ maxRows → 恒 0（不折叠）", () => {
    for (let cursor = 0; cursor < HINT_MAX_ROWS; cursor++) {
      expect(hintWindowStart(cursor, HINT_MAX_ROWS, HINT_MAX_ROWS)).toBe(0);
    }
    expect(hintWindowStart(2, 3, HINT_MAX_ROWS)).toBe(0);
  });

  test("光标在前 8 项内 → 窗口不动", () => {
    for (let cursor = 0; cursor < HINT_MAX_ROWS; cursor++) {
      expect(hintWindowStart(cursor, TOTAL, HINT_MAX_ROWS)).toBe(0);
    }
  });

  test("光标越下沿 → 逐行平移；回上沿 → 平移回来", () => {
    expect(hintWindowStart(HINT_MAX_ROWS, TOTAL, HINT_MAX_ROWS)).toBe(1);
    expect(hintWindowStart(TOTAL - 1, TOTAL, HINT_MAX_ROWS)).toBe(
      TOTAL - HINT_MAX_ROWS
    );
    expect(hintWindowStart(HINT_MAX_ROWS - 1, TOTAL, HINT_MAX_ROWS)).toBe(0);
  });

  test("窗口右端封顶：start + maxRows 恒 ≤ total（末项可见时 start 不再增）", () => {
    for (let cursor = 0; cursor < TOTAL; cursor++) {
      const start = hintWindowStart(cursor, TOTAL, HINT_MAX_ROWS);
      expect(start + HINT_MAX_ROWS).toBeLessThanOrEqual(TOTAL);
      // 光标必须始终落在窗口内
      expect(cursor).toBeGreaterThanOrEqual(start);
      expect(cursor).toBeLessThan(start + HINT_MAX_ROWS);
    }
  });

  test("越界光标（列表缩短竞态）→ 钳到最后一个窗口", () => {
    expect(hintWindowStart(99, TOTAL, HINT_MAX_ROWS)).toBe(
      TOTAL - HINT_MAX_ROWS
    );
  });
});
