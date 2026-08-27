/**
 * src/tui/think-fold.ts
 *
 * thinking 折叠行文案纯函数（SSOT）——2026-08-14 修复「两套文案渲染不统一」：
 *
 *  - `chat-view.tsx` 流式折叠行旧文案 = `[思考] 思考中… N 秒` / `[思考] 思考了 N 秒`
 *    （秒数**叠加**在 `[思考]` 标记上）；
 *  - `message-blocks.tsx` 历史折叠行旧文案 = `思考了 N 秒` / 纯 `[思考]`
 *    （秒数**替换** `[思考]` 标记）。
 *
 * 本模块把两处收敛到同一纯函数，从源头统一文案：
 *
 *  - `formatThinkingFold(seconds)` — 历史消息 thinking 折叠行：
 *    - `seconds > 0` → `思考了 N 秒`（「思考了几秒」即带语义，不再叠加 `[思考]`
 *      前缀；与 message-blocks 历史行为一致）；
 *    - `seconds === 0` / `undefined` / 非正 → `[思考]`（不显「思考了 0 秒」
 *      伪精度；子秒 thinking 历史消息回落纯标记）。
 *  - `thinkingPeekLines(text, limit)` — 折叠态「思考中」正文预览窗口：思考
 *    进行中露出正文**末** ≤3 行（plans/model-idle-thinking-peek.md T2），
 *    frozen / turn 结束后调用方停止取窗口，折回纯摘要行。
 *  - `formatThinkingLive()` — 流式面板 thinking 折叠行（进行中）：
 *    - 恒返回 `思考中…`。实时递增的「思考中… N 秒」已下线 —— 思考中阶段的
 *      实时秒数与 mode 行运行时长视觉重复且语义混淆（mode 行 `· Xs` 是
 *      turn 运行总时长 ≠ 思考时间），「思考时长」只由事后 frozen 摘要
 *      `思考了 N 秒` 承担。保留本函数作为 SSOT 收口，便于将来切换成
 *      动画动词 / spinner 时集中调整文案。
 *
 * 纪律：纯函数、无 React 依赖、无 IO —— 与 run-stats.ts 同款，供单测直驱
 * （tests/tui/think-fold.test.ts）。调用方（chat-view.tsx / message-blocks.tsx）
 * 只调本模块，禁止在渲染层另写模板字符串。
 */

/** 历史折叠行纯 `[思考]` 标记（无秒数 / 子秒时）。 */
export const THINKING_FOLD_LINE = "[思考]";

/** 历史折叠行文案：`思考了 N 秒` 或 `[思考]`（秒数替换 [思考]，不叠加）。 */
export function formatThinkingFold(seconds: number | undefined): string {
  const s = Math.max(0, Math.floor(seconds ?? 0));
  if (s <= 0) return THINKING_FOLD_LINE;
  return `思考了 ${s} 秒`;
}

/** 流式折叠行文案（恒 `思考中…`，无实时秒数 — 见模块注释）。 */
export function formatThinkingLive(): string {
  return "思考中…";
}

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
