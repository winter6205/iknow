/**
 * Stop-reason + turn-count meta line.
 * Renders one quiet mono meta line only when the turn has something to say
 * about how it ended (or turnCount > 1).
 * Label mapping and the wire fields it reads live in lib/stop-reason (see
 * `StopNoticeInput`); this component only handles layout (warn text first,
 * turn count after).
 */
import { stopNoticeLine, type StopNoticeInput } from "../lib/stop-reason";

export type StopNoticeProps = StopNoticeInput;

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
