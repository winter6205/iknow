/** @jsxImportSource @opentui/react */
/**
 * tests/tui/notice-geometry.test.tsx
 *
 * Notice-lane row geometry. The lane sits between the transcript viewport and
 * the permission-mode row, so its height is subtracted from the row account:
 * book too few rows and the column asks for more rows than the terminal owns —
 * every bottom-chrome box has no explicit height and flexShrink=1, so Yoga
 * squeezes the input box, the ContextBar and the location line onto shared rows
 * and the notice paints over the prompt; book too many and the transcript stays
 * pinned to its floor while the extra rows go unclaimed.
 *
 * Both directions are pinned against the two surfaces the renderer produces —
 * the Yoga renderable tree (node y / height / lineCount / wrapMode) and the
 * captured char frame (row indices) — driven by the real `/help` notice at the
 * shapes that used to break: 56x44 (copy wider than the lane, rows to spare),
 * 56x40 (same copy, one row short of the fold), 56x24 and 80x14 (the notice has
 * to fold itself away). 56 columns is where the double-width merge class shows:
 * a painted row that fills the last column with a wide glyph spills the next row
 * onto its own frame row, so the fold keeps that cell free.
 */
import { describe, expect, test } from "bun:test";
import stringWidth from "string-width";
import { testRender } from "@opentui/react/test-utils";
import type { TestRendererSetup } from "@opentui/core/testing";
import { TuiHarness } from "./_fixtures.js";
import {
  BOTTOM_MARGIN_ROWS,
  chromeReserveRows,
  endsOnWideGlyphInLastCell,
  noticeClippedLines,
  noticeLaneBodyRows,
  noticePhysicalLines,
} from "../../src/tui/app.js";
import { helpLines } from "../../src/tui/slash.js";
import { sessionLocationLines } from "../../src/tui/environment-pane.js";

type AnyNode = Record<string, any>;

/** Collapse marker the lane paints in place of the clipped tail. */
const COLLAPSE_MARKER = /^… \+\d+$/;

function kids(node: AnyNode): AnyNode[] {
  return (node.getChildren?.() ?? node.children ?? []) as AnyNode[];
}

/**
 * The notice lane is the only box whose children are all text rows taken from
 * the shared fold (or the collapse marker that replaces the clipped tail).
 */
function findNoticeLane(root: AnyNode, folded: ReadonlyArray<string>): AnyNode {
  const stack: AnyNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop() as AnyNode;
    const children = kids(node);
    if (
      children.length > 0 &&
      children.every((c) => c.constructor?.name === "TextRenderable") &&
      children.some(
        (c) =>
          c.plainText === folded[0] || COLLAPSE_MARKER.test(String(c.plainText))
      )
    ) {
      return node;
    }
    stack.push(...children);
  }
  throw new Error("notice lane not found in the renderable tree");
}

/** Captured frame as terminal rows: drop the buffer's trailing empty line. */
function frameRows(frame: string): string[] {
  const raw = frame.split("\n");
  return (raw[raw.length - 1] === "" ? raw.slice(0, -1) : raw).map((l) =>
    l.trimEnd()
  );
}

function rowIndex(lines: string[], needle: string): number {
  return lines.findIndex((l) => l.includes(needle));
}

/** Intact input box = 3 rows between the mode line and the ctx line. */
function inputRowCount(lines: string[]): number {
  const modeIdx = rowIndex(lines, "mode: Default");
  const ctxIdx = rowIndex(lines, "ctx ");
  if (modeIdx < 0 || ctxIdx < 0) return -1;
  return ctxIdx - modeIdx - 1;
}

function laneTexts(lane: AnyNode): string[] {
  return kids(lane).map((c) => String(c.plainText));
}

/** Pump one render loop: mockInput bytes parse through stdin asynchronously. */
async function pump(setup: TestRendererSetup, times: number): Promise<void> {
  for (let i = 0; i < times; i++) {
    await new Promise((r) => setTimeout(r, 50));
    await setup.renderOnce();
  }
}

