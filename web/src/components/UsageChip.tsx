/**
 * web/src/components/UsageChip.tsx
 *
 * Context-usage block (right half of the status bar under the input): `X.Xk /
 * Y.Yk` token breakdown + 64px progress bar + percentage. Three-tier color
 * semantics unchanged (<50% #7ab8ff / ≥50% #d9a343 / >80% #c95d47, same values
 * as TUI context-bar.tsx); hover title shows exact token counts.
 *
 * Cross-package mirror constraint: the three color thresholds and numeric
 * semantics mirror TUI src/tui/context-bar.tsx — changing either side must
 * sync the other (formula / thresholds change together).
 *
 * Numeric semantics (migrated from ContextUsageStrip, see CONTEXT.md
 * `context usage (display)`): used = inputTokens + cacheReadInputTokens +
 * cacheCreationInputTokens (null cache → 0); pct = round(used /
 * contextWindow × 100). Missing contextWindow → null; null usage (no reading
 * before the first turn) → render as 0 (the strip is always present; it does
 * not wait for a computed value to appear).
 */
import { useMemo } from "react";
import type { TokenUsage } from "../api/types";

export type UsageChipProps = {
  readonly usage: TokenUsage | null;
  readonly contextWindow: number | null;
  readonly sending?: boolean;
};

// Three-tier colors mirror TUI src/tui/context-bar.tsx (contextColor / CTX_BLUE)
// cross-package — changing either side must sync the other.
const COLOR_SAFE = "#7ab8ff";
const COLOR_WARN = "#d9a343";
const COLOR_ALERT = "#c95d47";

function ctxUsed(u: TokenUsage): number {
  return (
    u.inputTokens +
    (u.cacheReadInputTokens ?? 0) +
    (u.cacheCreationInputTokens ?? 0)
  );
}

function fmtK(n: number): string {
  return `${(n / 1000).toFixed(1)}k`;
}

export function UsageChip({
  usage,
  contextWindow,
  sending = false,
}: UsageChipProps) {
  const detail = useMemo(() => {
    if (contextWindow === null || contextWindow <= 0) {
      return null;
    }
    // usage absent (before first turn) → used=0: the strip persists, never hidden awaiting a reading.
    const used = usage === null ? 0 : ctxUsed(usage);
    return {
      used,
      pct: Math.round((used / contextWindow) * 100),
      label: `${fmtK(used)} / ${fmtK(contextWindow)}`,
      title: `${used.toLocaleString("en-US")} / ${contextWindow.toLocaleString(
        "en-US"
      )} tokens`,
    };
  }, [usage, contextWindow]);

  if (detail === null) return null;

  const color =
    detail.pct > 80 ? COLOR_ALERT : detail.pct >= 50 ? COLOR_WARN : COLOR_SAFE;
  // Slight transparency while sending, matching ContextUsageStrip's existing behavior (reading lags one frame).
  const style = sending ? { color, opacity: 0.85 } : { color };

  return (
    <span
      title={detail.title}
      style={style}
      className="flex shrink-0 items-center gap-1.5 font-mono text-[10px] leading-none"
    >
      <span>{detail.label}</span>
      <span
        aria-hidden="true"
        className="relative h-[3px] w-16 overflow-hidden rounded-full bg-ink-3/20"
      >
        <span
          className="absolute inset-y-0 left-0 rounded-full"
          style={{
            width: `${Math.min(detail.pct, 100)}%`,
            backgroundColor: color,
          }}
        />
      </span>
      <span>{detail.pct}%</span>
    </span>
  );
}
