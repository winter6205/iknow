/**
 * Bash result preview: collapse progress ticks / `\r` in-place overwrites
 * into single lines first, then hand off to takeTailWindow. Classification
 * looks only at visible text after stripping ANSI.
 */

const ANSI_ESCAPE_RE =
  /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

/** `Updating files: N%` / bare `N%` / optional `(a/b)` and `, done.`. */
const PROGRESS_TICK_RE =
  /^(?:[A-Za-z][\w .]*:\s+)?\d+%\s*(?:\([^)]*\))?(?:,\s*done\.)?\s*$/;

/** `\r` = in-place overwrite: keep only the last fragment of a physical line. A lone trailing `\r` is CRLF residue, dropped. */
export function resolveCarriageOverwrite(line: string): string {
  const withoutCrlfTrail = line.endsWith("\r") ? line.slice(0, -1) : line;
  const idx = withoutCrlfTrail.lastIndexOf("\r");
  return idx === -1 ? withoutCrlfTrail : withoutCrlfTrail.slice(idx + 1);
}

export function isProgressTick(line: string): boolean {
  const visible = line.replace(ANSI_ESCAPE_RE, "").trim();
  return PROGRESS_TICK_RE.test(visible);
}

/** Collapse consecutive progress ticks into the last one; non-progress lines pass through unchanged. */
export function foldProgressTicks(lines: readonly string[]): readonly string[] {
  const out: string[] = [];
  for (const line of lines) {
    const prev = out[out.length - 1];
    if (isProgressTick(line) && prev !== undefined && isProgressTick(prev)) {
      out[out.length - 1] = line;
      continue;
    }
    out.push(line);
  }
  return out;
}

/** Split physical lines (CRLF-tolerant) → resolve `\r` overwrites → fold consecutive ticks. */
export function foldBashPreviewLines(raw: string): readonly string[] {
  if (raw.length === 0) return [];
  const split = raw.split(/\r?\n/);
  const physical = split[split.length - 1] === "" ? split.slice(0, -1) : split;
  return foldProgressTicks(physical.map(resolveCarriageOverwrite));
}
