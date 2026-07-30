import { useId } from "react";
import type { SourceSpanView } from "./evidence";

export type EvidencePanelProps = {
  span: SourceSpanView;
  isConflict: boolean;
  isExpanded: boolean;
  onToggle: () => void;
};

// Chip pill (⊙ doc_id/source_ref). Conflict state swaps to warn palette + warn border.
const CHIP_BASE =
  "inline-flex items-center gap-[5px] rounded-pill border px-[10px] py-[6px] font-mono text-[10.5px] leading-tight transition-[transform,box-shadow,background-color] duration-[160ms] ease-out hover:-translate-y-px hover:shadow-chip active:scale-[0.97] focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2";

export function EvidencePanel({
  span,
  isConflict,
  isExpanded,
  onToggle,
}: EvidencePanelProps) {
  const panelId = useId();
  const chipLabel = span.source_ref ?? span.doc_id ?? span.chunk_id;

  // Three visual states: conflict (warn palette) > expanded (deeper accent) > default.
  const chipClass = isConflict
    ? `${CHIP_BASE} border-warn/58 bg-warn-soft text-warn`
    : isExpanded
      ? `${CHIP_BASE} border-transparent bg-accent/19 text-accent`
      : `${CHIP_BASE} border-transparent bg-accent-soft text-accent`;

  return (
    <div className="flex flex-col">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={isExpanded}
        aria-controls={panelId}
        aria-label={`${isExpanded ? "收起" : "展开"}来源 ${chipLabel}`}
        className={chipClass}
      >
        <span aria-hidden="true">⊙</span>
        <span className="max-w-full truncate">{chipLabel}</span>
      </button>
      <div
        id={panelId}
        aria-hidden={!isExpanded}
        className={`grid transition-[grid-template-rows,opacity] duration-[220ms] ease-[var(--ease-soft)] ${
          isExpanded
            ? "grid-rows-[1fr] opacity-100"
            : "grid-rows-[0fr] opacity-0"
        }`}
      >
        <div className="min-h-0 overflow-hidden">
          <p className="mt-[10px] mb-[3px] rounded-panel bg-bg/82 px-3 py-2.5 text-[12.5px] leading-[1.65] text-ink-2">
            {span.quote ? `「${span.quote}」` : "未提供摘录"}
          </p>
          <span className="block px-3 font-mono text-[10px] leading-[1.5] text-ink-3">
            {span.chunk_id}
          </span>
        </div>
      </div>
    </div>
  );
}
