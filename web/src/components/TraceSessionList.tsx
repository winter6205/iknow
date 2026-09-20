import { FOCUS_RING } from "../lib/ui";
import type { TraceSessionSummary } from "../api/types";

export type TraceSessionListProps = {
  sessions: ReadonlyArray<TraceSessionSummary>;
  selectedId: string | null;
  loading: boolean;
  error: string | null;
  onSelect: (id: string) => void;
  onRefresh: () => void;
};

function fmtBytes(bytes: number): string {
  if (bytes >= 1024) return (bytes / 1024).toFixed(1) + " KiB";
  return bytes + " B";
}

function fmtMtime(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "—";
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString();
}

/**
 * Session list → drill-down switch. Clicking a historical session drills the
 * detail panel (FlowTree / TraceTable) into it. List and detail are separate (SC-V 25).
 */
export function TraceSessionList({
  sessions,
  selectedId,
  loading,
  error,
  onSelect,
  onRefresh,
}: TraceSessionListProps) {
  return (
    <aside className="flex h-full w-64 shrink-0 flex-col border-r border-line bg-surface">
      <div className="flex items-center justify-between px-3 py-2">
        <span className="eyebrow m-0">会话</span>
        <button
          type="button"
          onClick={onRefresh}
          disabled={loading}
          className={`rounded-pill border border-line bg-accent-soft px-3 py-1 text-[11px] font-medium text-accent transition-all duration-200 ease-[var(--ease-soft)] hover:bg-accent hover:text-surface disabled:cursor-not-allowed disabled:opacity-50 ${FOCUS_RING}`}
        >
          {loading ? "加载中…" : "刷新"}
        </button>
      </div>

      {error !== null ? (
        <p className="px-3 py-2 text-[11px] leading-relaxed text-danger">
          {error}
        </p>
      ) : null}

      <div className="min-h-0 flex-1 overflow-auto px-2 pb-3">
        {sessions.length === 0 && !loading ? (
          <p className="px-2 py-4 text-center text-[11px] text-ink-3">
            暂无会话记录
          </p>
        ) : null}
        {sessions.map((s) => {
          const active = s.conversation_id === selectedId;
          return (
            <button
              key={s.conversation_id}
              type="button"
              onClick={() => onSelect(s.conversation_id)}
              className={`mb-1 flex w-full flex-col items-stretch gap-1 rounded-panel border px-2.5 py-2 text-left transition-colors duration-150 ease-[var(--ease-soft)] ${FOCUS_RING} ${
                active
                  ? "border-accent bg-accent-soft/60"
                  : "border-line bg-surface hover:bg-bg"
              }`}
            >
              <span className="truncate font-mono text-[10px] text-ink-2">
                {s.conversation_id.slice(0, 13)}…
              </span>
              <span className="truncate text-xs font-medium text-ink">
                {s.agent_version ? `v${s.agent_version}` : "agent"}
              </span>
              <span className="flex items-center justify-between text-[10px] text-ink-3">
                <span>{fmtBytes(s.size)}</span>
                <span>{fmtMtime(s.mtime)}</span>
              </span>
            </button>
          );
        })}
      </div>
    </aside>
  );
}
