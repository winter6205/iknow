/** @jsxImportSource @opentui/react */
/**
 * Thinking panel design 05: glassmorphism / gradient flow (demo gallery
 * candidate).
 *
 * Design highlights
 *  - Rounded-border flow light: the whole borderColor cycles
 *    `pal.logoInk → pal.running → pal.logoGold → pal.running` (useTimeline
 *    8s ease:"linear" loop, ~2s per stop, RGB linear interpolation between
 *    adjacent stops) to approximate "a light band flowing across the
 *    border" — OpenTUI's single border-color token can't do per-side
 *    gradients, so a whole-border periodic cycle is chosen; splicing 4
 *    edges would bring rounded-corner glyph overlap and yoga layout
 *    side-effects.
 *  - Entry: marginTop -2 → 0 + opacity 0 → 1, 400ms outExpo (OpenTUI's
 *    easing table has no `inOutExpo`; outExpo degrades gracefully — no
 *    bounce at the exponential tail, matching the intended smooth
 *    exponential curve).
 *  - Auto dot ◐/◑ half-filled glass look: on Auto toggle the glyph color
 *    fades `pal.dim` → `pal.running`, 200ms outExpo.
 *  - 5-level density ramp: one ascending density combo per level
 *    `[▒, ▒▓, ▓, ▓█, █]`; current level's indicator char is BOLD +
 *    `pal.running`; on switch its color eases `pal.dim` → `pal.running`
 *    over 180ms outQuad.
 *  - A separate dim row anchors the full ladder `▒▒▓▓▓█████` as a 5-level
 *    density reference.
 *  - Key hints in dim.
 *
 * Color discipline: high saturation only uses
 * `pal.running / pal.logoGold / pal.logoInk`; body `pal.text`, secondary
 * `pal.dim`; no other theme colors introduced.
 */
import { useEffect, useRef, useState } from "react";
import type { ReactElement } from "react";
import { TextAttributes } from "@opentui/core";
import type { Timeline } from "@opentui/core";
import { useTimeline } from "@opentui/react";
import { tuiPalette } from "../theme.js";
import {
  EFFORT_LEVELS,
  type ThinkingDesign,
  type ThinkingDesignProps,
} from "./_contract.js";

/** 5-level density combo sequence (1~2 chars per level, ascending density). */
const DENSITY_COMBOS: ReadonlyArray<string> = [
  "▒", // low    : ▒
  "▒▓", // medium : ▒▓
  "▓", // high   : ▓
  "▓█", // xhigh  : ▓█
  "█", // max    : █
];

/** Full density ladder anchor line. */
const LADDER_PREVIEW = "▒▒▓▓▓█████";

/** Border flow 4-phase tokens (cycled by period, adjacent phases RGB-interpolated). */
const FLOW_STOPS: ReadonlyArray<string> = [
  tuiPalette.logoInk,
  tuiPalette.running,
  tuiPalette.logoGold,
  tuiPalette.running,
];

/** Full border cycle period: a hard requirement, so 8s wins over the
 *  10000ms value mentioned elsewhere. */
const BORDER_CYCLE_MS = 8000;

/** Entry duration + easing (no inOutExpo in OpenTUI → outExpo). */
const ENTRY_DURATION_MS = 400;

/** Auto dot color-switch duration + easing. */
const AUTO_DOT_DURATION_MS = 200;

/** Current-level char color-switch duration + easing. */
const LEVEL_DURATION_MS = 180;

/** RGB triple. */
interface Rgb {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

/** #rrggbb → Rgb; null on invalid input (caller falls back to `from`). */
function hexToRgb(hex: string): Rgb | null {
  if (hex.length !== 7 || hex[0] !== "#") return null;
  const r = Number.parseInt(hex.slice(1, 3), 16);
  const g = Number.parseInt(hex.slice(3, 5), 16);
  const b = Number.parseInt(hex.slice(5, 7), 16);
  if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) return null;
  return { r, g, b };
}

/** Rgb → #rrggbb (each channel clamped and zero-padded). */
function rgbToHex({ r, g, b }: Rgb): string {
  const c = (n: number): string =>
    Math.max(0, Math.min(255, Math.round(n)))
      .toString(16)
      .padStart(2, "0");
  return `#${c(r)}${c(g)}${c(b)}`;
}

/** Linear interpolation between two hex colors over t (0..1) in RGB space; t clamped. */
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

