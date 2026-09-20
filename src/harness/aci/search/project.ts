/**
 * Output projection.
 *
 * All three output modes share one pipeline: **sort → paginate → project**.
 * The mode decides only "what goes into the roster", never "how to slice" —
 * slicing always applies to the sorted roster (see `sort.ts`).
 *
 * The projection layer touches no fs / processes: its inputs are the raw
 * artifacts normalized from both engines.
 */

import {
  CONTEXT_GROUP_SEPARATOR,
  type ContextGroup,
  type FileCount,
  type LineHit,
} from "./types.js";
import { NO_ENTRIES_AT_OFFSET, paginate } from "./paginate.js";
import { sortCounts, sortLineHits, sortPaths } from "./sort.js";

export interface ProjectionInput {
  readonly hits: { readonly lines: ReadonlyArray<LineHit> };
  readonly offset: number;
  readonly headLimit: number;
}

/** Unique file-relative paths, one per file; counts are per file. */
export function projectPaths(input: ProjectionInput): string {
  const unique = sortPaths([...new Set(input.hits.lines.map((h) => h.path))]);
  const page = paginate(unique, input.offset, input.headLimit);
  if (page.beyondEnd) return NO_ENTRIES_AT_OFFSET;
  return page.items.join("\n");
}

/** `path:line:text`. */
export function projectContent(input: ProjectionInput): string {
  const sorted = sortLineHits(input.hits.lines);
  const page = paginate(sorted, input.offset, input.headLimit);
  if (page.beyondEnd) return NO_ENTRIES_AT_OFFSET;
  return page.items
    .map((hit) => `${hit.path}:${String(hit.line)}:${hit.text}`)
    .join("\n");
}

/**
 * `path:count` lines plus the corpus-wide `total:` line.
 *
 * `total` counts the hits **before** slicing — it answers "how many hits does
 * this query have in total", not "how many are on this page". Pagination and
 * the total therefore never interfere with each other.
 */
export function projectCount(input: ProjectionInput): string {
  const lines = input.hits.lines;
  if (lines.length === 0) return "";
  const total = lines.length;
  const counts = new Map<string, number>();
  for (const hit of lines) {
    counts.set(hit.path, (counts.get(hit.path) ?? 0) + 1);
  }
  const files = sortPaths([...counts.keys()]);
  const page = paginate(files, input.offset, input.headLimit);
  if (page.beyondEnd) return NO_ENTRIES_AT_OFFSET;
  return [
    ...page.items.map((path) => `${path}:${String(counts.get(path) ?? 0)}`),
    `total:${String(total)}`,
  ].join("\n");
}

/** Project engine-per-file counts directly (the rg `--count` path; total is still computed pre-slice). */
export function projectCounts(
  counts: ReadonlyArray<FileCount>,
  offset: number,
  headLimit: number
): string {
  const total = counts.reduce((sum, c) => sum + c.count, 0);
  if (counts.length === 0) return "";
  const sorted = sortCounts(counts);
  const page = paginate(sorted, offset, headLimit);
  if (page.beyondEnd) return NO_ENTRIES_AT_OFFSET;
  return [
    ...page.items.map((c) => `${c.path}:${String(c.count)}`),
    `total:${String(total)}`,
  ].join("\n");
}

/** Project the engine's path list directly (the rg `-l` path). */
export function projectPathList(
  paths: ReadonlyArray<string>,
  offset: number,
  headLimit: number
): string {
  if (paths.length === 0) return "";
  const sorted = sortPaths([...new Set(paths)]);
  const page = paginate(sorted, offset, headLimit);
  if (page.beyondEnd) return NO_ENTRIES_AT_OFFSET;
  return page.items.join("\n");
}

/**
 * Render the group sequence for `content + context` output.
 *
 * Match lines are `path:line:text`; context lines are `path:line-text`; groups
 * are separated by `--`.
 *
 * Why context lines use `path:line-text` and **not** `path-line-text`: with
 * the latter, anything is allowed between the path and the line number, so a
 * context line whose content contains a colon would look like
 * `a.ts-1-see x:9:fake` — any consumer that decides "match line" by
 * `^[^:]*:\d+:` (a human or a downstream parser) would read that as a real
 * hit, and the "no fake lines" guarantee of context output would break.
 * Framing path and line number with the same separator (the `path:line`
 * prefix) leaves exactly **one** character after the line number to tell
 * truth from fiction (`:` = match, `-` = context), which is the same
 * disambiguation position rg itself uses in `--null -C N` output (there it is
 * `path\0line:text` / `path\0line-text` after the `\0`). No matter what the
 * content contains, a context line can never be split into a
 * `path:integer:text` triple.
 */
export function projectContext(groups: ReadonlyArray<ContextGroup>): string {
  if (groups.length === 0) return "";
  const blocks = groups.map((group) =>
    group.entries
      .map(
        (entry) =>
          `${entry.path}:${String(entry.line)}${entry.isMatch ? ":" : "-"}${entry.text}`
      )
      .join("\n")
  );
  return blocks.join(`\n${CONTEXT_GROUP_SEPARATOR}\n`);
}
