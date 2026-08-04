import type { TraceFieldDef, TraceRecordType } from "../api/types";
import type { TraceFilterValues } from "../hooks/useTracesData";
import { FOCUS_RING } from "../lib/ui";
import { FILTER_LABELS, filterOptionsForField } from "./traceFields";

export type TraceFilterBarProps = {
  values: TraceFilterValues;
  loading: boolean;
  /** Field table drives the dropdown option lists (SSOT; see M2). */
  fields: ReadonlyArray<TraceFieldDef>;
  onChange: (next: TraceFilterValues) => void;
  onRefresh: () => void;
};

const INPUT_CLASS =
  "rounded-pill border border-ink-3/30 bg-surface/70 px-3 py-1.5 text-xs text-ink placeholder:text-ink-3 transition-colors duration-200 ease-[var(--ease-soft)] focus:border-ink-3 focus:outline-none";

const BUTTON_CLASS =
  "rounded-pill border border-line bg-accent-soft px-4 py-1.5 text-xs font-medium text-accent transition-all duration-200 ease-[var(--ease-soft)] hover:bg-accent hover:text-surface hover:border-accent disabled:cursor-not-allowed disabled:opacity-50";

/** Filter inputs + refresh. All filters are exact-match (mirrors the reader). */
export function TraceFilterBar({
  values,
  loading,
  fields,
  onChange,
  onRefresh,
}: TraceFilterBarProps) {
  const recordTypeOptions = filterOptionsForField(fields, "record_type");
  const statusOptions = filterOptionsForField(fields, "status");

  // Explicit per-key dispatch keeps the filter value typed (no computed-key cast).
  const onRecordTypeChange = (raw: string) =>
    onChange({
      ...values,
      recordType: raw === "" ? undefined : (raw as TraceRecordType),
    });
  const onStatusChange = (raw: string) =>
    onChange({
      ...values,
      status: raw === "" ? undefined : (raw as "ok" | "error"),
    });

  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2.5">
      <input
        type="text"
        value={values.conversationId}
        placeholder="conversation_id 过滤"
        aria-label="按 conversation_id 过滤"
        className={`w-56 ${INPUT_CLASS}`}
        onChange={(e) =>
          onChange({ ...values, conversationId: e.target.value })
        }
      />
      <select
        value={values.recordType ?? ""}
        aria-label={FILTER_LABELS.recordType.label}
        className={INPUT_CLASS}
        onChange={(e) => onRecordTypeChange(e.target.value)}
      >
        <option value="">{FILTER_LABELS.recordType.all}</option>
        {recordTypeOptions.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
      <select
        value={values.status ?? ""}
        aria-label={FILTER_LABELS.status.label}
        className={INPUT_CLASS}
        onChange={(e) => onStatusChange(e.target.value)}
      >
        <option value="">{FILTER_LABELS.status.all}</option>
        {statusOptions.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
      <button
        type="button"
        disabled={loading}
        onClick={onRefresh}
        className={`${BUTTON_CLASS} ${FOCUS_RING}`}
      >
        {loading ? "加载中…" : "刷新"}
      </button>
    </div>
  );
}
