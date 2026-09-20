/** @jsxImportSource @opentui/react */
/**
 * Thinking-effort panel — Design 7: Fill Slot.
 *
 * Visual style elements:
 *  1. Whole bar `▓▓▓▓▓▓▓▓▓▓▓▓░░░░░░░░░░░░░`: strong contrast between the
 *     bright (traveled) and dark (untraveled) halves; bright char count is
 *     computed dynamically as `Math.round((currentIndex + 1) / 5 *
 *     totalChars)`, so the 5 levels map to 5 equidistant fill points.
 *  2. Top Auto dot `◐` / `◑` glass half-fill: auto on = ◐ bright
 *     (pal.running), off = ◑ dark (pal.dim); on toggle dotColor mix
 *     0↔1 in 200ms outExpo.
 *  3. Slider is a `◂──▸` bracket at the end of the filled part (not a ●
 *     dot): it tracks the fill tail smoothly, sliding 180ms outQuad on
 *     switch, while the bright `▓` region extends/retracts **continuously**
 *     — fillProgress interpolates via `target.progress`, bright char count
 *     recomputed each frame with `Math.round(progress)`, avoiding
 *     discrete 5/10/14/19/24 jumps.
 *  4. Rounded border (`borderStyle="rounded"`) + borderColor cycling over
 *     4 color tokens `logoInk → running → logoGold → running` (8s linear,
 *     adjacent frames RGB-interpolated) for a glass flow-light border.
 *  5. Entry: fill charges 0 → currentIndex's filledTarget in 400ms
 *     outExpo (battery-charging feel); slider translateX is pushed from 0
 *     to filledTarget in sync.
 *  6. Auto coupling: on auto, fillColorMix→1 (bright region turns gray =
 *     pal.dim) and slider opacity→0 fades out; off auto restores from the
 *     current position (fillColorMix→0, slider opacity→1 fades in).
 *
 * Color discipline: every color comes 100% from `tuiPalette` (theme.ts),
 * no new color constants; the OpenTUI renderer degrades hex strings by
 * terminal capability, the app layer never writes ANSI.
 *
 * Animation wiring (combining the mature design-1 / design-5 patterns):
 *  - Fill-progress timeline + auto-coupling timeline use design-1's
 *    `new Timeline` + `engine.register` / `unregister` model: registered
 *    mount-only, and on prop changes the effect runs `resetItems + add +
 *    play`, avoiding useTimeline's per-render new-instance reference drift.
 *  - Border flow timeline uses design-5's `useTimeline({ loop: true })` +
 *    `useRef` first-render lock: the item itself doesn't loop; instead
 *    onComplete zeroes the phase before Timeline.loop's end-of-cycle
 *    resetItems, so the next cycle re-interpolates from 0.
 *  - Slider translateX is assigned inside onUpdate to
 *    `sliderRef.current.translateX` (absolute box, outside React
 *    reconciler control), keeping it exactly in sync with fillProgress.
 */
import { useEffect, useRef, useState } from "react";
import type { ReactElement, ReactNode } from "react";
import { BoxRenderable, TextAttributes, Timeline, engine } from "@opentui/core";
import { useTimeline } from "@opentui/react";
import { tuiPalette } from "../theme.js";
import type { ThinkingDesign, ThinkingDesignProps } from "./_contract.js";

// ── duration / cycle constants ─────────────────────────────────────────
/** Border 4-phase full cycle (aligned with design-5's 8s). */
const BORDER_CYCLE_MS = 8000;
/** Entry charge animation duration + outExpo. */
const ENTRY_MS = 400;
/** Switch slider slide duration + outQuad. */
const SLIDE_MS = 180;
/** Auto-coupling mix transition duration + outExpo. */
const AUTO_MS = 200;

// ── border flow 4-phase tokens (cycled, adjacent phases RGB-interpolated) ──
const FLOW_STOPS: ReadonlyArray<string> = [
  tuiPalette.logoInk,
  tuiPalette.running,
  tuiPalette.logoGold,
  tuiPalette.running,
];

