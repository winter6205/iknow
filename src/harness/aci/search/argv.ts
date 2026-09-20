/**
 * rg argv construction + language-type table validation.
 *
 * The output-mode / flag mapping is part of the contract, not an
 * implementation detail:
 *   - `paths`   → `-l`          (rg: one line per unique file)
 *   - `count`   → `--count`     (`path:count`)
 *   - `content` → `--line-number --no-heading` (`path:line:text`)
 *   - `--null` always on: paths end with NUL, removing "path contains a
 *     colon" from the column-splitting problem.
 *   - `-C N` is added only for the content mode (other modes have no notion
 *     of "a few lines nearby").
 *
 * Typed rejection of unknown `type` is **not here**: `parseQuerySpec` in
 * `options.ts` blocks it (see the comment there) — validation attached only to
 * this function would take effect only "when the bundled engine is present".
 */

import type { QuerySpec } from "./types.js";
import { TYPE_GLOBS } from "./type-table.js";
import { MAX_TEXT_FILE_BYTES } from "./file-lines.js";
import { NEWLINE_PATH_EXCLUDES } from "./path-representable.js";
import { rgTransportBudgetBytes } from "./rg-output.js";

/** Frequently used samples from the type table (tests lock the shape; truth stays in TYPE_GLOBS). */
export const KNOWN_TYPE_SAMPLE: ReadonlyArray<string> = [
  "ts",
  "js",
  "py",
  "rust",
  "go",
  "md",
  "json",
];

export function buildRgArgs(
  spec: QuerySpec,
  searchPath: string,
  maxColumns: number
): string[] {
  const args: string[] = [];
  pushOutputMode(args, spec);
  // No Unicode mode switches for rg (`--no-unicode` / `--engine`) (ADR-0089):
  // both are levers that "bend rg's semantics toward JS", and using them to
  // force two-engine alignment is prohibited. rg runs its own default Unicode
  // semantics, so `\w` / `\d` / `\b` recognize non-ASCII word chars; the Node
  // path runs JS semantics, and a different hit set is an **accepted
  // contract** (see the `pattern.ts` header; the regression pin lives in
  // `tests/harness/aci/search/argv.test.ts`).
  // `--no-messages` silences **file-level** warnings (Permission denied on
  // unreadable files, broken symlinks) but does **not** silence regex / usage
  // errors. Hence rc=2 with empty stderr = some file just wasn't read (hits in
  // stdout remain valid); rc=2 with non-empty stderr = the query itself was
  // rejected. Without this switch, one unreadable neighbor file would fail the
  // whole query while the Node engine merely skips it — both engines answering
  // differently for the same directory.
  // `-H` always on: when `path` points at a single file, rg omits the filename
  // by default (only `line:content`), incompatible with the paths / count
  // modes and the Node engine's `path:line:text` shape.
  args.push("--null", "--color", "never", "--no-messages", "-H");
  // Traversal discipline: the Node scan (`walkFiles`) recognizes only these
  // two directory names, not `.gitignore` / `.ignore` / hidden files. rg's
  // default is the opposite (honors ignore files, skips hidden). Any
  // divergence fails cross-engine equivalence — and "swap engines, silently
  // lose half the repo" for one query is the worst kind of it. We choose "align
  // with Node's existing behavior" over "teach Node ignore rules": the latter
  // means reimplementing rg's gitignore syntax (negation / directory
  // (ADR-0004)
  // qualification / hierarchical scoping), a whole tool's worth of work;
  // `--no-ignore --hidden` is one line and matches existing semantics. The old
  // Node fallback never skipped hidden files either, so this is not a new
  // loosening.
  //
  // **Order is contract**: the user's `spec.glob` is delivered before the
  // tool's built-in exclusions, so rg's `last-glob-wins` makes "skip
  // node_modules / .git" the final verdict — it still holds when the user glob
  // narrows (`*.ts`: hits stay within `.ts`), and when the user glob widens
  // (`**` / `*`) the repo's dependency dirs and git config are never spat
  // back to the model.
  args.push("--no-ignore", "--hidden");
  if (spec.glob !== undefined) args.push("--glob", spec.glob);
  args.push(
    "--glob",
    "!**/node_modules",
    "--glob",
    "!**/.git",
    ...NEWLINE_PATH_EXCLUDES.flatMap((glob) => ["--glob", glob])
  );
  // Size gate during traversal; explicitly named files are exempt (rg
  // semantics), and the Node side uses the same rule.
  args.push(`--max-filesize=${String(MAX_TEXT_FILE_BYTES)}`);
  // CRLF alignment: the Node scan splits on `\n` then strips the trailing
  // `\r` (`file-lines.splitLines`; the old Node fallback did the same), so
  // `foo$` hits CRLF lines. rg by default treats `\r` as line content, and the
  // same `foo$` hits **nothing** in a CRLF file — acceptance would depend on
  // the engine. `--crlf` makes rg treat CRLF as the line terminator, so `$` /
  // `.` boundaries agree with Node. The `\r` in line content is stripped by
  // the parse layer (rg still echoes it verbatim), see `rg-output.ts`.
  args.push("--crlf");
  if (spec.output === "content") {
    // Two gates for over-long match lines: let rg finalize first, then the
    // projection layer cuts to MAX_MATCH_LINE_COLUMNS by code point (the
    // single authority). The first gate exists **only for transport volume** —
    // without it rg would echo the whole line back and a 1MB line would be
    // buffered before anyone noticed it must be truncated. Its byte budget is
    // `rgTransportBudgetBytes` (= 4x the code-point cap, i.e. the max width of
    // one UTF-8 char): rg **triggers** on bytes but **slices** by code point,
    // and only a full 4x budget keeps "rg added a marker" from coinciding with
    // content being cut (see the verified notes in `rg-output`). With a
    // smaller budget, `hit + 1000 three-byte CJK chars` (3003 bytes / 1003
    // code points) triggers on the 2000-byte line, the marker lands inside the
    // body while the Node side keeps it verbatim — same line, different bytes
    // / body / copyable content. The projection layer strips rg's marker and
    // then finalizes uniformly, so the two engines' final shape is decided
    // only by the authoritative width.
    args.push(
      `--max-columns=${String(rgTransportBudgetBytes(maxColumns))}`,
      "--max-columns-preview"
    );
    if (spec.context > 0) args.push("-C", String(spec.context));
  }
  if (spec.ignoreCase) args.push("--ignore-case");
  if (spec.type !== undefined) args.push("--type", spec.type);
  // The search path is **relative to cwd** (cwd = workspace root, see
  // rg-engine): rg echoes paths verbatim, so feeding an absolute path would
  // hand an absolute path to the model (relative paths are required); and
  // `--glob` anchoring is judged relative to cwd, so an absolute path would
  // make patterns like `sub/*.ts` misjudge whenever cwd is not the workspace
  // root (the Node engine judges segments workspace-relative — both sides
  // must use one rule).
  args.push("--", spec.pattern, searchPath);
  return args;
}

