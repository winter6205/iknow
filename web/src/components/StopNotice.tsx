/**
 * Stop-reason + turn-count meta line.
 * Renders one quiet mono meta line only when the turn has something to say
 * about how it ended (or turnCount > 1).
 * Label mapping lives in lib/stop-reason; this component only handles layout (warn text first, turn count after).
 */
import type { StopReason } from "../api/types";
import { stopNoticeLine } from "../lib/stop-reason";

export type StopNoticeProps = {
  /** Missing → treated as null → not shown. Absent together with
   *  `outcome.terminal === "unknown"` is the legacy-history case: no label. */
  stopReason?: StopReason;
  /** The hub's output-limit notice, shown verbatim in place of the generic
   *  non-completed label. Missing / empty → the label mapping decides. */
  outputLimitNotice?: string;
  /** Missing / ≤ 1 → the "N 轮" ("N turns") count is not shown. */
  turnCount?: number;
};

export function StopNotice({
  stopReason,
  outputLimitNotice,
  turnCount,
}: StopNoticeProps) {
  const notice = stopNoticeLine(stopReason, outputLimitNotice);
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
