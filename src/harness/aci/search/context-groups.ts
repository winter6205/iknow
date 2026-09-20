/**
 * **Group construction** for `content + context` (the "nearby lines"
 * responsibility).
 *
 * Why this layer (instead of passing rg stdout through):
 *   with rg `-C N`, `:` and `-` mix within one record and bare `--` sits
 *   between groups. To the model that text is just a pile of lines — context
 *   line `a.ts-4-line4` differs from match line `a.ts:4:hit` by one character,
 *   so context lines are easily misread as hits. Context lines and `--` must
 *   not be cut into fake `path:line:text`, hence this layer produces
 *   **explicit groups + an isMatch flag per entry**, leaving rendering to
 *   `project.ts`.
 *
 * Single-shape design: the rg path feeds parsed groups in, the Node path
 * builds the same groups from "hit line ± context" — both engines yield
 * identical shapes, so the projection layer need not know who computed them.
 */

import {
  isRgBinaryNotice,
  truncateMatchContent,
  truncateRgContent,
} from "./rg-output.js";
import {
  CONTEXT_GROUP_SEPARATOR,
  type ContextEntry,
  type ContextGroup,
  type LineHit,
} from "./types.js";

export interface ContextBuildInput {
  /** Hit lines (already sorted by (path, line)). */
  readonly matches: ReadonlyArray<LineHit>;
  /** Symmetric context radius (content mode; this layer is called only when >0). */
  readonly context: number;
  /** Workspace-relative path → full-text lines; unreadable → null. */
  readonly readLines: (path: string) => Promise<ReadonlyArray<string> | null>;
}

/**
 * Build context groups from hit lines.
 *
 * Grouping rule follows rg's `--` semantics: **adjacent or overlapping
 * context windows merge into one group**. Windows `[line-N, line+N]` touch
 * (or overlap) → same group, otherwise a new group starts. At file edges the
 * window is clamped to `[1, lineCount]`.
 */
export async function buildContextGroups(
  input: ContextBuildInput
): Promise<ContextGroup[]> {
  const byPath = groupByPath(input.matches);
  const groups: ContextGroup[] = [];
  for (const [path, hits] of byPath) {
    const lines = await input.readLines(path);
    if (lines === null) continue;
    groups.push(...groupsForFile(path, hits, lines, input.context));
  }
  return groups;
}

/** Collect same-file hits into one batch (sorting keeps same paths contiguous, but grouping by path is more robust). */
function groupByPath(matches: ReadonlyArray<LineHit>): Map<string, LineHit[]> {
  const byPath = new Map<string, LineHit[]>();
  for (const hit of matches) {
    const bucket = byPath.get(hit.path);
    if (bucket === undefined) byPath.set(hit.path, [hit]);
    else bucket.push(hit);
  }
  return byPath;
}

/**
 * The group sequence for a single file.
 *
 * Window-touching test: "this hit window's lower bound <= previous window's
 * upper bound + 1": touching merges (no skipped lines in between), otherwise a
 * new group starts (rendered with `--`).
 */
function groupsForFile(
  path: string,
  hits: ReadonlyArray<LineHit>,
  lines: ReadonlyArray<string>,
  context: number
): ContextGroup[] {
  // The set of hit lines (not "the current one"): when a later hit falls into
  // an earlier hit's window, it must still be emitted with `:` (rg behavior —
  // after windows merge, every hit line inside the group is a match line).
  const matchLines = new Set(hits.map((hit) => hit.line));
  const groups: ContextGroup[] = [];
  let current: ContextEntry[] = [];
  let windowEnd = -1;

  for (const hit of hits) {
    const from = Math.max(1, hit.line - context);
    const to = Math.min(lines.length, hit.line + context);
    if (from > windowEnd + 1 && current.length > 0) {
      groups.push({ entries: current });
      current = [];
    }
    const emitFrom = Math.max(from, windowEnd + 1);
    for (let line = emitFrom; line <= to; line++) {
      current.push(
        entryFor(path, line, lines[line - 1] ?? "", matchLines.has(line))
      );
    }
    windowEnd = Math.max(windowEnd, to);
  }
  if (current.length > 0) groups.push({ entries: current });
  return groups;
}

