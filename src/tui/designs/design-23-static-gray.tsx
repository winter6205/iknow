/** @jsxImportSource @opentui/react */
/**
 * src/tui/designs/design-23-static-gray.tsx
 *
 * Thinking panel · Design 23: Static Gray — base-color variant A of
 * design-22 on the design-5 frame.
 *
 * vs design-22: same frame, same 5-equal-segment geometry, same border flow.
 * The only difference is the fill: design-22 sweeps a shimmer band, design-23
 * uses a fully static light-gray gradient with zero fill animation.
 *
 * Frame (identical to design-22):
 *   [rounded border, 4-token flowing color]  ← kept: frame decoration, not fill motion
 *     ◆─ Thinking                ← title
 *     ◑  AUTO · <desc>           ← auto dot + description
 *     ████████████████████       ← static gray bar (no shimmer / no tween)
 *     low    medium    high    xhigh    max
 *     key hints
 *
 * Bar geometry comes from the shared _geometry.ts (identical to design-22, do
 * not modify): 5 strictly equal-width segments so the max segment ends flush
 * right at full fill; labels are centred at segment midpoints via labelPad,
 * so each breakpoint maps to one level at a glance.
 *
 * Fill (the point of this variant — fully static):
 *   - filled segments: dim → text light-gray gradient, no shimmer
 *   - the current segment is additionally lightened toward the accent side so
 *     the picked level stays readable without any motion
 *   - unfilled: pal.border dark track + dim glyphs
 *   - autoOn: the whole bar degrades to a uniform dark track, labels all dim
 *
 * Color discipline: fill colors derive only from pal.dim / pal.text /
 * pal.accent / pal.border via mixHex. User feedback rejected running /
 * bgRunning as base colors (gold / gray-green unsuitable), so running only
 * appears in frame decoration (border flow, title prefix, auto dot, focused
 * label) — that is not base color.
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
/** Border flow 4-phase cycle (same as design-5; frame decoration, the only animation kept). */
const BORDER_CYCLE_MS = 8_000;
/** Entry animation. */
const ENTRY_DURATION_MS = 400;
/** Auto dot cross-fade. */
const AUTO_DOT_DURATION_MS = 200;
/** Lightening strength for the current segment (applied in colorAt). */
/** 3-stop linear gradient logoInk(0) → running(0.5) → logoGold(1), same as design-16. */
function gradAt(t: number): string {
  const k = Math.max(0, Math.min(1, t));
  if (k <= 0.5) return mixHex(tuiPalette.logoInk, tuiPalette.running, k * 2);
  return mixHex(tuiPalette.running, tuiPalette.logoGold, (k - 0.5) * 2);
}

// ── Color utils (palette mix, same as design-5/16) ────────────────────
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

/** Border flow: phase p in [0, 4], RGB lerp between adjacent phases (same as design-5). */
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
function StaticGrayRender(props: ThinkingDesignProps): ReactNode {
  const pal = tuiPalette;
  const { model, cols } = props;
  const { autoOn, currentIndex, focusIndex, open } = model;

  // ── Timeline ref (lock the first-render instance via useRef, same as design-5/16) ──
  const initialTimeline = useTimeline({
    duration: BORDER_CYCLE_MS,
    loop: true,
  });
  const timelineRef = useRef<Timeline | null>(null);
  if (timelineRef.current === null) timelineRef.current = initialTimeline;
  const tl = timelineRef.current;

  // ── Ambient state (border flow setStates each frame; fill has no animation state) ──
  const [borderPhase, setBorderPhase] = useState(0);

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

  // ── Bar geometry (shared _geometry.ts, identical to design-22 — do not modify) ──
  //   border 2 cols + paddingX 2 cols = 4 cols fixed overhead
  const innerCols = Math.max(SEG_COUNT, cols - 4);
  const barLen = floorTo5BarLen(innerCols);
  const segLen = segmentLen(barLen);

  // ── Derived values ──
  const entry = entryRef.current;
  const autoDotGlyph = autoOn ? "◐" : "◑";
  const autoDotColor = mixHex(pal.dim, pal.running, autoMixRef.current.mix);
  const autoDesc = autoOn ? "自适应档位" : "手动档位";

  /** Visual color for char i: static light-gray gradient fill (no shimmer / no tween);
   *  the current segment is additionally lightened so the picked level reads clearly without motion. */
  function colorAt(i: number): { bg: string; fg: string } {
    if (autoOn) return { bg: pal.border, fg: pal.dim };
    const segIdx = Math.min(SEG_COUNT - 1, Math.floor(i / segLen));
    if (segIdx > currentIndex) {
      // unfilled dark track
      return { bg: pal.border, fg: pal.dim };
    }
    // filled: dim → text light-gray gradient (static, no motion)
    const filledEnd = (currentIndex + 1) * segLen;
    const t = i / Math.max(1, filledEnd - 1);
    // static violet-gray gradient: 3-stop logoInk(0) → running(0.5) → logoGold(1), no in-bar motion
    const base = gradAt(t);
    // current segment: lighten 15% overall (static) to mark the active level
    const isCurrent = segIdx === currentIndex;
    const lit = isCurrent ? mixHex(base, pal.text, 0.15) : base;
    const fg = mixHex(lit, pal.logoInk, 0.5);
    return { bg: lit, fg };
  }

  // ── Label styles: focus cursor ▸◂ (moving) / current level lit (confirmed) / others dim ──
  const labels = ["low", "medium", "high", "xhigh", "max"] as const;
  function labelFor(i: number): { text: string; fg: string; bold: boolean } {
    const text = labels[i];
    if (autoOn) return { text, fg: pal.dim, bold: false };
    if (open && i === focusIndex)
      return { text: `▸ ${text} ◂`, fg: pal.running, bold: true };
    if (i === currentIndex) return { text, fg: pal.accent, bold: true };
    return { text, fg: pal.dim, bold: false };
  }

  // ── Label row nodes: labelPad centres each label at its segment midpoint, concatenated to barLen width ──
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

  // ── Key hints (branch on auto state) ──
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
      {/* Title: ◆─ Thinking (same as design-5) */}
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

      {/* Static gray bar: dim→text light gradient fill, no shimmer (spans inner width) */}
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

      {/* Label row: 5 levels each centred at its segment midpoint (breakpoints map to levels) */}
      <text wrapMode="none">{labelNodes}</text>

      {/* Key hints */}
      <text fg={pal.dim}>{hint}</text>
    </box>
  );
}

// ── Export ──────────────────────────────────────────────────────────────
export const design23: ThinkingDesign = {
  meta: {
    id: "design-23-static-gray",
    name: "静态灰阶",
    tag: "Static Gray",
    summary: "design-5 框架 + 完全静态的浅灰渐变填充，无动效底色",
  },
  render: (p) => StaticGrayRender(p) as unknown as ReactElement,
};
