/**
 * src/tui/think-fold.ts
 *
 * thinking 折叠行文案纯函数（SSOT）。人读合同（specs/tui-human-display.md
 * D1/D2 + docs/CONTEXT.md `live tool line` / `unit fold`）：
 *
 *  - `formatThinkingFold(seconds)` — 结束态折叠行：有限且 `seconds > 0` →
 *    英文 `Thought for <duration>`（唯一结束态文案，不叠加 `[思考]`，不回落
 *    中文）；缺省 / 非正 / 非有限 → 空串（不造 0 秒行）。
 *    `unit fold` 只保留英文 `Thought for <duration>` 一种时长形态 ——
 *    渲染层把计数焊在同一行（turn-activity.ts），本函数只产时长段。
 *  - `thinkingPeekLines(text, limit)` — 折叠态「思考中」正文预览窗口：思考
 *    进行中露出正文**末** ≤3 行（plans/model-idle-thinking-peek.md T2），
 *    frozen / turn 结束后调用方停止取窗口，折回纯摘要行。
 *  - `formatThinkingLive()` — 流式面板 thinking 折叠行（进行中）：恒
 *    `Thinking…`。实时递增秒数已下线 —— 思考中阶段的实时秒数与 mode 行
 *    运行时长视觉重复且语义混淆（mode 行 `· Xs` 是 turn 运行总时长 ≠
 *    思考时间），「思考时长」只由事后 frozen 摘要承担。
 *
 * 纪律：纯函数、无 React 依赖、无 IO —— 与 run-stats.ts 同款，供单测直驱
 * （tests/tui/think-fold.test.ts）。调用方（chat-view.tsx / message-blocks.tsx）
 * 只调本模块，禁止在渲染层另写模板字符串。
 */

/** 结束态折叠行：`Thought for <N>s`；无可用秒数 → 空串。 */
export function formatThinkingFold(seconds: number | undefined): string {
  const s = Math.floor(seconds ?? 0);
  if (!Number.isFinite(s) || s <= 0) return "";
  return `Thought for ${s}s`;
}

/** 流式折叠行文案（恒 `Thinking…`，无实时秒数 — 见模块注释）。
 *  实现在 `src/shared/tool-line.ts` —— CLI 的 spinner（D1：CLI 与 TUI 共用）
 *  与 TUI 折叠行必须同一文案，CLI import src/tui 是反向分层。 */
export { formatThinkingLive } from "../shared/tool-line.js";

/** 折叠态思考预览的行数硬顶（计划 T2：末 2–3 行，取上限 3）。 */
export const THINKING_PEEK_MAX_LINES = 3;

/**
 * 折叠态「思考中」正文预览：取 `text` 末尾至多 `limit` 行（缺省 = 上限 3）。
 *
 * - 空行 / 纯空白行不占额度 —— 流式 thinking 常以 markdown 段落分隔，空行
 *   吃掉额度会让预览「只剩一行正文」；
 * - 行尾空白与 CR 一并剥掉 —— 渲染层按可见字符排版；
 * - `limit` 硬夹在 `[0, THINKING_PEEK_MAX_LINES]`：预览是有界窗口，调用方
 *   传多大都不得越过 3 行高度上限（折叠态高度与思考全文长度无关）。
 */
export function thinkingPeekLines(
  text: string,
  limit: number = THINKING_PEEK_MAX_LINES
): ReadonlyArray<string> {
  const take = Math.min(
    THINKING_PEEK_MAX_LINES,
    Math.max(0, Math.floor(limit))
  );
  if (take === 0 || text === "") return [];
  const lines: string[] = [];
  const all = text.split("\n");
  for (let i = all.length - 1; i >= 0 && lines.length < take; i--) {
    const line = (all[i] ?? "").replace(/\s+$/u, "");
    if (line.trim() === "") continue; // 空行不占预览额度
    lines.push(line);
  }
  return lines.reverse();
}
