/**
 * src/tui/run-stats.ts
 *
 * 运行时长 + token 统计的纯格式化模块（mode 指示行右侧的总结段）。
 *
 * 输出形态（2026-08-14 需求）：`3m 46s · ↓ 1.5k tokens`。
 *  - 时长：`formatRunDuration` — <60s 用 `46s`；≥60s 用 `3m 46s`；≥60m 用
 *    `1h 5m`（分秒两段，与参考形态一致，不做更细粒度）。
 *  - token：`formatRunTokens` — 仅统计 output tokens（用户参考形态 `↓ 1.5k`
 *    是产出量；输入侧含 cache 语义，不混入）。null / 0 → 省略 token 段。
 *
 * 纪律：纯函数、无 React 依赖、无 IO —— 与 tool-summary.ts 同款，供单测直驱。
 * 视觉宽度不截断（由调用方 mode 行整体宽度预算决定，见 app.tsx 接线处）。
 */

/** 秒数 → `46s` / `3m 46s` / `1h 5m`。负值 / NaN 兜底 0。 */
export function formatRunDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds) || 0);
  const hours = Math.floor(s / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const seconds = s % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

/**
 * output tokens → `↓ 1.5k`。null / 0 / NaN → 空串（调用方据此省略 token 段）。
 * 千分位口径与 context-bar 同款：`(n / 1000).toFixed(1)`。
 */
export function formatRunTokens(
  outputTokens: number | null | undefined
): string {
  if (
    outputTokens === null ||
    outputTokens === undefined ||
    !Number.isFinite(outputTokens) ||
    outputTokens <= 0
  ) {
    return "";
  }
  return `↓ ${(outputTokens / 1000).toFixed(1)}k`;
}

/**
 * 完整总结段：`3m 46s · ↓ 1.5k tokens`。token 段缺席时只有时长
 * （`3m 46s`，不带 `·`）。
 */
export function formatRunStats(
  totalSeconds: number,
  outputTokens: number | null | undefined
): string {
  const duration = formatRunDuration(totalSeconds);
  const tokens = formatRunTokens(outputTokens);
  return tokens === "" ? duration : `${duration} · ${tokens} tokens`;
}
