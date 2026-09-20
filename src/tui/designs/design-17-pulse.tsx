/** @jsxImportSource @opentui/react */
/**
 * Design 17 — Concentric Pulse thinking panel (demo gallery candidate).
 *
 * - Bullseye vocabulary: the current level is a solid core `●` flanked by
 *   two rings that light up with the pulse (`⊙` at peak, `·` at trough);
 *   the 5 levels form a row of identical targets breathing in sync, with
 *   only the current one's gold core lit. A bottom `● currentLevel`
 *   anchor row repeats the same signal so narrow terminals never lose
 *   the focal point.
 * - Breathing pulse (ambient, visible only when Auto off): current ring
 *   color breathes between pal.running and pal.logoGold via one
 *   non-loop timeline + item-level `loop:true, alternate:true`
 *   (1200ms inOutSine). A second property `fade` rides the same rhythm;
 *   above a 0.4 threshold the ring glyph flips `·`→`⊙` and gains BOLD —
 *   the outer circle solidifies as the pulse brightens.
 * - Entry (one-shot): panel opacity 0→1, marginTop -1→0, 450ms outExpo.
 * - Level-confirm (triggered): currentIndex change → ring flashes `◎`
 *   (heavy circle, "pulse outer ring expanding") with scale
 *   1→1.22→1, 300ms outBack; the scale value gates the glyph
 *   (>1.05 → `◎`, else `⊙`/`·`). The two tweens are staggered with an
 *   explicit startTime so they never overwrite the same target property.
 * - Auto dot: `●` on (breathing running↔logoGold) / `○` off (static
 *   pal.dim). Color swap 220ms outExpo; dot glow 1000ms inOutSine.
 * - With Auto on the 5 levels are visually disabled (cores revert to `⊙`,
 *   rings fixed `·`, all pal.dim) so focus shifts to the Auto dot;
 *   switching back eases the levels into the breathing state over 800ms
 *   outQuad.
 * - Focus cursor (INVERSE badge on focusIndex, pal.accent) and current
 *   core (currentIndex, pal.running BOLD) are strictly orthogonal.
 * - Rounded border: pal.border idle → pal.running when the picker is open.
 *
 * Animation budget: ≤ 2 ambient loops (level ring breathing + Auto dot
 * breathing). Both always run but render conditions make only one
 * visible at a time, so at most 2 channels ever stack. Entry / confirm /
 * color-swap are one-shots.
 *
 * Colors come 100% from tuiPalette; no new constants.
 */
import { useEffect, useRef, useState } from "react";
import type { ReactElement, ReactNode } from "react";
import { TextAttributes } from "@opentui/core";
import type { Timeline } from "@opentui/core";
import { useTimeline } from "@opentui/react";
import { tuiPalette } from "../theme.js";
import {
  EFFORT_LEVELS,
  type ThinkingDesign,
  type ThinkingDesignProps,
} from "./_contract.js";

/** 5 level labels (`xhigh` rendered as the more readable `x-high`). */
const LEVEL_LABELS: ReadonlyArray<string> = EFFORT_LEVELS.map((level) =>
  level === "xhigh" ? "x-high" : level
);

/** Key hint row. */
const HINT =
  "[← →] 切档  ·  [Tab/Space] 切 Auto  ·  [Enter] 确认  ·  [Esc] 取消";

/** Current-level ring breathing half-cycle (full ping-pong = 2×). */
const PULSE_MS = 1200;
/** Auto dot breathing half-cycle (visible only when Auto on). */
const AUTO_DOT_PULSE_MS = 1000;
/** Panel entry duration (outExpo, one-shot). */
const ENTRY_MS = 450;
/** Confirm-scale half duration (outBack, triggered; total = 2 × CONFIRM_MS). */
const CONFIRM_MS = 300;
/** Auto dot color-swap duration (outExpo, triggered). */
const AUTO_DOT_SWAP_MS = 220;
/** Ring reset duration (when Auto flips back off, outQuad, triggered). */
const PULSE_RESET_MS = 800;

