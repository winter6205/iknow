/** @jsxImportSource @opentui/react */
/**
 * Thinking panel design 6: continuous rising track + slider (glass gradient
 * base tone).
 *
 * Design highlights
 *  - One continuous progress bar: a symmetric trapezoid of 8 rising cells
 *    (▁→█) → 4 flat `█` cells → 8 falling cells (█→▁), "grown" from zero
 *    width by numeric interpolation (`trackGrowth: 0→1`, showing the
 *    first `round(w * N)` cells).
 *  - Entry (400ms outExpo): track grows → on completion the slider fades
 *    in at x=0 + slides to the initial level in 200ms outQuad, then a
 *    140ms outBack micro-bounce to "click into place".
 *  - Switch animation: slider translateX glides 200ms outQuad, followed by
 *    a light outBack settle. translateX is written directly by the
 *    timeline via the Renderable `set translateX(value)` (captureInitial
 *    Values→applyAnimationAtProgress assigns `target[key] = newValue` per
 *    frame and hits the setter; no React state needed).
 *  - The track cell under the slider is brightest: per-cell brightness
 *      `b = exp(-((cell - sliderX)/sigma)^2)`, σ = N/4; color
 *    `mixHex(pal.dim, pal.running, b)` — the brightness band travels with
 *    the slider on level switch.
 *  - Auto dot ◐/◑ (on/off), dot mix switches dim ↔ running in 200ms
 *    outExpo.
 *  - Border flow (8s linear loop): four phases pal.logoInk → pal.running →
 *    pal.logoGold → pal.running, adjacent phases RGB-interpolated to
 *    approximate "light flowing across the border". Timeline duration is
 *    INFINITE_MS (1h) to dodge the timeline.loop resetItems re-capture
 *    freeze (see designs 3/5).
 *  - Auto coupling: enabling auto fades the slider out (Renderable.opacity
 *    → 0, 150ms outQuad) and the whole bar turns pal.dim; disabling auto
 *    fades it back to opacity=1 and slides from its current position to
 *    currentIndex (200ms outQuad + outBack).
 *  - Color discipline: only pal.dim/pal.running/pal.logoInk/pal.logoGold/
 *    pal.text; no new color constants.
 */
import { useEffect, useRef, useState } from "react";
import type { ReactElement, ReactNode } from "react";
import { TextAttributes } from "@opentui/core";
import type { TextRenderable, Timeline } from "@opentui/core";
import { useTimeline } from "@opentui/react";
import { tuiPalette } from "../theme.js";
import {
  EFFORT_LEVELS,
  type ThinkingDesign,
  type ThinkingDesignProps,
} from "./_contract.js";

// ── track shape ───────────────────────────────────────────────────────
/** Ascending unicode blocks (▁→█, heights 1..8). */
const RAMP = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"] as const;
/** Descending unicode blocks (█→▁, heights 8..1). */
const FALL = ["█", "▇", "▆", "▅", "▄", "▃", "▂", "▁"] as const;
/** Trapezoid plateau `█` × N. */
const PLATEAU = ["█", "█", "█", "█"] as const;
/** Full track: `▁▂▃▄▅▆▇█` → `████` → `█▇▆▅▄▃▂▁`, 20 cells total. */
const TRACK: ReadonlyArray<string> = [...RAMP, ...PLATEAU, ...FALL];
const CELL_COUNT = TRACK.length;

// ── durations / easing ────────────────────────────────────────────────
/** Entry track growth (outExpo; no inOutExpo in OpenTUI → outExpo). */
const ENTRY_GROW_MS = 400;
/** Main switch slide (outQuad). */
const SLIDE_MAIN_MS = 200;
/** Settle bounce after switch (outBack). */
const SLIDE_BOUNCE_MS = 140;
/** Bounce pre-push distance to the left (cells). */
const SLIDE_BOUNCE_PUSH = 1.5;
/** Border flow full cycle (8s linear loop). */
const BORDER_CYCLE_MS = 8000;
/** Auto dot color switch. */
const DOT_TWEEN_MS = 200;
/** Slider fade in/out on auto toggle. */
const SLIDER_FADE_MS = 150;
/** Initial fade + slide-in bridge. */
const INTRO_FADE_MS = 120;
/** Large timeline duration to dodge the loop-reset trap. */
const INFINITE_MS = 3_600_000;

