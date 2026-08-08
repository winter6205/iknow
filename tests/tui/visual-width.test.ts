/**
 * tests/tui/visual-width.test.ts
 *
 * #279 项 2 回归：src/tui 视觉列宽 SSOT 收敛到 npm string-width
 * （banner.ts visualWidth / padEndVisual / padStartVisual / truncateMiddle；
 * selection.ts 删除重复 WIDE_RANGES 表、复用共享实现）。
 *
 * 覆盖 issue 要求的三档 CJK 回归：
 *  - 正常：CJK / 混合 / Emoji / 谚文 / 全角宽度口径（CJK=2）；
 *  - 边界：组合标记 0 列、ANSI 剥除（SGR + truecolor）、braille U+2800–28FF
 *    恒 1 列（智慧之眼点阵对齐依赖，string-width 实测口径钉死）、
 *    控制字符 0 列（与旧手写实现 1 列的已知差异）、truncateMiddle 不超宽；
 *  - 窄终端：BANNER_MIN_COLS 阈值降级（cols-1 → []）、SHORT 档单行保留、
 *    CJK info 值（dataDir）不撑破 banner 框（每行恰好占满 cols）。
 *
 * 附：markdown table CJK cell padEndVisual 对齐、tool-summary CJK detail
 * 窄终端收口、selection visualWidthOf/substrVisual 与共享实现一致。
 */
import { describe, expect, it } from "vitest";
import {
  BANNER_MIN_COLS,
  padEndVisual,
  padStartVisual,
  renderBanner,
  truncateMiddle,
  visualWidth,
} from "../../src/tui/banner.js";
import { substrVisual, visualWidthOf } from "../../src/tui/selection.js";
import { clipOneLineVisual, wrapTextVisual } from "../../src/tui/text.js";
import { EYE_LINES } from "../../src/tui/banner-art.js";

describe("visualWidth（string-width SSOT）", () => {
  it("正常：ASCII 宽度 = 字符数", () => {
    expect(visualWidth("")).toBe(0);
    expect(visualWidth("hello")).toBe(5);
  });
  it("正常：CJK 计 2 列（含混合 / 谚文 / 全角 / 增补区）", () => {
    expect(visualWidth("你好")).toBe(4);
    expect(visualWidth("你好世界")).toBe(8);
    expect(visualWidth("a你b")).toBe(4);
    expect(visualWidth("가")).toBe(2); // 谚文
    expect(visualWidth("ＡＢ")).toBe(4); // 全角 ASCII
    expect(visualWidth("\u{20000}")).toBe(2); // CJK 扩展 B
  });
  it("正常：Emoji 计 2 列", () => {
    expect(visualWidth("👋")).toBe(2);
    expect(visualWidth("👋abc")).toBe(5);
    expect(visualWidth("🙂")).toBe(2);
  });
  it("边界：ANSI 转义剥除后计量（SGR + truecolor，比旧实现只剥 SGR 更宽口径）", () => {
    expect(visualWidth("\x1b[31m中文\x1b[0m")).toBe(4);
    expect(visualWidth("\x1b[38;2;24;50;35mabc\x1b[0m")).toBe(3);
    expect(visualWidth("\x1b[1m\x1b[38;5;244m◆ iknow\x1b[0m")).toBe(7);
  });
  it("边界：braille U+2800–U+28FF 恒 1 列（智慧之眼点阵对齐依赖）", () => {
    expect(visualWidth("\u2800")).toBe(1); // 空点阵
    expect(visualWidth("\u2860")).toBe(1); // ⡠
    expect(visualWidth("\u28ff")).toBe(1); // ⣿
    // 完整眼 32×13：每行 braille 点阵 = 32 列（BANNER_MIN_COLS 的基石）。
    for (const line of EYE_LINES) {
      expect(visualWidth(line)).toBe(32);
    }
  });
  it("边界：组合标记 0 列 / 控制字符 0 列（旧实现计 1，已知差异）", () => {
    expect(visualWidth("e\u0301")).toBe(1); // 组合重音符
    expect(visualWidth("\t")).toBe(0);
    expect(visualWidth("\n")).toBe(0);
  });
});

describe("padEndVisual / padStartVisual（CJK 补白）", () => {
  it("CJK 按缺列补空格：结果恰好占满目标列", () => {
    expect(padEndVisual("中文", 6)).toBe("中文  ");
    expect(visualWidth(padEndVisual("中文", 6))).toBe(6);
    expect(padStartVisual("中文", 6)).toBe("  中文");
    expect(visualWidth(padStartVisual("中文", 6))).toBe(6);
  });
  it("已超宽不补 / ANSI 上色串按剥除后宽度补", () => {
    expect(padEndVisual("你好世界", 6)).toBe("你好世界");
    const painted = "\x1b[31m你好\x1b[0m";
    expect(visualWidth(padEndVisual(painted, 6))).toBe(6);
  });
});

