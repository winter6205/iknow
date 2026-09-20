/** @jsxImportSource @opentui/react */
/**
 * src/tui/thinking-picker.tsx
 *
 * Thinking panels: `/thinking` is a pure ON/OFF switch panel, `/effort` is a
 * 5-level picker (low..max). Interaction contract (SSOT, do not change):
 *  - `/thinking` only toggles thinkingEnabled; `/effort` only sets
 *    thinkingEffort (implicitly enabling thinking). Neither touches the other.
 *  - Enter = fix: pin the current selection inside the panel; panel stays open.
 *  - Esc = save-and-close: write the pinned value into the real
 *    thinkingEnabled / thinkingEffort state, then close. There is no
 *    cancel/discard path.
 *  - computeThinkingOverride (thinking-gate.ts) must not change — the picker
 *    is only a new entry point for setThinkingEnabled / setThinkingEffort.
 *
 * Pure functions (no React dependency):
 *  - effortToIndex / indexToEffort: SSOT mapping between
 *    ThinkingEffortWire and level index (""=adaptive → -1; low..max → 0..4).
 *  - THINKING_LEVELS: reuses ADJUSTABLE_EFFORT_LEVELS from slash.ts (single
 *    list, derived from contract.ts THINKING_EFFORT_VALUES upstream).
 *  - reduceThinkingSwitchKey / reduceThinkingEffortKey: key-routing pure
 *    functions for the two panels.
 *
 * Rendering (ThinkingPicker): rounded flowing-border frame + level labels +
 * key hints, dispatched by state.kind. Switch panel content is 3 lines
 * (title / status / hints, no progress bar); effort panel content is 5 lines
 * (title / status / progress bar / labels / hints). It is a persistent overlay
 * with a constant row budget and no entry animation.
 *  - thinkingPickerRows(kind): total terminal rows = thinking 5 (2 border +
 *    3 content) / effort 7 (2 border + 5 content), excluding marginBottom=1
 *    (same convention as modalRows; accounted by chromeReserveRows +1).
 *  - Fixed width PICKER_WIDTH, left-aligned via alignSelf="flex-start".
 *  - Color math lives in designs/_color.ts as the single implementation;
 *    design gallery files keep self-contained copies per that directory's
 *    convention.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { TextAttributes, type Timeline } from "@opentui/core";
import { useTimeline } from "@opentui/react";
import type { ThinkingEffortWire } from "../session-api/contract.js";
import type { ModalKeyEvent } from "./modal.js";
import { ADJUSTABLE_EFFORT_LEVELS } from "./slash.js";
import { tuiPalette } from "./theme.js";
import {
  SEG_COUNT,
  floorTo5BarLen,
  labelPad,
  segmentLen,
} from "./designs/_geometry.js";
import {
  BORDER_CYCLE_MS,
  flowBorderColor,
  gradAt,
  mixHex,
  triangleWindow,
} from "./designs/_color.js";

/** Adjustable thinking levels (SSOT reference: slash.ts, never redefined).
 *  5 concrete levels low..max at index 0..4; ""=adaptive is not in the list. */
export const THINKING_LEVELS: ReadonlyArray<Exclude<ThinkingEffortWire, "">> =
  ADJUSTABLE_EFFORT_LEVELS;

/** Upper bound of level index (5 levels → 0..4). */
const LEVEL_MAX_INDEX = THINKING_LEVELS.length - 1;

/** effort level → picker focus index (""=adaptive → -1). */
export function effortToIndex(effort: ThinkingEffortWire): number {
  if (effort === "") return -1;
  return THINKING_LEVELS.indexOf(effort);
}

/** effort level → picker *display* index (""=adaptive → 1=medium, matching
 *  the "default level is medium" contract). With thinkingEffort="" the panel
 *  must still highlight a perceptible current level, otherwise the first
 *  frame is blank and Enter pins an ambiguous selection. */
