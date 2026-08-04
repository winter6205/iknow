import { Fragment } from "react";
import type { TraceFieldDef, TraceRecord } from "../api/types";
import { formatCell, rowKeyOf } from "./traceFields";
import { TraceExpandedRow } from "./TraceExpandedRow";

export type TraceTableProps = {
  records: ReadonlyArray<TraceRecord>;
  /** Column defs already narrowed by the selected record_type. */
  fields: ReadonlyArray<TraceFieldDef>;
  /** Stable row key of the expanded row; null → none expanded. */
  expandedKey: string | null;
  onToggleRow: (key: string) => void;
};

const TONE_CLASS: Record<"ok" | "error" | "neutral", string> = {
  ok: "text-ok",
  error: "text-danger",
  neutral: "text-ink-2",
};

/** Field-driven table; click a row to expand the raw JSONL row beneath it. */
export function TraceTable({
  records,
  fields,
  expandedKey,
  onToggleRow,
}: TraceTableProps) {
  return (
    <div className="min-h-0 flex-1 overflow-auto px-4 pb-4">
      <table className="w-full border-collapse text-left text-xs">
        <thead>
          <tr className="sticky top-0 bg-surface">
            {fields.map((f) => (
              <th
                key={f.key}
                scope="col"
                className="border-b border-line px-2 py-2 font-medium whitespace-nowrap text-ink-3"
              >
                {f.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {records.map((record, i) => {
            const rowKey = rowKeyOf(record, i);
            const expanded = expandedKey === rowKey;
            return (
              <Fragment key={rowKey}>
                <tr
                  onClick={() => onToggleRow(rowKey)}
                  aria-expanded={expanded}
                  className={`cursor-pointer border-b border-line/60 transition-colors duration-150 ease-[var(--ease-soft)] hover:bg-accent-soft/60 ${
                    expanded ? "bg-accent-soft/40" : ""
                  }`}
                >
                  {fields.map((f) => {
                    const cell = formatCell(record, f);
                    return (
                      <td
                        key={f.key}
                        className={`px-2 py-1.5 font-mono whitespace-nowrap ${TONE_CLASS[cell.tone]}`}
                      >
                        {cell.text}
                      </td>
                    );
                  })}
                </tr>
                {expanded ? (
                  <tr className="border-b border-line/60">
                    <td colSpan={fields.length} className="px-2 py-2">
                      <TraceExpandedRow record={record} />
                    </td>
                  </tr>
                ) : null}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
