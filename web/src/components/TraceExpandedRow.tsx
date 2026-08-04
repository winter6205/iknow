import type { TraceRecord } from "../api/types";

export type TraceExpandedRowProps = {
  record: TraceRecord;
};

/** Pretty-printed raw JSONL row — nested fields (error / messages / ...) live here. */
export function TraceExpandedRow({ record }: TraceExpandedRowProps) {
  return (
    <pre className="m-0 overflow-x-auto rounded-panel bg-bg/82 px-4 py-3 font-mono text-[11px] leading-[1.7] text-ink-2">
      {JSON.stringify(record, null, 2)}
    </pre>
  );
}
