/**
 * src/tui/text.ts — TUI 共享文本工具。
 *
 * 单行截断（SSOT）：列表行 / 状态栏 / 工具摘要行三处此前各写了一份
 * clip（code review findings），收敛到这里。
 */

/** 压扁空白为单空格后按可视宽度截断，超长以 … 结尾。 */
export function clipOneLine(s: string, max: number): string {
  const oneLine = s.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}