/** Ambient timeline duration: non-loop but always long enough, dodging
 *  the loop:true resetItems initial-value re-capture trap (see
 *  design-3-crt notes); infinite looping comes from item-level
 *  `loop:true, alternate:true`. */
const INFINITE_MS = 3_600_000;

/** Ring fade-in BOLD threshold (0..1; past it the outer ring lights up). */
const RING_BOLD_THRESHOLD = 0.4;
/** Confirm glyph threshold (scale above it → ring becomes `◎` heavy circle). */
const CONFIRM_RING_THRESHOLD = 1.05;

/** 6-digit hex (`#rrggbb`) → integer RGB. */
function parseHex(hex: string): { r: number; g: number; b: number } {
  const v = Number.parseInt(hex.slice(1), 16);
  return { r: (v >> 16) & 0xff, g: (v >> 8) & 0xff, b: v & 0xff };
}

/** Linear RGB interpolation between two hex colors; t clamped to 0..1. */
function mixHex(a: string, b: string, t: number): string {
  const k = Math.max(0, Math.min(1, t));
  const pa = parseHex(a);
  const pb = parseHex(b);
  const r = Math.round(pa.r + (pb.r - pa.r) * k);
  const g = Math.round(pa.g + (pb.g - pa.g) * k);
  const bl = Math.round(pa.b + (pb.b - pa.b) * k);
  const hex = ((r << 16) | (g << 8) | bl).toString(16).padStart(6, "0");
  return `#${hex}`;
}

