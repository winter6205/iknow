/**
 * The fs boundary for "get full-text lines by path" (shared by the line
 * window and context rendering).
 *
 * Single responsibility: turn "one workspace-relative path" into a line array,
 * or null (unreadable / binary / oversize). Both `also-window.ts` and
 * `context-groups.ts` consume it, so the file admission of the two display
 * paths is identical — no forks like "visible via also but not via context".
 *
 * Skip policy inherited from the old Node fallback: files >1MB or containing
 *
 // (ADR-0004)
 * NUL **anywhere in the file** are not read as text (an explicitly named file
 * gets a separate generous cap, see `MAX_EXPLICIT_FILE_BYTES`). Line numbers
 * are 1-based = index + 1, so `readLines()[n-1]` is line n.
 */

import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";

/**
 * Size gate for text files (**single authority**): above 1 MiB is not read as
 * text.
 *
 * Same value as `read_file`'s refusal line but **not the same constant** —
 * `read-file.ts` keeps its own private `MAX_FILE_BYTES` (out of scope for this
 * slice). All three search-side consumers (the traversal `--max-filesize`,
 * `readWorkspaceLines`, and `node-scan`'s admission) take it from here, to
 * avoid growing another drifting copy.
 */
export const MAX_TEXT_FILE_BYTES = 1_048_576;

/**
 * Size cap for explicitly named files (**16x** `MAX_TEXT_FILE_BYTES`).
 *
 * The "explicit file exemption" exists to align with rg's `--max-filesize`
 * applying only during traversal (see below). But an unbounded exemption would
 * let `{path: "<huge file>"}` read an arbitrarily large file wholly into
 * memory; rg streams instead, so Node would become the OOM surface. Hence a
 * generous but finite cap, **shared by both engines**: an explicit file above
 * it is not searched by rg or Node either (on the rg side, `grep.ts`'s
 * admission filter trims it — not a separately written threshold).
 */
export const MAX_EXPLICIT_FILE_BYTES = MAX_TEXT_FILE_BYTES * 16;

/**
 * Workspace-relative path → text buffer; unreadable / binary / oversize →
 * null.
 *
 * This is the **single admission decision** for "can this file be read as
 * text": both `readWorkspaceLines` and `isTextFile` go through it, so both
 * engines' accepted sets share one source. Keeping two consumer shapes (lines
 * vs just a boolean) lets the `paths` / `count` modes skip the line-splitting
 * cost.
 *
 * `allowOversize` is used only on the path where "the search root is an
 * **explicitly named single file**": rg's `--max-filesize` applies only during
 * **recursive traversal**; an explicitly fed file is searched even above the
 * limit (verified rg 15.1.0). If Node refused by size unconditionally, the
 * same `path: "big.ts"` would get different answers from the two engines; and
 * with no bound at all, an oversize file becomes an unbounded read. Hence the
 * shared cap `MAX_EXPLICIT_FILE_BYTES`.
 *
 * The binary test scans the **whole file** for NUL (`containsNul`), same rule
 * as `read_file`'s `buffer.includes(0x00)` (the read-side precedent). Why rg's
 *
 // (ADR-0004)
 * own binary detection cannot be the authority: it judges within a 64 KiB
 * window and **reaches different conclusions per output mode** — a file with a
 * far-away NUL is listed by `-l` but skipped by `--count` (verified 15.1.0:
 * `-l` returns on first hit while `--count` reads to EOF). That has no
 * replicable consistent meaning, so both engines uniformly use this function's
 * whole-file verdict, and rg's built-in detection is only an I/O-saving
 * prefilter (see the admission filter in `rg-engine.ts`).
 */
async function readTextBuffer(
  workspaceRoot: string,
  relPath: string,
  allowOversize: boolean
): Promise<Buffer | null> {
  const abs = resolve(workspaceRoot, relPath);
  const info = await stat(abs).catch(() => null);
  if (info === null || !info.isFile()) return null;
  if (
    info.size > (allowOversize ? MAX_EXPLICIT_FILE_BYTES : MAX_TEXT_FILE_BYTES)
  ) {
    return null;
  }
  const buf = await readFile(abs).catch(() => null);
  if (buf === null || containsNul(buf)) return null;
  return buf;
}