export function effortToDisplayIndex(effort: ThinkingEffortWire): number {
  const idx = effortToIndex(effort);
  return idx === -1 ? 1 : idx; // "" → medium (index 1)
}

/** picker focus index → effort level (-1 adaptive / out of range → ""). */
export function indexToEffort(index: number): ThinkingEffortWire {
  return index >= 0 && index <= LEVEL_MAX_INDEX
    ? (THINKING_LEVELS[index] as ThinkingEffortWire)
    : "";
}

// ── commit payload projection (bidirectional settings persistence) ─────────

/** Persisted payload returned by committedThinkingPatch (fed to settings.ts):
 *  - thinking: llm.thinking domain ("off" | "adaptive");
 *  - thinkingEffort: one of the 5 concrete levels (IknowSettingsThinkingEffort
 *    domain, **no ""** — "auto" is expressed by deleting the key; empty string
 *    is meaningless in settings); null → caller deletes the key (semantics of
 *    mergeThinkingPatch in persist-settings). */
export interface CommittedThinkingPatch {
  readonly thinking: "off" | "adaptive";
  readonly thinkingEffort?: Exclude<ThinkingEffortWire, ""> | null;
}

/**
 * Project the panel state at Esc save-and-close into a **persistable
 * payload** (pure function, no React dependency, unit-testable). Only the
 * field of the panel the user actually used is persisted (minimal write):
 *  - kind:"thinking" → switch only: enabled → {thinking:"adaptive"};
 *    disabled → {thinking:"off"}. **No thinkingEffort key** — the switch
 *    panel never touches the level; the chosen level survives toggling off
 *    and back on.
 *  - kind:"effort" → the level panel always enables thinking:
 *    {thinking:"adaptive"}; autoOn → thinkingEffort:null (auto is meaningless
 *    in settings; deleting the key = default adaptive, consistent with
 *    env.ts defaultEffort=""); concrete → reuse indexToEffort on the pinned
 *    level (effortFixedIndex, the committed level after Enter).
 *  - null = nothing to persist (defensive branch, unreachable in the current
 *    union) — only a guard for future ThinkingPickerState variants; callers
 *    must handle it explicitly.
 */
export function committedThinkingPatch(
  state: ThinkingPickerState
): CommittedThinkingPatch | null {
  switch (state.kind) {
    case "thinking":
      return { thinking: state.enabled ? "adaptive" : "off" };
    case "effort":
      return {
        thinking: "adaptive",
        // currentIndex ∈ [0,4] (clamped by app.tsx) → indexToEffort always
        // returns one of the 5 levels; "" is narrowed away (meaningless in
        // settings; auto is already expressed by the null branch).
        thinkingEffort: state.autoOn
          ? null
          : (indexToEffort(state.currentIndex) as Exclude<
              ThinkingEffortWire,
              ""
            >),
      };
    default:
      // Unreachable after union narrowing: only a guard for future kind
      // variants. Returning null persists nothing, so an unknown panel is
      // never mis-written into the thinking key.
      return null;
  }
}

// ── switch panel key routing (/thinking) ──────────────────────────────────

/** Decision result of reduceThinkingSwitchKey. */
export type ThinkingSwitchAction =
  | { readonly type: "toggle" } // Space/Tab → flip the in-panel switch preview
  | { readonly type: "fix" } // Enter → pin current preview (panel stays open, no flip)
  | { readonly type: "commit" } // Esc → save-and-close (writes real thinkingEnabled)
  | { readonly type: "ignore" };

/**
 * Switch-panel key routing (consumed by the host's useKeyboard):
 *  - ctrl/meta combos → ignore (leave them to existing routes; Ctrl+C/O is
 *    not swallowed);
 *  - Esc → commit (save-and-close: pinned value goes to real state, no
 *    cancel path);
 *  - Space / Tab → toggle (flip in-panel preview, panel stays open);
 *  - Enter → fix (pin current preview; panel stays open and does not flip —
 *    same "Enter pins, not exits" semantics as the effort panel);
 *  - anything else (↑/↓/printable) → ignore (no hotkey direct-select).
 */
