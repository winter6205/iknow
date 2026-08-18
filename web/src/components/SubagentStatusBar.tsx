/**
 * #358 T8: Web 子代理状态栏（轮询起步）。
 *
 * 纯展示组件：props 只有 subagents（T7 端点 item 列表），测试可直接
 * renderToStaticMarkup。零 effect / 零内部 state —— 轮询生命周期在
 * `useSubagentsPolling`（镜像 useAsksPolling），本组件只负责渲染。
 *
 * 徽标语义对齐 SubagentState 四态：starting/running → 活跃 tone，
 * completed → ok tone（--color-ok），failed → error tone（--color-danger）。
 * 样式沿用组件既有 Tailwind token 约定（TraceStatsBar statusClass +
 * SendingIndicator 徽标形态），不做 CSS 类名扩展。
 *
 * 零子代理 → null（不打扰 idle 会话，spec SC8）。
 */
import type { SubagentState, SubagentStatus } from "../api/types";

export type SubagentStatusBarProps = {
  readonly subagents: ReadonlyArray<SubagentStatus>;
};

/** 终态（completed/failed）条目最多保留最近 N 条；活跃条目全显示。 */
const MAX_TERMINAL = 5;

/**
 * 历史累积缓解：starting/running 全保留，终态只保留列表序最后
 * MAX_TERMINAL 条（原相对顺序不变）。导出供 tests/web 直接断言。
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
 * 四态徽标 tone：starting/running → warn 琥珀（活跃/in-flight），
 * completed → ok 雾灰绿（--color-ok），failed → danger 红（--color-danger）。
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
