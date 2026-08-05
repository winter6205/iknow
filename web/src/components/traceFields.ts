/**
 * Pure helpers for the trace inspection panel (web side).
 *
 * Re-exports TraceFieldDef so callers (and tests) can use a single import
 * surface. The type itself lives in web/src/api/types.ts so the wire shape
 * mirror is owned by the api layer.
 */
import type { TraceFieldDef, TraceRecord, TraceRecordType } from "../api/types";

export type { TraceFieldDef };

/**
 * Filter the field table to those whose `recordTypes` includes the active
 * record_type. `undefined` → "全部" (no filter) → return every column.
 *
 * Unknown record_type returns an empty list — the dropdown in TraceFilterBar
 * only offers known types, so an empty list is the safest default (the table
 * renders nothing rather than misleading columns).
 */
export function filterFieldsForRecordType(
  fields: ReadonlyArray<TraceFieldDef>,
  recordType: TraceRecordType | undefined
): TraceFieldDef[] {
  if (recordType === undefined) return [...fields];
  return fields.filter((f) => f.recordTypes.includes(recordType));
}

/**
 * Datetime display: convert ISO8601 strings to a readable local string.
 * Invalid inputs fall through unchanged so the panel still surfaces the raw
 * value (debugging aid).
 */
export function formatDateTime(value: string): string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString();
}

export interface CellView {
  readonly text: string;
  /** Drives the colour token in TraceTable (ok / error / neutral). */
  readonly tone: "ok" | "error" | "neutral";
}

/**
 * Render a JSONL row's cell as a (text, tone) pair. Missing values render
 * as the placeholder "—". Booleans render "true"/"false". Colour is driven
 * declaratively by field.tone ("status" → ok/error) — a future field with
 * ok/error semantics only needs a tone declaration in the field table, no
 * renderer change.
 */
export function formatCell(
  record: TraceRecord,
  field: TraceFieldDef
): CellView {
  const raw = record[field.jsonlKey];
  if (raw === undefined || raw === null || raw === "") {
    return { text: "—", tone: "neutral" };
  }
  if (field.type === "datetime" && typeof raw === "string") {
    return { text: formatDateTime(raw), tone: "neutral" };
  }
  const text = String(raw);
  if (field.tone === "status") {
    return { text, tone: text === "error" ? "error" : "ok" };
  }
  return { text, tone: "neutral" };
}

export type FilterSelectKey = "recordType" | "status";

/**
 * Filter select label/all text only — the option values are derived from the
 * field table via filterOptionsForField (the /api/v1/traces/fields payload
 * mirrors backend TRACE_FIELD_DEFS.options), so this file never duplicates
 * value domains declared in src/traceserver/fields.ts.
 */
export const FILTER_LABELS: Record<
  FilterSelectKey,
  { readonly label: string; readonly all: string }
> = {
  recordType: { label: "按记录类型过滤", all: "全部类型" },
  status: { label: "按状态过滤", all: "全部状态" },
};

/**
 * Dropdown options for a filter select, derived from the field declaration
 * table (SSOT). Unknown jsonlKey or a def without options → empty list.
 */
export function filterOptionsForField(
  fields: ReadonlyArray<TraceFieldDef>,
  jsonlKey: string
): ReadonlyArray<string> {
  const def = fields.find((f) => f.jsonlKey === jsonlKey);
  return def?.options ?? [];
}

/**
 * Stable row identity for React keys and expansion state: llm_call_id, then
 * tool_call_id, then turn_id. Violation rows carry no id → fall back to
 * record_type:conversation_id:index; rows missing even those → "::index".
 */
export function rowKeyOf(record: TraceRecord, index: number): string {
  for (const key of ["llm_call_id", "tool_call_id", "turn_id"]) {
    const v = record[key];
    if (typeof v === "string" && v.length > 0) return v;
  }
  const recordType = record["record_type"];
  const conversationId = record["conversation_id"];
  return `${typeof recordType === "string" ? recordType : ""}:${
    typeof conversationId === "string" ? conversationId : ""
  }:${index}`;
}
