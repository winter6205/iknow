/**
 * Visible-line window for TUI markdown fences on the OpenTUI tree (separate
 * from `TOOL_PREVIEW_WINDOW` used by write/edit completion states).
 * Trims tree rows only; never touches session content.
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

/** Fence display window: keep the first N lines when over cap, report the hidden line count. */
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
