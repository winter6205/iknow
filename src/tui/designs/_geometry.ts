/**
 * Shared geometry for the 5-level progress bar (design-22 and its
 * background-shade variants).
 *
 * Why: each breakpoint of the 5-level bar must visually align with a level,
 * so labels are geometrically centered on the midpoints of 5 equal-width
 * segments. Three details matter:
 *   1. barLen must be divisible by 5 (equal segments; the max segment hugs
 *      the right edge → max renders fully filled);
 *   2. segment midpoint = `segLen * i + (segLen - 1) / 2`, label center
 *      targets that column;
 *   3. labels vary in width (low=3 / medium=6 / xhigh=5 / max=3), so
 *      `labelPad(segLen, label) → { lead, pad }` wraps each label in spaces
 *      around its segment midpoint (single-char-width assumption, valid for
 *      OpenTUI monospace terminals).
 *
 * All functions take inner width (innerCols) and return pure geometry —
 * no colors or animation; each design picks its own variants (gray fill,
 * breathing, flow border, etc.).
 */
import type { EffortLevel } from "./_contract.js";

/** Short level names (same order as EFFORT_LEVELS). */
export const LEVEL_LABELS: ReadonlyArray<EffortLevel> = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

/** Number of levels (5). */
export const SEG_COUNT = LEVEL_LABELS.length;

/** Total bar length: floored to a multiple of 5, minimum 15 cols (5 segments × 3). */
export function floorTo5BarLen(innerCols: number): number {
  return Math.max(15, innerCols - (innerCols % 5));
}

/** Equal segment width = barLen / 5. */
export function segmentLen(barLen: number): number {
  return barLen / 5;
}

/** Column coordinate of level i's midpoint (0-based, within the bar). */
export function levelCenter(barLen: number, i: number): number {
  const segLen = segmentLen(barLen);
  return segLen * i + (segLen - 1) / 2;
}

/** Column range [start, end) occupied by level i, for background segment tinting. */
export function levelRange(
  barLen: number,
  i: number
): { readonly start: number; readonly end: number } {
  const segLen = segmentLen(barLen);
  return { start: segLen * i, end: segLen * (i + 1) };
}

/**
 * Label centering: given label text and its segment-midpoint column, return
 * leading / trailing space counts so the label center aligns with the
 * midpoint (single-char-width assumption). lead and pad are both ≥ 0; when
 * pad is empty the label is tail-aligned (max segment = right bar edge).
 */
export function labelPad(
  segLen: number,
  label: string
): { readonly lead: number; readonly pad: number } {
  const left = (segLen - label.length) / 2;
  const lead = Math.max(0, Math.floor(left));
  const pad = Math.max(0, segLen - label.length - lead);
  return { lead, pad };
}
