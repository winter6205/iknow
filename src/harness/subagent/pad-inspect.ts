/**
 * T5 — list top-level fence-tmp pad names or read one relative file.
 * Sync (subagent_result stays non-blocking). The 200-line window below is
 * this pad roster's own cap, unrelated to `read_file`'s current contract
 * (ADR-0084 D1c: no default line window). `..` or pad escape → typed reject.
 */
import {
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

/** The pad roster's own 200-line window (not read_file's contract). */
export const PAD_ROSTER_LINE_LIMIT = 200;
/** Short envelope roster cap — the pad's own 200-name window. */
export const PAD_ROSTER_NAME_LIMIT = PAD_ROSTER_LINE_LIMIT;
/** Largest pad file one read will decode; larger files are a typed reject. */
export const READ_FILE_MAX_FILE_BYTES = 1_048_576;
/**
 * A paged page carries at most this many UTF-16 code units. Sized at half the
 * executor's 20 000-unit serialized floor so the worst-case JSON escaping of a
 * page body (every control char / quote doubling) still keeps the serialized
 * `subagent_result` output under that cap. `PAD_ROSTER_LINE_LIMIT` and this
 * budget bind together: whichever truncates first decides the page edge.
 */
export const PAD_PAGE_CODE_UNIT_BUDGET = 9_000;

export type PadInspectRejectReason =
  "path_escape" | "not_a_file" | "offset_out_of_range";

export type PadInspectResult =
  | { readonly status: "list"; readonly names: readonly string[] }
  | {
      readonly status: "read";
      readonly content: string;
      readonly truncated: boolean;
      /** Present only on a paged read: whether this page ended at end-of-file. */
      readonly eof?: boolean;
      /** Present only when `eof` is false: the offset to pass on the next call. */
      readonly next_offset?: number;
    }
  | {
      readonly status: "rejected";
      readonly reason: PadInspectRejectReason;
    };

export type PadQueryResult =
  { readonly status: "not_found" } | PadInspectResult;

function hasDotDotSegment(tmpPath: string): boolean {
  return tmpPath.split(/[/\\]/).includes("..");
}

function isInsideRoot(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function formatReadFileSlice(text: string): {
  readonly content: string;
  readonly truncated: boolean;
} {
  if (text.length === 0) {
    return { content: "[read_file] ok (empty file)", truncated: false };
  }
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const truncated = lines.length > PAD_ROSTER_LINE_LIMIT;
  const window = lines.slice(0, PAD_ROSTER_LINE_LIMIT);
  return {
    content: window
      .map((line, idx) => `${String(idx + 1).padStart(6)}\t${line}`)
      .join("\n"),
    truncated,
  };
}

/**
 * Raw start of the line following the decorated window's last line — the cursor
 * a model needs to continue past it. Counting newlines rather than rebuilding
 * the window keeps it correct when a line contains no separator at all.
 */
function rawOffsetAfterWindow(text: string, windowLines: number): number {
  let cursor = 0;
  for (let line = 0; line < windowLines; line += 1) {
    const nl = text.indexOf("\n", cursor);
    if (nl === -1) return text.length;
    cursor = nl + 1;
  }
  return cursor;
}

/**
 * The decorated first window. When it truncates it must still hand over a
 * cursor: the model-visible contract is "pass `next_offset` back as `offset`",
 * and a `truncated:true` read without one strands the reader on page one.
 */
function decoratedFirstWindow(text: string): PadInspectResult {
  const { content, truncated } = formatReadFileSlice(text);
  if (!truncated) return { status: "read", content, truncated: false };
  return {
    status: "read",
    content,
    truncated: true,
    eof: false,
    next_offset: rawOffsetAfterWindow(text, PAD_ROSTER_LINE_LIMIT),
  };
}

/**
 * Move a cut index back one code unit when it would leave a lone high
 * surrogate at the end of the page (its low partner belongs to the next page).
 * `start` is always a prior snapped boundary, so it never opens on a lone low
 * surrogate; only the trailing edge needs adjusting.
 */
function snapOffSurrogate(text: string, end: number, start: number): number {
  if (end <= start || end >= text.length) return end;
  const prev = text.charCodeAt(end - 1);
  if (prev >= 0xd800 && prev <= 0xdbff) return end - 1;
  return end;
}

/**
 * Snap an incoming cursor forward past a low surrogate. A model-supplied offset
 * is only range-checked, so it can land between the halves of a surrogate pair;
 * a page opening on the trailing half would hand back a lone surrogate the
 * reader cannot decode. Offsets produced by `pageFromOffset` are already
 * aligned, so this only repairs hand-made / drifted cursors.
 */
function snapStartOffset(text: string, offset: number): number {
  if (offset <= 0 || offset >= text.length) return offset;
  const code = text.charCodeAt(offset);
  return code >= 0xdc00 && code <= 0xdfff ? offset + 1 : offset;
}

/**
 * One bounded paged slice: the earlier of `PAD_ROSTER_LINE_LIMIT` complete
 * lines (newline included, so pages rejoin byte-for-byte) and the code-unit
 * budget, snapped to a code-point boundary. Returns the raw slice with no
 * line-number decoration; `next_offset` continues exactly where `content`
 * stopped, and `eof` says whether anything remains.
 */
function pageFromOffset(
  text: string,
  incomingOffset: number
): PadInspectResult {
  const total = text.length;
  if (
    !Number.isInteger(incomingOffset) ||
    incomingOffset < 0 ||
    incomingOffset > total
  ) {
    // EXIT: cursor outside the file — a typed reject, never a clamped page 0.
    return { status: "rejected", reason: "offset_out_of_range" };
  }
  const offset = snapStartOffset(text, incomingOffset);
  let cursor = offset;
  let lines = 0;
  while (lines < PAD_ROSTER_LINE_LIMIT && cursor < total) {
    const nl = text.indexOf("\n", cursor);
    if (nl === -1) {
      cursor = total;
      break;
    }
    cursor = nl + 1;
    lines += 1;
  }
  const end = snapOffSurrogate(
    text,
    Math.min(cursor, offset + PAD_PAGE_CODE_UNIT_BUDGET),
    offset
  );
  const eof = end >= total;
  return {
    status: "read",
    content: text.slice(offset, end),
    truncated: !eof,
    eof,
    next_offset: eof ? undefined : end,
  };
}

/** Top-level pad names for SC5 envelope roster (no file bodies). */
export function listPadTopLevelNames(
  padRoot: string | undefined
): readonly string[] {
  const listed = inspectWorkerPad(padRoot);
  if (listed.status !== "list") return [];
  return listed.names.slice(0, PAD_ROSTER_NAME_LIMIT);
}
function isValidRelativePadPath(tmpPath: string): boolean {
  return (
    tmpPath.length > 0 && !hasDotDotSegment(tmpPath) && !isAbsolute(tmpPath)
  );
}

function listPadEntries(padRoot: string | undefined): PadInspectResult {
  if (padRoot === undefined || !existsSync(padRoot)) {
    return { status: "list", names: [] };
  }
  const names = readdirSync(realpathSync(padRoot)).filter(
    (name) => name !== "." && name !== ".."
  );
  names.sort();
  return { status: "list", names };
}

function readOnePadFile(
  realPad: string,
  tmpPath: string,
  offset?: number
): PadInspectResult {
  const resolved = resolve(realPad, tmpPath);
  if (!isInsideRoot(realPad, resolved)) {
    return { status: "rejected", reason: "path_escape" };
  }
  let realTarget: string;
  try {
    realTarget = realpathSync(resolved);
  } catch {
    return { status: "rejected", reason: "not_a_file" };
  }
  if (!isInsideRoot(realPad, realTarget)) {
    return { status: "rejected", reason: "path_escape" };
  }
  let info;
  try {
    info = statSync(realTarget);
  } catch {
    return { status: "rejected", reason: "not_a_file" };
  }
  if (!info.isFile() || info.size > READ_FILE_MAX_FILE_BYTES) {
    return { status: "rejected", reason: "not_a_file" };
  }
  let buffer: Buffer;
  try {
    buffer = readFileSync(realTarget);
  } catch {
    // Denied read (EACCES/EPERM) must surface as a typed rejection, never a
    // thrown stack or the host path; EXIT: no retry, the pad is host-owned.
    return { status: "rejected", reason: "not_a_file" };
  }
  if (buffer.includes(0x00)) {
    return { status: "rejected", reason: "not_a_file" };
  }
  const text = buffer.toString("utf8");
  if (offset === undefined) return decoratedFirstWindow(text);
  return pageFromOffset(text, offset);
}

export function inspectWorkerPad(
  padRoot: string | undefined,
  tmpPath?: string,
  offset?: number
): PadInspectResult {
  if (tmpPath !== undefined && !isValidRelativePadPath(tmpPath)) {
    return { status: "rejected", reason: "path_escape" };
  }
  if (tmpPath === undefined) return listPadEntries(padRoot);
  if (padRoot === undefined || !existsSync(padRoot)) {
    return { status: "rejected", reason: "path_escape" };
  }
  return readOnePadFile(realpathSync(padRoot), tmpPath, offset);
}
