/**
 * src/tui/text.ts — TUI 共享文本工具。
 *
 * 单行截断（SSOT）：列表行 / 状态栏 / 工具摘要行三处此前各写了一份
 * clip（code review findings），收敛到这里。
 *
 * 行级滚动（#146 任务 A → 行级重构）：用 `wrapText` 把单条文本按 cols
 * 拆成物理行数组，供 ChatView 的行级滚动窗口消费（估算 message 物理行数）。
 * wrap 是按字节计数（不接 visualWidth，markdown 子块行级估计由
 * message-rows.ts 的 `measureMessage` 各自处理）；空文本返回 [""]，
 * 不返回 [] —— 保证 message 至少占 1 行。
 */

/** 压扁空白为单空格后按可视宽度截断，超长以 … 结尾。 */
export function clipOneLine(s: string, max: number): string {
  const oneLine = s.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

/**
 * 按 max 字节宽度把 s 折行（近似英文 word wrap；中文按字符切；CJK 不拆字）。
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
