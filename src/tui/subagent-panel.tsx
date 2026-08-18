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
 *   5. 全空 → return null（条件渲染时返回 null，调用方据此入账 0 行）；
 *      非 null 时行数 = lines.length，调用方传给 chromeReserveRows.panelRows
 *      计入底部行账。
 *   6. 活跃行（含未过期 failed）> 3 → 只显示前 3 条 + `… 另有 N 个子代理`。
 *
 * 窄列分支（cols < 40）说明：产品路径 cols 下限 40（见 app.tsx cols =
 * Math.max(width ?? 80, 40)），本分支属防御 / 测试 fixture 路径；保留是为
 * 让 cols=30 fixture 的单测能直驱可见性 + 折叠逻辑（行账 SSOT 单测覆盖）。
 *
 * 字形纪律（spec #146:86 无 emoji UI 字形）：只用几何字形 `● ○ ✓ ✗ …`
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
}

export interface SubagentLine {
  /** 行首几何字形（`● ○ ✗ ✓ …`）——单测匹配用；text 已含完整行文本。 */
  readonly icon: string;
  readonly fg: string;
  /** 完整行文本（含 icon 字形与分隔符），组件直接 `<text>{text}</text>`。 */
  readonly text: string;
}

/** 活跃行（starting/running/未过期 failed）显示上限；超出折叠为 footer。 */
const MAX_LIVE_ROWS = 3;
/** 失败行可见窗口：endedAt 距 now ≤ 30s。导出供 app.tsx 的 watch 窗口
 *  同源消费（hasRecentEndedSubagent failed 分支用本值 ×1000）。 */
export const FAILED_VISIBLE_WINDOW_S = 30;
/** 完成淡出窗口：endedAt 距 now ≤ 5s。导出供 app.tsx 的 watch 窗口
 *  同源消费（hasRecentEndedSubagent completed 分支用本值 ×1000）。 */
export const DONE_FADE_WINDOW_S = 5;
/** 宽列行装饰预留：icon(1) + 空格(1) + ` · `(3) + elapsed 最长 8 列 = 13。 */
const DECOR_RESERVE = 13;

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

/**
 * 纯函数投影：可见性过滤 + 行文本生成（不 touch OpenTUI，可单测直驱）。
 *
 *   - 活跃行：`{icon} {taskPreview 截断} · {elapsed}`（starting=○ dim /
 *     running=● running）；窄列（cols<40）退化为 `{icon} 子代理 · {elapsed}`；
 *   - 失败行：`✗ {taskPreview 截断} · {reason 截断}`（fg=error）—— reason 按
 *     视觉宽度裁到「cols − 已渲染前缀」剩余预算，避免 CJK 长 reason 溢出
 *     单行；窄列退化为 `✗ 子代理 · {reason 截断}`（reason 预算 = cols-11）；
 *   - 完成淡出行：`✓ {N} 完成`（N = 5s 窗口内 completed 数；fg=add 绿）；
 *   - 折叠 footer：`… 另有 {N} 个子代理`（fg=dim）。
 *
 * 行序 = 输入序（活跃行列表直接 slice 前 3，footer 在尾部）。
 */
export function projectSubagentLines(
  subagents: ReadonlyArray<SubagentInfo>,
  nowMs: number,
  cols: number
): ReadonlyArray<SubagentLine> {
  if (subagents.length === 0) return [];
  const narrow = cols < 40;
  const previewBudget = Math.max(4, cols - DECOR_RESERVE);
  /** 窄列失败行 reason 预算：icon(1) + 空格(1) + 子代理(6) + ` · `(3) = 11。 */
  const narrowReasonBudget = Math.max(4, cols - 11);
  /** 宽列失败行 reason 预算：cols − `✗ `(2) − preview 视觉宽 − ` · `(3)。 */
  function wideReasonBudget(previewText: string): number {
    return Math.max(4, cols - visualWidth(previewText) - 5);
  }

  const live: SubagentLine[] = [];
  let doneCount = 0;
  for (const s of subagents) {
    if (s.state === "starting" || s.state === "running") {
      const icon = s.state === "starting" ? "○" : "●";
      const fg = s.state === "starting" ? tuiPalette.dim : tuiPalette.running;
      const elapsed = formatRunDuration(elapsedSec(s.startedAt, nowMs));
      live.push(
        narrow
          ? { icon, fg, text: `${icon} 子代理 · ${elapsed}` }
          : {
              icon,
              fg,
              text: `${icon} ${clipOneLineVisual(s.taskPreview, previewBudget)} · ${elapsed}`,
            }
      );
    } else if (s.state === "failed") {
      if (s.endedAt === undefined) continue;
      const ended = Date.parse(s.endedAt);
      // NaN endedAt → ageSec NaN → 下方 `!(ageSec <= WINDOW)` 为 true → 隐藏
      //（过期即不可见，fail-safe 默认）。
      if (!Number.isFinite(ended)) continue;
      const ageSec = (nowMs - ended) / 1000;
      if (!(ageSec <= FAILED_VISIBLE_WINDOW_S)) continue;
      const reason = s.reason ?? "失败";
      if (narrow) {
        live.push({
          icon: "✗",
          fg: tuiPalette.error,
          text: `✗ 子代理 · ${clipOneLineVisual(reason, narrowReasonBudget)}`,
        });
      } else {
        const preview = clipOneLineVisual(s.taskPreview, previewBudget);
        live.push({
          icon: "✗",
          fg: tuiPalette.error,
          text: `✗ ${preview} · ${clipOneLineVisual(reason, wideReasonBudget(preview))}`,
        });
      }
    } else {
      // completed：只有 5s 窗口内的计入「N 完成」计数；其余全部忽略。
      if (s.endedAt === undefined) continue;
      const ended = Date.parse(s.endedAt);
      if (!Number.isFinite(ended)) continue;
      const ageSec = (nowMs - ended) / 1000;
      if (ageSec <= DONE_FADE_WINDOW_S) doneCount += 1;
    }
  }

  const lines: SubagentLine[] = [];
  if (live.length > MAX_LIVE_ROWS) {
    lines.push(...live.slice(0, MAX_LIVE_ROWS));
    lines.push({
      icon: "…",
      fg: tuiPalette.dim,
      text: `… 另有 ${live.length - MAX_LIVE_ROWS} 个子代理`,
    });
  } else {
    lines.push(...live);
  }
  // 完成淡出：任何活跃行（含未过期 failed）在场 → 不淡出。
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
    props.cols
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
