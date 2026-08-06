/**
 * src/tui/text.ts — TUI 共享文本工具。
 *
 * 单行截断（SSOT）：列表行 / 状态栏 / 工具摘要行三处此前各写了一份
 * clip（code review findings），收敛到这里。
 *
 * 行级滚动（#146 任务 A → 行级重构）：用 `wrapText` / `wrapTextVisual` 把
 * 单条文本按 cols 拆成物理行数组，供 ChatView 的行级滚动窗口消费。
 *  - `wrapText`：按字符数折（历史行为，保留向后兼容）；
 *  - `wrapTextVisual`：按视觉宽度折（banner.js visualWidth，CJK 占 2 列）。
 *    ink `wrap="wrap"` 按终端列数折，故行级窗口账目必须用视觉宽度。
 *  空文本返回 [""]，不返回 [] —— 保证 message 至少占 1 行。
 */
import { visualWidth } from "./banner.js";

/** 压扁空白为单空格后按可视宽度截断，超长以 … 结尾。 */
export function clipOneLine(s: string, max: number): string {
  const oneLine = s.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

/**
 * 按**视觉宽度**把 s 折行（visualWidth SSOT：CJK / 全角按 2 列）。
 * ink 的 `wrap="wrap"` 按终端列数折（CJK 占 2 列），故行级窗口账目必须用
 * 视觉宽度而非字符数——`wrapText`（字符数）对中文内容低估近 2×，是 #189
 * 滚动渲染漂移的根因之一。贪心逐字符累加，按视觉宽度判断折行（CJK 无词界
 * 可切；ASCII 长 token 超宽时按宽度硬切，与 ink 行为一致）。
 * 空字符串返回 [""]；max <= 0 返回 [s]。
 */
export function wrapTextVisual(s: string, max: number): string[] {
  if (s.length === 0) return [""];
  if (max <= 0) return [s];
  const out: string[] = [];
  for (const para of s.split("\n")) {
    if (para.length === 0) {
      out.push("");
      continue;
    }
    let line = "";
    let bufW = 0;
    for (const ch of para) {
      const cw = visualWidth(ch);
      if (bufW + cw > max && line.length > 0) {
        out.push(line);
        line = ch;
        bufW = cw;
      } else {
        line += ch;
        bufW += cw;
      }
    }
    if (line.length > 0) out.push(line);
  }
  return out;
}

/**
 * 按 max 字符宽度把 s 折行（近似英文 word wrap；中文按字符切；CJK 不拆字）。
 * 空字符串返回 [""]，调用方可统一按 `result.length` 算行数。
 */
export function wrapText(s: string, max: number): string[] {
  if (s.length === 0) return [""];
  if (max <= 0) return [s];
  const lines: string[] = [];
  // 按显式换行符预切：每段再独立折行。
  const paragraphs = s.split("\n");
  for (const para of paragraphs) {
    if (para.length === 0) {
      lines.push("");
      continue;
    }
    let buf = "";
    for (const ch of para) {
      const candidate = buf + ch;
      if (candidate.length > max && buf.length > 0) {
        lines.push(buf);
        buf = ch;
      } else {
        buf = candidate;
      }
    }
    if (buf.length > 0) lines.push(buf);
  }
  return lines;
}
