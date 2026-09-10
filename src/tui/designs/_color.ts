/**
 * src/tui/designs/_color.ts
 *
 * design-25 系面板共享的颜色数学（thinking-picker / memory-picker /
 * compact-progress）。
 *
 * 抽出来的原因：`mixHex` / `gradAt` / `triangleWindow` / `flowBorderColor`
 * 曾各自内联在 thinking-picker.tsx 与 memory-picker.tsx（外加各 design-* 的
 * 私有副本），三处必须逐字一致——任何一处漂移都会让面板换色。收敛到本文件
 * 后只有一份实现（design gallery 文件按该目录合同保持各自 inline 副本不
 * 动：每个 design 自包含、可独立预览）。
 *
 * 纯函数，无 React 依赖（tuiPalette 只作常量读取），可独立单测。
 */
import { tuiPalette } from "../theme.js";

/** 边框流光 4 相位周期（design-5/25 同款）。 */
export const BORDER_CYCLE_MS = 8_000;

/** hex → [r,g,b]（0..1）。非法输入回退 [1,1,1]。 */
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

/** a/b 按 t∈[0,1] 线性插值（越界 clamp）。 */
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

/** 3-stop 线性渐变 logoInk(0) → running(0.5) → logoGold(1)，design-25 同款。 */
export function gradAt(t: number): string {
  const k = Math.max(0, Math.min(1, t));
  if (k <= 0.5) return mixHex(tuiPalette.logoInk, tuiPalette.running, k * 2);
  return mixHex(tuiPalette.running, tuiPalette.logoGold, (k - 0.5) * 2);
}

/** 三角窗：中心 c、半宽 hw → [0,1] 强度（hw 外为 0）。 */
export function triangleWindow(i: number, c: number, hw: number): number {
  if (hw <= 0) return 0;
  const d = Math.abs(i - c);
  if (d >= hw) return 0;
  return 1 - d / hw;
}

/** 边框流光：相位 p ∈ [0, 4]，相邻 2 相位 RGB 插值。 */
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
