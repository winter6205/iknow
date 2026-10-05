/**
 * rg stdout parsing (line parsing).
 *
 * The input shape is fixed by `argv.ts`: `--null` → `path\0line:text\n`.
 * NUL delimiting removes "path contains a colon" from the column-splitting
 * problem entirely — the `:` / `-` / `--` splitting in the rendering layer
 * only matters for **content + context** (parsed by
 * `rg-output-context.ts`, see that file's comments).
 *
 * Old contract preserved: a single match line over MAX_MATCH_LINE_COLUMNS is
 * truncated with `...[truncated]`, cut by **code point** (never splitting a
 *
 // (ADR-0004)
 * surrogate pair).
 *
 * Provenance of the "verified / measured / verbatim" notes in this file: they
 * were taken on rg 15.1.0 and each cited rc / flag / verbatim form was re-run
 * against the shipped `@vscode/ripgrep` binary (rg 15.0.0) with identical
 * results, so the stamps below read 15.0.0 — the engine this tool actually
 * execs (`engine-manifest.RIPGREP_VERSION`).
 */

import { truncateByCodePoint } from "../../sandbox/runner.js";
import type { LineHit } from "./types.js";

export const MAX_MATCH_LINE_COLUMNS = 2_000;
export const RG_TRUNCATION_MARKER = "...[truncated]";

/**
 * The elision marker rg `--max-columns-preview` appends (verbatim rg 15.0.0).
 *
 * It is **not** this tool's elision marker: when this string appears in the
 * body, the model is seeing rg's transport-layer truncation, not the display
 * rule. The parser must strip it first, then apply the single code-point
 * gate — otherwise the rg path keeps this text tail while the Node path does
 * not.
 */
export const RG_PREVIEW_MARKER = " [... omitted end of long line]";

/**
 * Transport budget / authoritative width ratio: one UTF-8 code point is at
 * most 4 bytes.
 *
 * `--max-columns` **triggers** on bytes but **slices** on code points
 * (measured rg 15.0.0), whereas `truncateMatchContent` only understands code
 * points — different units. A 4x budget ensures "rg appended a marker" does
 * not imply "content was cut":
 *   - An over-long line (> 2000 cp) is necessarily >= 2001 bytes ⟹ always
 *     triggers; when sliced to 8000 cp the body is far above the
 *     authoritative cap, so after stripping the marker the code-point gate
 *     finalizes the same shape.
 *   - A non-over-long line is at most 2000 cp ⟹ at most 8000 bytes; a line at
 *     the trigger rg slices to at most 8000 cp and always snaps that cut
 *     **forward** to a whole code point (measured rg 15.0.0: 7999 ASCII chars
 *     + 300 CJK chars — 8899 bytes / 8299 cp — comes back as 8000 cp /
 *     8002 bytes: over the byte budget, never mid-character), so no character
 *     is lost. With a budget below 4x, lines of 1000 three-byte CJK chars
 *     (3003 bytes / 1003 cp) would actually lose a tail, while the Node side
 *     keeps them intact as under-column — same line, different bytes / body /
 *     copyable content.
 *
 * So this tool never lets rg's transport budget act as the display width: it
 * only limits transport, and the final shape is decided solely by
 * `truncateMatchContent`.
 */
export const MAX_COLUMN_BYTES_PER_CODE_POINT = 4;

/** Byte budget passed to rg `--max-columns` (`argv.ts` and the parser share one formula). */
export function rgTransportBudgetBytes(maxColumns: number): number {
  return maxColumns * MAX_COLUMN_BYTES_PER_CODE_POINT;
}

/**
 * Strip rg's transport-layer elision marker (only when it is **certain rg
 * added it**).
 *
 * Measured rg 15.0.0 semantics (the two units differ, see
 * `MAX_COLUMN_BYTES_PER_CODE_POINT`):
 *   - **Trigger**: append the marker when line bytes >= budget;
 *   - **Slice**: cut the body to the first `budget` **code points**, or keep
 *     it verbatim if shorter.
 * So a marker does not prove the body was cut (measured rg 15.0.0: a line of
 * exactly `budget` ASCII bytes gets the marker and keeps its whole 8000-cp
 * body; and there is no "cut would land mid-character" case at all — the cut
 * is snapped forward to a whole code point, which may push the body past
 * `budget` bytes), and "bytes after removing the marker >= budget" is
 * equivalent to "rg appended the marker":
 *   - a cut line loses a prefix of exactly `budget` code points, i.e. at
 *     least `budget` bytes;
 *   - an uncut whole line already had >= budget bytes.
 * A real file line that happens to end with this text is therefore not
 * stripped by mistake: if its byte count >= budget, rg would have appended
 * its own marker too, and removing just the last one restores it.
 *
 * `strippedTailBytes` = bytes the caller removed from the **raw record tail**
 * (the trailing `\r` rg echoes under `--crlf`, i.e. 1): it counts toward rg's
 * trigger base, and without it a 7999-byte CRLF line would escape stripping
 * (measured 15.0.0: 7999 + `\r` lands exactly on the line; and rg emits the
 * marker *before* that `\r`, so the tail is `\r` then `\n`). Callers must pass
 * "verbatim record length - content length passed in", not pre-deduct and
 * guess.
 */
