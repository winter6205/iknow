/**
 * src/tui/visual.ts
 *
 * 视觉宽度辅助（SSOT = string-width）：TUI 各模块共用的「按终端视觉宽度
 * （CJK 占 2 列）处理文本」工具。
 *
 * 此前 banner.ts / markdown.tsx 各持一份相同 padEndVisual 实现（Fowler
 * 重复代码，同一仓库两份相同实现）——抽到本模块统一引用，后续新增视觉
 * 宽度工具（clipVisual 等）也收敛到本文件。
 */
import stringWidth from "string-width";

/** 按视觉宽度右补空格到目标列宽（超过目标列宽时原样返回）。 */
export function padEndVisual(s: string, width: number): string {
  const w = stringWidth(s);
  return w >= width ? s : s + " ".repeat(width - w);
}