function pushOutputMode(args: string[], spec: QuerySpec): void {
  if (spec.output === "paths") {
    args.push("-l");
    return;
  }
  if (spec.output === "count") {
    args.push("--count");
    return;
  }
  args.push("--line-number", "--no-heading");
}

/**
 * Whether a filename hits the `type` table (the Node engine's narrowing
 * implementation).
 *
 * Supports both shapes found in rg's type table: `*.ext` and char-class
 * literal names like `Name.*` / `[Mm]akefile`. Case follows rg semantics:
 * classes like `*.[chH]` are case-sensitive, so case is expressed via the
 * character classes themselves rather than a global `i` flag.
 */
export function fileNameMatchesType(fileName: string, type: string): boolean {
  const globs = TYPE_GLOBS[type];
  if (globs === undefined) return false;
  return globs.some((glob) => globToRegExp(glob).test(fileName));
}

/** Compile one single-segment glob from rg's type table into a regex (`*` / `?` / `[...]`). */
function globToRegExp(glob: string): RegExp {
  let source = "";
  let i = 0;
  while (i < glob.length) {
    const ch = glob[i]!;
    if (ch === "*") {
      source += "[^/]*";
      i += 1;
      continue;
    }
    if (ch === "?") {
      source += "[^/]";
      i += 1;
      continue;
    }
    if (ch === "[") {
      const end = glob.indexOf("]", i + 1);
      if (end !== -1) {
        source += glob.slice(i, end + 1);
        i = end + 1;
        continue;
      }
    }
    source += escapeRegExp(ch);
    i += 1;
  }
  return new RegExp(`^${source}$`);
}

function escapeRegExp(ch: string): string {
  return /[.*+?^${}()|[\]\\]/.test(ch) ? `\\${ch}` : ch;
}
