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
 *   6. 活跃行全量列出，但受 SUBAGENT_PANEL_MAX_ROWS 上限约束 —— 超限时前
 *      maxRows-1 行原样、末行折叠为 `… +N`（#1044）。折叠后行数即 chrome 行账
 *      （app.tsx subagentPanelRowBudget → chromeReserveRows.panelRows），
 *      画在输入框下方且不再被 Yoga 比例压缩。
 *
 * 窄列分支（cols < 40）说明：产品路径 cols 下限 40（见 app.tsx cols =
 * Math.max(width ?? 80, 40)），本分支属防御 / 测试 fixture 路径；保留是为
 * 让 cols=30 fixture 的单测能直驱可见性（行账同源走 panelRows）。
 *
 * 字形纪律（spec #146:86 无 emoji UI 字形）：只用几何字形 `● ○ ✓ ✗`
 * （项目既有惯例，见 context-bar 的 █░ / tool-summary 的 …），禁止 emoji。
 */
import type { ReactNode } from "react";
import type { SubagentInfo } from "../harness/subagent/manager.js";
import { clipOneLineVisual, visualWidth } from "./tool-summary.js";
import { formatRunDuration } from "./run-stats.js";
import { tuiPalette } from "./theme.js";
// SC14/SC15 行序合同：live 判据是单一谓词（starting + running），与投影 /
// 强杀分派 / app focus 计数同源 —— 面板行序漂移会让 Ctrl+X 杀错行。
import { isLiveSubagent } from "./subagent-message-lines.js";

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
  /** 面板行数上限（#1044，超出折叠为 `… +N`）。缺省 SUBAGENT_PANEL_MAX_ROWS ——
   *  调用方（app.tsx）与本组件同源取值，行账与渲染高度恒等。 */
  readonly maxRows?: number;
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

/** live 行首字形（starting ○ / running ●）—— 投影与 visibleLiveRowCount 同源。 */
const ICON_STARTING = "○";
const ICON_RUNNING = "●";
const LIVE_LINE_ICONS: ReadonlySet<string> = new Set([
  ICON_STARTING,
  ICON_RUNNING,
]);

/**
 * 面板行数上限（#1044 SSOT）：SubagentPanel 渲染与 chromeReserveRows 的
 * panelRows 行账共用同一值 —— 超限折叠为「… +N」一行后，行账与实际渲染
 * 高度恒等，Yoga 负空间不再按 flexShrink 比例摊到输入框（底部 chrome 无显式
 * 高度、默认 flexShrink=1，见 issue #1044 根因）。app.tsx 经 subagentPanelRowBudget
 * 与本常量接线，不得另立数字。
 */
export const SUBAGENT_PANEL_MAX_ROWS = 5;

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
 * 行数上限折叠（#1044）—— lines 超过 maxRows 时截到 maxRows-1 行，末行换成
 * `… +N`（N = 被隐藏行数，dim 色）。maxRows 缺省 / ≤0 / 未超限 → 原样返回。
 * 模块级纯函数：projectSubagentLines 已顶 S5 ratchet 基线，分支外移不抬其
 * 复杂度。
 */
function collapseToMaxRows(
  lines: SubagentLine[],
  maxRows?: number
): ReadonlyArray<SubagentLine> {
  if (maxRows === undefined || maxRows <= 0 || lines.length <= maxRows) {
    return lines;
  }
  const hidden = lines.length - (maxRows - 1);
  return [
    ...lines.slice(0, maxRows - 1),
    {
      icon: "…",
      fg: tuiPalette.dim,
      text: `… +${hidden}`,
    },
  ];
}

/**
 * 折叠后仍可见的 live 行数（#1044 焦点环上界 SSOT）。复用与渲染完全同一份
 * projectSubagentLines 投影（含 failed 行穿插 + collapseToMaxRows 尾部裁剪 +
 * `… +N` 折叠行），再数其中的 live 字形（○/●）—— 可见行数与渲染行集恒等。
 *
 * 不能用 `min(live 行数, maxRows-1)` 公式：failed(✗) 行与 live 行穿插进同一
 * 序列参与折叠裁剪，failed 行占据可见槽位时实际可见 live 行数更少，公式会
 * 高估 → focusedRow 落到被隐藏的行上（`> ` 前缀画在不可见行）。
 *
 * `cols` 只影响行文本截断、不影响行集组成；`nowMs` 决定 failed 30s 窗口，
 * 必须与渲染同源传入。reducer（reduceChromeFocus.subagentCount）与越界
 * clamp（app.tsx useEffect）用本函数而不是原始 live 数。纯函数可单测直驱。
 */
export function visibleLiveRowCount(
  subagents: ReadonlyArray<SubagentInfo>,
  nowMs: number,
  cols: number,
  maxRows: number = SUBAGENT_PANEL_MAX_ROWS
): number {
  return projectSubagentLines(subagents, nowMs, cols, undefined, maxRows)
    .filter((line) => LIVE_LINE_ICONS.has(line.icon)).length;
}

/**
 * 纯函数投影：可见性过滤 + 行文本生成（不 touch OpenTUI，可单测直驱）。
 *
 *   - 活跃行：`{icon} {name} {taskPreview} · {elapsed}`；窄列无 preview；
 *   - 失败行：`✗ {name} {preview} · {reason}`；
 *   - 完成淡出行：`✓ {N} 完成`；
 *   - 受 maxRows 上限约束（超限末行折 `… +N`，#1044）。
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
  focusedRow?: number,
  maxRows?: number
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
    if (isLiveSubagent(s)) {
      liveIndex += 1;
      const icon = s.state === "starting" ? ICON_STARTING : ICON_RUNNING;
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

  let lines: SubagentLine[] = [...live];
  if (lines.length === 0 && doneCount > 0) {
    lines.push({
      icon: "✓",
      fg: tuiPalette.add,
      text: `✓ ${doneCount} 完成`,
    });
  }
  return collapseToMaxRows(lines, maxRows);
}

export function SubagentPanel(props: SubagentPanelProps): ReactNode {
  const lines = projectSubagentLines(
    props.subagents,
    props.nowMs ?? Date.now(),
    props.cols,
    props.focusedRow,
    props.maxRows
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