export function reduceThinkingSwitchKey(
  event: ModalKeyEvent
): ThinkingSwitchAction {
  const { key } = event;
  if (key.ctrl || key.meta) return { type: "ignore" };
  if (key.escape) return { type: "commit" };
  if (key.space || key.tab) return { type: "toggle" };
  if (key.return) return { type: "fix" };
  return { type: "ignore" };
}

// ── effort panel key routing (/effort) ─────────────────────────────────────

/** Decision result of reduceThinkingEffortKey. */
export type ThinkingEffortAction =
  | { readonly type: "move"; readonly index: number } // ←/→ clamp [0,4]
  | { readonly type: "fix" } // Enter → pin focus as committed (panel stays open)
  | { readonly type: "toggleAuto" } // Space/Tab → toggle adaptive (flip autoOn, panel stays open)
  | { readonly type: "commit" } // Esc → save-and-close (writes real thinkingEffort)
  | { readonly type: "ignore" };

/**
 * Effort-panel key routing (consumed by the host's useKeyboard):
 *  - ctrl/meta combos → ignore (leave them to existing routes; Ctrl+C/O is
 *    not swallowed);
 *  - Esc → commit (save-and-close: pinned level goes to real state, no
 *    cancel path);
 *  - ←/→ → move, clamp [0,4];
 *  - Enter → fix (pin the focused level as the in-panel committed level;
 *    panel stays open);
 *  - Space / Tab → toggleAuto (toggle adaptive; panel stays open — with auto
 *    on, the whole bar is dimmed and Esc persists ""=adaptive; with auto off,
 *    back to concrete level selection);
 *  - anything else (↑/↓/printable) → ignore (no hotkey direct-select).
 */
export function reduceThinkingEffortKey(
  event: ModalKeyEvent,
  opts: { readonly focusedIndex: number }
): ThinkingEffortAction {
  const { focusedIndex } = opts;
  const { key } = event;
  if (key.ctrl || key.meta) return { type: "ignore" };
  if (key.escape) return { type: "commit" };
  if (key.leftArrow) {
    return { type: "move", index: Math.max(0, focusedIndex - 1) };
  }
  if (key.rightArrow) {
    return { type: "move", index: Math.min(LEVEL_MAX_INDEX, focusedIndex + 1) };
  }
  if (key.space || key.tab) return { type: "toggleAuto" };
  if (key.return) return { type: "fix" };
  return { type: "ignore" };
}

// ── rendering component + row budget ───────────────────────────────────────

/** Fixed panel width (columns): progress-bar geometry derives from it and
 *  does not follow terminal width (never full-screen width). */
export const PICKER_WIDTH = 50;

/**
 * Total terminal rows of the thinking-picker panels (row-budget SSOT, pure).
 *
 * By panel kind: the thinking switch panel is 5 rows (2 rounded border +
 * 3 content: title, status line, key hints — **no progress bar**); the effort
 * panel is 7 rows (2 border + 5 content: title, status, progress bar, level
 * labels, key hints). Both panels have constant position and row count and a
 * fixed width (PICKER_WIDTH), so rows are independent of cols.
 *
 * **Excludes marginBottom=1** — same convention as modalRows: the panel's own
 * marginBottom is accounted by the +1 in chromeReserveRows (app.tsx).
 */
export function thinkingPickerRows(kind: ThinkingPickerState["kind"]): number {
  return kind === "thinking" ? 5 : 7;
}

// ── render constants ───────────────────────────────────────────────────────

/** Duration of one full left-right sweep of the edge waterline (one leg of
 *  the alternate ping-pong). */
