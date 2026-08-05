import { useId, useState } from "react";
import type { ThinkingView } from "../api/types";
import { FOCUS_RING } from "../lib/ui";

export type ThinkingBlockProps = {
  thinking: ThinkingView;
};

// Default collapsed; the disclosure button is keyboard-operable and carries
// aria-expanded so screen-readers announce the state change.
export function ThinkingBlock({ thinking }: ThinkingBlockProps) {
  const [expanded, setExpanded] = useState(false);
  const panelId = useId();

  const entries = thinking.entries;
  const redacted = thinking.redactedCount;
  const hasContent = entries.length > 0 || redacted > 0;
  if (!hasContent) return null;

  const meta = `${entries.length}${redacted > 0 ? ` · 已加密 ×${redacted}` : ""}`;

  return (
    <section
      aria-label="思考过程"
      className="mb-[12px] border-b border-line pb-[10px]"
    >
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={panelId}
        onClick={() => setExpanded((v) => !v)}
        className={`flex w-full items-center gap-1.5 rounded-[4px] py-[3px] pr-2 pl-1 text-left transition-colors duration-150 ease-[var(--ease-soft)] hover:bg-bg focus-visible:bg-bg ${FOCUS_RING}`}
      >
        <ChevronIcon expanded={expanded} />
        <span className="font-mono text-[11px] font-medium tracking-[0.02em] text-ink-2">
          思考过程
        </span>
        <span className="ml-auto font-mono text-[10px] tracking-[0.02em] text-ink-3">
          {meta}
        </span>
      </button>
      {expanded ? (
        <div
          id={panelId}
          role="region"
          aria-label="思考过程展开内容"
          className="mt-[8px] flex flex-col gap-[10px] border-l-2 border-accent/30 pl-[14px]"
        >
          {entries.map((entry, i) => (
            <p
              key={`t-${i}`}
              className="m-0 whitespace-pre-wrap font-mono text-[12px] leading-[1.7] text-ink-2"
            >
              {entry.text}
            </p>
          ))}
          {redacted > 0
            ? Array.from({ length: redacted }, (_, i) => (
                <p
                  key={`r-${i}`}
                  className="m-0 font-mono text-[12px] italic text-ink-3"
                >
                  [已加密思考]
                </p>
              ))
            : null}
        </div>
      ) : null}
    </section>
  );
}

function ChevronIcon({ expanded }: { expanded: boolean }) {
  return (
    <svg
      width={10}
      height={10}
      viewBox="0 0 10 10"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={`shrink-0 text-ink-3 transition-transform duration-150 ease-[var(--ease-soft)] ${
        expanded ? "rotate-90" : ""
      }`}
    >
      <polyline points="3.5 2 7 5 3.5 8" />
    </svg>
  );
}