describe("truncateMiddle（宽度感知中段截断）", () => {
  it("短串原样返回", () => {
    expect(truncateMiddle("/home/u/.iknow", 32)).toBe("/home/u/.iknow");
  });
  it("ASCII 长路径：首尾保留 + …，恰好占满 width", () => {
    const s = "/very/long/path/to/some/deeply/nested/directory/file.toml";
    const out = truncateMiddle(s, 20);
    expect(visualWidth(out)).toBeLessThanOrEqual(20);
    expect(out).toContain("…");
    expect(out.startsWith("/very")).toBe(true);
    expect(out.endsWith("file.toml")).toBe(true);
  });
  it("CJK 值不超宽（旧实现按码点数切会溢出）", () => {
    const s = "/家/用户/数据目录/超长路径名称一二三四五六七八九/iknow-数据.toml";
    const out = truncateMiddle(s, 32);
    expect(visualWidth(out)).toBeLessThanOrEqual(32);
    expect(out).toContain("…");
  });
});

describe("banner 窄终端降级（CJK 回归）", () => {
  const info = {
    version: "0.1.0",
    cwd: "/home/u/项目",
    dataDir: "/家/用户/.本地/共享/iknow-超长数据目录名称",
  };

  it("BANNER_MIN_COLS = 眼睛 32 + GAP 3 + info 43 + 框 2 = 80", () => {
    expect(BANNER_MIN_COLS).toBe(80);
  });
  it("cols = MIN：每行恰好占满 cols，CJK info 值不撑破框", () => {
    const lines = renderBanner(info, { cols: BANNER_MIN_COLS, short: false });
    expect(lines.length).toBe(EYE_LINES.length + 2);
    for (const line of lines) {
      expect(visualWidth(line)).toBe(BANNER_MIN_COLS);
    }
  });
  it("cols = MIN-1：降级返回 []（窄终端契约）", () => {
    expect(renderBanner(info, { cols: BANNER_MIN_COLS - 1, short: false })).toEqual([]);
  });
  it("窄终端 SHORT 档仍保留单行（不让 logo 消失）", () => {
    for (const cols of [40, 60, BANNER_MIN_COLS - 1]) {
      const lines = renderBanner(info, { cols, short: true });
      expect(lines).toHaveLength(1);
      expect(visualWidth(lines[0]!)).toBeLessThanOrEqual(cols);
    }
  });
});

describe("markdown table / tool-summary CJK 收口（经共享 visualWidth）", () => {
  it("padEndVisual 对齐 CJK table cell：各行等宽", () => {
    const cells = ["名称", "a", "描述列"];
    const max = Math.max(...cells.map(visualWidth));
    const padded = cells.map((c) => padEndVisual(c, max + 2));
    for (const p of padded) expect(visualWidth(p)).toBe(max + 2);
  });
  it("clipOneLineVisual：CJK 截断结果不超宽且以 … 收尾", () => {
    const out = clipOneLineVisual("中文内容很长的摘要行需要被截断", 10);
    expect(visualWidth(out)).toBeLessThanOrEqual(10);
    expect(out.endsWith("…")).toBe(true);
  });
  it("wrapTextVisual：CJK 按视觉宽度折行，每行不超宽", () => {
    const lines = wrapTextVisual("这是一段需要折行的中文文本内容", 8);
    expect(lines.length).toBeGreaterThan(1);
    for (const l of lines) expect(visualWidth(l)).toBeLessThanOrEqual(8);
    // 折行不丢字
    expect(lines.join("")).toBe("这是一段需要折行的中文文本内容");
  });
});

describe("selection：共享实现一致性（删除重复 WIDE_RANGES 后）", () => {
  it("visualWidthOf 与 visualWidth 同口径（CJK/Emoji/braille）", () => {
    for (const s of ["hello", "你好", "a你b", "👋", "\u2800\u28ff", "ＡＢ"]) {
      expect(visualWidthOf(s)).toBe(visualWidth(s));
    }
  });
  it("substrVisual CJK 切片不拆字", () => {
    expect(substrVisual("你好世界", 2, 6)).toBe("好世");
    expect(substrVisual("a你b", 1, 3)).toBe("你");
    // 宽字符跨切点整字丢弃（不产半字）
    expect(substrVisual("你好", 0, 1)).toBe("");
    expect(substrVisual("你好", 0, 2)).toBe("你");
  });
});
