/**
 * Visual-width helpers (SSOT = string-width): shared text utilities that
 * measure by terminal display width (CJK counts as 2 columns).
 *
 * padEndVisual used to be duplicated in banner.ts / markdown.tsx; new
 * width-aware helpers (clipVisual etc.) also belong here.
 */
import stringWidth from "string-width";

/** Right-pad with spaces to the target visual width (returned as-is when already wider). */
export function padEndVisual(s: string, width: number): string {
  const w = stringWidth(s);
  return w >= width ? s : s + " ".repeat(width - w);
}