// ── color utils (same as design-5, kept inline on purpose) ─────────────
interface Rgb {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

function hexToRgb(hex: string): Rgb | null {
  if (hex.length !== 7 || hex[0] !== "#") return null;
  const r = Number.parseInt(hex.slice(1, 3), 16);
  const g = Number.parseInt(hex.slice(3, 5), 16);
  const b = Number.parseInt(hex.slice(5, 7), 16);
  if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) return null;
  return { r, g, b };
}

function rgbToHex({ r, g, b }: Rgb): string {
  const c = (n: number): string =>
    Math.max(0, Math.min(255, Math.round(n)))
      .toString(16)
      .padStart(2, "0");
  return `#${c(r)}${c(g)}${c(b)}`;
}

function mixHex(a: string, b: string, t: number): string {
  const aa = hexToRgb(a);
  const bb = hexToRgb(b);
  if (aa === null || bb === null) return a;
  const k = Math.max(0, Math.min(1, t));
  return rgbToHex({
    r: aa.r + (bb.r - aa.r) * k,
    g: aa.g + (bb.g - aa.g) * k,
    b: aa.b + (bb.b - aa.b) * k,
  });
}

/** Look up by phase (real number, 0..FLOW_STOPS.length) and mix toward the next stop → borderColor. */
function flowBorderColor(phase: number): string {
  const phases = FLOW_STOPS.length;
  const idx = Math.floor(phase);
  const f = Math.max(0, Math.min(1, phase - idx));
  const a = FLOW_STOPS[((idx % phases) + phases) % phases] ?? FLOW_STOPS[0]!;
  const b =
    FLOW_STOPS[(((idx + 1) % phases) + phases) % phases] ?? FLOW_STOPS[0]!;
  return mixHex(a, b, f);
}

