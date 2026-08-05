/**
 * 停止原因 + 轮次元信息（T6）。
 * 仅当 stopReason 非 completed 或 turnCount > 1 时渲染一行 quiet mono 元信息。
 * 文案映射见 lib/stop-reason；本组件只负责布局（warn 文案在前 + 轮次计数在后）。
 */
import type { StopReason } from "../api/types";
import { stopReasonLabel } from "../lib/stop-reason";

export type StopNoticeProps = {
  /** 缺失时按 null 处理 → 不显示。 */
  stopReason?: StopReason;
  /** 缺失 / ≤ 1 时不显示（"N 轮"）。 */
  turnCount?: number;
};

export function StopNotice({ stopReason, turnCount }: StopNoticeProps) {
  const notice = stopReasonLabel(stopReason);
  const showTurnCount =
    typeof turnCount === "number" &&
    Number.isFinite(turnCount) &&
    turnCount > 1;

  if (notice === null && !showTurnCount) return null;

  return (
    <div
      className="mt-[10px] flex flex-wrap items-center gap-x-[9px] gap-y-[3px] font-mono text-[11px] leading-[1.5]"
      aria-live="polite"
    >
      {notice !== null ? <span className="text-warn">{notice}</span> : null}
      {showTurnCount ? (
        <span className="text-ink-3">{turnCount} 轮</span>
      ) : null}
    </div>
  );
}
