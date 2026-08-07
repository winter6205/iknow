/**
 * web/src/components/ContextUsageStrip.tsx
 *
 * T6 (#TBD): Web 上下文用量条 — 三档色容量条（与 TUI ContextBar 同视觉，
 * 原型 f3afc37 variant3-single.tsx 形态 `上下文 █░ band NN% 状态 X.Xk/Y.Yk`）。
 *
 * 数值语义（本计划裁决 1）：used = inputTokens + cacheReadInputTokens +
 * cacheCreationInputTokens（cache null → 0，Anthropic 三类 token 互不相交，
 * 合计 = 本回合模型看到的完整上下文）；pct = round(used / contextWindow × 100)。
 *
 * 三档色阈值 <50% 安全 / 50-80% 注意 / >80% 告警，与 TUI theme.ts:61-62 同
 * hex（#7d8a82 / #d9a343 / #c95d47，inline；tokens.css 现有 --color-warn /
 * --color-danger 与 TUI 数值不一致，未复用以保证 TUI / Web 颜色严格对齐）。
 * usage 或 contextWindow 为 null → 单行 `上下文 — 待首轮`（dim）。
 * 纯组件：useMemo 算 pct/used；无 effect；窄屏不折叠（AppShell footer 已是
 * flex column，按 container 宽度自适应）。
 */
import { useMemo } from "react";
import type { TokenUsage } from "../api/types";

export type ContextUsageStripProps = {
  readonly usage: TokenUsage | null;
  readonly contextWindow: number | null;
  readonly sending: boolean;
};

// 三档色（与 TUI theme.ts:61-62 同值，inline 保 TUI / Web 一致）。
const COLOR_SAFE = "#7d8a82";
const COLOR_WARN = "#d9a343";
const COLOR_ALERT = "#c95d47";

/** 容量条：█ 填充 + ░ 空余（与 TUI context-bar.tsx valueBand 同公式）。 */
function valueBand(pct: number, width = 10): string {
  const clamped = Math.max(0, Math.min(100, pct));
  const filled = Math.round((clamped / 100) * width);
  return "█".repeat(filled) + "░".repeat(width - filled);
}

/** 上下文 token 用量合计（裁决 1）：cache 空字段按 0 处理。 */
function ctxUsed(u: TokenUsage): number {
  return (
    u.inputTokens +
    (u.cacheReadInputTokens ?? 0) +
    (u.cacheCreationInputTokens ?? 0)
  );
}

export function ContextUsageStrip({
  usage,
  contextWindow,
  sending,
}: ContextUsageStripProps) {
  // useMemo 兜底：null 场景也走同一 memo，仅返回零值（保持 hook 顺序稳定）。
  const { pct, used, windowTokens } = useMemo(() => {
    if (usage === null || contextWindow === null || contextWindow <= 0) {
      return { pct: 0, used: 0, windowTokens: 0 };
    }
    const tokens = ctxUsed(usage);
    return {
      pct: Math.round((tokens / contextWindow) * 100),
      used: tokens,
      windowTokens: contextWindow,
    };
  }, [usage, contextWindow]);

  if (usage === null || contextWindow === null || contextWindow <= 0) {
    return (
      <div
        className="mx-auto flex w-full max-w-[var(--chat-max)] items-center gap-2 px-4 pb-1 pt-2 text-xs"
        style={{ color: "var(--color-ink-3)" }}
      >
        <span>上下文 — 待首轮</span>
      </div>
    );
  }

  const color = pct > 80 ? COLOR_ALERT : pct >= 50 ? COLOR_WARN : COLOR_SAFE;
  const status = pct > 80 ? "告警" : pct >= 50 ? "注意" : "安全";
  // sending 时轻微透明，反映「正在跑、读数滞后」一帧（无 effect，与 TUI
  // 600ms 脉动同语义但 web 侧不依赖定时器，避免污染纯组件约束）。
  const rowStyle = sending ? { opacity: 0.85 } : undefined;

  return (
    <div
      className="mx-auto flex w-full max-w-[var(--chat-max)] items-center gap-2 px-4 pb-1 pt-2 font-mono text-xs"
      style={rowStyle}
    >
      <span style={{ color }}>{valueBand(pct, 10)}</span>
      <span style={{ color }}>{pct}%</span>
      <span style={{ color }}>{status}</span>
      <span style={{ color: "var(--color-ink-3)" }}>
        {(used / 1000).toFixed(1)}k/{(windowTokens / 1000).toFixed(1)}k
      </span>
    </div>
  );
}
