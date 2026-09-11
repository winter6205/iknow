/**
 * bash 结果预览：先把 progress tick / `\r` 原地覆盖收成一行，再交给
 * takeTailWindow。分类只看剥 ANSI 后的可见文本。
 */

const ANSI_ESCAPE_RE =
  /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

/** `Updating files: N%` / 光秃 `N%` / 可选 `(a/b)` 与 `, done.`。 */
const PROGRESS_TICK_RE =
  /^(?:[A-Za-z][\w .]*:\s+)?\d+%\s*(?:\([^)]*\))?(?:,\s*done\.)?\s*$/;

/** `\r` = 原地覆盖：同一物理行只留最后一个片段。行尾单独 `\r` 当 CRLF 残渣丢掉。 */
export function resolveCarriageOverwrite(line: string): string {
  const withoutCrlfTrail = line.endsWith("\r") ? line.slice(0, -1) : line;
  const idx = withoutCrlfTrail.lastIndexOf("\r");
  return idx === -1 ? withoutCrlfTrail : withoutCrlfTrail.slice(idx + 1);
}

export function isProgressTick(line: string): boolean {
  const visible = line.replace(ANSI_ESCAPE_RE, "").trim();
  return PROGRESS_TICK_RE.test(visible);
}

/** 连续 progress tick 塌成最后一跳；非进度行原样保留。 */
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

/** 切物理行（兼容 CRLF）→ `\r` 覆盖 → 折连续 tick。 */
export function foldBashPreviewLines(raw: string): readonly string[] {
  if (raw.length === 0) return [];
  const split = raw.split(/\r?\n/);
  const physical = split[split.length - 1] === "" ? split.slice(0, -1) : split;
  return foldProgressTicks(physical.map(resolveCarriageOverwrite));
}