/**
 * Every entry in a group passes the same line-width gate (match lines and
 * context lines are **treated alike**).
 *
 * rg's `--max-columns-preview` applies to both kinds (verified: a 5000-char
 * context line is also cut to 2000 plus its own elision marker); if Node only
 * cut match lines, the same query would differ in bytes between engines.
 */
function entryFor(
  path: string,
  line: number,
  text: string,
  isMatch: boolean
): ContextEntry {
  return { path, line, text: truncateMatchContent(text), isMatch };
}

/**
 * Parse rg `--null -C N` stdout into groups (the rg engine path).
 *
 * The separator lines rg inserts are the group boundaries; we trust them and
 * do not re-derive from line numbers — if rg's merge threshold differs subtly
 * from the Node path's implementation above, adopting rg's boundaries directly
 * is steadier than "guessing how it grouped". Malformed records are skipped
 * entirely (no guessing, no fake hits).
 */
export function parseRgContextStdout(stdout: string): ContextGroup[] {
  const groups: ContextGroup[] = [];
  let current: ContextEntry[] = [];
  const flush = (): void => {
    if (current.length > 0) {
      groups.push({ entries: current });
      current = [];
    }
  };
  for (const record of stdout.split("\n")) {
    if (record.length === 0) continue;
    if (isGroupSeparator(record)) {
      flush();
      continue;
    }
    // The binary notice line is shaped like `path:line:text` (`path: binary
    // file matches (...)`), so the shape test must run before column
    // splitting — otherwise it parses as a fake `isMatch` hit (see
    // `rg-output.isRgBinaryNotice`). The check lives in the loop (not inside
    // `parseContextRecord`), so the splitting function's branch count does not
    // grow because of this defense.
    if (isRgBinaryNotice(record)) continue;
    const entry = parseContextRecord(record);
    if (entry === undefined) continue;
    current.push(entry);
  }
  flush();
  return groups;
}

/**
 * Group-separator test.
 *
 * Under `--null`, rg wraps the separator with NUL (empty path segment);
 * without `--null` it is a bare `--` — both shapes are accepted, and the test
 * lives in exactly one place.
 */
function isGroupSeparator(record: string): boolean {
  return record.split("\0").join("").trim() === CONTEXT_GROUP_SEPARATOR;
}

function parseContextRecord(record: string): ContextEntry | undefined {
  const nulIdx = record.indexOf("\0");
  if (nulIdx === -1) return undefined;
  const path = stripDotSlash(record.slice(0, nulIdx));
  const rest = record.slice(nulIdx + 1);
  // The line number is the leading decimal segment, followed by a one-char
  // separator (`:` match / `-` context). Scan digits first, then test the
  // separator — so `:` / `-` inside content never participate in splitting
  // (the key point).
  let i = 0;
  while (i < rest.length && rest[i]! >= "0" && rest[i]! <= "9") i += 1;
  if (i === 0) return undefined;
  const sep = rest[i];
  if (sep !== ":" && sep !== "-") return undefined;
  const line = Number(rest.slice(0, i));
  if (!Number.isInteger(line) || line < 1) return undefined;
  // rg-path-only entry: first wash transport-layer artifacts (trailing `\r` +
  // rg's own elision marker), then the shared display gate. **Pass the content
  // verbatim**; do not strip `\r` at the call site — that byte counts toward
  // rg's oversize trigger base (see `rg-output.truncateRgContent`).
  return {
    path,
    line,
    text: truncateRgContent(rest.slice(i + 1)),
    isMatch: sep === ":",
  };
}

function stripDotSlash(path: string): string {
  return path.startsWith("./") ? path.slice(2) : path;
}
