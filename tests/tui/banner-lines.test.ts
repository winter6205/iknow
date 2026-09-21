/**
 * tests/tui/banner-lines.test.ts
 *
 * Unit tests for the renderBannerLines pure function (banner shares the
 * scroll space with messages). No React / no ANSI; line counts and content
 * are directly assertable.
 *
 *  - cols wide enough for the 32-column eye → full 13-line eye (79 cols is
 *    still the eye, no collapse to a single line).
 *  - Extremely narrow, the eye itself does not fit → 1 line
 *    bannerShortLine(version), no divider.
 */
import { describe, expect, test } from "bun:test";
import {
  BANNER_INFO_WIDTH,
  BANNER_MIN_COLS,
  EYE_LINES,
  bannerInfoLines,
  bannerShortLine,
  eyeGradientCells,
  renderBannerLines,
  VERSION,
} from "../../src/tui/banner.js";

const INFO = {
  version: "9.9.9-test",
  cwd: "/tmp/proj",
  dataDir: "/tmp/proj/.data",
};

// GAP=3 between the eye and the info column (same value as banner.ts's private constant).
const GAP = 3;
const EYE_W = [...(EYE_LINES[0] ?? "")].length;
const LINE_W = EYE_W + GAP + BANNER_INFO_WIDTH; // 32 + 3 + 43 = 78

/** Same semantics as banner.ts: pad info lines right to BANNER_INFO_WIDTH to keep the right edge aligned. */
function padInfo(s: string): string {
  return s.padEnd(BANNER_INFO_WIDTH);
}

describe("renderBannerLines", () => {
  test("宽终端 cols ≥ BANNER_MIN_COLS → 13 行，每行 = 眼睛 + GAP + info 栏", () => {
    const lines = renderBannerLines(INFO, BANNER_MIN_COLS);
    expect(lines.length).toBe(EYE_LINES.length);
    lines.forEach((line, r) => {
      expect(line.startsWith(EYE_LINES[r] ?? "")).toBe(true);
      // Every line has constant width = 32 + 3 + 43 = 78 cols ≤ 80, no overflow.
      expect([...line]).toHaveLength(LINE_W);
    });
  });

  test("info 三行垂直居中：第 5/6/7 行右侧含 Version / Cwd / Data dir", () => {
    const lines = renderBannerLines(INFO, BANNER_MIN_COLS);
    const infoLines = bannerInfoLines(INFO);
    // Middle 3 of the 13 eye lines (0-indexed 5/6/7); info segment padded right to 43 cols.
    expect(lines[5]).toBe(
      `${EYE_LINES[5] ?? ""}${" ".repeat(GAP)}${padInfo(infoLines[0] ?? "")}`
    );
    expect(lines[6]).toBe(
      `${EYE_LINES[6] ?? ""}${" ".repeat(GAP)}${padInfo(infoLines[1] ?? "")}`
    );
    expect(lines[7]).toBe(
      `${EYE_LINES[7] ?? ""}${" ".repeat(GAP)}${padInfo(infoLines[2] ?? "")}`
    );
    // The remaining 10 lines' info segment is pure spaces (right-aligned, no text leakage).
    const notInfo = [0, 1, 2, 3, 4, 8, 9, 10, 11, 12];
    for (const r of notInfo) {
      const line = lines[r] ?? "";
      const infoSegment = line.slice(EYE_W + GAP);
      expect(infoSegment).toBe(" ".repeat(BANNER_INFO_WIDTH));
    }
  });

  test("Version 行并排于眼睛右侧（行内包含，非独立 info 行）", () => {
    const lines = renderBannerLines(INFO, BANNER_MIN_COLS);
    const row = lines[5] ?? "";
    expect(row).toContain("Version");
    expect(row).toContain("9.9.9-test");
    // Info text sits on the right: after the 32-col eye line + 3-col GAP.
    expect(row.indexOf("Version")).toBeGreaterThanOrEqual(EYE_W + GAP);
  });

  test("近阈值 79 列仍是 13 行完整眼，不塌单行", () => {
    const lines = renderBannerLines(INFO, BANNER_MIN_COLS - 1);
    expect(lines.length).toBe(EYE_LINES.length);
    expect(lines[0]?.startsWith(EYE_LINES[0] ?? "")).toBe(true);
    expect(lines[0]).not.toBe(bannerShortLine(INFO.version));
  });

  test("极窄终端放不下眼睛才退单行 short", () => {
    const lines = renderBannerLines(INFO, 20);
    expect(lines.length).toBe(1);
    expect(lines[0]).toBe(bannerShortLine(INFO.version));
    expect(lines[0]).not.toContain("─");
  });

  test("窄终端 cols = 0 也退单行（不抛）", () => {
    const lines = renderBannerLines(INFO, 0);
    expect(lines.length).toBe(1);
    expect(lines[0]).toBe(bannerShortLine(INFO.version));
  });

  test("VERSION SSOT：VERSION 存在且非空", () => {
    expect(typeof VERSION).toBe("string");
    expect(VERSION.length).toBeGreaterThan(0);
  });
});

