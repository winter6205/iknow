/** @jsxImportSource @opentui/react */
/**
 * src/tui/subagent-panel.tsx
 *
 * 子代理状态面板 —— 渲染在 ContextBar（用量条）下方的几行子代理状态。
 *
 * 数据契约（#358 T3）：本组件**只读**消费 `SubagentInfo` 投影
 * （src/harness/subagent/manager.ts 的 listSubagents 输出原样），不写任何
 * 状态、不订阅、不轮询 —— 纯展示组件，props（startedAt/endedAt ISO）驱动，
 * 零 effect / interval。接线（app.tsx 把 subagents 数组 + cols + 时间源传
 * 下来）由调用方负责，本模块只管「投影 → 行文本」与渲染分两层。
 *
 * 可见性语义（对齐 Claude Code 完成态行为）：
 *   1. 活跃行（starting/running）始终显示，每子代理一行；
 *   2. 失败行（failed）仅当 endedAt 距 now ≤ FAILED_VISIBLE_WINDOW_S 显示，
 *      过期即移出；
 *   3. 完成行（completed）不单独显示（立即移除）；
 *   4. 无任何活跃行且存在 DONE_FADE_WINDOW_S 内完成的 → 单行 `✓ N 完成`
 *      淡出提示；
 *   5. 全空 → return null；
 *   6. 活跃行全量列出（不折叠 footer）。不计入 chrome 行账，画在输入框下方。
 *
 * 窄列分支（cols < 40）说明：产品路径 cols 下限 40（见 app.tsx cols =
 * Math.max(width ?? 80, 40)），本分支属防御 / 测试 fixture 路径；保留是为
 * 让 cols=30 fixture 的单测能直驱可见性（行账由 app 产品路径恒 panelRows=0）。
 *
 * 字形纪律（spec #146:86 无 emoji UI 字形）：只用几何字形 `● ○ ✓ ✗`
 * （项目既有惯例，见 context-bar 的 █░ / tool-summary 的 …），禁止 emoji。
 */
import type { ReactNode } from "react";
import type { SubagentInfo } from "../harness/subagent/manager.js";
import { clipOneLineVisual, visualWidth } from "./tool-summary.js";
import { formatRunDuration } from "./run-stats.js";
import { tuiPalette } from "./theme.js";

export interface SubagentPanelProps {
  /** 只读投影（#358 T7）：host 传 SubagentInfo 列表，本组件不改写。 */
  readonly subagents: ReadonlyArray<SubagentInfo>;
  readonly cols: number;
  /** 测试注入用；缺省 Date.now()。 */
  readonly nowMs?: number;
  /**
   * T7：当前聚焦的 live 子代理行下标（chrome-focus reducer 的
   * `{ kind: "subagent", row }` 派生）。仅作用于 live 行 —— 聚焦行
   * taskPreview 不截断 + 加 `> ` 前缀；其余行保持原截断行为。
   * 越界或 undefined → 无聚焦（等价原行为）。
   */
  readonly focusedRow?: number;
}

export interface SubagentLine {
  /** 行首几何字形（`● ○ ✗ ✓ …`）——单测匹配用；text 已含完整行文本。 */
  readonly icon: string;
  readonly fg: string;
  /** 完整行文本（含 icon 字形与分隔符），组件直接 `<text>{text}</text>`。 */
  readonly text: string;
}

/** 失败行可见窗口：endedAt 距 now ≤ 30s。导出供 app.tsx 的 watch 窗口
 *  同源消费（hasRecentEndedSubagent failed 分支用本值 ×1000）。 */
export const FAILED_VISIBLE_WINDOW_S = 30;
/** 完成淡出窗口：endedAt 距 now ≤ 5s。导出供 app.tsx 的 watch 窗口
 *  同源消费（hasRecentEndedSubagent completed 分支用本值 ×1000）。 */
export const DONE_FADE_WINDOW_S = 5;
/** 宽列行装饰预留：icon(1) + 空格(1) + name 空格(1) + ` · `(3) + elapsed 最长 8 列。 */
const DECOR_RESERVE = 14;
const NAME_BUDGET = 20;

/**
 * startedAt(ISO) → nowMs 的整秒 elapsed。非法 ISO / nowMs 早于 startedAt
 * （时钟漂移）→ 0（防 NaN 上行到渲染层）。
 */
export function elapsedSec(startedAt: string, nowMs: number): number {
  const started = Date.parse(startedAt);
  if (!Number.isFinite(started)) return 0;
  const diffMs = nowMs - started;
  if (diffMs <= 0) return 0;
  return Math.floor(diffMs / 1000);
}

function subagentDisplayName(info: SubagentInfo): string {
  const role = info.role?.trim();
  return role !== undefined && role.length > 0 ? role : "子代理";
}

