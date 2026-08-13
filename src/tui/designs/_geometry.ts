/**
 * src/tui/designs/_geometry.ts
 *
 * 思考面板 5 档进度条共享几何（design-22 及其底色变体共用）。
 *
 * 背景：5 档进度条要有"每个断点对齐一个档位"的视觉，标签必须几何居中到
 * 5 个等宽段的中点。三处细节决定成败：
 *   1. barLen 必须能被 5 整除（5 段等宽，max 段贴右边 → max 完全填充）；
 *   2. 每段中点 = `segLen * i + (segLen - 1) / 2`，标签中心对准该列；
 *   3. 标签宽度不一（low=3 / medium=6 / xhigh=5 / max=3），统一用
 *      `labelPad(segLen, label) → { lead, pad }` 把标签包在段中点的两侧
 *      空格里（单字符宽假设，OpenTUI 等宽终端成立）。
 *
 * 所有数值都以"内宽 innerCols"为输入，输出纯几何量，不涉及任何颜色 /
 * 动效——颜色与动画由各 design 自取（灰阶填充、呼吸、流光边界等变体）。
 */
import type { EffortLevel } from "./_contract.js";

/** 5 档短名（与 EFFORT_LEVELS 同序）。 */
export const LEVEL_LABELS: ReadonlyArray<EffortLevel> = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

/** 档位数量（5）。 */
export const SEG_COUNT = LEVEL_LABELS.length;

/** 进度条总长：向下取整到 5 的倍数，且至少 15 列（5 段 × 3 列可读）。 */
export function floorTo5BarLen(innerCols: number): number {
  return Math.max(15, innerCols - (innerCols % 5));
}

/** 每段等宽 = barLen / 5。 */
export function segmentLen(barLen: number): number {
  return barLen / 5;
}

/** 档 i 中点列坐标（0-based，落在进度条内）。 */
export function levelCenter(barLen: number, i: number): number {
  const segLen = segmentLen(barLen);
  return segLen * i + (segLen - 1) / 2;
}

/** 档 i 占用的列区间 [start, end)，供 bg 分段染色。 */
export function levelRange(
  barLen: number,
  i: number
): { readonly start: number; readonly end: number } {
  const segLen = segmentLen(barLen);
  return { start: segLen * i, end: segLen * (i + 1) };
}

/**
 * 标签居中定位：给定标签文本与其所在段中点列坐标，返回该标签前 / 后的
 * 空格数，使其中心对齐到中点（单字符宽假设）。lead 与 pad 均 ≥ 0，
 * pad 为空则尾部对齐（max 段 = 进度条右缘）。
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