export function stripRgPreviewMarker(
  content: string,
  strippedTailBytes = 0
): string {
  if (!content.endsWith(RG_PREVIEW_MARKER)) return content;
  const head = content.slice(0, -RG_PREVIEW_MARKER.length);
  return Buffer.byteLength(head, "utf8") + strippedTailBytes >=
    rgTransportBudgetBytes(MAX_MATCH_LINE_COLUMNS)
    ? head
    : content;
}

/**
 * Parse hit lines from `--null` content output.
 *
 * Malformed records (no NUL, non-decimal line number) are skipped entirely —
 * no guessing, no fake hits.
 */
export function parseRgNullLines(stdout: string): LineHit[] {
  const hits: LineHit[] = [];
  for (const record of stdout.split("\n")) {
    if (record.length === 0) continue;
    // The binary notice is not a hit line (see `isRgBinaryNotice`): its
    // "path:" segment is shaped like `path:line:text`, so without an explicit
    // exclusion it would parse as a fake hit.
    if (isRgBinaryNotice(record)) continue;
    const nulIdx = record.indexOf("\0");
    if (nulIdx === -1) continue;
    const path = stripDotSlash(record.slice(0, nulIdx));
    const rest = record.slice(nulIdx + 1);
    const colonIdx = rest.indexOf(":");
    if (colonIdx === -1) continue;
    const line = Number(rest.slice(0, colonIdx));
    if (!Number.isInteger(line) || line < 1) continue;
    hits.push({
      path,
      line,
      text: truncateRgContent(rest.slice(colonIdx + 1)),
    });
  }
  return hits;
}

/**
 * rg's binary notice records (**not hit lines**).
 *
 * Two verbatim forms verified in 15.0.0 (under `--null -H` the path segment
 * ends with NUL, so the notice body follows the NUL):
 *   - `path\0 binary file matches (found "\0" byte around offset 8)`
 *   - `path\0 WARNING: stopped searching binary file after match (found "\0" byte around offset 70008)`
 *   - `path: binary file matches (...)` — under `--null`, rg only NUL-delimits
 *     **real content records**; the notice line uses the NUL-free `path: `
 *     form (verified 15.0.0).
 *
 * They look like records (path, colon); unrecognized, parsers like
 * `parseRgNullLines` would treat them as hits or drop them wholesale. Under
 * `-l` / `--count` rg does not even **emit** these notices, so the same
 * NUL-containing file is listed by `-l` but reported as a notice by
 * `content` (verified 15.0.0: a file with a far NUL gives `-l` rc=0 with the
 * path, `--count` rc=0 without, `content` a WARNING). Which of the two notice
 * bodies appears is itself not a rule — it depends on the search shape (an
 * explicitly named file prints `binary file matches`, a directory walk prints
 * the `WARNING:` form), and under the default parallel walk the notice can be
 * dropped entirely for a tree holding several NUL files (`-j1` restores it).
 * All of it is a side effect of rg's own detection window (64 KiB) and not a
 * replicable rule, so both engines uniformly treat binary files as
 * unsearchable; this code only recognizes the notice.
 *
 * The test must be **anchored at the record position**: a hit line's body can
 * contain the very same text (e.g. querying `binary file matches` as a
 * pattern), so a substring test would drop real hits too. Both verbatim forms
 * have a fixed posture — the notice body follows the path segment directly
 * (`path\0 ` or `path: `) and there is **no line-number segment** (a hit
 * record is always `path\0<decimal>:body`, delimited by `:`).
 */
const RG_BINARY_NOTICE_BODY =
  /^(?:WARNING: )?(?:binary file matches|stopped searching binary file)/;

/** Whether this record is rg's binary notice (rather than a hit). */
export function isRgBinaryNotice(record: string): boolean {
  const nul = record.indexOf("\0");
  if (nul !== -1) {
    const rest = record.slice(nul + 1);
    // `path\0<decimal>:` is a hit record — even the same text in its body
    // must not be dropped as a notice.
    if (/^\d+:/.test(rest)) return false;
    return RG_BINARY_NOTICE_BODY.test(rest.replace(/^ /, ""));
  }
  // Without NUL there are only two cases: a notice line (`path: notice body`)
  // or a malformed record.
  const colon = record.indexOf(": ");
  return colon !== -1 && RG_BINARY_NOTICE_BODY.test(record.slice(colon + 2));
}

