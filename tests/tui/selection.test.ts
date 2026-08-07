/**
 * tests/tui/selection.test.ts
 *
 * #238 应用内选区纯函数单测：
 *  - normalize：方向无关，anchor 在前；
 *  - isEmpty / rowRange / highlightRangeForLine / extractSelectionText；
 *  - terminalToCellPos：SGR (1-based x,y) → 内容 (row, col)，含窗口裁剪；
 *  - substrVisual / visualWidthOf：CJK/Emoji 双列，ANSI 子串按 visual 列切。
 */
import { describe, expect, it } from "vitest";
import {
  extractSelectionText,
  highlightRangeForLine,
  isEmpty,
  normalize,
  rowRange,
  substrVisual,
  terminalToCellPos,
  visualWidthOf,
} from "../../src/tui/selection.js";
import type {
  CellPos,
  ContentWindow,
  Selection,
} from "../../src/tui/selection.js";

const cell = (row: number, col: number): CellPos => ({ row, col });

describe("normalize / isEmpty / rowRange", () => {
  it("拖动方向自上而下 → 锚点不变", () => {
    const s: Selection = { anchor: cell(1, 3), active: cell(5, 10) };
    expect(normalize(s)).toEqual(s);
  });
  it("拖动方向自下而上 → anchor / active 互换", () => {
    const s: Selection = { anchor: cell(5, 10), active: cell(1, 3) };
    expect(normalize(s)).toEqual({
      anchor: cell(1, 3),
      active: cell(5, 10),
    });
  });
  it("同行内反向 → 同样按 col 排序", () => {
    expect(normalize({ anchor: cell(2, 9), active: cell(2, 3) })).toEqual({
      anchor: cell(2, 3),
      active: cell(2, 9),
    });
  });
  it("isEmpty 仅 anchor === active 时为真", () => {
    expect(isEmpty({ anchor: cell(0, 0), active: cell(0, 0) })).toBe(true);
    expect(isEmpty({ anchor: cell(0, 0), active: cell(0, 1) })).toBe(false);
    expect(isEmpty({ anchor: cell(0, 1), active: cell(0, 0) })).toBe(false);
  });
  it("rowRange 按 normalize 后取首尾行", () => {
    expect(rowRange({ anchor: cell(3, 0), active: cell(1, 5) })).toEqual({
      from: 1,
      to: 3,
    });
  });
});

describe("terminalToCellPos", () => {
  const win: ContentWindow = { startRow: 10, endRow: 20, cols: 80 };

  it("(1, y=1) → (row=10, col=0)（窗口第一可见行）", () => {
    expect(terminalToCellPos(1, 1, win)).toEqual(cell(10, 0));
  });
  it("(80, y=10) → (row=19, col=79)（窗口最后可见行含边界）", () => {
    expect(terminalToCellPos(80, 10, win)).toEqual(cell(19, 79));
  });
  it("y 越下界（0）→ null", () => {
    expect(terminalToCellPos(1, 0, win)).toBeNull();
  });
  it("y 越上界（> visibleRows）→ null", () => {
    expect(terminalToCellPos(1, 11, win)).toBeNull();
  });
  it("x 越右界 → clamp 到 cols-1", () => {
    expect(terminalToCellPos(200, 5, win)).toEqual(cell(14, 79));
  });
  it("x 越左界（<1）→ clamp 到 0", () => {
    expect(terminalToCellPos(0, 5, win)).toEqual(cell(14, 0));
  });
});