const EDGE_FLOW_MS = 2400;
/** Waterline sway amplitude (half a segLen, ± 0.9 segments). */
const EDGE_SWAY = 0.9;
/** Upper mixing bound toward logoGold at the waterline crest. */
const EDGE_MIX = 1;

/**
 * ThinkingPicker working state (owned by the host app.tsx) — discriminated
 * union of the two panels.
 *
 *  - { kind:"thinking", enabled }: switch-panel preview state (/thinking) —
 *    enabled = uncommitted in-panel switch preview (Enter pins / Esc
 *    save-and-close writes thinkingEnabled);
 *  - { kind:"effort", focusedIndex, currentIndex, autoOn }: effort panel
 *    (/effort) — focusedIndex = cursor (0..4, preview while ←/→ moving);
 *    currentIndex = pinned level (Enter pins / Esc writes thinkingEffort);
 *    autoOn = adaptive mode (Space/Tab toggles; when on the whole bar is
 *    dimmed and Esc persists ""=adaptive).
 */
export type ThinkingPickerState =
  | { readonly kind: "thinking"; readonly enabled: boolean }
  | {
      readonly kind: "effort";
      readonly focusedIndex: number;
      readonly currentIndex: number;
      readonly autoOn: boolean;
    };

/** Short names of the 5 levels (same order as _geometry.ts LEVEL_LABELS / slash.ts). */
const LEVEL_LABELS = ["low", "medium", "high", "xhigh", "max"] as const;

/**
 * ThinkingPicker — rounded flowing-border frame + purple gradient + edge
 * waterline. Dispatched by state.kind: thinking switch panel (pure ON/OFF, no
 * progress bar) / effort panel (5-level cursor + fill by currentIndex + edge
 * waterline). Persistent overlay: no entry animation, fixed width
 * PICKER_WIDTH with alignSelf flex-start; constant rows: thinking 5
 * (2 border + 3 content), effort 7 (2 border + 5 content).
 */