/**
 * Strip a trailing `\r` (every rg stdout content record passes this gate).
 *
 * `argv.ts` passes `--crlf`: rg decides line boundaries by CRLF (so `foo$`
 * hits a CRLF line), but **the echoed line content still carries `\r`**
 * (verified 15.0.0, same with or without `--null`). The Node side already
 * strips `\r` after splitting on `\n` (see `file-lines.splitLines`); not
 * stripping here means the same query differs by one invisible char between
 * engines — invisible to the model, but byte comparisons and a later
 * `edit_file` `old_str` would both trip on it.
 *
 * Stripping is unified in `truncateRgContent` (this helper is private): `\r`
 * is part of the byte base rg uses to judge "line too long" (see
 * `stripRgPreviewMarker`), so if a caller strips it before handing the body
 * over, that byte is lost for good and marker-stripping then misjudges.
 */
function stripCr(text: string): string {
  return text.endsWith("\r") ? text.slice(0, -1) : text;
}

/**
 * Output shape of `--count` under `--null`: `path\0count\n`.
 *
 * The count form needs no line numbers; paths use the same NUL delimiter.
 */
export function parseRgNullCounts(
  stdout: string
): ReadonlyArray<{ path: string; count: number }> {
  const counts: Array<{ path: string; count: number }> = [];
  for (const record of stdout.split("\n")) {
    if (record.length === 0) continue;
    // Binary notice, same as `parseRgNullLines`: it is not a count record, so
    // the shape test must agree — without this a notice under `--count` would
    // be accepted as a fake count like `path:0`.
    if (isRgBinaryNotice(record)) continue;
    const nulIdx = record.indexOf("\0");
    if (nulIdx === -1) continue;
    const path = stripDotSlash(record.slice(0, nulIdx));
    const count = Number(record.slice(nulIdx + 1));
    if (!Number.isInteger(count) || count < 0) continue;
    counts.push({ path, count });
  }
  return counts;
}

/** `--files-with-matches --null` → a `path\0` sequence. */
export function parseRgNullPaths(stdout: string): string[] {
  const paths: string[] = [];
  for (const record of stdout.split("\0")) {
    if (record.length === 0) continue;
    // The last segment may carry a trailing \n (after each record's \0, rg
    // still emits whitespace); strip it, then strip `./`.
    const cleaned = stripDotSlash(record.replace(/\n+$/, ""));
    if (cleaned.length > 0) paths.push(cleaned);
  }
  return paths;
}

/**
 * Finalize a single content line: cut to MAX_MATCH_LINE_COLUMNS by **code
 * point**, appending the marker when over.
 *
 * Same thing as `truncateByCodePoint` in `sandbox/runner.ts` — here we only
 * wrap in this layer's elision marker and cap constant; the cut itself is not
 * reimplemented (the old `Array.from` + `slice` was a second implementation,
 * pure drift risk).
 *
 * Pure display gate, **no handling of transport-layer artifacts** (see
 * `truncateRgContent`): the final shape of both engines is thus decided only
 * here, and neither engine cuts an extra time.
 */
export function truncateMatchContent(content: string): string {
  if (Array.from(content).length <= MAX_MATCH_LINE_COLUMNS) return content;
  return `${truncateByCodePoint(content, MAX_MATCH_LINE_COLUMNS)}${RG_TRUNCATION_MARKER}`;
}

/**
 * Entry point for the rg parse path: first wash off transport-layer
 * artifacts, then apply the shared display gate.
 *
 * The wash must happen **only on the rg path**: `stripRgPreviewMarker`'s test
 * is "bytes after removing the marker >= budget", so a real file line that is
 * exactly that long and happens to end with that text would lose a tail for
 * nothing on the Node path (Node has no transport layer — such an ending is
 * just content), giving the two engines different bodies for the same file.
 * Hence the Node path runs `truncateMatchContent` only.
 *
 * The trailing `\r` is stripped here (rg echoes it, the Node side already
 * stripped via `splitLines`), but its byte count must be handed to marker
 * stripping as the trigger base — the order cannot be reversed.
 */
export function truncateRgContent(raw: string): string {
  const hasCr = raw.endsWith("\r");
  const body = stripCr(raw);
  return truncateMatchContent(stripRgPreviewMarker(body, hasCr ? 1 : 0));
}

function stripDotSlash(path: string): string {
  return path.startsWith("./") ? path.slice(2) : path;
}
