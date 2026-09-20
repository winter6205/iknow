/** @jsxImportSource @opentui/react */
/**
 * tests/tui/diff-view.test.tsx
 *
 * diff-view renderer (OpenTUI):
 *  - diffRowText text shapes across three width tiers (cols>=80 dual-line-number
 *    / 40–79 single / <40 add-only);
 *  - DiffView frame render: hunk header, line-number column, narrow-terminal folding;
 *  - captureSpans coloring asserts (the real-color contract that was it.skip'd in
 *    the archive, now measurable under OpenTUI): add lines fg green (#2ea043)
 *    + full-line light-green bg (#1f3d2b), del lines fg red (#d73a49)
 *    + light-red bg (#3d1f24), at least one each.
 */
import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import type { CapturedFrame } from "@opentui/core";
import { computeDiff, type DiffLine } from "../../src/tui/diff-unified.js";
import { DiffView, diffRowText } from "../../src/tui/diff-view.js";
import { tuiPalette } from "../../src/tui/theme.js";

const OLD = "one\ntwo\nthree\nfour\nfive";
const NEW = "one\nTWO\nthree\nFOUR\nfive";

function editRows(oldText: string, newText: string): readonly DiffLine[] {
  return computeDiff("a.ts", oldText, newText);
}

/** hex → [r,g,b] floats 0-1 (captureSpans RGBA convention). */
function hex01(hex: string): [number, number, number] {
  return [
    parseInt(hex.slice(1, 3), 16) / 255,
    parseInt(hex.slice(3, 5), 16) / 255,
    parseInt(hex.slice(5, 7), 16) / 255,
  ];
}

/** Does the frame contain a span whose text includes needle with fg (and optional bg) matching hex (±1/255)? */
function hasSpan(
  frame: CapturedFrame,
  needle: string,
  fgHex: string,
  bgHex?: string
): boolean {
  const [fr, fg2, fb] = hex01(fgHex);
  const bg = bgHex === undefined ? undefined : hex01(bgHex);
  return frame.lines.some((line) =>
    line.spans.some((span) => {
      if (!span.text.includes(needle)) return false;
      const eps = 1.5 / 255;
      if (Math.abs(span.fg.r - fr) > eps) return false;
      if (Math.abs(span.fg.g - fg2) > eps) return false;
      if (Math.abs(span.fg.b - fb) > eps) return false;
      if (bg !== undefined) {
        if (Math.abs(span.bg.r - bg[0]) > eps) return false;
        if (Math.abs(span.bg.g - bg[1]) > eps) return false;
        if (Math.abs(span.bg.b - bg[2]) > eps) return false;
      }
      return true;
    })
  );
}

/** Does any cell in the frame have bg = hex (full-row masks may land on cells outside the text)? */
function hasBgCell(frame: CapturedFrame, bgHex: string): boolean {
  const [r, g, b] = hex01(bgHex);
  const eps = 1.5 / 255;
  return frame.lines.some((line) =>
    line.spans.some(
      (span) =>
        Math.abs(span.bg.r - r) < eps &&
        Math.abs(span.bg.g - g) < eps &&
        Math.abs(span.bg.b - b) < eps
    )
  );
}

async function renderDiff(rows: readonly DiffLine[], cols: number) {
  const setup = await testRender(<DiffView rows={rows} cols={cols} />, {
    width: cols,
    height: 30,
  });
  await setup.renderOnce();
  return setup;
}

describe("diffRowText（纯函数文本形状）", () => {
  test("cols>=80：del/add 双列行号", () => {
    const rows = editRows(OLD, NEW);
    const del = rows.find((r) => r.kind === "del");
    const add = rows.find((r) => r.kind === "add");
    expect(del).toBeDefined();
    expect(add).toBeDefined();
    expect(diffRowText(del!, 80)).toMatch(
      /^\s*2\s+3\s+│\s+-two|^\s*2\s+│\s+-two/
    );
    expect(diffRowText(add!, 80)).toMatch(/2\s+│\s+\+TWO/);
  });

  test("40–79：单列行号", () => {
    const rows = editRows(OLD, NEW);
    const del = rows.find((r) => r.kind === "del");
    expect(diffRowText(del!, 60)).toMatch(/^\s*2\s+│\s+-two/);
  });

  test("cols<40：add 保留原文，del/ctx 空串", () => {
    const rows = editRows(OLD, NEW);
    const add = rows.find((r) => r.kind === "add");
    const del = rows.find((r) => r.kind === "del");
    expect(diffRowText(add!, 32)).toBe("+TWO");
    expect(diffRowText(del!, 32)).toBe("");
  });

  test("hunk 头整行保留（无行号）", () => {
    const rows = editRows(OLD, NEW);
    const hdr = rows.find((r) => r.text.startsWith("@@"));
    expect(diffRowText(hdr!, 80)).toBe(hdr!.text);
    expect(diffRowText(hdr!, 60)).toBe(hdr!.text);
  });
});