// ── border flow 4 phases ──────────────────────────────────────────────
const FLOW_STOPS: ReadonlyArray<string> = [
  tuiPalette.logoInk,
  tuiPalette.running,
  tuiPalette.logoGold,
  tuiPalette.running,
];

// ── color utils (hexToRgb / rgbToHex / mixHex) ────────────────────────
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
/** Look up by phase (real number 0..FLOW_STOPS.length) and mix toward the next stop → borderColor. */
function flowBorderColor(phase: number): string {
  const phases = FLOW_STOPS.length;
  const idx = Math.floor(phase);
  const f = Math.max(0, Math.min(1, phase - idx));
  const a = FLOW_STOPS[((idx % phases) + phases) % phases] ?? FLOW_STOPS[0]!;
  const b =
    FLOW_STOPS[(((idx + 1) % phases) + phases) % phases] ?? FLOW_STOPS[0]!;
  return mixHex(a, b, f);
}

/** 5 levels → track cell position (0..CELL_COUNT-1, fractional allowed). */
function levelCellPos(levelIndex: number): number {
  const last = EFFORT_LEVELS.length - 1;
  if (last <= 0) return 0;
  return (levelIndex / last) * (CELL_COUNT - 1);
}

/** Gaussian-decay brightness (cell under the slider is brightest). σ=N/4. */
function cellBrightness(cellIdx: number, sliderX: number): number {
  const sigma = CELL_COUNT / 4;
  const d = cellIdx - sliderX;
  return Math.exp(-((d / sigma) * (d / sigma)));
}