describe("highlightRangeForLine", () => {
  it("行不在选区 → null", () => {
    const sel = selection(cell(3, 0), cell(5, 10));
    expect(highlightRangeForLine(2, "abcdef", sel)).toBeNull();
    expect(highlightRangeForLine(6, "abcdef", sel)).toBeNull();
  });
  it("中间行 → 整行覆盖 [0, visualWidth)（半开上界）", () => {
    const sel = selection(cell(3, 5), cell(5, 10));
    const range = highlightRangeForLine(4, "abcdef", sel);
    expect(range).toEqual({ start: 0, end: 6 });
  });
  it("首行 → 从 anchor.col 起（半开）", () => {
    const sel = selection(cell(3, 2), cell(5, 10));
    expect(highlightRangeForLine(3, "abcdef", sel)).toEqual({
      start: 2,
      end: 6,
    });
  });
  it("尾行 → 到 active.col+1 止（半开上界）", () => {
    const sel = selection(cell(3, 0), cell(5, 3));
    expect(highlightRangeForLine(5, "abcdef", sel)).toEqual({
      start: 0,
      end: 4,
    });
  });
  it("anchor.col > line visualWidth → null（视觉外）", () => {
    const sel = selection(cell(3, 100), cell(5, 110));
    expect(highlightRangeForLine(3, "abc", sel)).toBeNull();
  });
  it("空行 → null", () => {
    const sel = selection(cell(3, 0), cell(5, 5));
    expect(highlightRangeForLine(4, "", sel)).toBeNull();
  });
});

describe("extractSelectionText", () => {
  it("单行选区 → 按 visual col 切", () => {
    const lines = ["hello world", "row2", "row3"];
    expect(
      extractSelectionText(selection(cell(0, 6), cell(0, 10)), lines)
    ).toBe("world");
  });
  it("多行选区 → 行间 \\n + 首/尾行按 col 截取", () => {
    const lines = ["hello", "brave", "world"];
    expect(extractSelectionText(selection(cell(0, 2), cell(2, 3)), lines)).toBe(
      "llo\nbrave\nworl"
    );
  });
  it("反向拖动 → normalize 后行为一致", () => {
    const lines = ["alpha", "beta", "gamma"];
    expect(extractSelectionText(selection(cell(2, 2), cell(0, 1)), lines)).toBe(
      "lpha\nbeta\ngam"
    );
  });
  it("包含空行（占位 / 边距）→ 跳过", () => {
    const lines = ["a", "", "b"];
    expect(extractSelectionText(selection(cell(0, 0), cell(2, 0)), lines)).toBe(
      "a\nb"
    );
  });
  it("边界越界行 → null 截断", () => {
    const lines = ["abc"]; // 仅 1 行
    // row=5 越界 → lines[5]=undefined → 跳过；row=0 是首/尾 → 按 col 截取
    expect(
      extractSelectionText(selection(cell(0, 1), cell(5, 10)), lines)
    ).toBe("bc");
  });
});

describe("visualWidthOf / substrVisual（CJK 双列）", () => {
  it("ASCII 宽度 = char count", () => {
    expect(visualWidthOf("hello")).toBe(5);
  });
  it("中文宽度 = 字符 ×2", () => {
    expect(visualWidthOf("你好")).toBe(4);
    expect(visualWidthOf("你好世界")).toBe(8);
  });
  it("混合（CJK + ASCII）→ CJK 计 2", () => {
    expect(visualWidthOf("a你b")).toBe(4);
  });
  it("Emoji 宽字符计 2", () => {
    expect(visualWidthOf("👋")).toBe(2);
    expect(visualWidthOf("👋abc")).toBe(5);
  });
  it("substrVisual 按 visual 列切", () => {
    expect(substrVisual("hello", 1, 4)).toBe("ell");
    expect(substrVisual("你好世界", 2, 6)).toBe("好世");
    expect(substrVisual("a你b", 1, 3)).toBe("你");
  });
  it("substrVisual colStart >= colEnd → 空串", () => {
    expect(substrVisual("abc", 2, 2)).toBe("");
    expect(substrVisual("abc", 3, 1)).toBe("");
  });
  it("substrVisual 越界端 → clamp", () => {
    expect(substrVisual("abc", 1, 100)).toBe("bc");
  });
});

// ── 简化构造器：避免每个 it 重复 { anchor, active } ──
function selection(a: CellPos, b: CellPos): Selection {
  return { anchor: a, active: b };
}
