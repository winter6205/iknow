import { useId, useState } from "react";
import type { ToolCallView } from "../api/types";
import { FOCUS_RING } from "../lib/ui";

export type ToolCallListProps = {
  toolCalls: readonly ToolCallView[];
};

// Local owner of single-expand index (same pattern as EvidenceBlock in
// AgentCard) — one preview open at a time keeps the card scan-able.
export function ToolCallList({ toolCalls }: ToolCallListProps) {
  const [expandedIndex, setExpandedIndex] = useState<number | null>(null);

  if (toolCalls.length === 0) return null;

  return (
    <section
      aria-label="工具调用"
      className="mt-[18px] border-t border-line pt-[15px]"
    >
      <div className="mb-[9px] font-mono text-[10px] tracking-[0.03em] text-ink-3">
        工具调用
      </div>
      <div className="flex flex-col gap-[7px]">
        {toolCalls.map((call, index) => (
          <ToolCallItem
            key={`${call.id}-${index}`}
            call={call}
            isExpanded={expandedIndex === index}
            onToggle={() =>
              setExpandedIndex((current) => (current === index ? null : index))
            }
          />
        ))}
      </div>
    </section>
  );
}

type ToolCallItemProps = {
  call: ToolCallView;
  isExpanded: boolean;
  onToggle: () => void;
};

function ToolCallItem({ call, isExpanded, onToggle }: ToolCallItemProps) {
  const panelId = useId();

  return (
    <div
      className={`overflow-hidden rounded-panel border transition-colors duration-150 ease-[var(--ease-soft)] ${
        call.isError
          ? "border-danger/30 bg-danger-soft/50"
          : "border-line bg-bg/60"
      }`}
    >
      <button
        type="button"
        aria-expanded={isExpanded}
        aria-controls={panelId}
        onClick={onToggle}
        className={`flex w-full items-center gap-2 px-3 py-[7px] text-left transition-colors duration-150 ease-[var(--ease-soft)] hover:bg-surface/70 ${FOCUS_RING}`}
      >
        {/* mono chip: tool name; danger tint when the tool errored. */}
        <span
          className={`truncate rounded-pill border px-[9px] py-[2px] font-mono text-[11px] leading-[1.5] ${
            call.isError
              ? "border-danger/40 bg-surface text-danger"
              : "border-line bg-surface text-ink-2"
          }`}
        >
          {call.name}
        </span>
        {call.isError ? (
          <span className="shrink-0 font-mono text-[10px] font-medium text-danger">
            出错
          </span>
        ) : null}
        <ChevronRightIcon expanded={isExpanded} className="ml-auto shrink-0" />
      </button>
      {isExpanded ? (
        <div
          id={panelId}
          role="region"
          aria-label={`${call.name} 调用详情`}
          className="flex flex-col gap-[9px] border-t border-line/70 px-3 py-[10px]"
        >
          <PreviewBlock label="输入" text={call.inputPreview} />
          <PreviewBlock
            label="输出"
            text={call.outputPreview}
            truncated={call.truncated}
          />
        </div>
      ) : null}
    </div>
  );
}

function PreviewBlock({
  label,
  text,
  truncated = false,
}: {
  label: string;
  text: string;
  truncated?: boolean;
}) {
  return (
    <div>
      <div className="mb-[3px] font-mono text-[10px] tracking-[0.03em] text-ink-3">
        {label}
      </div>
      <pre className="m-0 max-h-[180px] overflow-auto whitespace-pre-wrap break-all rounded-[8px] border border-line/70 bg-surface px-[10px] py-[8px] font-mono text-[11.5px] leading-[1.6] text-ink-2">
        {text || "—"}
        {truncated ? "…（已截断）" : ""}
      </pre>
    </div>
  );
}

function ChevronRightIcon({
  expanded,
  className = "",
}: {
  expanded: boolean;
  className?: string;
}) {
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
      className={`text-ink-3 transition-transform duration-150 ease-[var(--ease-soft)] ${
        expanded ? "rotate-90" : ""
      } ${className}`}
    >
      <polyline points="3.5 2 7 5 3.5 8" />
    </svg>
  );
}
