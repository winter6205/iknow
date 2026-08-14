/**
 * src/tui/run-stats.ts
 *
 * 运行时长 / 压缩耗时的纯格式化模块（mode 指示行右侧的总结段）。
 *
 *  - `formatRunDuration` — 秒数 → `46s` / `3m 46s` / `1h 5m`（<60s 用 `46s`；
 *    ≥60s 用 `3m 46s`；≥60m 用 `1h 5m`，分秒两段，不做更细粒度）。
 *  - `formatCrunched` — 压缩耗时总结段：`Crunched for 3m 46s`。非正 / 子秒
 *    turn 返回空串（调用方据此省略段，不渲染无意义的 `Crunched for 0s`）。
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
 * 压缩耗时总结段：`Crunched for 3m 46s`。非正 / NaN / 子秒 → 空串
 * （子秒 turn 渲染 `Crunched for 0s` 无意义）。防御性钳制 —— 调用方
 * （ChatView）已用 `(crunchedSeconds ?? 0) > 0` gate 排除非正输入，本函数
 * 的 `<=0 → ""` 分支是双保险，两者需保持同步（改 gate 必改本钳制）。
 */
export function formatCrunched(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds) || 0);
  if (s <= 0) return "";
  return `Crunched for ${formatRunDuration(s)}`;
}
