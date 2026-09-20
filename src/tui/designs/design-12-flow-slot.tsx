/** @jsxImportSource @opentui/react */
/**
 * Thinking panel · Design 12: Dual Flow Slot (glass gradient base tone).
 *
 * Visual layout (top Auto + border + two vertically stacked layers):
 *   [rounded border] (borderColor breathes across 4 tokens, on its own
 *   cadence from the flow band)
 *     ◐  Auto
 *     ═══·════·═══════·════    <- top flow band (fg token cycle, 8s linear)
 *     ●                        <- slider (between layers, x = currentIndex's slot coordinate)
 *     low medium high xhigh max   <- bottom level names
 *
 * Design points:
 *  - Top flow band: fixed string "═══·════·═══════·════" (═ U+2550 + ·).
 *    Each `═` group's fg cycles through `pal.running → pal.logoGold →
 *    pal.logoInk → pal.accent` (8s linear loop, 4-segment phases) —
 *    visually equivalent to "a light dot flowing inside a tube".
 *  - Bottom level names: `low medium high xhigh max` (5 segments, 1 space
 *    apart) — the geometric baseline (slot) for the slider's x coordinate.
 *  - Top Auto dot: ◐ (on, glass half-fill) / ◑ (off). On leans
 *    `pal.running`, off leans `pal.dim`, switching in 150ms outQuad.
 *  - Slider ●: drawn between the two layers at the midpoint x of
 *    currentIndex on the slot; driven by `sliderX` state (written per
 *    frame via timeline onUpdate); switches slide 200ms outQuad.
 *  - Rounded border: `borderStyle="rounded"`, `borderColor` cycles the
 *    same 4 tokens on an independent phase (6s linear, deliberately
 *    out-of-sync with the 8s flow band — two independent breathings).
 *  - Entry: the flow band "grows" from width 0 to full in 400ms outExpo
 *    (simulated by character slicing); then the slider (staggered 420ms)
 *    slides from x=0 to the initial level's x in 200ms outQuad.
 *  - Switch: slider slides to the new position 200ms outQuad; the flow
 *    band's fg phase offsets with the slider position (`currentIndex *
 *    0.8` as a derived indexOffset added to the cycle phase — visually
 *    "the light dot flows to the slider").
 *  - Auto coupling: on auto the slider fades out (opacity 1 → 0, 150ms
 *    outQuad) and the flow phase offset zeroes (indexOffset → 0, leaving
 *    only the base cycle); off auto restores in reverse.
 *
 * Color discipline: every color comes 100% from `tuiPalette` (theme.ts),
 * no new color constants; the OpenTUI renderer degrades hex strings by
 * terminal capability, the app layer never writes ANSI.
 *
 * `useTimeline` caveat (same as design-5): the hook news a Timeline every
 * render but only the first-render instance reaches the engine; later
 * instances are never advanced by `engine.update` and animations fail
 * silently. All timelines are locked to their first-render instance via
 * `useRef`, so every `.add()` lands on a stable ref. Two persistent
 * timelines (flow-band fg cycle / border borderColor cycle) use `loop:
 * true` + item `onComplete` zeroing to dodge the resetItems
 * initial-value re-capture trap.
 */
import { useEffect, useRef, useState } from "react";
import type { ReactElement, ReactNode } from "react";
import { TextAttributes, type Timeline } from "@opentui/core";
import { useTimeline } from "@opentui/react";
import { tuiPalette } from "../theme.js";
import {
  EFFORT_LEVELS,
  type ThinkingDesign,
  type ThinkingDesignProps,
} from "./_contract.js";

// ── constants ─────────────────────────────────────────────────────────

/** Top flow band string: built from ═ U+2550 + ·, with `·` as "light dot" spacing between segments. */
const FLOW_GLYPH = "═══·════·═══════·════";

/** Flow band fg token 4-phase sequence (looping; shares the palette with the border tokens but phases are independent). */
const FLOW_TOKENS: ReadonlyArray<string> = [
  tuiPalette.running, // 1
  tuiPalette.logoGold, // 2
  tuiPalette.logoInk, // 3
  tuiPalette.accent, // 4
];

/** Flow band full cycle: 8s linear loop, 2s per token. */
const FLOW_CYCLE_MS = 8000;

/** Border breathing full cycle: deliberately out-of-phase with the flow band — 6s linear loop, 1.5s per token. */
const BORDER_CYCLE_MS = 6000;

