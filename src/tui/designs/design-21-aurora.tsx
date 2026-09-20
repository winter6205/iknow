/** @jsxImportSource @opentui/react */
/**
 * Design 21 — Aurora Particles thinking panel (demo gallery candidate).
 *
 * Design language:
 * - Aurora = three tones: green (pal.add) + gray-green (pal.bgRunning) +
 *   pink-gold (pal.logoGold); body pal.text, aux pal.dim, no new colors.
 * - 8 "aurora particles" scatter over the 5-level track: 5 orbiters (one
 *   `·` per level, green flicker) + 3 gap drifters (`: ° •` cycling with
 *   phase, pink-gold flicker), organized into 3 phase-offset alternate
 *   loops (800 / 1100 / 1400ms) driven by 3 separate timelines.
 * - Current level = bright `●` (pal.running BOLD) that flies old→new via
 *   translateX (200ms outQuad) — the only displacement animation on change.
 * - Focus cursor is independent of the current level: focusIndex shows as
 *   pal.accent BOLD in the label row (autoOn sets focusIndex=-1 and focus
 *   returns to the Auto label).
 * - Auto dot hard states: on `●` (gold BOLD) / off `○` (gray dim).
 * - Entry: whole panel fades opacity 0 → 1, 220ms outQuad, no bounce.
 *
 * Animation wiring:
 * - The 3 particle timelines use `useTimeline({ duration: INFINITE_MS })`:
 *   the first-render instance is auto `play + engine.register`ed by the
 *   mount effect and auto `pause + unregister`ed on unmount; fresh
 *   instances from later renders go unregistered and get GC'd (verified in
 *   design-2 / design-3). Each item loops with `loop: true, alternate:
 *   true` for endless 0↔1 oscillation; differing `duration` + per-group
 *   `startTime` offsets create the three-phase staggering.
 * - The slider translateX uses the useRef-lazy-Timeline + engine.register
 *   pattern (verified in design-1 / design-4): resetItems + add + play on
 *   each currentIndex change. translateX never appears in a React prop
 *   (the reconciler would overwrite it with the stale value); only
 *   imperative init + timeline add drive it.
 * - The entry fade uses the same lazy-ref pattern.
 * - Particle phase changes quantize to 1/16 buckets and force setState
 *   only on bucket crossings (design-5 pattern), keeping re-renders around
 *   2-4/sec instead of every frame.
 *
 * Ambient budget: 1 ambient category (particle glow); slider flight and
 * entry fade are event-triggered one-shots.
 */
import { useEffect, useRef, useState } from "react";
import type { ReactElement, ReactNode } from "react";
import { BoxRenderable, TextAttributes, Timeline, engine } from "@opentui/core";
import { useTimeline } from "@opentui/react";
import { tuiPalette } from "../theme.js";
import { EFFORT_LEVELS } from "./_contract.js";
import type { ThinkingDesign, ThinkingDesignProps } from "./_contract.js";

// ── Constants ─────────────────────────────────────────────────────────
/** Three phase-offset particle glow periods (ms). */
const PARTICLE_PERIODS: readonly [number, number, number] = [800, 1100, 1400];

/** "Long enough" timeline duration (1h): dodges the timeline-loop resetItems
 *  initial-value re-capture trap; the item-level `loop: true, alternate:
 *  true` supplies the endless oscillation, so no timeline-level loop. */
const INFINITE_MS = 3_600_000;

/** Entry fade duration (outQuad, no bounce). */
const FADE_MS = 220;

/** Slider travel time (main particle flies old→new level on change). */
const SLIDE_MS = 200;

/** Aurora track total width, aligned with the label row
 *  `" low  medium  high  xhigh  max "` (1+3+2+6+2+4+2+5+2+3+1 = 31). */
const TRACK_LEN = 31;

/** Center column of each level on the track (derived from label-row text positions):
 *   " low  medium  high  xhigh  max "
 *     ^1   ^6       ^14    ^20      ^27
 *      ^2  ^9.5→8   ^15.5→16 ^22.5→22  ^28.5→28 */
const LEVEL_X: readonly number[] = [2, 8, 15, 22, 28];

/** Columns of the 3 gap drifters (near the midpoints between levels). */
const DRIFT_X: readonly number[] = [5, 12, 25];

