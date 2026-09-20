import { FOCUS_RING } from "../lib/ui";

export type TraceView = "flow" | "table";

export type TraceViewToggleProps = {
  value: TraceView;
  onChange: (view: TraceView) => void;
};

const OPTIONS: { id: TraceView; label: string }[] = [
  { id: "flow", label: "FlowTree" },
  { id: "table", label: "表格" },
];

/** View switch: FlowTree is the primary view; TraceTable stays as the table variant (spec Open Q5). */
export function TraceViewToggle({ value, onChange }: TraceViewToggleProps) {
  return (
    <div className="flex items-center gap-1 rounded-pill border border-line bg-bg p-0.5">
      {OPTIONS.map((o) => (
        <button
          key={o.id}
          type="button"
          onClick={() => onChange(o.id)}
          aria-pressed={value === o.id}
          className={`rounded-pill px-3 py-1 text-xs font-medium transition-colors duration-150 ease-[var(--ease-soft)] ${FOCUS_RING} ${
            value === o.id
              ? "bg-ink text-surface"
              : "text-ink-2 hover:bg-surface"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
