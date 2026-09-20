/** @jsxImportSource @opentui/react */
/**
 * src/tui/compact-progress.tsx
 *
 * Compaction progress panel: the rounded flowing-border frame with gradient
 * bar and edge crest, matching the /effort picker's visual language.
 *
 * **The bar is a time estimate, not real progress** — the harness emits only
 * 5 discrete events (`compaction_started {droppedCount}` /
 * `compaction_text_delta` / `compaction_completed` / `compaction_failed` /
 * `compaction_cancelled`, see src/harness/stream.ts); there is **no** tick,
 * percentage or phase signal. So the fill can only asymptote over elapsed
 * (`compactBarFill`, capped at 0.95) and hits 1.0 only on completed. The
 * panel never fakes a finished bar: an incomplete bar always keeps a gap.
 *
 * Pure functions (no React dependency, independently unit-testable):
 *  - `reduceCompactionEvent`: event-reduction state machine (identity contract below);
 *  - `compactBarFill` / `compactStatusText` / `compactHintText` /
 *    `compactProgressRows`: fill estimate, status text, key hints, row-account SSOT;
 *  - `startCompactPanel` / `settleCompactPanel`: panel create/terminal entry points.
 *
 * The render component `CompactProgress`: rounded flow frame (8s border phase)
 * + title + status line + 45-cell `█` bar + key hints, 6 rows total (2 border
 * + 4 content), excluding marginBottom (same convention as thinkingPickerRows /
 * memoryPickerRows, accounted via chromeReserveRows +1). Fixed PICKER_WIDTH
 * (50), alignSelf="flex-start".
 *
 * Events are the **fast path**, the promise result is the **terminal authority**:
 * the pre-abort early return (full-compact.ts `signal_aborted` branch) and the
 * catch emit no `compaction_*` events at all, so relying on events alone would
 * strand the panel in a 95% pseudo in-flight state. The host must fall back to
 * `settleCompactPanel` for the terminal state and force-sweep in the turn's finally.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { TextAttributes, type Timeline } from "@opentui/core";
import { useTimeline } from "@opentui/react";
import type { HarnessStreamEvent } from "../harness/stream.js";
import { useTick } from "./components.js";
import { tuiPalette } from "./theme.js";
import { PICKER_WIDTH } from "./thinking-picker.js";
import { floorTo5BarLen } from "./designs/_geometry.js";
import {
  BORDER_CYCLE_MS,
  flowBorderColor,
  gradAt,
  mixHex,
  triangleWindow,
} from "./designs/_color.js";

// ── State model + pure projections ─────────────────────────────────────────

/** Panel origin: manual `/compact` (Esc cancels it) / in-turn auto-compact (Esc interrupts the turn). */
export type CompactProgressSource = "manual" | "turn";

/** Terminal classification. done = compaction actually completed; failed = summary failed; cancelled = user cancelled. */
export type CompactTerminalKind = "done" | "failed" | "cancelled";

/**
 * Panel state (owned by the host app.tsx, keyed by conversationId).
 *
 *  - source: which path owns the panel (decides the hint text, and who sweeps it);
 *  - droppedCount: message count carried by the started event (0 = started not yet
 *    received, the status line shows "preparing");
 *  - startedAt: panel creation moment (elapsed origin, ms epoch);
 *  - terminal: terminal state (null = in-flight). Once terminal, late events are
 *    ignored.
 */
export interface CompactProgressState {
  readonly source: CompactProgressSource;
  readonly droppedCount: number;
  readonly startedAt: number;
  readonly terminal: null | {
    readonly kind: CompactTerminalKind;
    readonly atMs: number;
  };
}

/** Bar fill cap (the time estimate never "completes" — only done reaches 1.0). */
export const COMPACT_BAR_MAX_FILL = 0.95;
/** Time constant: at elapsed = tau the estimate is about 63% complete (asymptote, see compactBarFill). */
export const COMPACT_TAU_MS = 12_000;
/** Terminal dwell time: lets 100% / failure color be seen before the host unmounts the panel. */
export const COMPACT_HOLD_MS = 1_200;

