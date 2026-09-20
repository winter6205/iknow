/**
 * Shared color math for design-25-family panels (thinking-picker /
 * memory-picker / compact-progress).
 *
 * mixHex / gradAt / triangleWindow / flowBorderColor were inlined in
 * thinking-picker.tsx, memory-picker.tsx and private copies in each
 * design-*; all copies had to stay byte-identical or panel colors drifted.
 * This file is the single implementation. Design gallery files keep their
 * own inline copies by convention: each design is self-contained and
 * independently previewable.
 *
 * Pure functions, no React dependency (tuiPalette read as constants only);
 * unit-testable standalone.
 */
import { tuiPalette } from "../theme.js";

/** Border flow: 4-phase cycle. */
export const BORDER_CYCLE_MS = 8_000;

/** hex → [r,g,b] (0..1). Falls back to [1,1,1] on invalid input. */
export function hexToRgb(hex: string): readonly [number, number, number] {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex);
  if (!m) return [1, 1, 1];
  const v = parseInt(m[1]!, 16);
  return [
    ((v >> 16) & 0xff) / 255,
    ((v >> 8) & 0xff) / 255,
    (v & 0xff) / 255,
  ] as const;
}

/** Linear interpolation of a/b over t in [0,1] (clamped). */
export function mixHex(a: string, b: string, t: number): string {
  const tt = Math.max(0, Math.min(1, t));
  const [ar, ag, ab] = hexToRgb(a);
  const [br, bg, bb] = hexToRgb(b);
  const r = Math.round((ar + (br - ar) * tt) * 255);
  const g = Math.round((ag + (bg - ag) * tt) * 255);
  const bl = Math.round((ab + (bb - ab) * tt) * 255);
  return `#${r.toString(16).padStart(2, "0")}${g
    .toString(16)
    .padStart(2, "0")}${bl.toString(16).padStart(2, "0")}`;
}

/** 3-stop linear gradient logoInk(0) → running(0.5) → logoGold(1). */
export function gradAt(t: number): string {
  const k = Math.max(0, Math.min(1, t));
  if (k <= 0.5) return mixHex(tuiPalette.logoInk, tuiPalette.running, k * 2);
  return mixHex(tuiPalette.running, tuiPalette.logoGold, (k - 0.5) * 2);
}

/** Triangle window: center c, half-width hw → [0,1] intensity (0 outside hw). */
export function triangleWindow(i: number, c: number, hw: number): number {
  if (hw <= 0) return 0;
  const d = Math.abs(i - c);
  if (d >= hw) return 0;
  return 1 - d / hw;
}

/** Border flow color: phase p in [0, 4], interpolate between adjacent phase RGBs. */
export function flowBorderColor(phase: number): string {
  const n = 4;
  const idx = Math.floor(phase) % n;
  const f = phase - Math.floor(phase);
  const tokens = [
    tuiPalette.logoInk,
    tuiPalette.running,
    tuiPalette.logoGold,
    tuiPalette.running,
  ];
  const a = tokens[idx]!;
  const b = tokens[(idx + 1) % n]!;
  return mixHex(a, b, f);
}
