/** @jsxImportSource @opentui/react */
/**
 * Unified-diff renderer (ink → OpenTUI port): renders `DiffLine[]` from
 * `computeDiff` (diff-unified.ts) into a red/green diff preview sized to the
 * terminal width. Render only, no algorithms.
 *
 * Width tiers (line numbers + color):
 *  - cols >= 80: two line-number columns (oldNo | newNo) + red/green;
 *  - 40 <= cols < 80: single column (oldNo preferred, │ separated) + red/green;
 *  - cols < 40: fold to `add` lines only (no line numbers, no del / hunk
 *    headers) — narrow-terminal degradation, no throw, no overflow.
 *
 * Line text (DiffLine.text) already carries the unified-diff prefix
 * (` ` / `-` / `+`); this layer only lays out number columns + color. Hunk
 * headers (`@@ -A,B +C,D @@`, kind ctx) have no line numbers and render dim
 * across the full row.
 *
 * Coloring (OpenTUI): add/del rows get semantic fg + the outer
 * `<box width={cols}>` paints a full-row backgroundColor mask (bgAdd/bgDel);
 * tests/tui/diff-view.test.tsx samples real fg/bg RGBA via captureSpans (the
 * coloring contract that the archived ink-era tests skipped).
 */
import type { ReactNode } from "react";
import type { DiffLine } from "./diff-unified.js";
import { tuiPalette } from "./theme.js";

function pad3(n: number | undefined): string {
  return n === undefined ? "   " : String(n).padStart(3);
}

/** Hunk-header detection (ctx lines starting with `@@`). */
function isHunkHeader(line: DiffLine): boolean {
  return line.kind === "ctx" && line.text.startsWith("@@");
}

/** Single-row render string (pure function; tests assert the text shape directly). */
export function diffRowText(line: DiffLine, cols: number): string {
  // Narrow-terminal degradation: add lines only, no line numbers.
  if (cols < 40) return line.kind === "add" ? line.text : "";
  if (isHunkHeader(line)) return line.text;
  if (line.kind === "ctx") return line.text;
  if (cols >= 80) {
    const old = pad3(line.oldNo);
    const nw = pad3(line.newNo);
    return `${old} ${nw} │ ${line.text}`;
  }
  // Single column: oldNo preferred, del/add fall back to newNo.
  const n = line.oldNo ?? line.newNo;
  const num = n === undefined ? "   " : String(n).padStart(3);
  return `${num} │ ${line.text}`;
}

/**
 * DiffLine[] → visible flat text lines (folded by cols; empty texts dropped).
 *
 * Row-accounting SSOT: both `liveToolPreviewRows` (live tail row-account
 * prediction) and `<DiffView>` rendering go through `diffRowText`'s single
 * set of col-folding rules — folding logic converges here only, no inline
 * forks (row-account parity).
 */
export function diffRowTexts(
  rows: readonly DiffLine[],
  cols: number
): string[] {
  return rows.map((r) => diffRowText(r, cols)).filter((t) => t !== "");
}

/**
 * Full-row background mask color for one line (by kind + hunk header).
 *
 * Applies to the JSX render layer only: add/del return a light background,
 * ctx / hunk headers return undefined (transparent). **Not** routed through
 * the diffRowText / diffRowTexts text projection (that is the row-account
 * SSOT, must never change). Effective at any terminal width: when narrow
 * terminals fold to add-only rows, add rows still get the green background.
 */
function rowBgColor(line: DiffLine): string | undefined {
  if (isHunkHeader(line)) return undefined;
  switch (line.kind) {
    case "add":
      return tuiPalette.bgAdd;
    case "del":
      return tuiPalette.bgDel;
    default:
      return undefined;
  }
}

/** Single-line color (by kind + hunk header). */
function rowColor(line: DiffLine): string {
  if (isHunkHeader(line)) return tuiPalette.dim;
  switch (line.kind) {
    case "add":
      return tuiPalette.add;
    case "del":
      return tuiPalette.del;
    default:
      return tuiPalette.dim;
  }
}

/** One diff row: empty text → occupies no line; otherwise a full-width box
 *  (mask spans cols) + text (wrapMode none = over-wide truncates without
 *  folding, 1 row in the line accounting). */
export function DiffRow(props: {
  readonly line: DiffLine;
  readonly cols: number;
}): ReactNode {
  const text = diffRowText(props.line, props.cols);
  if (text === "") return null;
  const bg = rowBgColor(props.line);
  return (
    <box
      width={props.cols}
      overflow="hidden"
      {...(bg === undefined ? {} : { backgroundColor: bg })}
    >
      <text fg={rowColor(props.line)} wrapMode="none">
        {text}
      </text>
    </box>
  );
}

/** Narrow-terminal fold: keep add lines only (no line numbers, no hunk headers). */
function foldNarrow(rows: readonly DiffLine[]): readonly DiffLine[] {
  return rows.filter((r) => r.kind === "add");
}

/** Diff preview container: renders the row list per cols tier. */
export function DiffView(props: {
  readonly rows: readonly DiffLine[];
  readonly cols: number;
}): ReactNode {
  const rows = props.cols < 40 ? foldNarrow(props.rows) : props.rows;
  return (
    <box flexDirection="column">
      {rows.map((line, i) => (
        <DiffRow key={i} line={line} cols={props.cols} />
      ))}
    </box>
  );
}