/**
 * Bar fill (time estimate, **not** real progress).
 *
 * `min(0.95, 0.05 + 0.90 * (1 - exp(-max(0,elapsed)/12000)))`:
 *  - starts at 0.05 (a visible fill the moment the panel appears, never empty);
 *  - asymptotic cap 0.95 (passing time never impersonates "done");
 *  - negative elapsed clamps to 0 (startedAt in the future / clock skew).
 *
 * The 1.0 on completed is handled by the component directly via
 * `terminal.kind === "done"`, not through this function (which only expresses
 * the in-flight estimate).
 */
export function compactBarFill(elapsedMs: number): number {
  const t = Math.max(0, elapsedMs);
  return Math.min(
    COMPACT_BAR_MAX_FILL,
    0.05 + 0.9 * (1 - Math.exp(-t / COMPACT_TAU_MS))
  );
}

/**
 * Status line text (SSOT pure function). elapsed = floor(max(0, now-startedAt)/1000) seconds:
 *
 *  - in-flight and droppedCount === 0 → `◐  {n}s · preparing` (started not yet seen);
 *  - in-flight → `◐  {n}s · {droppedCount} messages folded`;
 *  - done → `✓  {n}s · done`; failed → `✗  {n}s · summary failed`;
 *    cancelled → `—  {n}s · cancelled`.
 */
export function compactStatusText(
  state: CompactProgressState,
  nowMs: number
): string {
  const elapsed = Math.floor(Math.max(0, nowMs - state.startedAt) / 1000);
  if (state.terminal === null) {
    const detail =
      state.droppedCount === 0
        ? "preparing"
        : `${state.droppedCount} messages folded`;
    return `◐  ${elapsed}s · ${detail}`;
  }
  switch (state.terminal.kind) {
    case "done":
      return `✓  ${elapsed}s · done`;
    case "failed":
      return `✗  ${elapsed}s · summary failed`;
    case "cancelled":
      return `—  ${elapsed}s · cancelled`;
    default: {
      // Unreachable after union narrowing; only a future new kind lands here (never silently swallowed).
      const _exhaustive: never = state.terminal.kind;
      throw new Error(`unknown compact terminal kind: ${String(_exhaustive)}`);
    }
  }
}

/**
 * Key hints: manual → `[Esc] cancel`; turn → `[Esc] interrupt`.
 *
 * The turn path has no dedicated compaction-cancel channel — Esc interrupts
 * the turn itself and compaction aborts along with it (loop-engine passes the
 * same signal into applyCompactAttachment), so the text must say interrupt,
 * not cancel, to avoid promising an exact operation that does not exist.
 */
export function compactHintText(source: CompactProgressSource): string {
  return source === "manual" ? "[Esc] cancel" : "[Esc] interrupt";
}

/** Total terminal rows of the panel (row-account SSOT): border 2 + content 4. Excludes marginBottom=1. */
export function compactProgressRows(): number {
  return 6;
}

/** Create a panel (startedAt=nowMs, droppedCount 0, in-flight). */
export function startCompactPanel(
  source: CompactProgressSource,
  nowMs: number
): CompactProgressState {
  return { source, droppedCount: 0, startedAt: nowMs, terminal: null };
}

/**
 * Terminal entry point (the promise result is the terminal authority).
 *
 * Already terminal → returned as-is (reference equality): late paths must not
 * rewrite a presented outcome, nor reset the hold timer (atMs is the first
 * settle moment).
 */
export function settleCompactPanel(
  state: CompactProgressState,
  kind: CompactTerminalKind,
  nowMs: number
): CompactProgressState {
  if (state.terminal !== null) return state;
  return { ...state, terminal: { kind, atMs: nowMs } };
}

