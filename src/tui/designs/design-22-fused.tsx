/** @jsxImportSource @opentui/react */
/**
 * Design 22 — Fused version (design-5 rounded flow border + design-16 gradient flow bar).
 *
 * Frame structure (inherited from design-5):
 *   [rounded border, borderColor cycles the 4-token flow]
 *     ◆─ Thinking                ← title
 *     ◑  AUTO · manual label     ← auto dot + description
 *
 *     ████████████████████      ← flowing progress bar (design-16 style)
 *     ████████████████████
 *     ████████████████████
 *
 *     low         medium         high         xhigh        max   ← 5 labels
 *     hint row
 *
 * Bar geometry (from _geometry.ts; all 5 segments equal width):
 *   - barLen = innerCols floored to a multiple of 5 → max segment hugs the
 *     right edge at full fill
 *   - each segment = barLen / 5 (strictly equal, mapping low…max)
 *   - labels centered exactly on segment midpoints, even spacing
 *   - each breakpoint marks one level, so the fill edge reads the current level
 *
 * Fill colors (grayscale only, no yellow-green inversion; bgRunning contrast
 * was dropped by feedback):
 *   - filled segments [0, currentIndex]: dim → text light-gray gradient with a
 *     shimmer band sweeping over it (alternate ping-pong 2800ms, design-16)
 *   - current segment keeps a 0.5 brightness floor so the focus stays on it
 *   - unfilled segments: pal.border dark track with dim glyphs
 *   - the bar spans the full inner width (not left-packed)
 *   - autoOn → uniform dark track: no fill, no band, labels all dim
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
/** Border flow 4-phase cycle (same as design-5). */
const BORDER_CYCLE_MS = 8_000;
/** Entry animation. */
const ENTRY_DURATION_MS = 400;
/** Auto dot color crossfade. */
const AUTO_DOT_DURATION_MS = 200;
/** Ambient shimmer cycle (one alternate ping-pong round, same as design-16). */
const SHIMMER_MS = 2800;

// ── Color utils (same palette mixes as design-5/16) ───────────────────
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

/** Triangular light band: center c, half-width hw → intensity [0,1]. */
function lightGlow(i: number, c: number, hw: number): number {
  const d = Math.abs(i - c);
  if (d >= hw) return 0;
  return 1 - d / hw;
}

/** 3-stop linear gradient logoInk(0) → running(0.5) → logoGold(1), same as design-16. */
function gradAt(t: number): string {
  const k = Math.max(0, Math.min(1, t));
  if (k <= 0.5) return mixHex(tuiPalette.logoInk, tuiPalette.running, k * 2);
  return mixHex(tuiPalette.running, tuiPalette.logoGold, (k - 0.5) * 2);
}

/** Border flow color: phase p ∈ [0, 4], RGB-interpolated between adjacent phases. */
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

// ── Main render component ─────────────────────────────────────────────
function FusedFlowRender(props: ThinkingDesignProps): ReactNode {
  const pal = tuiPalette;
  const { model, cols } = props;
  const { autoOn, currentIndex, focusIndex, open } = model;

  // ── Timeline refs (useRef locks first-render instances, same as design-5/16) ──
  const initialTimeline = useTimeline({
    duration: BORDER_CYCLE_MS,
    loop: true,
  });
  const timelineRef = useRef<Timeline | null>(null);
  if (timelineRef.current === null) timelineRef.current = initialTimeline;
  const tl = timelineRef.current;

  const shimmerFirst = useTimeline({
    duration: SHIMMER_MS * 2,
    loop: true,
  });
  const shimmerRef = useRef<Timeline | null>(null);
  if (shimmerRef.current === null) shimmerRef.current = shimmerFirst;
  const tlShimmer = shimmerRef.current;

  // ── Ambient state (setState per frame) ──
  const [borderPhase, setBorderPhase] = useState(0);
  const [phase, setPhase] = useState(0); // shimmer

  // ── Entry + Auto refs (timeline mutates directly; force setState re-renders) ──
  const entryRef = useRef<{ marginTop: number; opacity: number }>({
    marginTop: -2,
    opacity: 0,
  });
  const autoMixRef = useRef<{ mix: number }>({ mix: autoOn ? 1 : 0 });
  const [, force] = useState(0);

  // Border flow phase: 8s linear loop (onComplete zeroes the value to dodge the
  // reset trap, same as design-5)
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

  // Ambient 1: shimmer phase 0→1→0 alternate
  useEffect(() => {
    const target = { p: 0 };
    tlShimmer.add(target, {
      p: 1,
      duration: SHIMMER_MS,
      ease: "linear",
      loop: true,
      alternate: true,
      onUpdate: () => setPhase(target.p),
    });
  }, [tlShimmer]);

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

  // Auto dot color swap: dim ↔ running 200ms outExpo
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

  /** Char i's color: 3-stop purple gradient (logoInk→running→logoGold) with a
   *  white shimmer band sweeping over it (floating effect); the current segment
   *  gets an extra brightness floor for focus (no bgRunning inversion).
   *  This is design-16's original purple motion, just without the yellow-green contrast. */
  function colorAt(i: number): { bg: string; fg: string } {
    if (autoOn) return { bg: pal.border, fg: pal.dim };
    const segIdx = Math.min(SEG_COUNT - 1, Math.floor(i / segLen));
    if (segIdx > currentIndex) {
      // Unfilled dark track
      return { bg: pal.border, fg: pal.dim };
    }
    // Filled segment: 3-stop purple gradient (keeps the design-16 color feel)
    const filledEnd = (currentIndex + 1) * segLen;
    const t = i / Math.max(1, filledEnd - 1);
    const base = gradAt(t);
    // White shimmer band sweeping over it (floating effect)
    const lightCenter = phase * (barLen - 1);
    const glow = lightGlow(i, lightCenter, barLen * 0.32);
    const isCurrent = segIdx === currentIndex;
    const eff = isCurrent ? Math.max(glow, 0.55) : glow;
    const lit = mixHex(base, pal.text, eff * 0.65);
    const fg = mixHex(lit, pal.logoInk, 0.5);
    return { bg: lit, fg };
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

  // ── Key hint (branches on auto state) ──
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
      {/* Title ◆─ Thinking (same as design-5) */}
      <text>
        <span fg={pal.running}>{"◆─ "}</span>
        <span fg={pal.text} attributes={TextAttributes.BOLD}>
          Thinking
        </span>
      </text>

      {/* Auto row: ◐/◑ + AUTO + description (same as design-5) */}
      <text>
        <span fg={autoDotColor}>{`${autoDotGlyph}  `}</span>
        <span fg={pal.dim}>AUTO</span>
        <span fg={pal.dim}>{`  ·  ${autoDesc}`}</span>
      </text>

      {/* Flowing progress bar: grayscale fill + shimmer band (spans inner width, no per-level blocks) */}
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

      {/* Label row: 5 levels each centered on its segment midpoint (geometry-aligned, breakpoints map to levels) */}
      <text wrapMode="none">{labelNodes}</text>

      {/* Key hints */}
      <text fg={pal.dim}>{hint}</text>
    </box>
  );
}

// ── Export ────────────────────────────────────────────────────────────
export const design22: ThinkingDesign = {
  meta: {
    id: "design-22-fused",
    name: "流动条融合",
    tag: "Fused Flow",
    summary:
      "design-5 玻璃渐变框架 + design-16 流动进度条；5 段等宽 + 几何对齐标签 + 灰阶填充",
  },
  render: (p) => FusedFlowRender(p) as unknown as ReactElement,
};