/**
 * Workspace-relative path → line array; unreadable / binary / oversize → null.
 *
 * Line numbers are 1-based = index + 1, so `readLines()[n-1]` is line n.
 */
export async function readWorkspaceLines(
  workspaceRoot: string,
  relPath: string,
  options?: { readonly allowOversize?: boolean }
): Promise<ReadonlyArray<string> | null> {
  const buf = await readTextBuffer(
    workspaceRoot,
    relPath,
    options?.allowOversize === true
  );
  return buf === null ? null : splitLines(buf);
}

/**
 * Admission boolean: can this path be searched as text right now (the non-null
 * test of `readWorkspaceLines`, without splitting lines). The rg engine uses
 * it to drop files that "rg reported but are binary / oversize by this tool's
 * rule" — both engines thus share one admission line (see `rg-engine.ts`).
 */
export async function isTextFile(
  workspaceRoot: string,
  relPath: string,
  options?: { readonly allowOversize?: boolean }
): Promise<boolean> {
  return (
    (await readTextBuffer(
      workspaceRoot,
      relPath,
      options?.allowOversize === true
    )) !== null
  );
}

/**
 * A batch of workspace-relative paths → those passing admission (**order
 * kept**, each path checked once).
 *
 * Why a batch shape: the rg engine can only re-check after receiving its
 * candidates (see the admission filter in `rg-engine.ts`), and rg may report
 * tens of thousands of files at once. `await`ing one by one multiplies
 * wall-clock linearly with file count; measured on 34k files (this repo's real
 * scale for `pattern=import`): serial 18.2s, 8-way 3.2s, **64-way 1.3s**.
 * Whole-file NUL scanning is pure I/O, so concurrency is safe — the 64 cap
 * exists to avoid pressuring file descriptors / page cache, it is not part of
 * the semantics.
 */
export async function admittedPaths(
  workspaceRoot: string,
  paths: ReadonlyArray<string>,
  options?: { readonly allowOversize?: boolean }
): Promise<ReadonlySet<string>> {
  const admitted = new Set<string>();
  const pending: string[] = [];
  const seen = new Set<string>();
  for (const path of paths) {
    if (seen.has(path)) continue;
    seen.add(path);
    pending.push(path);
  }
  for (let i = 0; i < pending.length; i += ADMISSION_CONCURRENCY) {
    const slice = pending.slice(i, i + ADMISSION_CONCURRENCY);
    const flags = await Promise.all(
      slice.map((path) => isTextFile(workspaceRoot, path, options))
    );
    for (let j = 0; j < slice.length; j += 1) {
      if (flags[j] === true) admitted.add(slice[j]!);
    }
  }
  return admitted;
}

/** Concurrency of the admission re-check (pure I/O; see the measurements in `admittedPaths`). */
const ADMISSION_CONCURRENCY = 64;

/** Split on lines; strip the `\r` of CRLF; a final line without newline still counts. */
export function splitLines(buffer: Buffer): string[] {
  const text = buffer.toString("utf8");
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) {
      out.push(stripCr(text.slice(start, i)));
      start = i + 1;
    }
  }
  if (start < text.length) out.push(stripCr(text.slice(start)));
  return out;
}

function stripCr(line: string): string {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}

/**
 * Binary test: NUL anywhere in the **whole** buffer → binary.
 *
 * No window truncation (the old implementation only looked at the first
 * 8 KiB): a window is an approximation of rg's binary detection, and rg's
 * window (64 KiB) versus NUL position produces self-contradictions like "the
 * same file is binary in a named search but text in recursive traversal". NUL
 * can only come from non-text content, so the whole-file scan is the only
 * stable rule — and it matches `read_file`'s `buffer.includes(0x00)` exactly.
 */
export function containsNul(buffer: Buffer): boolean {
  return buffer.includes(0x00);
}