export function ThinkingPicker(props: {
  readonly state: ThinkingPickerState;
}): ReactNode {
  const pal = tuiPalette;
  const { state } = props;

  // ── Timeline refs (useRef pins the first-render instance) ──
  const initialTimeline = useTimeline({
    duration: BORDER_CYCLE_MS,
    loop: true,
  });
  const timelineRef = useRef<Timeline | null>(null);
  if (timelineRef.current === null) timelineRef.current = initialTimeline;
  const tl = timelineRef.current;

  const edgeFirst = useTimeline({
    duration: EDGE_FLOW_MS,
    loop: true,
  });
  const edgeRef = useRef<Timeline | null>(null);
  if (edgeRef.current === null) edgeRef.current = edgeFirst;
  const tlEdge = edgeRef.current;

  // ── Persistent animation state (setState per frame) ──
  const [borderPhase, setBorderPhase] = useState(0);
  const [edgePhase, setEdgePhase] = useState(0.5); // waterline phase 0..1..0

  // Border flow phase: 8s linear loop (onComplete resets to 0 to avoid the timeline reset trap)
  useEffect(() => {
    const target = { phase: 0 };
    tl.add(target, {
      phase: 4,
      duration: BORDER_CYCLE_MS,
      ease: "linear",
      onComplete: () => {
        target.phase = 0;
      },
      onUpdate: () => {
        const next = target.phase;
        setBorderPhase((prev) => (prev === next ? prev : next));
      },
    });
  }, [tl]);

  // Persistent: waterline phase 0→1→0 (alternate ping-pong), driving the small
  // left-right flow at the fill edge
  useEffect(() => {
    const target = { p: 0 };
    tlEdge.add(target, {
      p: 1,
      duration: EDGE_FLOW_MS,
      ease: "linear",
      loop: true,
      alternate: true,
      onUpdate: () => setEdgePhase(target.p),
    });
  }, [tlEdge]);

  // ── Progress-bar geometry (shared _geometry.ts, column-exact with the
  //    design language) ──
  //   Fixed width PICKER_WIDTH regardless of terminal cols: border 2 cols +
  //   paddingX 2 cols = 4 cols of overhead, inner width = PICKER_WIDTH - 4.
  const innerCols = Math.max(SEG_COUNT, PICKER_WIDTH - 4);
  const barLen = floorTo5BarLen(innerCols);
  const segLen = segmentLen(barLen);

  // ── Switch panel (/thinking): pure ON/OFF, no progress bar (a switch panel
  //    must not fake level progress; only the effort panel shows it) ──
  if (state.kind === "thinking") {
    const { enabled } = state;
    // Status line: enabled → ◐ running + ON; otherwise ◑ dim + OFF. The
    // description stays dim either way.
    const dotGlyph = enabled ? "◐" : "◑";
    const dotFg = enabled ? pal.running : pal.dim;
    const modeLabel = enabled ? "ON" : "OFF";
    const modeFg = enabled ? pal.running : pal.dim;
    const desc = enabled ? "思考已开启" : "思考已关闭";

    return (
      <box
        flexDirection="column"
        borderStyle="rounded"
        borderColor={flowBorderColor(borderPhase)}
        paddingX={1}
        paddingY={0}
        marginBottom={1}
        width={PICKER_WIDTH}
        alignSelf="flex-start"
      >
        {/* Title: thinking switch (◆─ shared panel prefix, distinct from the collapsed thinking line in the transcript) */}
        <text>
          <span fg={pal.running}>{"◆─ "}</span>
          <span fg={pal.text} attributes={TextAttributes.BOLD}>
            思考开关
          </span>
        </text>

        {/* Status line: ◐/◑ + ON/OFF + description (enabled bright running, off dim) */}
        <text>
          <span fg={dotFg}>{`${dotGlyph}  `}</span>
          <span fg={modeFg}>{modeLabel}</span>
          <span fg={pal.dim}>{`  ·  ${desc}`}</span>
        </text>

        {/* Key hints (wrapMode none: narrow terminals clip instead of wrapping, keeping the fixed 5-row budget) */}
        <text fg={pal.dim} wrapMode="none">
          [Space] 切换 · [Enter] 固定 · [Esc] 保存退出
        </text>
      </box>
    );
  }

  // ── Effort panel (/effort): 5-level cursor + fill by currentIndex + edge waterline ──
  const { focusedIndex, currentIndex, autoOn } = state;

  /** Waterline center column: rightmost cell of the current level's segment,
   *  slowly swaying ± 0.9*segLen. */
  const edgeCenter =
    currentIndex * segLen + segLen - 1 + (edgePhase - 0.5) * segLen * EDGE_SWAY;

  /**
   * Visual color of cell i: in auto mode the whole bar degrades to a dim grey
   * track (no waterline — the model decides, no concrete fill to show);
   * otherwise unfilled segments (> currentIndex) stay a dry grey track, and
   * filled segments get the purple-gradient base color plus a waterline
   * flowing along the current level's edge (triangular window blending toward
   * logoGold).
   */
  function colorAt(i: number): { bg: string; fg: string } {
    if (autoOn) return { bg: pal.border, fg: pal.dim };
    const segIdx = Math.min(SEG_COUNT - 1, Math.floor(i / segLen));
    if (segIdx > currentIndex) {
      // Unfilled dim track (waterline never crosses over — keeps the "dry" look)
      return { bg: pal.border, fg: pal.dim };
    }
    // Filled segment: 3-stop purple gradient base color
    const filledEnd = (currentIndex + 1) * segLen;
    const base = gradAt(i / Math.max(1, filledEnd));
    // Edge waterline: triangular window half-width = segLen; closer to the
    // edge blends more toward logoGold
    const glowEdge = triangleWindow(i, edgeCenter, segLen);
    const crest = mixHex(pal.logoInk, pal.logoGold, glowEdge * EDGE_MIX);
    const bg = mixHex(base, crest, glowEdge); // crest point is exactly logoGold
    const fg = mixHex(bg, pal.logoInk, 0.5);
    return { bg, fg };
  }

  // ── Level-label styling: cursor ▸◂ (while moving) / pinned level brightened
  //    (Enter pins) / the rest dim. In auto mode the whole row is greyed out —
  //    no ▸◂ cursor, no accent highlight (the 5 levels are display-only; the
  //    model decides adaptively). ──
  function labelFor(i: number): { text: string; fg: string; bold: boolean } {
    const text = LEVEL_LABELS[i]!;
    if (autoOn) return { text, fg: pal.dim, bold: false };
    if (i === focusedIndex)
      return { text: `▸ ${text} ◂`, fg: pal.running, bold: true };
    if (i === currentIndex) return { text, fg: pal.accent, bold: true };
    return { text, fg: pal.dim, bold: false };
  }

  // ── Label row nodes: labelPad centers each label on its segment midpoint,
  //    concatenated to barLen cells ──
  const labelNodes: ReactNode[] = [];
  for (let i = 0; i < LEVEL_LABELS.length; i++) {
    const seg = labelFor(i);
    const { lead, pad } = labelPad(segLen, seg.text);
    labelNodes.push(<span key={`p${i}`}>{" ".repeat(lead)}</span>);
    labelNodes.push(
      <span
        key={`l${i}`}
        fg={seg.fg}
        attributes={seg.bold ? TextAttributes.BOLD : TextAttributes.NONE}
      >
        {seg.text}
      </span>
    );
    labelNodes.push(<span key={`t${i}`}>{" ".repeat(pad)}</span>);
  }

  // ── Progress bar: fill by currentIndex + edge waterline (spans the inner width) ──
  const barCells: ReactNode[] = [];
  for (let i = 0; i < barLen; i++) {
    const { bg, fg } = colorAt(i);
    barCells.push(
      <span key={i} bg={bg} fg={fg}>
        █
      </span>
    );
  }

  // ── Render ──
  return (
    <box
      flexDirection="column"
      borderStyle="rounded"
      borderColor={flowBorderColor(borderPhase)}
      paddingX={1}
      paddingY={0}
      marginBottom={1}
      width={PICKER_WIDTH}
      alignSelf="flex-start"
    >
      {/* Title: thinking effort (◆─ shared panel prefix, distinct from the collapsed thinking line) */}
      <text>
        <span fg={pal.running}>{"◆─ "}</span>
        <span fg={pal.text} attributes={TextAttributes.BOLD}>
          思考强度
        </span>
      </text>

      {/* Status line: ◐ always running (the effort panel implies thinking on);
        auto mode → ● running "AUTO", otherwise ◐ "manual level" */}
      <text>
        <span fg={pal.running}>{autoOn ? "●  " : "◐  "}</span>
        <span fg={pal.running} attributes={TextAttributes.BOLD}>
          {autoOn ? "AUTO · 自适应" : "手动档位"}
        </span>
      </text>

      {/* Progress bar: purple-gradient fill + waterline flowing along the
        current level's edge (spans the inner width) */}
      <text wrapMode="none">{barCells}</text>

      {/* Label row: each of the 5 levels centered on its segment midpoint
        (geometry-aligned, breakpoints match the levels) */}
      <text wrapMode="none">{labelNodes}</text>

      {/* Key hints (wrapMode none: narrow terminals clip instead of wrapping,
          keeping the fixed 7-row budget). Auto toggle is disclosed via Tab;
          measured inner width 46 cols must fit this string — spaces/·/←→ were
          dropped to avoid clipping (PICKER_WIDTH 50 - 2 border - 2 paddingX = 46). */}
      <text fg={pal.dim} wrapMode="none">
        [←→] 选档 [Tab]自动 [Enter]固定 [Esc]保存退出
      </text>
    </box>
  );
}
