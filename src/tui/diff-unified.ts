/**
 * Pure unified-diff functions (jsdiff): turn old/new text into per-line
 * `DiffLine[]`. The TUI red/green diff preview (diff-view.tsx) only renders,
 * never computes.
 *
 * Contract (aligned with `git diff --unified=3`, verified isomorphic):
 *  - line text carries the unified-diff prefix: `ctx` → leading space,
 *    `del` → `-`, `add` → `+`;
 *  - hunk header `@@ -A,B +C,D @@` (first line of each hunk, kind `ctx`,
 *    no line numbers) — it anchors `oldNo`/`newNo` start (diff-view builds
 *    the line-number columns from it);
 *  - `oldNo` increments on `del`/`ctx` lines, `newNo` on `add`/`ctx` lines;
 *    each hunk restarts independently from its oldStart/newStart;
 *  - the missing-newline marker `\ No newline at end of file` is kept as a `ctx` line;
 *  - both inputs empty → empty array; one side empty → a single pure-add / pure-del hunk.
 *
 * Error contract: any jsdiff exception is wrapped into the typed `DiffError`
 * (with `code`); raw Error never leaks — the render layer classifies via
 * instanceof, never touches stack text.
 */
import { structuredPatch } from "diff";

export type DiffRowKind = "add" | "del" | "ctx";

export interface DiffLine {
  readonly kind: DiffRowKind;
  readonly oldNo?: number;
  readonly newNo?: number;
  readonly text: string;
}

/** Typed error thrown on jsdiff failure: `code` lets callers classify programmatically. */
export class DiffError extends Error {
  constructor(
    message: string,
    readonly code?: string
  ) {
    super(message);
    this.name = "DiffError";
  }
}

/** Hunk header line (`@@ -A,B +C,D @@`): has kind / no line numbers; line-number counting starts here. */
function hunkHeaderText(
  oldStart: number,
  oldLines: number,
  newStart: number,
  newLines: number
): string {
  return `@@ -${oldStart},${oldLines} +${newStart},${newLines} @@`;
}

/**
 * old/new text → per-line unified diff. `cols` is kept for the render layer
 * (narrow-terminal folding); this layer is a pure function independent of
 * terminal width — the parameter is ignored.
 *
 * Empty-input contract: both empty → `[]`; one side empty → a single
 * pure-add / pure-del hunk.
 *
 * @throws {DiffError} on jsdiff internal failure (code `JS_DIFF_FAILED`).
 */
export function computeDiff(
  _filePath: string,
  oldContent: string,
  newContent: string,
  _cols?: number
): readonly DiffLine[] {
  if (oldContent === "" && newContent === "") return [];

  let patch;
  try {
    patch = structuredPatch(
      _filePath,
      _filePath,
      oldContent,
      newContent,
      "",
      "",
      { context: 3 }
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new DiffError(`jsdiff failed: ${msg}`, "JS_DIFF_FAILED");
  }

  const rows: DiffLine[] = [];
  for (const hunk of patch.hunks) {
    rows.push({
      kind: "ctx",
      text: hunkHeaderText(
        hunk.oldStart,
        hunk.oldLines,
        hunk.newStart,
        hunk.newLines
      ),
    });
    // Line numbers restart at the hunk start, independent of the previous hunk (unified-diff semantics).
    let oldNo = hunk.oldStart;
    let newNo = hunk.newStart;
    for (const line of hunk.lines) {
      if (line.length > 0 && line[0] === "-") {
        rows.push({ kind: "del", oldNo, text: line });
        oldNo += 1;
      } else if (line.length > 0 && line[0] === "+") {
        rows.push({ kind: "add", newNo, text: line });
        newNo += 1;
      } else {
        // ctx (leading space) and the `\ No newline at end of file` marker both count as ctx.
        rows.push({ kind: "ctx", oldNo, newNo, text: line });
        if (line.startsWith(" ")) {
          oldNo += 1;
          newNo += 1;
        }
      }
    }
  }
  return rows;
}