/** Design 17 main panel: hooks + rendering. */
function PulsePanel(props: ThinkingDesignProps): ReactNode {
  const pal = tuiPalette;
  const { model, cols } = props;
  const { autoOn, currentIndex, focusIndex, open } = model;

  // useTimeline news a fresh Timeline each render but only the first is
  // registered and driven by the engine; pin that one in a ref so every
  // later .add() lands on it.
  const initialTimeline = useTimeline({ duration: INFINITE_MS });
  const timelineRef = useRef<Timeline | null>(null);
  if (timelineRef.current === null) timelineRef.current = initialTimeline;
  const tl = timelineRef.current;

  // The timeline mutates these refs in place; setState is only a force re-render trigger.
  const [, force] = useState(0);
  const entryRef = useRef<{ opacity: number; marginTop: number }>({
    opacity: 0,
    marginTop: -1,
  });
  const pulseRef = useRef<{ ring: number; fade: number }>({ ring: 0, fade: 0 });
  const dotRef = useRef<{ mix: number }>({ mix: autoOn ? 1 : 0 });
  const dotPulseRef = useRef<{ v: number }>({ v: autoOn ? 1 : 0 });
  const scaleRef = useRef<{ s: number }>({ s: 1 });

  // ── Ambient: current-level ring breathing + Auto dot breathing ──
  // Both loop forever; render conditions decide which one is visible
  // (see showLevels / autoOn branches below). They never play/pause each
  // other, avoiding a resetItems initial-value re-capture.
  useEffect(() => {
    tl.add(pulseRef.current, {
      ring: 1,
      fade: 1,
      duration: PULSE_MS,
      ease: "inOutSine",
      alternate: true,
      loop: true,
      onUpdate: () => force((x) => x + 1),
    });
    tl.add(dotPulseRef.current, {
      v: 1,
      duration: AUTO_DOT_PULSE_MS,
      ease: "inOutSine",
      alternate: true,
      loop: true,
      onUpdate: () => force((x) => x + 1),
    });
    // mount-only; useTimeline auto-pauses + engine-unregisters on unmount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tl]);

  // ── Entry (one-shot): opacity 0→1, marginTop -1→0. ──
  useEffect(() => {
    tl.add(entryRef.current, {
      opacity: 1,
      marginTop: 0,
      duration: ENTRY_MS,
      ease: "outExpo",
      once: true,
      onUpdate: () => force((x) => x + 1),
    });
  }, [tl]);

  // ── Trigger: Auto toggle gating ──
  //  on  → reset ring/dot visual state (dot = running, ring = 0; ring
  //    visibility suppressed by showLevels=false; dot color picked up by
  //    the dot-swap effect).
  //  off → ease ring from 0 up to 1 (breathing reset); dot color picked
  //    up by the swap effect.
  const prevAutoRef = useRef<boolean>(autoOn);
  useEffect(() => {
    if (prevAutoRef.current === autoOn) return;
    prevAutoRef.current = autoOn;
    if (autoOn) {
      pulseRef.current.ring = 0;
      pulseRef.current.fade = 0;
      dotPulseRef.current.v = 1;
    } else {
      pulseRef.current.ring = 0;
      pulseRef.current.fade = 0;
      dotPulseRef.current.v = 0;
      tl.add(pulseRef.current, {
        ring: 1,
        fade: 1,
        duration: PULSE_RESET_MS,
        ease: "outQuad",
        once: true,
        onUpdate: () => force((x) => x + 1),
      });
    }
  }, [autoOn, tl]);

  // ── Trigger: Auto dot color swap (autoOn change → dim ↔ running). ──
  const dotSwapPrevRef = useRef<boolean>(autoOn);
  useEffect(() => {
    if (dotSwapPrevRef.current === autoOn) return;
    dotSwapPrevRef.current = autoOn;
    tl.add(dotRef.current, {
      mix: autoOn ? 1 : 0,
      duration: AUTO_DOT_SWAP_MS,
      ease: "outExpo",
      once: true,
      onUpdate: () => force((x) => x + 1),
    });
  }, [autoOn, tl]);

  // ── Trigger: Enter confirm (currentIndex change → scale 1→1.22→1) ──
  // Explicit startTime staggers the two outBack tweens so two once items
  // sharing one startTime can't overwrite each other's property. After an
  // item completes, `once:true` splices it out of the items array, so the
  // next currentIndex change re-adds cleanly without interference.
  const prevIndexRef = useRef<number>(currentIndex);
  useEffect(() => {
    if (prevIndexRef.current === currentIndex) return;
    prevIndexRef.current = currentIndex;
    scaleRef.current.s = 1;
    tl.add(scaleRef.current, {
      s: 1.22,
      duration: CONFIRM_MS,
      ease: "outBack",
      once: true,
      onUpdate: () => force((x) => x + 1),
    });
    tl.add(
      scaleRef.current,
      {
        s: 1,
        duration: CONFIRM_MS,
        ease: "outBack",
        once: true,
        onUpdate: () => force((x) => x + 1),
      },
      tl.currentTime + CONFIRM_MS
    );
  }, [currentIndex, tl]);

  // ── Derived values (refs mutated in place by the timeline; the forced
  //  setState re-render reads the latest) ──
  const ringBright = pulseRef.current.ring;
  const ringBold = pulseRef.current.fade > RING_BOLD_THRESHOLD;
  const ringColor = mixHex(pal.running, pal.logoGold, ringBright);
  const dotColor = mixHex(pal.dim, pal.running, dotRef.current.mix);
  const dotGlow = mixHex(pal.running, pal.logoGold, dotPulseRef.current.v);
  const confirmScale = scaleRef.current.s;
  const entry = entryRef.current;
  const borderColor = open ? pal.running : pal.border;
  const showLevels = !autoOn;
  const autoDesc = autoOn
    ? "自适应档位 · server picks" // adaptive level
    : "手动档位 · concrete effort"; // manual level

  return (
    <box
      flexDirection="column"
      borderStyle="rounded"
      borderColor={borderColor}
      paddingX={1}
      paddingY={0}
      width={Math.max(1, cols)}
      opacity={entry.opacity}
      marginTop={entry.marginTop}
    >
      {/* Title: ⊙ ornament + THINKING */}
      <text>
        <span fg={pal.running} attributes={TextAttributes.BOLD}>
          {"⊙ "}
        </span>
        <span fg={pal.text} attributes={TextAttributes.BOLD}>
          THINKING
        </span>
      </text>

      {/* Auto row: dot toggle + state label (glowing breath = on). */}
      <text>
        <span fg={autoOn ? dotGlow : dotColor} attributes={TextAttributes.BOLD}>
          {autoOn ? "●" : "○"}
        </span>
        <span fg={pal.dim}>
          {"  AUTO  ·  "}
          {autoDesc}
        </span>
      </text>

      {/* 5 levels: current = solid gold core + breathing ring; others = hollow ⊙.
          With Auto on all 5 are disabled (dim + ring fixed `·`). */}
      <box flexDirection="row" alignItems="center">
        {LEVEL_LABELS.map((label, i) => {
          const current = showLevels && i === currentIndex;
          const focused = showLevels && i === focusIndex;
          const dim = !showLevels;
          const core = dim ? "⊙" : current ? "●" : "⊙";
          // Ring glyph threshold: `·` when dim; otherwise chosen by pulse/fade +
          // confirm scale: `◎` (heavy ring, at confirm), `⊙` (bright ring, peak),
          // `·` (dark ring, trough).
          const ringCh = dim
            ? "·"
            : current
              ? confirmScale > CONFIRM_RING_THRESHOLD
                ? "◎"
                : ringBold
                  ? "⊙"
                  : "·"
              : "·";
          const coreColor = dim ? pal.dim : current ? pal.running : pal.text;
          const ringColorAt = dim ? pal.dim : current ? ringColor : pal.dim;
          return (
            <box key={label} flexDirection="row" alignItems="center" gap={0}>
              {/* Focus cursor (INVERSE badge while picker open, orthogonal to the current-level gold core) */}
              <span
                fg={focused ? pal.accent : pal.dim}
                attributes={
                  focused ? TextAttributes.INVERSE : TextAttributes.NONE
                }
              >
                {focused ? " " : "·"}
              </span>
              <span
                fg={ringColorAt}
                attributes={
                  ringBold ? TextAttributes.BOLD : TextAttributes.NONE
                }
              >
                {ringCh}
              </span>
              <span
                fg={coreColor}
                attributes={current ? TextAttributes.BOLD : TextAttributes.NONE}
              >
                {core}
              </span>
              <span
                fg={ringColorAt}
                attributes={
                  ringBold ? TextAttributes.BOLD : TextAttributes.NONE
                }
              >
                {ringCh}
              </span>
              <span fg={dim ? pal.dim : current ? pal.running : pal.text}>
                {" "}
                {label}
              </span>
              <span fg={pal.dim}>
                {i < LEVEL_LABELS.length - 1 ? "   " : ""}
              </span>
            </box>
          );
        })}
      </box>

      {/* Anchor bullseye row: current level on its own line `● currentLevel`,
          reinforcing "this is current" + "the ring breathes here". Hidden when Auto on. */}
      {showLevels && (
        <box flexDirection="row" alignItems="center" marginTop={0}>
          <span fg={pal.running} attributes={TextAttributes.BOLD}>
            {"⊙ "}
          </span>
          <text fg={pal.running} attributes={TextAttributes.BOLD}>
            {LEVEL_LABELS[currentIndex] ?? ""}
          </text>
          <span fg={pal.dim}>{"  ·  呼吸外环 · 靶心落定"}</span>
        </box>
      )}

      {/* Key hints */}
      <text fg={pal.dim}>{HINT}</text>
    </box>
  );
}

export const design17: ThinkingDesign = {
  meta: {
    id: "design-17-pulse",
    name: "同心圆脉冲风",
    tag: "Concentric Pulse",
    summary:
      "同心圆靶心 + 外环呼吸脉冲（金↔粉金）+ 焦点游标/当前档正交 + Enter 靶心落定重圈闪现。",
  },
  render: ({ model, cols }) =>
    (<PulsePanel model={model} cols={cols} />) as ReactElement,
};