interface NoticeFrame {
  readonly lines: string[];
  readonly lane: AnyNode;
  readonly texts: string[];
  readonly folded: ReadonlyArray<string>;
}

/** Mount the app, submit `/help`, read the lane off the tree and the frame. */
async function mountHelp(width: number, height: number): Promise<NoticeFrame> {
  const setup = await testRender(<TuiHarness />, {
    width,
    height,
    exitOnCtrlC: false,
    consoleMode: "disabled",
  });
  try {
    await new Promise((r) => setTimeout(r, 400));
    await setup.waitForVisualIdle();
    // A leftover keystroke would submit a plain message instead of a command.
    setup.mockInput.pressKey("x");
    await pump(setup, 1);
    for (let i = 0; i < 5; i++) {
      setup.mockInput.pressBackspace();
      await pump(setup, 1);
    }
    for (const ch of "/help") {
      setup.mockInput.pressKey(ch);
      await pump(setup, 1);
    }
    setup.mockInput.pressEnter();
    const folded = noticePhysicalLines(helpLines(), width);
    const start = Date.now();
    let lane: AnyNode | undefined;
    while (!lane && Date.now() - start < 8000) {
      await pump(setup, 2);
      try {
        lane = findNoticeLane(
          setup.renderer.root as unknown as AnyNode,
          folded
        );
      } catch {
        lane = undefined;
      }
    }
    if (!lane)
      throw new Error(`/help notice never reached the renderable tree`);
    return {
      lines: frameRows(setup.captureCharFrame()),
      lane,
      texts: laneTexts(lane),
      folded,
    };
  } finally {
    if (!setup.renderer.isDestroyed) setup.renderer.destroy();
  }
}

/** Chrome geometry that must hold whatever the lane does. */
function expectChromeIntact(
  lines: string[],
  width: number,
  height: number
): number {
  expect(lines.length).toBe(height);
  const promptIdx = rowIndex(lines, "❯");
  expect(promptIdx).toBe(height - 5);
  expect(inputRowCount(lines)).toBe(3);
  const modeIdx = rowIndex(lines, "mode: Default");
  const ctxIdx = rowIndex(lines, "ctx ");
  const locationText = sessionLocationLines({
    projectRoot: "/tmp/proj",
    cols: width,
  })[0]?.text;
  const locIdx = lines.findIndex(
    (l, i) => i > ctxIdx && l.trim() === locationText?.trim()
  );
  // mode → prompt → ctx → location each own their row, in order.
  expect(modeIdx).toBe(promptIdx - 2);
  expect(ctxIdx).toBe(promptIdx + 2);
  expect(locIdx).toBe(ctxIdx + 1);
  expect(height - 1 - locIdx).toBe(BOTTOM_MARGIN_ROWS);
  return modeIdx;
}