/** Entry "growth" duration + easing (outExpo). */
const ENTRY_DURATION_MS = 400;

/** Slider entry stagger delay (fires after the flow band finishes growing). */
const SLIDER_ENTRY_DELAY_MS = 420;

/** Slider switch / entry slide duration + easing (outQuad). */
const SLIDER_DURATION_MS = 200;

/** Auto coupling (slider fade-out + dot color switch) duration + easing. */
const AUTO_DURATION_MS = 150;

// ── color utils ───────────────────────────────────────────────────────

/** `#rrggbb` → [r,g,b]∈[0,1]³. */
function hexToRgb(hex: string): readonly [number, number, number] {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex);
  if (!m) return [1, 1, 1];
  const v = parseInt(m[1] as string, 16);
  return [
    ((v >> 16) & 0xff) / 255,
    ((v >> 8) & 0xff) / 255,
    (v & 0xff) / 255,
  ] as const;
}

/** Linear mix of two colors over t∈[0,1] → `#rrggbb` string. */
function mixHex(a: string, b: string, t: number): string {
  const [ar, ag, ab] = hexToRgb(a);
  const [br, bg, bb] = hexToRgb(b);
  const k = Math.max(0, Math.min(1, t));
  const r = Math.round((ar + (br - ar) * k) * 255);
  const g = Math.round((ag + (bg - ag) * k) * 255);
  const bl = Math.round((ab + (bb - ab) * k) * 255);
  return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${bl.toString(16).padStart(2, "0")}`;
}

/** Look up phase (real number, 0..FLOW_TOKENS.length) in the token table and RGB-interpolate toward the next → fg hex. */
function tokenColorAt(phase: number, tokens: ReadonlyArray<string>): string {
  const n = tokens.length;
  const idx = Math.floor(phase);
  const f = Math.max(0, Math.min(1, phase - idx));
  const a = tokens[((idx % n) + n) % n] ?? tokens[0]!;
  const b = tokens[(((idx + 1) % n) + n) % n] ?? tokens[0]!;
  return mixHex(a, b, f);
}

// ── geometry ──────────────────────────────────────────────────────────

/** x coordinate of level index's midpoint (char offset in the "segment length + 1 space" baseline). */
function levelCenterX(index: number): number {
  let x = 0;
  for (let k = 0; k < index && k < EFFORT_LEVELS.length; k++) {
    x += EFFORT_LEVELS[k]!.length + 1; // segment length + 1 space
  }
  const segLen = EFFORT_LEVELS[index]!.length;
  return x + (segLen - 1) / 2; // midpoint = segment start + (len - 1) / 2
}

// ── render component ─────────────────────────────────────────────────

function FlowSlotPanel(props: ThinkingDesignProps): ReactNode {
  const pal = tuiPalette;
  const { model, cols } = props;
  const { autoOn, currentIndex } = model;

  // ── Timeline refs (locked to first-render instances) ───────────────
  // Flow band fg cycle: 8s linear loop.
  const initialFlowTl = useTimeline({ duration: FLOW_CYCLE_MS, loop: true });
  // Border breathing: 6s linear loop (out of sync with the flow band — two independent breathings).
  const initialBorderTl = useTimeline({
    duration: BORDER_CYCLE_MS,
    loop: true,
  });
  // Entry (flow band "growth").
  const initialEntryTl = useTimeline({
    duration: SLIDER_ENTRY_DELAY_MS + SLIDER_DURATION_MS + 40,
  });
  // Slider switch slide.
  const initialSliderTl = useTimeline({ duration: SLIDER_DURATION_MS + 20 });
  // Auto coupling (slider fade-out + dot color switch).
  const initialAutoTl = useTimeline({ duration: AUTO_DURATION_MS + 20 });

  const flowTlRef = useRef<Timeline | null>(null);
  const borderTlRef = useRef<Timeline | null>(null);
  const entryTlRef = useRef<Timeline | null>(null);
  const sliderTlRef = useRef<Timeline | null>(null);
  const autoTlRef = useRef<Timeline | null>(null);
  if (flowTlRef.current === null) flowTlRef.current = initialFlowTl;
  if (borderTlRef.current === null) borderTlRef.current = initialBorderTl;
  if (entryTlRef.current === null) entryTlRef.current = initialEntryTl;
  if (sliderTlRef.current === null) sliderTlRef.current = initialSliderTl;
  if (autoTlRef.current === null) autoTlRef.current = initialAutoTl;
  const flowTl = flowTlRef.current;
  const borderTl = borderTlRef.current;
  const entryTl = entryTlRef.current;
  const sliderTl = sliderTlRef.current;
  const autoTl = autoTlRef.current;

  // ── flow band base cycle phase (0..4, timeline-driven) ─────────────
  const [flowBasePhase, setFlowBasePhase] = useState(0);
  // ── border phase (independently drives the border color cycle) ─────
  const [borderPhase, setBorderPhase] = useState(0);
  // ── flow band entry width 0..1 (drives "growth") ───────────────────
  const [flowGrow, setFlowGrow] = useState(0);
  // ── slider x coordinate (currentIndex → levelCenterX, timeline-driven) ──
  const [sliderX, setSliderX] = useState(0);
  // ── slider opacity (Auto fade-out coupling; 1 = visible) ───────────
  const [sliderOpacity, setSliderOpacity] = useState(autoOn ? 0 : 1);
  // ── Auto dot mix (0 = dim, 1 = running; same timeline as slider fade) ──
  const [dotMix, setDotMix] = useState(autoOn ? 1 : 0);

  // Flow band fg base cycle: 8s linear loop, 2s per token.
  // The item must not use loop:true: as noted in design-5, timeline.loop
  // resetItems at cycle end and re-captures initial values, so
  // target.phase would stick at the end state. Instead, item onComplete
  // zeroes target.phase before the reset.
  useEffect(() => {
    const target = { phase: 0 };
    flowTl.add(target, {
      phase: FLOW_TOKENS.length,
      duration: FLOW_CYCLE_MS,
      ease: "linear",
      onComplete: () => {
        target.phase = 0;
      },
      onUpdate: () => {
        const next = target.phase;
        setFlowBasePhase((prev) => (prev === next ? prev : next));
      },
    });
  }, [flowTl]);

  // Border breathing: 6s linear loop (independent cadence, out of sync with the flow band).
  useEffect(() => {
    const target = { phase: 0 };
    borderTl.add(target, {
      phase: FLOW_TOKENS.length,
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

  // Entry: flow band "growth" (width 0..1, outExpo 400ms), then the slider
  // (staggered 420ms) slides from x=0 to the initial level's x. The entry
  // slider is scheduled via setTimeout and kept in a ref; a level switch
  // cancels it first to avoid conflicting with the switch slide.
  const initialIndexRef = useRef(currentIndex);
  const entryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const target = { w: 0 };
    entryTl.add(target, {
      w: 1,
      duration: ENTRY_DURATION_MS,
      ease: "outExpo",
      onUpdate: () => {
        const next = target.w;
        setFlowGrow((prev) => (prev === next ? prev : next));
      },
    });
    // Staggered slider slide-in (fires SLIDER_ENTRY_DELAY_MS after mount).
    const sliderStart = { x: 0 };
    const targetX = levelCenterX(initialIndexRef.current);
    entryTimerRef.current = setTimeout(() => {
      entryTimerRef.current = null;
      sliderTl.add(sliderStart, {
        x: targetX,
        duration: SLIDER_DURATION_MS,
        ease: "outQuad",
        onUpdate: () => {
          const next = sliderStart.x;
          setSliderX((prev) => (prev === next ? prev : next));
        },
      });
    }, SLIDER_ENTRY_DELAY_MS);
    return () => {
      if (entryTimerRef.current !== null) {
        clearTimeout(entryTimerRef.current);
        entryTimerRef.current = null;
      }
    };
    // Both timelines are ref-locked stable instances, so this is effect-equivalent to mount-only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entryTl, sliderTl]);

  // Switch: slider slides to the new position 200ms outQuad. The flow band
  // phase offset is not state here — `indexOffset = currentIndex * 0.8` is
  // derived (see render), so the fg phase shifts with currentIndex —
  // "the light dot flows to the slider".
  const prevIndexRef = useRef<number>(currentIndex);
  useEffect(() => {
    if (prevIndexRef.current === currentIndex) return;
    prevIndexRef.current = currentIndex;
    // Cancel a not-yet-fired entry slider to avoid racing this switch slide on the same timeline.
    if (entryTimerRef.current !== null) {
      clearTimeout(entryTimerRef.current);
      entryTimerRef.current = null;
    }
    const sliderStart = { x: sliderX };
    const targetX = levelCenterX(currentIndex);
    sliderTl.add(sliderStart, {
      x: targetX,
      duration: SLIDER_DURATION_MS,
      ease: "outQuad",
      onUpdate: () => {
        const next = sliderStart.x;
        setSliderX((prev) => (prev === next ? prev : next));
      },
    });
    // sliderX changes every frame and re-runs this effect; the early-return guard prevents duplicate adds.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentIndex, sliderTl, sliderX]);

  // Auto coupling: on auto the slider fades out and the flow phase offset
  // zeroes (indexOffset → 0, see derivation); off auto restores in
  // reverse. One timeline drives both slider opacity and Auto dot mix.
  const prevAutoRef = useRef<boolean>(autoOn);
  useEffect(() => {
    if (prevAutoRef.current === autoOn) return;
    const from = prevAutoRef.current ? 1 : 0; // previous state
    const to = autoOn ? 1 : 0; // new state
    prevAutoRef.current = autoOn;
    const autoTarget = { a: from };
    autoTl.add(autoTarget, {
      a: to,
      duration: AUTO_DURATION_MS,
      ease: "outQuad",
      onUpdate: () => {
        const v = autoTarget.a;
        setSliderOpacity(1 - v);
        setDotMix(v);
      },
    });
  }, [autoOn, autoTl]);

  // ── derived ───────────────────────────────────────────────────────
  // Flow band phase = base cycle + slider-position offset (0.8 phase per
  // level, 4 tokens across 5 levels). When autoOn, indexOffset zeroes →
  // "phase reset" leaves only the base cycle. tokenColorAt internally
  // modulo-wraps out-of-range phases, so the transition stays continuous.
  const indexOffset = autoOn ? 0 : currentIndex * 0.8;
  const flowFg = tokenColorAt(flowBasePhase + indexOffset, FLOW_TOKENS);
  const borderFg = tokenColorAt(borderPhase, FLOW_TOKENS);
  const autoDotGlyph = autoOn ? "◐" : "◑";
  const autoDotFg = mixHex(pal.dim, pal.running, dotMix);
  const autoDesc = autoOn ? "自适应档位" : "手动档位";

  // Flow band entry "growth": slice a prefix by grow ratio (FLOW_GLYPH's
  // full width = FLOW_GLYPH.length single-width chars, so char-wise slice
  // is safe).
  const visibleLen = Math.max(
    0,
    Math.min(FLOW_GLYPH.length, Math.round(FLOW_GLYPH.length * flowGrow))
  );
  const flowVisible = FLOW_GLYPH.slice(0, visibleLen);

  return (
    <box
      flexDirection="column"
      borderStyle="rounded"
      borderColor={borderFg}
      paddingX={1}
      paddingY={0}
      width={Math.max(1, cols)}
    >
      {/* top Auto row: ◐/◑ + AUTO + description */}
      <box flexDirection="row">
        <text>
          <span fg={autoDotFg} attributes={TextAttributes.BOLD}>
            {autoDotGlyph}
          </span>
          <span fg={pal.dim}>{`  AUTO  ·  ${autoDesc}`}</span>
        </text>
      </box>

      {/* top flow band (fg color cycle, width driven by entry grow) */}
      <text fg={flowFg} wrapMode="none">
        {flowVisible}
      </text>

      {/* slider ● (between the two layers, x = currentIndex's slot coordinate) */}
      <box width="100%" flexDirection="row">
        <text
          fg={pal.running}
          attributes={TextAttributes.BOLD}
          wrapMode="none"
          opacity={sliderOpacity}
        >
          {" ".repeat(Math.max(0, Math.round(sliderX))) + "●"}
        </text>
      </box>

      {/* bottom level names (geometric baseline for slider x; current level in gold) */}
      <text wrapMode="none">
        {EFFORT_LEVELS.map((level, i) => {
          const current = i === currentIndex && !autoOn;
          return (
            <span
              key={level}
              fg={current ? pal.running : pal.dim}
              attributes={current ? TextAttributes.BOLD : TextAttributes.NONE}
            >
              {level}
              {i < EFFORT_LEVELS.length - 1 ? " " : ""}
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

export const design12: ThinkingDesign = {
  meta: {
    id: "design-12-flow-slot",
    name: "双层流光槽",
    tag: "Dual Flow Slot",
    summary: "上层 ═·═ 流光带 + 下层档位名 + 滑块贯穿 + 双层独立流光呼吸",
  },
  render: ({ model, cols }: ThinkingDesignProps): ReactElement =>
    (<FlowSlotPanel model={model} cols={cols} />) as ReactElement,
};