/**
 * Short-circuit for terminal events with no panel: nothing to update →
 * undefined (do not conjure a panel). Shared by the three terminal events,
 * pulled out of reduceCompactionEvent to stay within the complexity budget.
 */
function settleIfPresent(
  state: CompactProgressState | undefined,
  kind: CompactTerminalKind,
  nowMs: number
): CompactProgressState | undefined {
  return state === undefined
    ? undefined
    : settleCompactPanel(state, kind, nowMs);
}

/**
 * Event reduction (pure function, identity contract below). The host calls it
 * keyed by conversationId.
 *
 * **Identity contract**: non-compaction events return **the same reference** —
 * app.tsx's onStream event chain uses reference equality as a guard, so
 * non-compaction events trigger no setState (otherwise every text_delta would
 * re-render the whole chrome).
 *
 *  - `compaction_started`: in-flight → update droppedCount (keep source/startedAt,
 *    do not reset the timer); already terminal → ignore (late); no panel → create
 *    per opts;
 *  - `compaction_completed` / `_failed` / `_cancelled`: no panel → undefined
 *    (nothing to update, do not conjure one); already terminal → ignore (late);
 *    in-flight → settle;
 *  - `compaction_text_delta`: always identity (liveness signal; the fill is a
 *    time estimate, text deltas advance nothing).
 */
export function reduceCompactionEvent(
  state: CompactProgressState | undefined,
  event: HarnessStreamEvent,
  opts: { readonly source: CompactProgressSource; readonly nowMs: number }
): CompactProgressState | undefined {
  switch (event.type) {
    case "compaction_started":
      if (state === undefined) {
        return {
          source: opts.source,
          droppedCount: event.droppedCount,
          startedAt: opts.nowMs,
          terminal: null,
        };
      }
      if (state.terminal !== null) return state; // late started, ignored
      return { ...state, droppedCount: event.droppedCount };
    case "compaction_completed":
      return settleIfPresent(state, "done", opts.nowMs);
    case "compaction_failed":
      return settleIfPresent(state, "failed", opts.nowMs);
    case "compaction_cancelled":
      return settleIfPresent(state, "cancelled", opts.nowMs);
    default:
      // compaction_text_delta: always identity (the summary text stream only
      // proves liveness, it does not advance progress). Same for non-compaction
      // events — identity is what the app-layer reference-equality guard relies on.
      return state;
  }
}

// ── Render constants (same visual language as the pickers) ─────────────────

/** Duration of one full left-right crest traverse (alternate ping-pong single pass). */
const EDGE_FLOW_MS = 2400;
/** Crest sway amplitude (half-range relative to segLen, ± 0.9 segments). */
const EDGE_SWAY = 0.9;
/** Brightest point of the crest blends fully to logoGold. */
const EDGE_MIX = 1;
/** Bar heartbeat period (drives the per-second elapsed ticks + crest advance). */
const TICK_MS = 100;

/**
 * CompactProgress — rounded-flow compaction progress panel.
 *
 * Persistent overlay: no entrance animation, fixed PICKER_WIDTH with
 * alignSelf flex-start; constant 6 rows (2 border + 4 content: title /
 * status line / bar / key hints). Colors and motion align verbatim with
 * the effort panel of thinking-picker (same visual language).
 */