describe("DiffView 帧渲染", () => {
  test("cols=80：双列行号 + hunk 头", async () => {
    const setup = await renderDiff(editRows(OLD, NEW), 80);
    const frame = setup.captureCharFrame();
    expect(frame).toContain("@@ -1,5 +1,5 @@");
    expect(frame).toMatch(/2\s+│\s+-two/);
    expect(frame).toMatch(/2\s+│\s+\+TWO/);
    await setup.renderer.destroy();
  });

  test("cols=40：单列行号仍生效（边界含 40）", async () => {
    const setup = await renderDiff(editRows(OLD, NEW), 40);
    const frame = setup.captureCharFrame();
    expect(frame).toMatch(/2\s+│\s+-two/);
    expect(frame).toContain("@@ -1,5 +1,5 @@");
    await setup.renderer.destroy();
  });

  test("cols=32（<40）：折叠为仅 add，无行号 / 无 del / 无 hunk 头，不抛错", async () => {
    const setup = await renderDiff(editRows(OLD, NEW), 32);
    const frame = setup.captureCharFrame();
    expect(frame).toContain("+TWO");
    expect(frame).not.toContain("-two");
    expect(frame).not.toContain("@@");
    expect(frame).not.toContain("│");
    await setup.renderer.destroy();
  });

  test("纯新增（write_file）：全 add", async () => {
    const setup = await renderDiff(editRows("", "a\nb\nc\n"), 80);
    const frame = setup.captureCharFrame();
    expect(frame).toContain("+a");
    expect(frame).toContain("+b");
    expect(frame).toContain("+c");
    await setup.renderer.destroy();
  });

  test("空 diff：空帧不抛", async () => {
    const setup = await renderDiff([], 80);
    expect(setup.captureCharFrame().trim()).toBe("");
    await setup.renderer.destroy();
  });
});

describe("DiffView 着色（captureSpans）", () => {
  test("add 行 fg 绿（#2ea043）至少一条", async () => {
    const setup = await renderDiff(editRows(OLD, NEW), 80);
    const spans = setup.captureSpans();
    expect(hasSpan(spans, "+TWO", tuiPalette.add)).toBe(true);
    await setup.renderer.destroy();
  });

  test("del 行 fg 红（#d73a49）至少一条", async () => {
    const setup = await renderDiff(editRows(OLD, NEW), 80);
    const spans = setup.captureSpans();
    expect(hasSpan(spans, "-two", tuiPalette.del)).toBe(true);
    await setup.renderer.destroy();
  });

  test("add/del 整行背景遮罩（bgAdd 淡绿底 / bgDel 淡红底）", async () => {
    const setup = await renderDiff(editRows(OLD, NEW), 80);
    const spans = setup.captureSpans();
    expect(hasBgCell(spans, tuiPalette.bgAdd)).toBe(true);
    expect(hasBgCell(spans, tuiPalette.bgDel)).toBe(true);
    await setup.renderer.destroy();
  });

  test("窄终端折叠后 add 行仍上绿底", async () => {
    const setup = await renderDiff(editRows(OLD, NEW), 32);
    const spans = setup.captureSpans();
    expect(hasSpan(spans, "+TWO", tuiPalette.add)).toBe(true);
    expect(hasBgCell(spans, tuiPalette.bgAdd)).toBe(true);
    // Folded: no del line → no light-red bg.
    expect(hasBgCell(spans, tuiPalette.bgDel)).toBe(false);
    await setup.renderer.destroy();
  });

  test("ctx 行不上 add/del 色", async () => {
    const setup = await renderDiff(editRows(OLD, NEW), 80);
    const spans = setup.captureSpans();
    expect(hasSpan(spans, "one", tuiPalette.add)).toBe(false);
    expect(hasSpan(spans, "one", tuiPalette.del)).toBe(false);
    await setup.renderer.destroy();
  });
});