describe("notice lane row account (pure)", () => {
  test("fold keeps the last cell off wide glyphs, one entry per painted row", () => {
    const folded = noticePhysicalLines(helpLines(), 56);
    // The copy is wider than the terminal: 21 logical lines become more rows,
    // and every entry is a row the lane can paint as-is (no border, no
    // padding), so nothing re-wraps or clips once it is on screen.
    expect(folded.length).toBeGreaterThan(helpLines().length);
    for (const entry of folded) {
      expect(stringWidth(entry)).toBeLessThanOrEqual(56);
      // The merge class is asserted with the production predicate, so a wrong
      // predicate cannot pass on both sides.
      expect(endsOnWideGlyphInLastCell(entry, 56)).toBe(false);
    }
    // Full-width copy that would close on the last column is the only copy that
    // pays the one-cell margin: 28 `中` (string-width 56) folds to a 54-column
    // head plus the glyph it had to move down.
    expect(noticePhysicalLines(["中".repeat(28)], 56)).toEqual([
      "中".repeat(27),
      "中",
    ]);
    // A row the terminal fits exactly but a single-width glyph closes keeps its
    // one row: the last cell is occupied by that glyph, not by a wide half. This
    // is the shape the /thinking write-back notice has at 80 columns.
    expect(noticePhysicalLines(["x".repeat(80)], 80)).toEqual(["x".repeat(80)]);
    expect(noticePhysicalLines(["x".repeat(81)], 80)).toEqual([
      "x".repeat(80),
      "x",
    ]);
    expect(noticePhysicalLines(["x".repeat(79)], 80)).toEqual(["x".repeat(79)]);
  });

  test("empty notice paints nothing; a notice that fits stays verbatim", () => {
    expect(noticePhysicalLines(undefined, 80)).toEqual([]);
    expect(noticePhysicalLines([], 80)).toEqual([]);
    // A notice that fits its lane stays verbatim: no marker, no re-wrap — a
    // one-line notice must never become two rows.
    expect(noticePhysicalLines(["一行短提示"], 80)).toEqual(["一行短提示"]);
    expect(noticeClippedLines(["一行短提示"], 20)).toEqual(["一行短提示"]);
  });

  test("lane body rows: terminal minus the rest of the chrome, minus floors", () => {
    // Minimal booked chrome without a notice (chrome-budget pins this 6).
    const chrome = chromeReserveRows({
      noticeRows: 0,
      inputHintRows: 0,
      bgLine: false,
      inputRows: 1,
    });
    expect(chrome).toBe(6);
    // The lane never takes the transcript floor (5) or its own margin row (1).
    const reserved = chrome + 5 + 1;
    expect(noticeLaneBodyRows(chrome, 40)).toBe(40 - reserved);
    expect(noticeLaneBodyRows(chrome, 14)).toBe(14 - reserved);
    // Never negative, however little the terminal has.
    expect(noticeLaneBodyRows(chrome, reserved)).toBe(0);
    expect(noticeLaneBodyRows(chrome, 10)).toBe(0);
    expect(noticeLaneBodyRows(20, 10)).toBe(0);
  });

  test("clip keeps the head, replaces the tail with `… +N`, never exceeds the lane", () => {
    const folded = ["a", "b", "c", "d", "e", "f"];
    expect(noticeClippedLines(folded, 6)).toEqual(folded);
    expect(noticeClippedLines(folded, 1)).toEqual(["… +6"]);
    expect(noticeClippedLines(folded, 0)).toEqual([]);
    expect(noticeClippedLines(folded, -3)).toEqual([]);
    const clipped = noticeClippedLines(folded, 3);
    expect(clipped).toEqual(["a", "b", "… +4"]);
    for (const body of [0, 1, 2, 3, 6, 9]) {
      expect(noticeClippedLines(folded, body).length).toBeLessThanOrEqual(body);
    }
  });

  test("the 56-column /help fold needs more rows than a 40-row lane has", () => {
    // Ledger arithmetic the frame cases below read: the app books 7 chrome rows
    // without a notice (margin 1 + mode 1 + input 1 + 2 borders + ctx 1 +
    // session location 1), so a 40-row terminal leaves 40-7-5-1 = 27 lane rows.
    const bodyRows = noticeLaneBodyRows(7, 40);
    expect(bodyRows).toBe(27);
    const folded = noticePhysicalLines(helpLines(), 56);
    // 30 since ADR-0141: the `/yolo` row grew to name all three declared axes,
    // and at 56 columns that wraps onto a second physical row.
    expect(folded.length).toBe(30);
    expect(noticeClippedLines(folded, bodyRows).length).toBe(bodyRows);
    // A 44-row terminal leaves 31 ≥ 30, which is where the unclipped lane is pinned.
    expect(noticeLaneBodyRows(7, 44)).toBe(31);
    expect(noticeClippedLines(folded, 31)).toEqual(folded);
  });
});

/**
 * The lane box is exactly as tall as the rows it holds, each row is one
 * unwrapped line, and every one of them lands on its own frame row without
 * being clipped by the terminal.
 */
function expectRowsPainted(
  lines: string[],
  lane: AnyNode,
  texts: string[],
  width: number
): void {
  expect(lane.height).toBe(texts.length);
  for (const child of kids(lane)) {
    expect(child.height).toBe(1);
    expect(child.lineCount).toBe(1);
    expect(child.wrapMode).toBe("none");
  }
  for (let i = 0; i < texts.length; i++) {
    const row = lines[lane.y + i];
    // Row equality is the merge check: a frame row carrying the next booked row
    // as a suffix (the double-width spill class) never equals one entry.
    expect(row.trim()).toBe(texts[i].trim());
    expect(stringWidth(row)).toBeLessThanOrEqual(width);
  }
}

