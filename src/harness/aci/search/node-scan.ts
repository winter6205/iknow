/**
 * The Node scan engine.
 *
 // (ADR-0089)
 *
 * Enabled when the bundled engine cannot start (install-root binary missing,
 * or spawn yields ENOENT / not executable): Node walks files and runs the
 * pattern compiled by `compilePattern` through `RegExp`, and the call still
 * succeeds. It does **not** fail by refusing features, and does **not** exec
 * an `rg` off PATH. The hit set may differ from rg's — Node does not imitate
 * rg's default-engine rejection set (lookaround / `\d` classes etc. may be
 * wider on machines without rg; docs and tests treat this as a feature, not a
 * missing test).
 *
 * Single responsibility: **produce raw hits shaped exactly like the rg
 * engine's** (`LineHit[]`, stably sorted by (path,line)). Pagination /
 * projection / line-window filtering belong to the shared layer, not here —
 * the two engines' downstream sharing comes from "feeding the same pipeline",
 * not from mirrored logic.
 *
 * Narrowing goes through shared layers: `type` uses rg's original table in
 * `type-table.ts` (judged by filename), `glob` uses rg-equivalent matching in
 * `glob-match.ts`. Both are the second implementation of rg engine's
 * `--type` / `--glob` under one semantics.
 */

import { readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";

import { fileNameMatchesType } from "./argv.js";
import { isNegation, matchesGlobSet } from "./glob-match.js";
import { readWorkspaceLines } from "./file-lines.js";
import { isPathRepresentable } from "./path-representable.js";
import { truncateMatchContent } from "./rg-output.js";
import type { LineHit, QuerySpec } from "./types.js";

export interface NodeScanInput {
  readonly spec: QuerySpec;
  readonly workspaceRoot: string;
  readonly searchRoot: string;
  /** Compiled main pattern (bad regex was already typed-rejected in `pattern.ts`). */
  readonly regex: RegExp;
}

/** All hits (unsorted; callers go sort → paginate → project). */
export async function nodeScan(input: NodeScanInput): Promise<LineHit[]> {
  const hits: LineHit[] = [];
  // When the search root is an **explicitly named single file**, the size gate
  // and `glob` / `type` step aside — rg's `--max-filesize` only applies during
  // recursive traversal, and user glob/type do not act on explicit file
  // arguments either (both verified). If Node kept blocking, the same `path`
  // would get engine-dependent answers.
  const explicitFile = await isFile(input.searchRoot);
  for await (const absPath of walkCandidates(input, explicitFile)) {
    // The path must be **workspace-relative**: model-visible lines are all
    // required to be relative paths, and `glob` anchoring (`src/*.ts`) judges
    // segments on relative paths.
    //
    // `..` prefixes are **not removed**: the identity root is the read-only
    // root outside workspace, admitted via `resolveWithinRoot`, and its hits
    // naturally take the shape `../<identity>/x`. Filtering by prefix here
    // would make post-rebinding grep reads silently empty (while the rg path
    // still returns) — the same path argument answered differently depending on
    // which engine runs. Escapes are blocked at the entry: inside the
    // containment roots by the shared reach resolver's
    // resolveWithinRoot arm (read-policy.ts `resolveReadReach`), and outside
    // them only by the canonical policy's allow verdict — the widened arm
    // never walks an unguarded root. Traversal itself only walks under
    // searchRoot.
    const relPath = toWorkspaceRelative(input.workspaceRoot, absPath);
    // Paths unrepresentable in the line protocol are skipped outright: a path
    // with `\n` splits its own record into two (see
    // `path-representable.ts`). Skip rather than error — on the rg side,
    // traversal excludes them silently via glob, so both sides must be equally
    // "blind"; otherwise counts, `total:`, and hit sets for the same directory
    // would vary by engine.
    if (!isPathRepresentable(relPath)) continue;
    if (!explicitFile && !passesFilters(relPath, input.spec)) continue;
    const lines = await readWorkspaceLines(input.workspaceRoot, relPath, {
      allowOversize: explicitFile,
    });
    if (lines === null) continue;
    collectHits(relPath, lines, input.regex, hits);
  }
  return hits;
}

/** Whether the search root points at an existing file (decides if the "explicit file" exemption applies). */
async function isFile(path: string): Promise<boolean> {
  const info = await stat(path).catch(() => null);
  return info !== null && info.isFile();
}

/**
 * Candidate files: `path` itself when it is a file, recursive expansion when
 * it is a directory.
 *
 * Recursing only into directories would make `path: "a.ts"` silently return
 * empty — rg hits there, so the two engines would answer the same argument
 * differently. Hence stat first: a file becomes the sole candidate.
 */
async function* walkCandidates(
  input: NodeScanInput,
  explicitFile: boolean
): AsyncGenerator<string> {
  if (explicitFile) {
    yield input.searchRoot;
    return;
  }
  yield* walkFiles(input.searchRoot);
}

/**
 * Narrowing: `glob` and `type` side by side.
 *
 * rg's real rule (verified item by item, not inferred from docs): **as soon as
 * one positive glob is given, `--type` drops out of judging entirely** — the
 * glob decides the included set, type is silently ignored. The original Node-
 * side implementation was AND (both must hold), so the same query
 * `{type:"ts", glob:"sub/*"}` returns `sub/a.ts` + `sub/b.js` via rg (`sub/b.js`
 * gets in despite not being `.ts`, because the glob decides) but only
 * `sub/a.ts` via Node.
 *
 * Only **negated** globs keep type in effect: `--type ts` plus one negated
 * glob excluding node_modules verified as `sub/a.ts,top.ts` (type filters
 * first, the negated glob then removes), which differs from the 4 results of
 * that negated glob alone.
 *
 * This function implements rg's verified rule, so both engines judge alike.
 * Semantically this means "`type` and `glob` are not stackable narrowing
 * dimensions": write a single `sub/*.ts` to express the intersection. Note
 * this and the tool's glob-ordering contract are two faces of one mechanism —
 * the ordering makes the tool's exclusion globs the final verdict, while here
 * the user glob's override of type matches rg.
 */
function passesFilters(relPath: string, spec: QuerySpec): boolean {
  const { type, glob } = spec;
  if (type === undefined && glob === undefined) return true;
  if (glob === undefined) return fileNameMatchesType(baseName(relPath), type!);
  if (type === undefined) return matchesGlobSet(relPath, [glob]);
  // Side by side: a positive glob present → type steps aside (verified rg
  // behavior); only a negated glob → type still in effect.
  if (!isNegation(glob)) return matchesGlobSet(relPath, [glob]);
  return (
    fileNameMatchesType(baseName(relPath), type) &&
    matchesGlobSet(relPath, [glob])
  );
}

function collectHits(
  relPath: string,
  lines: ReadonlyArray<string>,
  regex: RegExp,
  out: LineHit[]
): void {
  for (let i = 0; i < lines.length; i++) {
    if (regex.test(lines[i]!)) {
      out.push({
        path: relPath,
        line: i + 1,
        text: truncateMatchContent(lines[i]!),
      });
    }
  }
}

/**
 * Recursively yield absolute file paths, skipping node_modules / .git.
 *
 * Exported for **shared use by the scope gate** (`scope-guard.ts` counts with
 * the same traversal discipline) — precisely so an oversized `path` gets the
 * same verdict on both engines, rather than gate and scan each writing a copy
 * that slowly drifts.
 */
export async function* walkFiles(dir: string): AsyncGenerator<string> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => null);
  if (entries === null) return;
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkFiles(full);
    } else if (entry.isFile()) {
      yield full;
    }
  }
}

/** Basename of a posix-style relative path (text after the last `/`). */
export function baseName(relPath: string): string {
  const idx = relPath.lastIndexOf("/");
  return idx === -1 ? relPath : relPath.slice(idx + 1);
}

/** Folds an absolute path to workspace-relative (posix form) for callers. */
export function toWorkspaceRelative(
  workspaceRoot: string,
  absPath: string
): string {
  const rel = relative(workspaceRoot, absPath);
  return rel.split("\\").join("/");
}
