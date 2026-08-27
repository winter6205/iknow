/**
 * src/tui/fence-display-cap.ts
 *
 * TUI markdown 围栏在 OpenTUI 树上的可见行窗（与 write/edit 完成态
 * `TOOL_PREVIEW_WINDOW` 分开）。只裁树上的行，不改 session 正文。
 */
export const FENCE_DISPLAY_WINDOW = 32;

export type FenceDisplayClip = {
  readonly visible: readonly string[];
  readonly hiddenLineCount: number;
};

function resolveFenceWindow(window: number | undefined): number {
  if (
    window === undefined ||
    typeof window !== "number" ||
    !Number.isFinite(window) ||
    window <= 0
  ) {
    return FENCE_DISPLAY_WINDOW; // EXIT: missing / non-positive / non-finite
  }
  return Math.floor(window);
}

/** 围栏行显示窗：超出则只留前 N 行并给出未挂行数。 */
export function clipFenceDisplayLines(
  lines: unknown,
  window?: number
): FenceDisplayClip {
  if (!Array.isArray(lines)) {
    throw new TypeError("fence display lines must be an array of strings");
  }
  const visibleSource: string[] = [];
  for (const line of lines) {
    if (typeof line !== "string") {
      throw new TypeError("fence display lines must be an array of strings");
    }
    visibleSource.push(line);
  }
  const cap = resolveFenceWindow(window);
  if (visibleSource.length <= cap) {
    return { visible: visibleSource, hiddenLineCount: 0 };
  }
  return {
    visible: visibleSource.slice(0, cap),
    hiddenLineCount: visibleSource.length - cap,
  };
}