// ── render component ──────────────────────────────────────────────────
function FillSlotRender(props: ThinkingDesignProps): ReactNode {
  const pal = tuiPalette;
  const { model, cols } = props;
  const { autoOn, currentIndex } = model;

  // Total bar chars (adapts to panel cols, leaving headroom for slider
  // overflow + margins). Bounds: cols < 24 → 12 chars floor; cols >= 36 →
  // 24 chars ceiling.
  const totalChars = Math.max(12, Math.min(24, cols - 12));

  // Filled char count per level (5 levels).
  const filledTarget = (idx: number): number =>
    Math.round(((idx + 1) / 5) * totalChars);

  // ── Refs ───────────────────────────────────────────────────────────
  // Fill progress: continuous value, rewritten in place by the timeline.
  // Bright char count and slider translateX both depend on it — one
  // source of truth drives two render outputs.
  const fillProgressRef = useRef<{ progress: number }>({ progress: 0 });
  // Auto-coupling mixes: fillColorMix (bright run-color → gray) /
  // dotColorMix (dark → run) / sliderOpacity (1→0 fade-out). All three
  // tween in lockstep.
  const autoMixRef = useRef<{
    fillColorMix: number;
    dotColorMix: number;
    sliderOpacity: number;
  }>({
    fillColorMix: autoOn ? 1 : 0,
    dotColorMix: autoOn ? 1 : 0,
    sliderOpacity: autoOn ? 0 : 1,
  });
  // Slider box ref (imperative translateX drive).
  const sliderRef = useRef<BoxRenderable | null>(null);
  // Previous index / auto values for change detection (avoid re-triggering tweens).
  const prevIndexRef = useRef<number>(currentIndex);
  const prevAutoRef = useRef<boolean>(autoOn);

  // ── Force re-render ────────────────────────────────────────────────
  const [borderPhase, setBorderPhase] = useState(0);
  const [, forceFill] = useState(0);
  const [, forceAuto] = useState(0);

  // ── Timelines ──────────────────────────────────────────────────────
  // Fill-progress timeline: lazy-created once (never reset per render),
  // manually attached via `engine.register` (design-1 style).
  const fillTlRef = useRef<Timeline | null>(null);
  if (fillTlRef.current === null) {
    fillTlRef.current = new Timeline({ autoplay: false });
  }
  const fillTl = fillTlRef.current;

  // Auto-coupling timeline: same as above.
  const autoTlRef = useRef<Timeline | null>(null);
  if (autoTlRef.current === null) {
    autoTlRef.current = new Timeline({ autoplay: false });
  }
  const autoTl = autoTlRef.current;

  // Border flow timeline: useTimeline + first-render useRef lock (design-5 style).
  const initialBorderTl = useTimeline({
    duration: BORDER_CYCLE_MS,
    loop: true,
  });
  const borderTlRef = useRef<Timeline | null>(null);
  if (borderTlRef.current === null) {
    borderTlRef.current = initialBorderTl;
  }
  const borderTl = borderTlRef.current;

  // mount-only: register / unregister fillTl + autoTl (cancel-on-close).
  useEffect(() => {
    engine.register(fillTl);
    engine.register(autoTl);
    return () => {
      fillTl.pause();
      engine.unregister(fillTl);
      autoTl.pause();
      engine.unregister(autoTl);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── border flow phase cycle ─────────────────────────────────────────
  // Same as design-5: the item doesn't loop; onComplete zeroes
  // target.phase before Timeline.loop's end-of-cycle resetItems, so the
  // next cycle re-interpolates from 0 (no capture drift).
  useEffect(() => {
    const target = { phase: 0 };
    borderTl.add(target, {
      phase: FLOW_STOPS.length,
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
  }, [borderTl]);

  // ── entry (mount-only): fill 0 → filledTarget, 400ms outExpo battery charge ──
  // Slider translateX stays in sync via the forceFill → re-render chain
  // (after onUpdate mutates, forceFill triggers render → render reads
  // progress → recomputes filled / sliderX).
  useEffect(() => {
    const target = fillProgressRef.current;
    fillTl.resetItems();
    fillTl.add(target, {
      progress: filledTarget(currentIndex),
      duration: ENTRY_MS,
      ease: "outExpo",
      onUpdate: () => {
        forceFill((x) => x + 1);
      },
    });
    fillTl.play();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── switch: currentIndex change → tween fill progress to new filledTarget ──
  // 180ms outQuad. During the tween `target.progress` interpolates
  // continuously and the bright `▓` count is recomputed per frame with
  // Math.round(progress) → the bright region extends/retracts
  // **continuously** (no discrete 5/10/14/19/24 jumps). Slider translateX in sync.
  useEffect(() => {
    if (prevIndexRef.current === currentIndex) return;
    prevIndexRef.current = currentIndex;
    const target = fillProgressRef.current;
    fillTl.resetItems();
    fillTl.add(target, {
      progress: filledTarget(currentIndex),
      duration: SLIDE_MS,
      ease: "outQuad",
      onUpdate: () => {
        forceFill((x) => x + 1);
      },
    });
    fillTl.play();
  }, [currentIndex, fillTl]);

  // ── auto coupling: autoOn change → fillColorMix / dotColorMix /
  // sliderOpacity tween together, 200ms outExpo. Auto on: bright region
  // turns gray (pal.running → pal.dim) + slider opacity → 0; auto off:
  // restore from current position (mix reset + slider fades in). All three
  // values live in one tween item, not separate timelines, so their
  // pacing can never drift apart.
  useEffect(() => {
    if (prevAutoRef.current === autoOn) return;
    prevAutoRef.current = autoOn;
    const target = autoMixRef.current;
    autoTl.resetItems();
    autoTl.add(target, {
      fillColorMix: autoOn ? 1 : 0,
      dotColorMix: autoOn ? 1 : 0,
      sliderOpacity: autoOn ? 0 : 1,
      duration: AUTO_MS,
      ease: "outExpo",
      onUpdate: () => {
        forceAuto((x) => x + 1);
      },
    });
    autoTl.play();
  }, [autoOn, autoTl]);

  // ── derived values (refs rewritten in place by timelines; latest after forced setState) ──
  const progress = fillProgressRef.current.progress;
  const filled = Math.max(0, Math.min(totalChars, Math.round(progress)));
  const unfilled = totalChars - filled;
  // Slider translateX = fill tail position (= filled char count). Clamped
  // to cols - 6 so the 4-char slider can't overflow the panel on very
  // narrow terminals.
  const sliderX = Math.max(0, Math.min(filled, cols - 6));
  const fillColor = mixHex(
    pal.running,
    pal.dim,
    autoMixRef.current.fillColorMix
  );
  const dotColor = mixHex(pal.dim, pal.running, autoMixRef.current.dotColorMix);
  const sliderOpacity = autoMixRef.current.sliderOpacity;
  const autoGlyph = autoOn ? "◐" : "◑";
  const autoDesc = autoOn
    ? "adaptive (server picks effort)"
    : "concrete effort";

  // ── slider translateX follows progress (pushed to box.renderable after every re-render) ──
  // useEffect with no deps syncs once per render; the forceFill re-renders
  // from onUpdate also pass through here, keeping slider = fill tail.
  useEffect(() => {
    if (sliderRef.current) {
      sliderRef.current.translateX = sliderX;
    }
  });

  return (
    <box
      flexDirection="column"
      borderStyle="rounded"
      borderColor={flowBorderColor(borderPhase)}
      paddingX={1}
      paddingY={0}
      width={Math.max(1, cols)}
    >
      {/* title ◆─ Thinking (gold decorative prefix, plain content) */}
      <text>
        <span fg={pal.running}>{"◆─ "}</span>
        <span fg={pal.text} attributes={TextAttributes.BOLD}>
          Thinking
        </span>
      </text>

      {/* Auto row: ◐/◑ + AUTO + description (dot color tweens dim ↔ running) */}
      <text>
        <span fg={dotColor}>{`${autoGlyph}  `}</span>
        <span fg={pal.dim}>AUTO</span>
        <span fg={pal.dim}>{`  ·  ${autoDesc}`}</span>
      </text>

      {/* progress bar: bright ▓ + dark ░ halves, strong contrast; bright count = filled (computed) */}
      <text wrapMode="none">
        <span fg={fillColor}>{"▓".repeat(filled)}</span>
        <span fg={pal.dim}>{"░".repeat(unfilled)}</span>
      </text>

      {/* slider ◂──▸ bracketing the fill tail: absolutely positioned box,
          translateX follows fillProgress (i.e. the fill tail). opacity→0
          fades out when auto on; opacity→1 fades back in when auto off. */}
      <box width="100%" flexDirection="row">
        <box
          ref={sliderRef}
          position="absolute"
          left={0}
          opacity={sliderOpacity}
        >
          <text
            fg={pal.running}
            attributes={TextAttributes.BOLD}
            wrapMode="none"
          >
            ◂──▸
          </text>
        </box>
      </box>

      {/* key hints ([← →] omitted when auto on) */}
      <text fg={pal.dim}>
        {autoOn
          ? "[Tab/Space] 切 Auto · [Enter] 确认 · [Esc] 取消"
          : "[← →] 切档 · [Tab/Space] 切 Auto · [Enter] 确认 · [Esc] 取消"}
      </text>
    </box>
  );
}

// ── export ────────────────────────────────────────────────────────────
export const design7: ThinkingDesign = {
  meta: {
    id: "design-7-fill-slot",
    name: "填充滑杆",
    tag: "Fill Slot",
    summary: "▓/░ 亮暗两段 + ◂──▸ 框选滑块 + 亮区连续伸缩 + 圆角流光边框",
  },
  render: (props: ThinkingDesignProps): ReactElement =>
    (<FillSlotRender {...props} />) as unknown as ReactElement,
};
