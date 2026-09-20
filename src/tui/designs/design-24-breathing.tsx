/** @jsxImportSource @opentui/react */
/**
 * src/tui/designs/design-24-breathing.tsx
 *
 * Thinking panel · Design 24: Breathing Fill — base-color variant B of
 * design-22.
 *
 * Frame inherited from design-22 (design-5 rounded flowing border + 5 equal
 * segments + geometry-centred labels):
 *   [rounded border, 4-token flowing color, 8000ms]
 *     ◆─ Thinking                ← title
 *     ◑  AUTO · <desc>           ← auto dot + description
 *     ████████████████████       ← whole-bar breathing pulse fill (core difference)
 *     low    medium    high    xhigh    max
 *     key hints
 *
 * Bar geometry from the shared _geometry.ts: 5 strictly equal segments,
 * labels centred at segment midpoints.
 *
 * Fill (the core difference — a whole-bar breathing pulse replacing
 * design-22's shimmer band):
 *   - filled segments: dim → text gray gradient base, multiplied by a global
 *     breath luma and mixed toward pal.accent
 *   - breath: `0.5 + 0.5 * sin(2π * phase)`, phase ∈ [0,1] driven by a
 *     timeline alternate ping-pong; one sweep T = 3200ms is the baseline
 *     "breathing" period
 *   - at the peak the whole bar leans accent-warm, at the trough it falls
 *     back to the gray gradient
 *   - current segment (segIdx === currentIndex) gets extra lightening toward
 *     pal.accent so it still stands out at the trough
 *   - unfilled / autoOn: bg = pal.border, fg = pal.dim (dark track, excluded
 *     from breathing)
 *   - border keeps the design-5/22 8000ms 4-phase flow
 *
 * Color discipline: fill uses only pal.dim / pal.text / pal.accent /
 * pal.border; foreground glyphs mix with logoInk for contrast (design-22
 * fg handling — fg only, never base color).
 */
import {
  useEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import { TextAttributes, type Timeline } from "@opentui/core";
import { useTimeline } from "@opentui/react";
import { tuiPalette } from "../theme.js";
import { type ThinkingDesign, type ThinkingDesignProps } from "./_contract.js";
import {
  SEG_COUNT,
  floorTo5BarLen,
  labelPad,
  segmentLen,
} from "./_geometry.js";

// ── Constants ─────────────────────────────────────────────────────────
/** Border flow 4-phase cycle (same as design-5/22). */
const BORDER_CYCLE_MS = 8_000;
/** Entry animation. */
const ENTRY_DURATION_MS = 400;
/** Auto dot cross-fade. */
const AUTO_DOT_DURATION_MS = 200;
/** Whole-bar breathing pulse: one 0→1 sweep in 3200ms; with alternate
 *  ping-pong the visual period is 2*3200ms. 3200ms is the baseline "breathing" period. */
const BREATH_MS = 3_200;

// ── Color utils ───────────────────────────────────────────────────────
function hexToRgb(hex: string): readonly [number, number, number] {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex);
  if (!m) return [1, 1, 1];
  const v = parseInt(m[1]!, 16);
  return [
    ((v >> 16) & 0xff) / 255,
    ((v >> 8) & 0xff) / 255,
    (v & 0xff) / 255,
  ] as const;
}

function mixHex(a: string, b: string, t: number): string {
  const tt = Math.max(0, Math.min(1, t));
  const [ar, ag, ab] = hexToRgb(a);
  const [br, bg, bb] = hexToRgb(b);
  const r = Math.round((ar + (br - ar) * tt) * 255);
  const g = Math.round((ag + (bg - ag) * tt) * 255);
  const bl = Math.round((ab + (bb - ab) * tt) * 255);
  return `#${r.toString(16).padStart(2, "0")}${g
    .toString(16)
    .padStart(2, "0")}${bl.toString(16).padStart(2, "0")}`;
}

/** 3-stop linear gradient logoInk(0) → running(0.5) → logoGold(1), same as design-16. */
function gradAt(t: number): string {
  const k = Math.max(0, Math.min(1, t));
  if (k <= 0.5) return mixHex(tuiPalette.logoInk, tuiPalette.running, k * 2);
  return mixHex(tuiPalette.running, tuiPalette.logoGold, (k - 0.5) * 2);
}