// ── Color utils ───────────────────────────────────────────────────────
/** `#rrggbb` → [r, g, b]∈[0, 255]³; returns 0 for invalid hex (safe fallback). */
function parseHex(hex: string): readonly [number, number, number] {
  const v = parseInt(hex.slice(1), 16);
  return [(v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff] as const;
}
/** Linear mix of two hex colors at t∈[0, 1] → `#rrggbb`. */
function mixHex(a: string, b: string, t: number): string {
  const k = Math.max(0, Math.min(1, t));
  const [ar, ag, ab] = parseHex(a);
  const [br, bg, bb] = parseHex(b);
  const r = Math.round(ar + (br - ar) * k);
  const g = Math.round(ag + (bg - ag) * k);
  const bl = Math.round(ab + (bb - ab) * k);
  const hex = ((r << 16) | (g << 8) | bl).toString(16).padStart(6, "0");
  return `#${hex}`;
}

/** Pick a drifter glyph by quantized phase: low band → first glyph, mid
 *  band → second, high band → third. Orbiters have a 1-glyph set, returned as-is. */
function driftGlyph(glyphs: readonly string[], q: number): string {
  if (glyphs.length === 1) return glyphs[0] ?? "·";
  let idx = 0;
  if (q >= 0.75) idx = 2;
  else if (q >= 0.4) idx = 1;
  return glyphs[idx] ?? glyphs[0] ?? "·";
}

// ── Particle spec table (8 phase-offset aurora particles) ─────────────
interface ParticleSpec {
  /** Horizontal coordinate on the track. */
  readonly x: number;
  /** Glyph set: orbiters use a single `·`; drifters cycle three glyphs by phase to fake drift. */
  readonly glyphs: readonly string[];
  /** Phase-offset group index (0/1/2 → 800/1100/1400ms). */
  readonly periodIdx: number;
  /** Start-time offset inside the group (ms). */
  readonly startMs: number;
  /** orbiter = level-track particle (green flicker); drift = gap drifter (gold flicker). */
  readonly kind: "orbiter" | "drift";
}

/** 8 aurora particles: 5 orbiters + 3 drifters in 3 phase-offset alternate loops.
 *  Group A 800ms: orbiters 0/2 + drift 12 (3 total)
 *  Group B 1100ms: orbiters 1/3 + drift  5 (3 total)
 *  Group C 1400ms: orbiter 4 + drift 25   (2 total) */
const PARTICLE_SPECS: readonly ParticleSpec[] = [
  { x: LEVEL_X[0]!, glyphs: ["·"], periodIdx: 0, startMs: 0, kind: "orbiter" },
  { x: LEVEL_X[1]!, glyphs: ["·"], periodIdx: 1, startMs: 0, kind: "orbiter" },
  {
    x: LEVEL_X[2]!,
    glyphs: ["·"],
    periodIdx: 0,
    startMs: 400,
    kind: "orbiter",
  },
  {
    x: LEVEL_X[3]!,
    glyphs: ["·"],
    periodIdx: 1,
    startMs: 550,
    kind: "orbiter",
  },
  { x: LEVEL_X[4]!, glyphs: ["·"], periodIdx: 2, startMs: 0, kind: "orbiter" },
  {
    x: DRIFT_X[0]!,
    glyphs: [":", "•", "·"],
    periodIdx: 1,
    startMs: 275,
    kind: "drift",
  },
  {
    x: DRIFT_X[1]!,
    glyphs: ["°", ":", "•"],
    periodIdx: 0,
    startMs: 200,
    kind: "drift",
  },
  {
    x: DRIFT_X[2]!,
    glyphs: ["•", "°", ":"],
    periodIdx: 2,
    startMs: 350,
    kind: "drift",
  },
];

// ── Rendering component ───────────────────────────────────────────────
function AuroraPanel(props: ThinkingDesignProps): ReactNode {
  const pal = tuiPalette;
  const { model, cols } = props;
  const { autoOn, currentIndex, focusIndex } = model;

  // ── Refs: panel (fade opacity), slider (translateX), particle phases
  //    (timeline mutates directly + quantized buckets + force re-render). ──
  const panelRef = useRef<BoxRenderable | null>(null);
  const sliderRef = useRef<BoxRenderable | null>(null);
  const particleTargetsRef = useRef<ReadonlyArray<{ p: number; q: number }>>(
    PARTICLE_SPECS.map(() => ({ p: 0, q: 0 }))
  );
  const [, force] = useState(0);

  // ── 3 phase-offset particle timelines: useTimeline registers + plays the
  //    first-render instance; fresh instances from later renders stay
  //    unregistered and get GC'd. useRef pins the first instances, and the
  //    two lazily-created slide/fade Timelines are merged into the same
  //    stable ref (pattern verified in design-2 / design-4). ──
  const particleTlA = useTimeline({ duration: INFINITE_MS, autoplay: false });
  const particleTlB = useTimeline({ duration: INFINITE_MS, autoplay: false });
  const particleTlC = useTimeline({ duration: INFINITE_MS, autoplay: false });
  const tlRef = useRef({
    a: particleTlA,
    b: particleTlB,
    c: particleTlC,
    slide: new Timeline({ autoplay: false }),
    fade: new Timeline({ autoplay: false }),
  });
  const tl = tlRef.current;

  // ── mount/unmount: register the slide/fade lazy timelines; init slider
  //    position and entry fade; add the 8 particle items by phase group and start. ──
  useEffect(() => {
    engine.register(tl.slide);
    engine.register(tl.fade);

    // Entry fade-in: panelRef.current.opacity 0 → 1
    if (panelRef.current) {
      tl.fade.resetItems();
      tl.fade.add(panelRef.current, {
        opacity: 1,
        duration: FADE_MS,
        ease: "outQuad",
        onComplete: () => force((x) => x + 1),
      });
      tl.fade.play();
    }

    // Particles: 3 timelines dispatched by PARTICLE_SPECS.periodIdx; per-group
    // startMs offsets create 8 non-overlapping glow phases. target.q stores the
    // 1/16-quantized value and onUpdate only forces on bucket crossings —
    // avoiding 8 setState calls per frame.
    const groups: ReadonlyArray<Timeline> = [tl.a, tl.b, tl.c];
    PARTICLE_SPECS.forEach((spec, i) => {
      const gtl = groups[spec.periodIdx]!;
      const target = particleTargetsRef.current[i]!;
      const period = PARTICLE_PERIODS[spec.periodIdx]!;
      gtl.add(
        target,
        {
          p: 1,
          duration: period,
          ease: "inOutSine",
          alternate: true,
          loop: true,
          onUpdate: (a) => {
            const v = Math.round((a.targets[0]?.p ?? 0) * 16) / 16;
            if (target.q !== v) {
              target.q = v;
              force((x) => x + 1);
            }
          },
        },
        spec.startMs
      );
    });
    tl.a.play();
    tl.b.play();
    tl.c.play();

    return () => {
      tl.slide.pause();
      engine.unregister(tl.slide);
      tl.fade.pause();
      engine.unregister(tl.fade);
      // Particle timelines are auto pause + unregister by useTimeline's unmount effect
    };
  }, [tl]);

  // ── autoOn toggle: the slider appears/vanishes; on remount it snaps straight
  //    to the current level (no flight animation — flight is only for manual
  //    ←/→ switching on the level row). ──
  useEffect(() => {
    if (sliderRef.current) {
      sliderRef.current.translateX = LEVEL_X[currentIndex] ?? 0;
    }
  }, [autoOn, currentIndex]);

  // ── Slider flight: currentIndex change → translateX old→new, 200ms outQuad. ──
  const prevIndexRef = useRef<number>(currentIndex);
  useEffect(() => {
    const slider = sliderRef.current;
    if (!slider) return;
    if (prevIndexRef.current === currentIndex) return;
    prevIndexRef.current = currentIndex;
    tl.slide.resetItems();
    tl.slide.add(slider, {
      translateX: LEVEL_X[currentIndex] ?? 0,
      duration: SLIDE_MS,
      ease: "outQuad",
    });
    tl.slide.play();
  }, [currentIndex, tl]);

  // ── Derived ──
  const focusOnAuto = autoOn && focusIndex === -1;
  const sliderVisible = !autoOn;
  const hint = autoOn
    ? "[Tab/Space] 切 Auto · [Enter] 确认 · [Esc] 取消"
    : "[←/→] 切档 · [Tab/Space] 切 Auto · [Enter] 确认 · [Esc] 取消";
  const borderColor = autoOn ? pal.running : pal.bgRunning;

  // Track spans: after sorting by position, build the `─` baseline + particle
  // spans; each particle's color mixes from track base toward the aurora tone
  // (green/gold) by its quantized phase, and drifters cycle their three glyphs
  // by phase — combined with spatial offsets to fake aurora drift.
  const trackSpans = (): ReactNode => {
    const sorted = PARTICLE_SPECS.map((spec, i) => ({
      spec,
      target: particleTargetsRef.current[i]!,
    }))
      .slice()
      .sort((a, b) => a.spec.x - b.spec.x);
    const out: ReactNode[] = [];
    let pos = 0;
    sorted.forEach(({ spec, target }, j) => {
      if (spec.x > pos) {
        const pad = spec.x - pos;
        out.push(
          <span key={`base-${j}`} fg={pal.bgRunning}>
            {"─".repeat(pad)}
          </span>
        );
      }
      const q = target.q;
      const fg =
        spec.kind === "orbiter"
          ? mixHex(pal.bgRunning, pal.add, q)
          : mixHex(pal.dim, pal.logoGold, q);
      const glyph = driftGlyph(spec.glyphs, q);
      out.push(
        <span
          key={`p-${spec.x}`}
          fg={fg}
          attributes={q > 0.55 ? TextAttributes.BOLD : TextAttributes.NONE}
        >
          {glyph}
        </span>
      );
      pos = spec.x + 1;
    });
    if (pos < TRACK_LEN) {
      out.push(
        <span key="base-tail" fg={pal.bgRunning}>
          {"─".repeat(TRACK_LEN - pos)}
        </span>
      );
    }
    return out;
  };

  return (
    <box
      ref={panelRef}
      flexDirection="column"
      borderStyle="rounded"
      borderColor={borderColor}
      paddingX={1}
      opacity={0}
      width={Math.max(1, cols)}
    >
      {/* Title ◆─ Thinking · aurora (gold ◆ + white Thinking + dim suffix) */}
      <text>
        <span fg={pal.logoGold} attributes={TextAttributes.BOLD}>
          {"◆ "}
        </span>
        <span fg={pal.text} attributes={TextAttributes.BOLD}>
          Thinking
        </span>
        <span fg={pal.dim}>{"  ·  aurora effort"}</span>
      </text>

      {/* Auto row: ●/○ two states + AUTO label (highlighted when focus is on Auto) */}
      <text>
        <span
          fg={autoOn ? pal.running : pal.dim}
          attributes={autoOn ? TextAttributes.BOLD : TextAttributes.NONE}
        >
          {autoOn ? "●" : "○"}
        </span>
        <span
          fg={focusOnAuto ? pal.accent : pal.dim}
          attributes={focusOnAuto ? TextAttributes.BOLD : TextAttributes.NONE}
        >
          {"  AUTO  ·  "}
        </span>
        <span fg={pal.dim}>
          {autoOn ? "adaptive (server picks)" : "concrete effort"}
        </span>
      </text>

      {/* Level label row (focus cursor): focusIndex rendered accent BOLD here. */}
      <text wrapMode="none">
        <span fg={pal.dim}> </span>
        {EFFORT_LEVELS.map((level, i) => {
          const isFocused = !autoOn && i === focusIndex;
          return (
            <span
              key={level}
              fg={isFocused ? pal.accent : pal.dim}
              attributes={isFocused ? TextAttributes.BOLD : TextAttributes.NONE}
            >
              {level}
              {i < EFFORT_LEVELS.length - 1 ? "  " : ""}
            </span>
          );
        })}
        <span fg={pal.dim}> </span>
      </text>

      {/* Aurora track + slider overlay: the track text sets row height, the slider
          is an absolute overlay at the current level's center x; translateX flight on change. */}
      <box width="100%" flexDirection="row">
        <text wrapMode="none">{trackSpans()}</text>
        {sliderVisible && (
          <box ref={sliderRef} position="absolute" left={0}>
            <text fg={pal.running} attributes={TextAttributes.BOLD}>
              {"●"}
            </text>
          </box>
        )}
      </box>

      {/* Key hints */}
      <text fg={pal.dim}>{hint}</text>
    </box>
  );
}

export const design21: ThinkingDesign = {
  meta: {
    id: "design-21-aurora",
    name: "极光粒子风",
    tag: "Aurora Particles",
    summary:
      "极光三色调（绿/灰绿/粉金）+ 8 个错相位极光粒子 + 三组 alternate loop（800/1100/1400ms）+ 滑块 translateX 飞档。",
  },
  render: (props: ThinkingDesignProps): ReactElement =>
    (<AuroraPanel {...props} />) as ReactElement,
};
