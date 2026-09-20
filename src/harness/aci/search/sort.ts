/**
 * Stable sorting: (path, then line) ordering happens **before** slicing.
 *
 * Neither engine's raw order can be relied on: rg's parallel walk order varies
 * with thread scheduling, and the Node scan's `readdir` order varies with the
 * filesystem. Pagination requires "the same query called twice sees the same
 * page", so sorting must be a prerequisite of slicing, not a display-layer
 * garnish.
 */

import type { ContextGroup, LineHit } from "./types.js";

/**
 * Sort ascending by (path, line); equal keys keep input relative order
 * (Array#sort has been stable since ES2019). Path comparison uses code-unit
 * order — same convention as rg's `--sort path` lexicographic order, and it
 * does not vary with locale.
 */
export function sortLineHits(hits: ReadonlyArray<LineHit>): LineHit[] {
  return [...hits].sort((a, b) => {
    if (a.path !== b.path) return a.path < b.path ? -1 : 1;
    return a.line - b.line;
  });
}

/** Path-list sorting (shared by the paths / count outputs; counts render as `path:count` in this order). */
export function sortPaths(paths: ReadonlyArray<string>): string[] {
  return [...paths].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * Context-group sorting (the pagination roster for `content + context`).
 *
 * The pagination unit is the **group**, so groups must be sorted before
 * slicing — neither engine's group order can be relied on: rg emits groups in
 * parallel-walk order, Node builds them in `readdir` order. Slicing without
 * sorting would land the same `offset` on different groups across two calls,
 * breaking the guarantee that `offset=0,head_limit=50` and `offset=50` never
 * overlap.
 *
 * Groups are compared by the (path, line) of their **first** entry: entries
 * inside a group necessarily share a file with increasing line numbers, so the
 * first entry is the group's position in the global roster.
 */
export function sortContextGroups(
  groups: ReadonlyArray<ContextGroup>
): ContextGroup[] {
  return [...groups].sort((a, b) => {
    const left = a.entries[0];
    const right = b.entries[0];
    if (left === undefined || right === undefined) return 0;
    if (left.path !== right.path) return left.path < right.path ? -1 : 1;
    return left.line - right.line;
  });
}

/** Per-file count sorting (the rg `--count` direct-output path; counts never enter the comparison, only paths). */
export function sortCounts(
  counts: ReadonlyArray<{ readonly path: string; readonly count: number }>
): Array<{ readonly path: string; readonly count: number }> {
  return [...counts].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0
  );
}
