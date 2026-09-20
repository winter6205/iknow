/** @jsxImportSource @opentui/react */
/**
 * src/tui/subagent-panel.tsx
 *
 * Subagent status panel — a few lines of subagent state rendered below the
 * ContextBar (usage bar).
 *
 * Data contract: this component only reads the `SubagentInfo` projection (the
 * raw `listSubagents` output of src/harness/subagent/manager.ts). No state
 * writes, no subscriptions, no polling — a pure presentational component
 * driven by props (startedAt/endedAt ISO), zero effects/intervals. Wiring
 * (app.tsx passing the subagents array + cols + time source) is the caller's
 * job; this module owns only "projection → line text" and rendering.
 *
 * Visibility semantics (aligned with Claude Code's done-state behaviour):
 *   1. Active lines (starting/running): always shown, one line per subagent;
 *   2. Failed lines: shown only while endedAt is within
 *      FAILED_VISIBLE_WINDOW_S of now, then dropped;
 *   3. Completed lines: never shown individually (removed immediately);
 *   4. No active line but something completed within DONE_FADE_WINDOW_S →
 *      a single fading `✓ N 完成` hint line;
 *   5. Everything empty → return null;
 *   6. Active lines are listed in full but capped at SUBAGENT_PANEL_MAX_ROWS —
 *      on overflow the first maxRows-1 lines stay and the tail collapses to
 *      `… +N`. After collapse the line count equals the chrome row accounting
 *      (app.tsx subagentPanelRowBudget → chromeReserveRows.panelRows); the
 *      panel draws below the input box and is no longer compressed by Yoga
 *      ratios.
 *
 * Narrow-column branch (cols < 40): the product path floors cols at 40 (see
 * app.tsx `Math.max(width ?? 80, 40)`), so this branch is defensive / for
 * test fixtures; kept so cols=30 unit tests can drive visibility directly
 * (row accounting still goes through panelRows).
 *
 * Glyph discipline (no emoji UI glyphs): only geometric glyphs `● ○ ✓ ✗`
 * (project convention, cf. █░ in context-bar and … in tool-summary).
 */
import type { ReactNode } from "react";
import type { SubagentInfo } from "../harness/subagent/manager.js";
import { clipOneLineVisual, visualWidth } from "./tool-summary.js";
import { formatRunDuration } from "./run-stats.js";
import { tuiPalette } from "./theme.js";
// Row-order contract shared with the kill dispatch and app focus counting:
// "live" is the single predicate isLiveSubagent (starting + running) — panel
// row-order drift would make Ctrl+X kill the wrong row.
import { isLiveSubagent } from "./subagent-message-lines.js";

export interface SubagentPanelProps {
  /** Read-only projection: the host passes the SubagentInfo list; this component never rewrites it. */
  readonly subagents: ReadonlyArray<SubagentInfo>;
  readonly cols: number;
  /** Test injection; defaults to Date.now(). */
  readonly nowMs?: number;
  /**
   * Index of the currently focused live subagent row (derived from the
   * chrome-focus reducer's `{ kind: "subagent", row }`). Applies to live rows
   * only — the focused row's taskPreview is not truncated and gains a `> `
   * prefix; other rows keep the original truncation. Out of range or
   * undefined → no focus (behaviour identical to unfocused).
   */
  readonly focusedRow?: number;
  /** Panel row cap (overflow collapses to `… +N`). Defaults to
   *  SUBAGENT_PANEL_MAX_ROWS — the caller (app.tsx) and this component read
   *  the same source, so row accounting always equals rendered height. */
  readonly maxRows?: number;
}

export interface SubagentLine {
  /** Leading geometric glyph (`● ○ ✗ ✓ …`) for unit-test matching; text already holds the full line. */
  readonly icon: string;
  readonly fg: string;
  /** Full line text (icon glyph and separators included); rendered directly as `<text>{text}</text>`. */
  readonly text: string;
}

/** Failed-line visibility window: endedAt within 30s of now. Exported so app.tsx's
 *  watch window consumes the same value (hasRecentEndedSubagent failed branch uses this ×1000). */
export const FAILED_VISIBLE_WINDOW_S = 30;
/** Done-fade window: endedAt within 5s of now. Exported so app.tsx's watch window
 *  consumes the same value (hasRecentEndedSubagent completed branch uses this ×1000). */