describe("notice lane geometry in the rendered frame", () => {
  test("56x44 (narrow copy, room to spare): the whole fold is painted verbatim", async () => {
    const { lines, lane, texts, folded } = await mountHelp(56, 44);
    // The lane owns 31 of the 44 rows and the fold is 29, so every folded row
    // is painted as-is and no collapse marker appears.
    expect(texts).toEqual([...folded]);
    expect(texts.some((t) => COLLAPSE_MARKER.test(t))).toBe(false);
    expectRowsPainted(lines, lane, texts, 56);
    const modeIdx = expectChromeIntact(lines, 56, 44);
    expect(lane.y + lane.height + 1).toBe(modeIdx);
    // Spare rows go to the transcript, not to unclaimed lane padding:
    // 44 - 7 booked chrome - 30 notice - 1 lane margin = 6 viewport rows.
    expect(lane.y).toBe(6);
    expect(lines.slice(modeIdx).every((l) => !l.includes("/sessions"))).toBe(
      true
    );
  }, 90_000);

  test("56x40 (narrow copy): every booked row is painted, chrome keeps its rows", async () => {
    const { lines, lane, texts, folded } = await mountHelp(56, 40);
    // 40 rows leave the lane 27 (40 - 7 booked chrome - 5 transcript floor - 1
    // lane margin) and the safety-margin fold needs 30, so the tail must fold
    // into a count: booking the raw 30 would ask the terminal for rows it does
    // not have and Yoga would squeeze the bottom chrome under the notice.
    expect(folded.length).toBe(30);
    expect(texts.length).toBe(27);
    expect(texts.slice(0, -1)).toEqual(folded.slice(0, 26));
    expect(texts[26]).toBe("… +4");
    expectRowsPainted(lines, lane, texts, 56);
    const modeIdx = expectChromeIntact(lines, 56, 40);
    expect(lane.y + lane.height + 1).toBe(modeIdx);
    expect(lane.y).toBe(5);
    expect(lines.slice(modeIdx).every((l) => !l.includes("/sessions"))).toBe(
      true
    );
  }, 90_000);

  test("56x24 (narrow copy, short terminal): the tail folds into a count", async () => {
    const { lines, lane, texts, folded } = await mountHelp(56, 24);
    // Painted rows are the head of the same array the ledger books, so the
    // clipped copy stays accounted for instead of vanishing off the frame.
    expect(folded.length).toBe(30);
    expect(texts.length).toBe(11);
    expect(texts.slice(0, -1)).toEqual(folded.slice(0, texts.length - 1));
    expect(texts[texts.length - 1]).toBe(
      `… +${folded.length - texts.length + 1}`
    );
    expectRowsPainted(lines, lane, texts, 56);
    const modeIdx = expectChromeIntact(lines, 56, 24);
    expect(lane.y + lane.height + 1).toBe(modeIdx);
    // The notice claimed every spare row, so the transcript sits on its floor.
    expect(lane.y).toBe(5);
    expect(lines.slice(modeIdx).every((l) => !l.includes("/sessions"))).toBe(
      true
    );
  }, 90_000);

  test("80x14 (normal width, short terminal): the notice folds away instead of crushing the chrome", async () => {
    const { lines, lane, texts, folded } = await mountHelp(80, 14);
    // One lane row is all the account leaves, and it carries the count.
    expect(texts).toEqual([`… +${folded.length}`]);
    expectRowsPainted(lines, lane, texts, 80);
    const modeIdx = expectChromeIntact(lines, 80, 14);
    expect(lane.y + lane.height + 1).toBe(modeIdx);
    expect(lane.y).toBe(5);
    expect(lines.slice(modeIdx).every((l) => !l.includes("/sessions"))).toBe(
      true
    );
  }, 90_000);
});
