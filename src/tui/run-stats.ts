/**
 * Pure formatting for run duration / compaction duration (summary segment on
 * the right of the mode indicator line).
 *
 *  - `formatRunDuration` — seconds → `46s` / `3m 46s` / `1h 5m`
 *    (<60s uses `46s`; ≥60s uses `3m 46s`; ≥60m uses `1h 5m` —
 *    two segments max, no finer granularity).
 *  - `formatCrunched` — compaction summary segment: `Crunched for 3m 46s`.
 *    Non-positive / sub-second turns return "" so the caller omits the
 *    segment instead of rendering a meaningless `Crunched for 0s`.
 *
 * Discipline: pure function, no React, no IO — same as tool-summary.ts,
 * driven directly by unit tests. No visual-width truncation here (the
 * caller budgets the whole mode-line width, see the app.tsx wiring).
 */

/** Seconds → `46s` / `3m 46s` / `1h 5m`. Negative / NaN clamp to 0. */
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
 * Compaction summary segment: `Crunched for 3m 46s`. Non-positive / NaN /
 * sub-second → "" (a `Crunched for 0s` line is meaningless). Defensive
 * clamp — the caller (ChatView) already gates on
 * `(crunchedSeconds ?? 0) > 0`, so the `<=0 → ""` branch here is a second
 * line of defense; keep both in sync (changing the gate requires updating
 * this clamp).
 */
export function formatCrunched(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds) || 0);
  if (s <= 0) return "";
  return `Crunched for ${formatRunDuration(s)}`;
}