export const DONE_FADE_WINDOW_S = 5;
/** Wide-column line decoration reserve: icon(1) + space(1) + name space(1) + ` · `(3) + elapsed up to 8 columns. */
const DECOR_RESERVE = 14;
const NAME_BUDGET = 20;

/** Live-row leading glyphs (starting ○ / running ●) — projection and visibleLiveRowCount share this source. */
const ICON_STARTING = "○";
const ICON_RUNNING = "●";
const LIVE_LINE_ICONS: ReadonlySet<string> = new Set([
  ICON_STARTING,
  ICON_RUNNING,
]);

/**
 * Panel row cap (SSOT): shared by SubagentPanel rendering and the
 * chromeReserveRows.panelRows row accounting in app.tsx — after overflow
 * collapses into a single `… +N` line, the accounted rows and the rendered
 * height are always equal, so Yoga's negative space no longer gets spread
 * onto the input box by flexShrink ratio (bottom chrome has no explicit
 * height and defaults to flexShrink=1). app.tsx wires through
 * subagentPanelRowBudget; do not introduce a second number.
 */
export const SUBAGENT_PANEL_MAX_ROWS = 5;

/**
 * Whole-second elapsed between startedAt(ISO) and nowMs. Invalid ISO or
 * nowMs earlier than startedAt (clock drift) → 0, keeping NaN out of the
 * render layer.
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
 * Row-cap collapsing: when lines exceed maxRows, keep maxRows-1 lines and
 * replace the tail with `… +N` (N = hidden row count, dim colour). Undefined
 * or ≤0 maxRows, or no overflow → returned as-is. Module-level pure
 * function: projectSubagentLines is already at its S5 ratchet baseline, so
 * moving this branch out keeps its complexity flat.
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
 * Live rows still visible after collapsing (focus-ring upper bound, SSOT).
 * Reuses the exact same projectSubagentLines projection as rendering
 * (including failed-line interleaving, collapseToMaxRows tail cutting and
 * the `… +N` fold line), then counts live glyphs (○/●) in it — the visible
 * count and the rendered row set are always identical.
 *
 * A `min(live rows, maxRows-1)` formula will not do: failed (✗) lines
 * interleave with live lines in the same sequence and take part in
 * collapsing; when failed lines occupy visible slots, fewer live lines are
 * actually visible and the formula overestimates → focusedRow could land on
 * a hidden row (the `> ` prefix drawn on an invisible line).
 *
 * `cols` only affects line-text truncation, not row-set composition;
 * `nowMs` decides the 30s failed window and must be passed from the same
 * source as rendering. The reducer (reduceChromeFocus.subagentCount) and the
 * out-of-range clamp (app.tsx useEffect) use this function instead of the
 * raw live count. Pure function, directly unit-testable.
 */
export function visibleLiveRowCount(
  subagents: ReadonlyArray<SubagentInfo>,
  nowMs: number,
  cols: number,
  maxRows: number = SUBAGENT_PANEL_MAX_ROWS
): number {
  return projectSubagentLines(
    subagents,
    nowMs,
    cols,
    undefined,
    maxRows
  ).filter((line) => LIVE_LINE_ICONS.has(line.icon)).length;
}

/**
 * Pure projection: visibility filtering + line-text generation (never
 * touches OpenTUI, directly unit-testable).
 *
 *   - live line: `{icon} {name} {taskPreview} · {elapsed}`; no preview in narrow columns;
 *   - failed line: `✗ {name} {preview} · {reason}`;
 *   - done-fade line: `✓ {N} 完成`;
 *   - capped at maxRows (overflow folds the tail into `… +N`).
 *
 * `focusedRow` (optional): when a `live[i]` has `i === focusedRow`, its
 * taskPreview is not truncated (still bounded by cols visual width) and gains
 * a `> ` prefix marking focus; other `live` rows keep truncation. Failed
 * lines take no focus (focusedRow applies to live rows only — subagent chrome
 * focus moves within the live ring). `undefined` or out of range → no focus
 * (all rows render as before).
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
      // Focus applies to live rows only: the focused row keeps its preview
      // untruncated (still bounded by cols) + `> ` prefix; other rows keep
      // the original truncation. focusedRow out of range (≥ live.length) →
      // equivalent to unfocused (no prefix).
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