export function CompactProgress(props: {
  readonly state: CompactProgressState;
}): ReactNode {
  const pal = tuiPalette;
  const { state } = props;

  // ── Timeline refs (useRef pins the first render instance, same as the pickers) ──
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

  // ── Persistent animation state (setState every frame) ──
  const [borderPhase, setBorderPhase] = useState(0);
  const [edgePhase, setEdgePhase] = useState(0.5); // crest phase 0..1..0
  // Elapsed clock: 100ms heartbeat (not useTimeline — second ticks are discrete
  // readings, not continuous interpolation). The return value only triggers
  // re-render; elapsed is recomputed from Date.now(), the tick value is unused.
  useTick(TICK_MS);

  // Border flow phase: 8s linear loop (onComplete resets to avoid the reset trap).
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

  // Persistent: crest phase 0→1→0 (alternate ping-pong), driving the edge a
  // small left-right flow. Even when the fill barely moves the crest keeps
  // running — a liveness signal.
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

  // ── Bar geometry (shared _geometry.ts): width fixed at PICKER_WIDTH; border
  //    2 cols + paddingX 2 cols = 4 cols fixed overhead, inner width =
  //    PICKER_WIDTH - 4.
  const barLen = floorTo5BarLen(PICKER_WIDTH - 4);
  const segLen = barLen / 5;

  // ── Fill: 1.0 only on done (real completion), otherwise time-asymptotic
  //    (see module header).
  const terminalKind = state.terminal?.kind ?? null;
  const nowMs = Date.now();
  const fill =
    terminalKind === "done" ? 1 : compactBarFill(nowMs - state.startedAt);
  // Crest center = fill frontier ± 0.9*segLen slow sway.
  const edgeCenter = fill * barLen - 1 + (edgePhase - 0.5) * segLen * EDGE_SWAY;

  /** Crest (triangular window of half-width segLen, blending toward logoGold at the frontier). */
  function crestColor(i: number): number {
    return triangleWindow(i, edgeCenter, segLen) * EDGE_MIX;
  }

  /**
   * Color of char i:
   *  - unfilled → dark-gray dry track (bg border / fg dim), crest stays out;
   *  - filled → purple-gradient base (gradAt normalized by the frontier) with the
   *    edge crest mixing toward logoGold;
   *  - terminal failed → the filled segment overall mixes toward error;
   *  - terminal cancelled → whole bar degrades to dark gray (nothing to show).
   */
  function colorAt(i: number): { bg: string; fg: string } {
    if (terminalKind === "cancelled") {
      return { bg: pal.border, fg: pal.dim };
    }
    const filledEnd = Math.max(1, Math.ceil(fill * barLen));
    if (terminalKind === null && i >= filledEnd) {
      return { bg: pal.border, fg: pal.dim };
    }
    const base = gradAt(i / Math.max(1, filledEnd));
    const glowEdge = crestColor(i);
    const crest = mixHex(pal.logoInk, pal.logoGold, glowEdge);
    let bg = mixHex(base, crest, glowEdge);
    if (terminalKind === "failed") {
      // Failed: the filled segment tilts toward error overall (a bit of gradient skeleton kept).
      bg = mixHex(bg, pal.error, 0.72);
    }
    const fg = mixHex(bg, pal.logoInk, 0.5);
    return { bg, fg };
  }

  // ── Progress bar: fills the inner width, per-cell bg/fg tinting ──
  const barCells: ReactNode[] = [];
  for (let i = 0; i < barLen; i++) {
    const { bg, fg } = colorAt(i);
    barCells.push(
      <span key={i} bg={bg} fg={fg}>
        █
      </span>
    );
  }

  const statusTone =
    terminalKind === "failed"
      ? pal.error
      : terminalKind === "done"
        ? pal.running
        : pal.dim;

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
      {/* Title ◆─ Compacting (picker-family prefix, running color + BOLD body) */}
      <text>
        <span fg={pal.running}>{"◆─ "}</span>
        <span fg={pal.text} attributes={TextAttributes.BOLD}>
          Compacting
        </span>
      </text>

      {/* Status line: ◐/✓/✗/— + elapsed + outcome (text SSOT = compactStatusText) */}
      <text fg={statusTone} wrapMode="none">
        {compactStatusText(state, nowMs)}
      </text>

      {/* Progress bar: purple-gradient fill + flowing edge crest (time estimate, not real progress) */}
      <text wrapMode="none">{barCells}</text>

      {/* Key hints (wrapMode none: clipped on narrow terminals, keeping the fixed 6-row budget) */}
      <text fg={pal.dim} wrapMode="none">
        {compactHintText(state.source)}
      </text>
    </box>
  );
}
