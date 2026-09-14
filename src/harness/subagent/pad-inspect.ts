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
const PAD_ROSTER_LINE_LIMIT = 200;
/** Short envelope roster cap — the pad's own 200-name window. */
export const PAD_ROSTER_NAME_LIMIT = PAD_ROSTER_LINE_LIMIT;
const READ_FILE_MAX_FILE_BYTES = 1_048_576;

export type PadInspectRejectReason = "path_escape" | "not_a_file";

export type PadInspectResult =
  | { readonly status: "list"; readonly names: readonly string[] }
  | {
      readonly status: "read";
      readonly content: string;
      readonly truncated: boolean;
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

function readOnePadFile(realPad: string, tmpPath: string): PadInspectResult {
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
  const buffer = readFileSync(realTarget);
  if (buffer.includes(0x00)) {
    return { status: "rejected", reason: "not_a_file" };
  }
  const { content, truncated } = formatReadFileSlice(buffer.toString("utf8"));
  return { status: "read", content, truncated };
}

export function inspectWorkerPad(
  padRoot: string | undefined,
  tmpPath?: string
): PadInspectResult {
  if (tmpPath !== undefined && !isValidRelativePadPath(tmpPath)) {
    return { status: "rejected", reason: "path_escape" };
  }
  if (tmpPath === undefined) return listPadEntries(padRoot);
  if (padRoot === undefined || !existsSync(padRoot)) {
    return { status: "rejected", reason: "path_escape" };
  }
  return readOnePadFile(realpathSync(padRoot), tmpPath);
}