/** Border flow: phase p in [0, 4], RGB lerp between adjacent phases (same as design-5/22). */
function flowBorderColor(phase: number): string {
  const n = 4;
  const idx = Math.floor(phase) % n;
  const f = phase - Math.floor(phase);
  const tokens = [
    tuiPalette.logoInk,
    tuiPalette.running,
    tuiPalette.logoGold,
    tuiPalette.running,
  ];
  const a = tokens[idx]!;
  const b = tokens[(idx + 1) % n]!;
  return mixHex(a, b, f);
}

// ── Main render component ───────────────────────────────────────────
function BreathingRender(props: ThinkingDesignProps): ReactNode {
  const pal = tuiPalette;
  const { model, cols } = props;
  const { autoOn, currentIndex, focusIndex, open } = model;

  // ── Timeline ref (lock the first-render instance via useRef, same as design-5/22) ──
  const initialTimeline = useTimeline({
    duration: BORDER_CYCLE_MS,
    loop: true,
  });
  const timelineRef = useRef<Timeline | null>(null);
  if (timelineRef.current === null) timelineRef.current = initialTimeline;
  const tl = timelineRef.current;

  // Breathing pulse timeline: item-level loop + alternate ping-pong
  // (TimelineOptions has no top-level alternate; same pattern as the design-22
  // shimmer — the top level only drives)
  const breathFirst = useTimeline({
    duration: BREATH_MS,
    loop: true,
  });
  const breathRef = useRef<Timeline | null>(null);
  if (breathRef.current === null) breathRef.current = breathFirst;
  const tlBreath = breathRef.current;

  // ── Ambient state (setStates each frame) ──
  const [borderPhase, setBorderPhase] = useState(0);
  const [phase, setPhase] = useState(0); // breath phase in [0,1]

  // ── Entry + Auto refs (timeline mutates directly; force setState re-renders) ──
  const entryRef = useRef<{ marginTop: number; opacity: number }>({
    marginTop: -2,
    opacity: 0,
  });
  const autoMixRef = useRef<{ mix: number }>({ mix: autoOn ? 1 : 0 });
  const [, force] = useState(0);

  // Border flow phase: 8s linear loop (onComplete zeroes the target to dodge the reset trap, same as design-5)
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

  // Ambient: breath phase 0→1→0 alternate (whole-bar pulse phase)
  useEffect(() => {
    const target = { p: 0 };
    tlBreath.add(target, {
      p: 1,
      duration: BREATH_MS,
      ease: "linear",
      loop: true,
      alternate: true,
      onUpdate: () => setPhase(target.p),
    });
  }, [tlBreath]);

  // Entry: marginTop -2 → 0, opacity 0 → 1
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

  // Auto dot color switch: dim ↔ running, 200ms outExpo
  useEffect(() => {
    const target = autoMixRef.current;
    const currentMix = target.mix;
    const targetMix = autoOn ? 1 : 0;
    if (currentMix === targetMix) return;
    tl.once(target, {
      mix: targetMix,
      duration: AUTO_DOT_DURATION_MS,
      ease: "outExpo",
      onUpdate: () => force((x) => x + 1),
    });
  }, [autoOn, tl]);

  // ── Progress-bar geometry (shared _geometry.ts) ──
  //   border left/right 2 cols + paddingX 1 each = 4 cols of fixed overhead
  const innerCols = Math.max(SEG_COUNT, cols - 4);
  const barLen = floorTo5BarLen(innerCols);
  const segLen = segmentLen(barLen);

  // ── Derived values ──
  const entry = entryRef.current;
  const autoDotGlyph = autoOn ? "◐" : "◑";
  const autoDotColor = mixHex(pal.dim, pal.running, autoMixRef.current.mix);
  const autoDesc = autoOn ? "自适应档位" : "手动档位";

  // breath formula: phase ∈ [0,1], breath = 0.5 + 0.5 * sin(2π * phase) ∈ [0,1]
  const breath = 0.5 + 0.5 * Math.sin(2 * Math.PI * phase);
  // Full 0..1 swing (deep purple → bright purple) so the motion is visible
  const luma = breath;

  /** Char i's visual color: purple-gradient base + whole-bar breathing pulse
   *  (low luma → deep-purple logoInk, high luma → the bright base). The current
   *  segment gets +0.25 extra brightness to stay visible at the trough. */
  function colorAt(i: number): { bg: string; fg: string } {
    if (autoOn) return { bg: pal.border, fg: pal.dim };
    const segIdx = Math.min(SEG_COUNT - 1, Math.floor(i / segLen));
    if (segIdx > currentIndex) {
      // Unfilled dark track
      return { bg: pal.border, fg: pal.dim };
    }
    const filledEnd = (currentIndex + 1) * segLen;
    const t = i / Math.max(1, filledEnd - 1);
    // Purple-gradient base
    const base = gradAt(t);
    // Breathing: low luma mixes the whole bar into deep logoInk (dark), high luma approaches base (bright)
    const lit = mixHex(base, pal.logoInk, (1 - luma) * 0.7);
    let out = lit;
    if (segIdx === currentIndex) {
      // Current level +0.3 brightness (still stands out at the breathing trough)
      out = mixHex(lit, pal.text, 0.3);
    }
    const fg = mixHex(out, pal.logoInk, 0.5);
    return { bg: out, fg };
  }

  // ── Level-label styles: focus ▸◂ (moving) / current brightened (confirmed) / rest dim ──
  const labels = ["low", "medium", "high", "xhigh", "max"] as const;
  function labelFor(i: number): { text: string; fg: string; bold: boolean } {
    const text = labels[i];
    if (autoOn) return { text, fg: pal.dim, bold: false };
    if (open && i === focusIndex)
      return { text: `▸ ${text} ◂`, fg: pal.running, bold: true };
    if (i === currentIndex) return { text, fg: pal.accent, bold: true };
    return { text, fg: pal.dim, bold: false };
  }

  // ── Label-row nodes: labelPad centers each label on its segment midpoint, concatenated to barLen width ──
  const labelNodes: ReactNode[] = [];
  for (let i = 0; i < labels.length; i++) {
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

  // ── Key hints (branch on the current auto state) ──
  const hint = autoOn
    ? "[Tab/Space] 切 Auto · [Enter] 确认 · [Esc] 取消"
    : "[← →] 切档 · [Tab/Space] 切 Auto · [Enter] 确认 · [Esc] 取消";

  // ── Render ──
  return (
    <box
      flexDirection="column"
      borderStyle="rounded"
      borderColor={flowBorderColor(borderPhase)}
      paddingX={1}
      paddingY={0}
      marginTop={entry.marginTop}
      opacity={entry.opacity}
      width={Math.max(1, cols)}
    >
      {/* Title ◆─ Thinking (same as design-5/22) */}
      <text>
        <span fg={pal.running}>{"◆─ "}</span>
        <span fg={pal.text} attributes={TextAttributes.BOLD}>
          Thinking
        </span>
      </text>

      {/* Auto row: ◐/◑ + AUTO + description (same as design-5/22) */}
      <text>
        <span fg={autoDotColor}>{`${autoDotGlyph}  `}</span>
        <span fg={pal.dim}>AUTO</span>
        <span fg={pal.dim}>{`  ·  ${autoDesc}`}</span>
      </text>

      {/* Breathing-pulse bar: gradient base + whole-bar luma breathing
          (replaces design-22's shimmer band with a breathing fill color) */}
      <text wrapMode="none">
        {Array.from({ length: barLen }, (_, i) => {
          const { bg, fg } = colorAt(i);
          return (
            <span key={i} bg={bg} fg={fg}>
              █
            </span>
          );
        })}
      </text>

      {/* Label row: each of 5 levels centered on its segment midpoint (geometry-aligned, breakpoints match levels) */}
      <text wrapMode="none">{labelNodes}</text>

      {/* Key hints */}
      <text fg={pal.dim}>{hint}</text>
    </box>
  );
}

// ── Export ────────────────────────────────────────────────────────────
export const design24: ThinkingDesign = {
  meta: {
    id: "design-24-breathing",
    name: "呼吸填充",
    tag: "Breathing Fill",
    summary: "design-5 框架 + 整条已填充段 3.2s 同步呼吸脉冲底色",
  },
  render: (p) => BreathingRender(p) as unknown as ReactElement,
};
