/**
 * web/src/components/UsageChip.tsx
 *
 * 上下文用量块（输入框下方状态条的右半部）：`X.Xk / Y.Yk` token 明细 +
 * 64px 进度条 + 百分比，三档色语义沿用原口径（<50% #7ab8ff / ≥50%
 * #d9a343 / >80% #c95d47，与 TUI context-bar.tsx 同值）；悬停 title 给出
 * 精确 token 值。
 *
 * 跨 package 镜像约束：三档色阈值与数值语义和 TUI src/tui/context-bar.tsx
 * 镜像同值 —— 修改任一侧必须同步另一侧（公式 / 三档色阈值双改）。
 *
 * 数值语义（迁移自 ContextUsageStrip，见 CONTEXT.md `context usage
 * (display)` 词条）：used = inputTokens + cacheReadInputTokens +
 * cacheCreationInputTokens（cache null → 0）；pct = round(used /
 * contextWindow × 100)。usage 为 null 或 contextWindow 缺失 → null。
 */
import { useMemo } from "react";
import type { TokenUsage } from "../api/types";

export type UsageChipProps = {
  readonly usage: TokenUsage | null;
  readonly contextWindow: number | null;
  readonly sending?: boolean;
};

// 三档色阈值与 TUI src/tui/context-bar.tsx（contextColor / CTX_BLUE）跨
// package 镜像同值 —— 修改任一侧必须同步另一侧。
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
    if (usage === null || contextWindow === null || contextWindow <= 0) {
      return null;
    }
    const used = ctxUsed(usage);
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
  // sending 时轻微透明，与 ContextUsageStrip 现有口径一致（读数滞后一帧）。
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
