import type { TraceRecord, TracesResponse } from "../api/types";

export type TraceStatsBarProps = {
  data: TracesResponse;
};

function countBy(
  records: ReadonlyArray<TraceRecord>,
  key: string
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const r of records) {
    const v = typeof r[key] === "string" ? (r[key] as string) : "—";
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  return counts;
}

function statusClass(value: string): string {
  if (value === "error") return "bg-danger-soft text-danger";
  if (value === "ok") return "bg-accent-soft text-ok";
  return "bg-bg text-ink-3";
}

function Chips(props: { counts: Map<string, number>; tone?: "status" }) {
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      {[...props.counts.entries()].map(([value, n]) => (
        <span
          key={value}
          className={`rounded-pill border border-line px-2 py-0.5 font-mono text-[10.5px] ${
            props.tone === "status"
              ? statusClass(value)
              : "bg-surface text-ink-2"
          }`}
        >
          {value} × {n}
        </span>
      ))}
    </span>
  );
}

/** Aggregate counts over the *loaded* page only — never implies a full-file scan. */
export function TraceStatsBar({ data }: TraceStatsBarProps) {
  return (
    <div className="flex flex-col gap-1.5 border-b border-line/60 px-4 py-2 text-[11px] text-ink-3">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
        <span className="text-ink-2">
          基于当前加载的{" "}
          <span className="font-mono">{data.records.length}</span> 条：
        </span>
        <span className="flex items-center gap-1.5">
          <span>类型</span>
          <Chips counts={countBy(data.records, "record_type")} />
        </span>
        <span className="flex items-center gap-1.5">
          <span>状态</span>
          <Chips counts={countBy(data.records, "status")} tone="status" />
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-[10.5px]">
        <span>
          过滤总数 total <span className="text-ink-2">{data.total}</span>
        </span>
        {data.skipped_lines > 0 ? (
          <span className="text-warn">跳过无效行 {data.skipped_lines}</span>
        ) : null}
        {data.truncated ? (
          <span className="text-warn">文件超过读取上限，已截断</span>
        ) : null}
      </div>
    </div>
  );
}