describe("eyeGradientCells", () => {
  const FROM = "#1a1d6e"; // dark blue-violet (gradient start)
  const TO = "#ffafaf"; // pink-gold (gradient end)

  test("13 行 × 32 cell：逐 cell 输出 {text, hex}", () => {
    const cells = eyeGradientCells({
      from: FROM,
      to: TO,
      cWeight: 0.6,
      rWeight: 0.4,
    });
    expect(cells.length).toBe(13);
    for (const row of cells) {
      expect(row.length).toBe(32);
    }
    // Each cell is { text, hex }: text from EYE_LINES, hex is #rrggbb.
    for (const row of cells) {
      for (const cell of row) {
        expect(typeof cell.text).toBe("string");
        expect(cell.text.length).toBe(1);
        expect(cell.hex).toMatch(/^#[0-9a-f]{6}$/);
      }
    }
  });

  test("text 与 EYE_LINES 逐 cell 保持一致（braille 点阵宽度不漂）", () => {
    const cells = eyeGradientCells({
      from: FROM,
      to: TO,
      cWeight: 0.6,
      rWeight: 0.4,
    });
    for (let r = 0; r < EYE_LINES.length; r++) {
      const eyeChars = [...(EYE_LINES[r] ?? "")];
      expect(cells[r]!.length).toBe(eyeChars.length);
      for (let c = 0; c < eyeChars.length; c++) {
        expect(cells[r]![c]!.text).toBe(eyeChars[c]);
      }
    }
  });

  test("首 cell (0,0) = 起点色 #1a1d6e（t = 0）", () => {
    const cells = eyeGradientCells({
      from: FROM,
      to: TO,
      cWeight: 0.6,
      rWeight: 0.4,
    });
    expect(cells[0]![0]!.hex).toBe("#1a1d6e");
  });

  test("末 cell (12,31) = 终点色 #ffafaf（t = 1）", () => {
    const cells = eyeGradientCells({
      from: FROM,
      to: TO,
      cWeight: 0.6,
      rWeight: 0.4,
    });
    expect(cells[12]![31]!.hex).toBe("#ffafaf");
  });

  test("中 cell (6,16) ≈ rgb(143,103,143) = #8f678f（与 e2 预览脚本 exotic-e2.ts 对齐）", () => {
    const cells = eyeGradientCells({
      from: FROM,
      to: TO,
      cWeight: 0.6,
      rWeight: 0.4,
    });
    // t = 0.6*(16/31) + 0.4*(6/12) ≈ 0.50968
    // lerp(#1a1d6e, #ffafaf, t) ≈ rgb(143, 103, 143) = #8f678f
    expect(cells[6]![16]!.hex).toBe("#8f678f");
  });

  test("权重反向验证：c 权重 1.0 / r 权重 0.0 时末列 (c=31) 仍为 #ffafaf", () => {
    const cells = eyeGradientCells({
      from: FROM,
      to: TO,
      cWeight: 1.0,
      rWeight: 0.0,
    });
    expect(cells[0]![31]!.hex).toBe("#ffafaf");
    expect(cells[0]![0]!.hex).toBe("#1a1d6e");
    // Any column in row r=6 feels zero row weight: t is determined by column only.
    expect(cells[6]![0]!.hex).toBe("#1a1d6e");
    expect(cells[6]![31]!.hex).toBe("#ffafaf");
  });
});