// ── component ─────────────────────────────────────────────────────────
function TrackBarRender(props: ThinkingDesignProps): ReactNode {
  const pal = tuiPalette;
  const { model } = props;
  const autoOn = model.autoOn;
  const currentIndex = model.currentIndex;

  // useTimeline news a Timeline per render but the mount effect registers
  // only the first instance. Lock and reuse the first so later .add()
  // calls never hit an unregistered Timeline (see design 5).
  const initialTimeline = useTimeline({
    duration: INFINITE_MS,
  });
  const timelineRef = useRef<Timeline | null>(null);
  if (timelineRef.current === null) timelineRef.current = initialTimeline;
  const tl = timelineRef.current;

  // ── derived refs (rewritten in place by the timeline; latest after forced render) ──
  const trackGrowthRef = useRef<{ w: number }>({ w: 0 });
  const sliderXRef = useRef<{ x: number }>({
    x: levelCellPos(currentIndex),
  });
  const dotMixRef = useRef<{ mix: number }>({ mix: autoOn ? 1 : 0 });
  const slideTokenRef = useRef<number>(0);
  const modelRef = useRef(model);
  modelRef.current = model;

  const [borderPhase, setBorderPhase] = useState(0);
  // force keeps ref-driven derivations (border / dot mix / sliderX) in sync with renders.
  const [, force] = useState(0);

  const sliderRenderableRef = useRef<TextRenderable | null>(null);

  // ── cancel pending animations on given props (avoid overlap / conflict) ──
  const cancelSliderAnim = (props: ReadonlyArray<string>): void => {
    const slider = sliderRenderableRef.current;
    if (!slider) return;
    tl.items = tl.items.filter(
      (item) =>
        !(
          item.type === "animation" &&
          item.target.includes(slider) &&
          props.some((p) => p in (item.properties ?? {}))
        )
    );
  };

  // ── slide to target level: outQuad 200ms → outBack 140ms micro-bounce ──
  const slideTo = (pos: number): void => {
    const slider = sliderRenderableRef.current;
    if (!slider) return;
    cancelSliderAnim(["translateX"]);
    const token = ++slideTokenRef.current;
    const bumpX = (): void => {
      const x = slider.translateX;
      sliderXRef.current.x = x;
      force((n) => n + 1);
    };
    tl.once(slider, {
      translateX: pos,
      duration: SLIDE_MAIN_MS,
      ease: "outQuad",
      onUpdate: bumpX,
      onComplete: () => {
        if (token !== slideTokenRef.current) return;
        const startX = Math.max(0, pos - SLIDE_BOUNCE_PUSH);
        if (startX === pos) return; // pos=0: no room to bounce
        slider.translateX = startX;
        tl.once(slider, {
          translateX: pos,
          duration: SLIDE_BOUNCE_MS,
          ease: "outBack",
          onUpdate: bumpX,
        });
      },
    });
  };

  // ── mount: border flow (item loop ∞) + track growth + initial slider state ──
  useEffect(() => {
    const initialAutoOn = modelRef.current.autoOn;
    const initialIndex = modelRef.current.currentIndex;

    // Border phase 0 → FLOW_STOPS.length, infinite loop, linear. The 1h
    // timeline duration never triggers timeline.loop reset; item-level
    // loop:true lets the phase itself cycle.
    const phaseTarget = { phase: 0 };
    tl.add(phaseTarget, {
      phase: FLOW_STOPS.length,
      duration: BORDER_CYCLE_MS,
      ease: "linear",
      loop: true,
      onUpdate: () => {
        const next = phaseTarget.phase;
        setBorderPhase((prev) => (prev === next ? prev : next));
      },
    });

    // Initial sliderX and growth.
    sliderXRef.current.x = levelCellPos(initialIndex);

    // Hide the slider at mount if autoOn.
    const slider = sliderRenderableRef.current;
    if (slider && initialAutoOn) {
      slider.opacity = 0;
    }

    // Track growth 0 → 1 (outExpo).
    const growTarget = trackGrowthRef.current;
    growTarget.w = 0;
    tl.once(growTarget, {
      w: 1,
      duration: ENTRY_GROW_MS,
      ease: "outExpo",
      onUpdate: () => force((n) => n + 1),
      onComplete: () => {
        // After entry: manual → fade in + slide to current level; auto → slider stays hidden.
        if (modelRef.current.autoOn) return;
        const s = sliderRenderableRef.current;
        if (!s) return;
        s.opacity = 0;
        // Fade-in + slide-in in parallel: opacity 0→1 while translateX 0→initialPos.
        cancelSliderAnim(["translateX", "opacity"]);
        const token = ++slideTokenRef.current;
        tl.once(s, {
          opacity: 1,
          duration: INTRO_FADE_MS,
          ease: "outQuad",
        });
        tl.once(s, {
          translateX: levelCellPos(modelRef.current.currentIndex),
          duration: SLIDE_MAIN_MS,
          ease: "outQuad",
          onUpdate: () => {
            sliderXRef.current.x = s.translateX;
            force((n) => n + 1);
          },
          onComplete: () => {
            if (token !== slideTokenRef.current) return;
            const pos = levelCellPos(modelRef.current.currentIndex);
            const startX = Math.max(0, pos - SLIDE_BOUNCE_PUSH);
            if (startX === pos) return;
            s.translateX = startX;
            tl.once(s, {
              translateX: pos,
              duration: SLIDE_BOUNCE_MS,
              ease: "outBack",
              onUpdate: () => {
                sliderXRef.current.x = s.translateX;
                force((n) => n + 1);
              },
            });
          },
        });
      },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tl]);

  // ── dot ◐/◑ color switch: autoOn change → dim ↔ running ──
  useEffect(() => {
    const target = dotMixRef.current;
    const currentMix = target.mix;
    const targetMix = autoOn ? 1 : 0;
    if (currentMix === targetMix) return;
    tl.once(target, {
      mix: targetMix,
      duration: DOT_TWEEN_MS,
      ease: "outExpo",
      onUpdate: () => force((n) => n + 1),
    });
  }, [autoOn, tl]);

  // ── autoOn toggle: slider fade in/out ──
  useEffect(() => {
    const slider = sliderRenderableRef.current;
    if (!slider) return;
    cancelSliderAnim(["opacity"]);
    if (autoOn) {
      tl.once(slider, {
        opacity: 0,
        duration: SLIDER_FADE_MS,
        ease: "outQuad",
      });
    } else {
      // Manual: pull slider opacity back to 1 (if still 0) and slide to the current level.
      tl.once(slider, {
        opacity: 1,
        duration: INTRO_FADE_MS,
        ease: "outQuad",
      });
      slideTo(levelCellPos(modelRef.current.currentIndex));
    }
  }, [autoOn, tl]);

  // ── level switch: currentIndex change → slideTo ──
  useEffect(() => {
    if (modelRef.current.autoOn) return;
    slideTo(levelCellPos(currentIndex));
  }, [currentIndex, tl]);

  // ── derived (render reads refs) ──
  const grow = Math.max(0, Math.min(1, trackGrowthRef.current.w));
  const visibleCells = Math.max(
    0,
    Math.min(CELL_COUNT, Math.round(grow * CELL_COUNT))
  );
  const sliderX = sliderXRef.current.x;
  const dotGlyph = autoOn ? "◐" : "◑";
  const dotColor = mixHex(pal.dim, pal.running, dotMixRef.current.mix);
  const sliderColor = pal.running;
  const autoDesc = autoOn ? "自适应档位" : "手动档位";

  // ── render ──
  return (
    <box
      flexDirection="column"
      borderStyle="rounded"
      borderColor={flowBorderColor(borderPhase)}
      paddingX={1}
      paddingY={0}
      gap={1}
    >
      {/* title */}
      <text>
        <span fg={pal.running}>{"◆─ "}</span>
        <span fg={pal.text} attributes={TextAttributes.BOLD}>
          Thinking
        </span>
      </text>

      {/* Auto row */}
      <text>
        <span fg={dotColor}>{`${dotGlyph}  `}</span>
        <span fg={pal.dim}>AUTO</span>
        <span fg={pal.dim}>{`  ·  ${autoDesc}`}</span>
      </text>

      {/* slider row: own line; its translateX is written into the Renderable by the timeline */}
      <box height={1}>
        <text
          ref={sliderRenderableRef}
          fg={sliderColor}
          attributes={TextAttributes.BOLD}
        >
          ●
        </text>
      </box>

      {/* track: full ascending block ramp (visible cell count = cells grown so far) */}
      <text wrapMode="none">
        {TRACK.slice(0, visibleCells).map((cell, idx) => {
          const color = autoOn
            ? pal.dim
            : mixHex(pal.dim, pal.running, cellBrightness(idx, sliderX));
          return (
            <span key={`cell-${idx}`} fg={color}>
              {cell}
            </span>
          );
        })}
      </text>

      {/* level names */}
      <text>
        {EFFORT_LEVELS.map((level, i) => {
          const isCurrent = i === currentIndex;
          return (
            <span
              key={level}
              fg={isCurrent ? pal.running : pal.dim}
              attributes={isCurrent ? TextAttributes.BOLD : TextAttributes.NONE}
            >
              {`${level}${i < EFFORT_LEVELS.length - 1 ? "  " : ""}`}
            </span>
          );
        })}
      </text>

      {/* key hints */}
      <text fg={pal.dim}>
        {"[← →] 切档  ·  [Tab/Space] 切 Auto  ·  [Enter] 确认  ·  [Esc] 取消"}
      </text>
    </box>
  );
}

export const design6: ThinkingDesign = {
  meta: {
    id: "design-6-track-bar",
    name: "连续渐高条",
    tag: "Continuous Track",
    summary: "整条渐高 block + 滑块滑动 + 流光联动 + 圆角流光边框",
  },
  render: (props: ThinkingDesignProps): ReactElement =>
    TrackBarRender(props) as unknown as ReactElement,
};
