/**
 * Stop-reason + turn-count meta line.
 * Renders one quiet mono meta line only when stopReason is not completed or turnCount > 1.
 * Label mapping lives in lib/stop-reason; this component only handles layout (warn text first, turn count after).
 */
import type { StopReason } from "../api/types";
import { stopReasonLabel } from "../lib/stop-reason";

export type StopNoticeProps = {
  /** Missing → treated as null → not shown. */
  stopReason?: StopReason;
  /** Missing / ≤ 1 → the "N 轮" ("N turns") count is not shown. */
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
