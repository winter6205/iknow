/**
 * Shared types for the grep search surface.
 *
 * This module declares shapes only, no behaviour — behaviour lives in
 * options / argv / rg-output / node-scan / sort / paginate / project.
 */

/** Output mode; the default is "paths". */
export type GrepOutput = "paths" | "content" | "count";

/** Normalised parameters of one query (product of flag parsing, shared by every handler path). */
export interface QuerySpec {
  readonly pattern: string;
  /** Second term of the query (drives the line-window filter); absent = no line-window filtering. */
  readonly also?: string;
  /** Symmetric line-window radius when `also` is present (default 5). */
  readonly withinLines: number;
  readonly ignoreCase: boolean;
  readonly output: GrepOutput;
  /** Symmetric context lines for the `content` output; 0 = off (default). */
  readonly context: number;
  /** Filename pattern, parallel to `type`. */
  readonly glob?: string;
  /** Language type filter. */
  readonly type?: string;
  /** Start index into the sorted result list. */
  readonly offset: number;
  /** Max entries from the sorted result list (default 50, hard cap 2000). */
  readonly headLimit: number;
}

/**
 * One hit line. `line` is the 1-based line number; `text` is already truncated
 * to MAX_MATCH_LINE_COLUMNS (same convention for both engines).
 */
export interface LineHit {
  readonly path: string;
  readonly line: number;
  readonly text: string;
}

/** Per-file hit count (input to the `count` output). */
export interface FileCount {
  readonly path: string;
  readonly count: number;
}

/**
 * One display group for `content + context` output.
 *
 * rg inserts `--` separator lines between two non-adjacent context runs; this
 * shape makes "group" explicit and leaves the separators to the rendering
 * layer, so `:` / `-` / `--` can never be mis-parsed as a fake
 * `path:line:text`.
 */
export interface ContextGroup {
  /** Group entries: match lines have `isMatch=true`, context lines `false`. */
  readonly entries: ReadonlyArray<ContextEntry>;
}

export interface ContextEntry {
  readonly path: string;
  readonly line: number;
  readonly text: string;
  readonly isMatch: boolean;
}

/**
 * The group separator line (the single authority for rendering and parsing).
 *
 * Under `--null -C N`, rg prints the separator as **two spaces plus `--`**
 * (`\0--\0\n`, verified on 15.1.0; different from the bare `--` it prints
 * without `--null`). A parser that only accepts bare `--` would drop the
 * separator as a corrupt record, merging adjacent groups — the group count
 * behind `head_limit` and the landing point of `offset` would both shift —
 * while the Node engine builds its own groups and would not be affected: the
 * same `-C N` query would paginate differently across the two engines.
 */
export const CONTEXT_GROUP_SEPARATOR = "--";
