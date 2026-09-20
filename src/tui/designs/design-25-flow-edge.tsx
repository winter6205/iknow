/** @jsxImportSource @opentui/react */
/**
 * src/tui/designs/design-25-flow-edge.tsx
 *
 * Thinking panel · Design 25: design-5 frame + flowing waterline edge color
 * (base-color variant C of design-22).
 *
 * Sole difference from design-22 is the **fill narrative**: design-22 sweeps a
 * shimmer band across the whole filled region; this version collapses all the
 * light onto the boundary between the "current segment / unfilled segment",
 * making a 2-segment-wide (segLen × 2) soft-glow transition band — like a
 * waterline flowing slightly left/right at the boundary, so the reader sees at
 * a glance "which level the water has reached, and it's still moving".
 *
 * Frame structure (identical to design-22, reusing design-5):
 *   [rounded border, 4-token flowing color]
 *     ◆─ Thinking                ← title
 *     ◑  AUTO · <desc>           ← auto dot + description
 *
 *     ████████████████████      ← progress bar (gray fill + boundary waterline)
 *
 *     low   medium   high   xhigh   max   ← 5 geometry-centred labels
 *     [←/→] level · [Tab/Space] Auto · [Enter] confirm · [Esc] cancel
 *
 * Bar geometry: fully reuses `_geometry.ts` (5 equal segments + labelPad
 * centring), column-aligned with design-22 for side-by-side comparison.
 *
 * Fill (gray + a single accent waterline, no yellow-green):
 *   - filled segment ([0, currentIndex]): dim → text stable gray gradient, **no shimmer**
 *   - boundary waterline: centre = rightmost column of the current segment,
 *     triangular-window half-width = segLen (spans one segment each side);
 *     strength glowEdge ∈ [0,1] → base mixes toward
 *     `mixHex(pal.text, pal.accent, glowEdge*0.65)`; the crest sways ±0.2*segLen
 *     with a 2400 ms alternate phase
 *   - unfilled segment (> currentIndex): `pal.border` dark track + dim glyph
 *     (keeps a "dry" look)
 *   - autoOn → whole bar degrades to a uniform dark track, waterline stops, all labels dim
 *   - keeps design-22's border 4-phase flow (8000 ms)
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
/** Auto dot cross-fade. */
const AUTO_DOT_DURATION_MS = 200;
/** One left/right sweep of the boundary waterline (alternate ping-pong single pass). */
const EDGE_FLOW_MS = 2400;
/** Waterline sway amplitude (half-width relative to segLen, ± 0.2 segments). */
const EDGE_SWAY = 0.9;
/** Upper bound of the waterline crest's mix toward accent. */
const EDGE_MIX = 1;

// ── Color utils (same palette mix as design-5/16/22) ──────────────────
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

/** Triangular window: centre c, half-width hw → [0,1] strength (0 outside hw). */
function triangleWindow(i: number, c: number, hw: number): number {
  if (hw <= 0) return 0;
  const d = Math.abs(i - c);
  if (d >= hw) return 0;
  return 1 - d / hw;
}

/** Border flow: phase p ∈ [0, 4], RGB lerp between adjacent phases. */
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
function FlowEdgeRender(props: ThinkingDesignProps): ReactNode {
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

  const edgeFirst = useTimeline({
    duration: EDGE_FLOW_MS,
    loop: true,
  });
  const edgeRef = useRef<Timeline | null>(null);
  if (edgeRef.current === null) edgeRef.current = edgeFirst;
  const tlEdge = edgeRef.current;

  // ── Ambient state (setStates each frame) ──
  const [borderPhase, setBorderPhase] = useState(0);
  const [edgePhase, setEdgePhase] = useState(0.5); // waterline phase 0..1..0

  // ── Entry + Auto refs (timeline mutates directly; force setState re-renders) ──
  const entryRef = useRef<{ marginTop: number; opacity: number }>({
    marginTop: -2,
    opacity: 0,
  });
  const autoMixRef = useRef<{ mix: number }>({ mix: autoOn ? 1 : 0 });
  const [, force] = useState(0);

  // Border flow phase: 8s linear loop (onComplete zeroes the target to dodge the reset trap)
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

  // Ambient: waterline phase 0→1→0 (alternate ping-pong), drives the small left/right boundary flow
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

  /** Waterline crest column: rightmost column of the current segment ± a slow 0.2*segLen sway. */
  const edgeCenter =
    currentIndex * segLen + segLen - 1 + (edgePhase - 0.5) * segLen * EDGE_SWAY;

  /** Char i's visual color: stable gray fill + soft boundary waterline glow. */
  function colorAt(i: number): { bg: string; fg: string } {
    if (autoOn) return { bg: pal.border, fg: pal.dim };
    const segIdx = Math.min(SEG_COUNT - 1, Math.floor(i / segLen));
    if (segIdx > currentIndex) {
      // Unfilled dark track (waterline stays in-bounds, keeps the "dry" look)
      return { bg: pal.border, fg: pal.dim };
    }
    // Filled segment: 3-stop purple gradient base (keeps the purple feel synced with design-22/23/24)
    const filledEnd = (currentIndex + 1) * segLen;
    const base = gradAt(i / Math.max(1, filledEnd));
    // Boundary waterline: triangular window of half-width segLen; closer to the edge, more it transitions toward logoGold
    const glowEdge = triangleWindow(i, edgeCenter, segLen);
    const crest = mixHex(pal.logoInk, pal.logoGold, glowEdge * EDGE_MIX);
    const bg = mixHex(base, crest, glowEdge); // at the centre, directly crest = logoGold
    const fg = mixHex(bg, pal.logoInk, 0.5);
    return { bg, fg };
  }

  // ── Level-label styles: focus cursor ▸◂ (moving) / current brightened (confirmed) / rest dim ──
  const labels = ["low", "medium", "high", "xhigh", "max"] as const;
  function labelFor(i: number): { text: string; fg: string; bold: boolean } {
    const text = labels[i]!;
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

      {/* Bar: stable gray fill + flowing waterline at the current level's edge (spans the inner width) */}
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
export const design25: ThinkingDesign = {
  meta: {
    id: "design-25-flow-edge",
    name: "流光边界",
    tag: "Flow Edge",
    summary: "design-5 框架 + 当前档边界柔和流动水线，从左到右推进",
  },
  render: (p) => FlowEdgeRender(p) as unknown as ReactElement,
};