function GradientDesignRender(props: ThinkingDesignProps) {
  const pal = tuiPalette;
  const { model } = props;

  // useTimeline creates a new Timeline instance per render but only the
  // first gets registered and driven by the engine. Lock the first
  // instance so all animations act on it instead of unregistered empty
  // timelines; autoOn / currentIndex tweens reuse the same instance.
  const initialTimeline = useTimeline({
    duration: BORDER_CYCLE_MS,
    loop: true,
  });
  const timelineRef = useRef<Timeline | null>(null);
  if (timelineRef.current === null) timelineRef.current = initialTimeline;
  const tl = timelineRef.current;

  const [borderPhase, setBorderPhase] = useState(0);
  // force drives re-renders for refs mutated in place by the timeline
  // (entryRef / autoMixRef / levelMixRef) — `tick` is never read, it only
  // serves as a setState trigger.
  const [, force] = useState(0);

  // ── entry target: top-level box marginTop + opacity, rewritten by the timeline ──
  const entryRef = useRef<{ marginTop: number; opacity: number }>({
    marginTop: -2,
    opacity: 0,
  });
  // ── Auto dot mix: 0 = dim, 1 = running ──
  const autoMixRef = useRef<{ mix: number }>({
    mix: model.autoOn ? 1 : 0,
  });
  // ── current-level indicator mix: 0 = dim, 1 = running ──
  const levelMixRef = useRef<{ mix: number }>({ mix: 1 });

  // Border flow phase: 8s linear loop, per-frame onUpdate → setBorderPhase
  // (React bails out on equal values; RGB interpolation between adjacent
  // phases keeps it visually smooth with no jumps).
  //
  // The item must not use loop:true: Timeline.loop resetItems at cycle end
  // and re-captures initial values — by then target.phase is already 4, so
  // the next cycle would freeze at 4. Instead item onComplete zeroes
  // target.phase before the timeline resets (inside update(), evaluateItem
  // runs before loop-reset), so the next cycle re-interpolates from 0 — a
  // seamless loop.
  useEffect(() => {
    const target = { phase: 0 };
    tl.add(target, {
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
  }, [tl]);

  // Entry animation (onMount once): marginTop -2 → 0, opacity 0 → 1.
  useEffect(() => {
    const target = entryRef.current;
    tl.once(target, {
      marginTop: 0,
      opacity: 1,
      duration: ENTRY_DURATION_MS,
      ease: "outExpo",
      onUpdate: () => force((x) => x + 1),
    });
  }, [tl]);

  // Auto dot color switch: model.autoOn change → dim ↔ running 200ms outExpo.
  useEffect(() => {
    const target = autoMixRef.current;
    const currentMix = target.mix;
    const targetMix = model.autoOn ? 1 : 0;
    if (currentMix === targetMix) return;
    tl.once(target, {
      mix: targetMix,
      duration: AUTO_DOT_DURATION_MS,
      ease: "outExpo",
      onUpdate: () => force((x) => x + 1),
    });
  }, [model.autoOn, tl]);

  // Current-level char color switch: model.currentIndex change → dim → running 180ms outQuad.
  useEffect(() => {
    const target = levelMixRef.current;
    target.mix = 0;
    tl.once(target, {
      mix: 1,
      duration: LEVEL_DURATION_MS,
      ease: "outQuad",
      onUpdate: () => force((x) => x + 1),
    });
  }, [model.currentIndex, tl]);

  // ── derived values (refs are rewritten in place by the timeline; re-read after the forced setState) ──
  const entry = entryRef.current;
  const autoDotGlyph = model.autoOn ? "◐" : "◑"; // ◐ / ◑
  const autoDotColor = mixHex(pal.dim, pal.running, autoMixRef.current.mix);
  const currentLevelColor = mixHex(
    pal.dim,
    pal.running,
    levelMixRef.current.mix
  );
  const autoDesc = model.autoOn
    ? "自适应档位" // adaptive level
    : "手动档位"; // manual level

  return (
    <box
      flexDirection="column"
      borderStyle="rounded"
      borderColor={flowBorderColor(borderPhase)}
      paddingX={1}
      paddingY={0}
      marginTop={entry.marginTop}
      opacity={entry.opacity}
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
        <span fg={autoDotColor}>{`${autoDotGlyph}  `}</span>
        <span fg={pal.dim}>AUTO</span>
        <span fg={pal.dim}>{`  ·  ${autoDesc}`}</span>
      </text>

      {/* 5-level density combos + names: combo above, name below; current level BOLD. */}
      <box flexDirection="row" gap={2} alignItems="center">
        {EFFORT_LEVELS.map((level, i) => {
          const current = i === model.currentIndex;
          const combo = DENSITY_COMBOS[i] ?? "";
          return (
            <box key={level} flexDirection="column" alignItems="center">
              <text
                fg={current ? currentLevelColor : pal.dim}
                attributes={current ? TextAttributes.BOLD : TextAttributes.NONE}
              >
                {combo}
              </text>
              <text
                fg={current ? pal.running : pal.dim}
                attributes={current ? TextAttributes.BOLD : TextAttributes.NONE}
              >
                {level}
              </text>
            </box>
          );
        })}
      </box>

      {/* density ladder anchor line (whole row dim) */}
      <text fg={pal.dim}>{LADDER_PREVIEW}</text>

      {/* key hints */}
      <text fg={pal.dim}>
        {"[← →] 切档  ·  [Tab/Space] 切 Auto  ·  [Enter] 确认  ·  [Esc] 取消"}
      </text>
    </box>
  );
}

export const design5: ThinkingDesign = {
  meta: {
    id: "design-5-gradient",
    name: "玻璃渐变风", // glass gradient
    tag: "Glass Gradient",
    summary: "圆角 + 流光渐变边框 + outExpo 入场 + 切档颜色平滑过渡。", // rounded border + flow-gradient + outExpo entry + smooth switch colors
  },
  render: (props: ThinkingDesignProps): ReactElement =>
    GradientDesignRender(props) as unknown as ReactElement,
};
