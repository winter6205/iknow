/**
 * Web subagent status bar (polling first cut).
 *
 * Pure display component: props hold only subagents (the endpoint's item
 * list), so tests can renderToStaticMarkup directly. Zero effects / zero
 * internal state — the polling lifecycle lives in `useSubagentsPolling`
 * (mirrors useAsksPolling); this component only renders.
 *
 * Badge semantics map the four SubagentState values: starting/running →
 * active tone, completed → ok tone (--color-ok), failed → error tone
 * (--color-danger). Styling reuses existing Tailwind tokens (TraceStatsBar
 * statusClass + SendingIndicator badge shape) — no new CSS class names.
 *
 * Zero subagents → null (never disturbs idle sessions).
 */
import type { SubagentState, SubagentStatus } from "../api/types";

export type SubagentStatusBarProps = {
  readonly subagents: ReadonlyArray<SubagentStatus>;
};

/** Terminal (completed/failed) entries keep at most the latest N; active entries always show. */
const MAX_TERMINAL = 5;

/**
 * History-accumulation relief: keep all starting/running, terminal entries
 * only in the last MAX_TERMINAL list positions (relative order preserved).
 * Exported so tests/web can assert against it directly.
 */
export function visibleSubagents(
  subagents: ReadonlyArray<SubagentStatus>
): ReadonlyArray<SubagentStatus> {
  const terminal = subagents.filter(
    (s) => s.state === "completed" || s.state === "failed"
  );
  if (terminal.length <= MAX_TERMINAL) return subagents;
  const keep = new Set(terminal.slice(-MAX_TERMINAL).map((s) => s.taskId));
  return subagents.filter(
    (s) => s.state === "starting" || s.state === "running" || keep.has(s.taskId)
  );
}

function stateLabel(state: SubagentState): string {
  switch (state) {
    case "starting":
      return "启动中";
    case "running":
      return "运行中";
    case "completed":
      return "已完成";
    case "failed":
      return "失败";
  }
}

/**
 * Four-state badge tone: starting/running → warn amber (active/in-flight),
 * completed → ok misty green (--color-ok), failed → danger red (--color-danger).
 */
function badgeClass(state: SubagentState): string {
  switch (state) {
    case "starting":
    case "running":
      return "bg-warn-soft text-warn";
    case "completed":
      return "bg-accent-soft text-ok";
    case "failed":
      return "bg-danger-soft text-danger";
  }
}

export function SubagentStatusBar({ subagents }: SubagentStatusBarProps) {
  const visible = visibleSubagents(subagents);
  if (visible.length === 0) return null;
  return (
    <div className="mx-auto flex w-full max-w-[var(--chat-max)] flex-col gap-1 px-4 pt-2">
      {visible.map((s) => {
        const label =
          s.taskPreview.trim().length > 0 ? s.taskPreview : "子代理";
        return (
          <div
            key={s.taskId}
            data-state={s.state}
            className="flex items-center gap-2 overflow-hidden rounded-pill border border-line bg-surface px-3 py-1 text-[11px]"
          >
            <span
              className={`shrink-0 rounded-pill border border-line px-1.5 py-0.5 font-mono text-[10px] leading-none ${badgeClass(s.state)}`}
            >
              {stateLabel(s.state)}
            </span>
            <span className="min-w-0 flex-1 truncate text-ink-2">{label}</span>
            {s.state === "completed" && s.summary ? (
              <span className="min-w-0 max-w-[40%] truncate text-ink-3">
                {s.summary}
              </span>
            ) : null}
            {s.state === "failed" && s.reason ? (
              <span className="min-w-0 max-w-[30%] truncate text-danger">
                {s.reason}
              </span>
            ) : null}
            {s.state === "failed" && s.summary ? (
              <span className="min-w-0 max-w-[30%] truncate text-ink-3">
                {s.summary}
              </span>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