/**
 * 纯函数投影：可见性过滤 + 行文本生成（不 touch OpenTUI，可单测直驱）。
 *
 *   - 活跃行：`{icon} {name} {taskPreview} · {elapsed}`；窄列无 preview；
 *   - 失败行：`✗ {name} {preview} · {reason}`；
 *   - 完成淡出行：`✓ {N} 完成`；
 *   - 全量列出，不折叠 footer；不计入 chrome 行账。
 *
 * `focusedRow`（可选，T7 接线）：当 `live[i]` 的下标 `i === focusedRow` 时，
 * taskPreview 不再截断（仍按 cols 视觉宽度兜底），并加 `> ` 前缀标记聚焦；
 * 其余 `live` 行保持原截断。failed 行不参与 focus（focusedRow 仅作用于
 * live 行 —— 子代理 chrome 的 focus 仅在 live 环移动）。`undefined` 或
 * 越界 → 不聚焦（所有行按原行为渲染）。
 */
export function projectSubagentLines(
  subagents: ReadonlyArray<SubagentInfo>,
  nowMs: number,
  cols: number,
  focusedRow?: number
): ReadonlyArray<SubagentLine> {
  if (subagents.length === 0) return [];
  const narrow = cols < 40;
  const live: SubagentLine[] = [];
  let liveIndex = -1;
  let doneCount = 0;
  for (const s of subagents) {
    const name = clipOneLineVisual(subagentDisplayName(s), NAME_BUDGET);
    const nameWidth = visualWidth(name);
    const previewBudget = Math.max(4, cols - DECOR_RESERVE - nameWidth);
    const narrowReasonBudget = Math.max(4, cols - (2 + nameWidth + 3));
    if (s.state === "starting" || s.state === "running") {
      liveIndex += 1;
      const icon = s.state === "starting" ? "○" : "●";
      const fg = s.state === "starting" ? tuiPalette.dim : tuiPalette.running;
      const elapsed = formatRunDuration(elapsedSec(s.startedAt, nowMs));
      // 聚焦判定：仅 live 行参与；聚焦行 → 不截断 preview（仍按 cols 兜底）+
      // `> ` 前缀；其余行保持原截断行为。`focusedRow` 越界（≥ live.length）→
      // 等价于未聚焦（不做前缀）。
      const isFocused = focusedRow !== undefined && focusedRow === liveIndex;
      const focusedPrefix = isFocused ? "> " : "";
      const previewRendered = isFocused
        ? clipOneLineVisual(
            s.taskPreview,
            Math.max(
              4,
              cols -
                visualWidth(focusedPrefix + icon + " " + name + " ") -
                visualWidth(" · " + elapsed)
            )
          )
        : clipOneLineVisual(s.taskPreview, previewBudget);
      live.push(
        narrow
          ? {
              icon,
              fg,
              text: `${focusedPrefix}${icon} ${name} · ${elapsed}`,
            }
          : {
              icon,
              fg,
              text: `${focusedPrefix}${icon} ${name} ${previewRendered} · ${elapsed}`,
            }
      );
    } else if (s.state === "failed") {
      if (s.endedAt === undefined) continue;
      const ended = Date.parse(s.endedAt);
      if (!Number.isFinite(ended)) continue;
      const ageSec = (nowMs - ended) / 1000;
      if (!(ageSec <= FAILED_VISIBLE_WINDOW_S)) continue;
      const reason = s.reason ?? "失败";
      if (narrow) {
        live.push({
          icon: "✗",
          fg: tuiPalette.error,
          text: `✗ ${name} · ${clipOneLineVisual(reason, narrowReasonBudget)}`,
        });
      } else {
        const preview = clipOneLineVisual(s.taskPreview, previewBudget);
        const reasonBudget = Math.max(
          4,
          cols - visualWidth(preview) - nameWidth - 6
        );
        live.push({
          icon: "✗",
          fg: tuiPalette.error,
          text: `✗ ${name} ${preview} · ${clipOneLineVisual(reason, reasonBudget)}`,
        });
      }
    } else {
      if (s.endedAt === undefined) continue;
      const ended = Date.parse(s.endedAt);
      if (!Number.isFinite(ended)) continue;
      const ageSec = (nowMs - ended) / 1000;
      if (ageSec <= DONE_FADE_WINDOW_S) doneCount += 1;
    }
  }

  const lines: SubagentLine[] = [...live];
  if (lines.length === 0 && doneCount > 0) {
    lines.push({
      icon: "✓",
      fg: tuiPalette.add,
      text: `✓ ${doneCount} 完成`,
    });
  }
  return lines;
}

export function SubagentPanel(props: SubagentPanelProps): ReactNode {
  const lines = projectSubagentLines(
    props.subagents,
    props.nowMs ?? Date.now(),
    props.cols,
    props.focusedRow
  );
  if (lines.length === 0) return null;
  return (
    <box flexDirection="column">
      {lines.map((line, idx) => (
        <text key={idx} fg={line.fg} wrapMode="none">
          {line.text}
        </text>
      ))}
    </box>
  );
}
