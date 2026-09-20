/** @jsxImportSource @opentui/react */
/**
 * Design 16 — BG Gradient Flow thinking panel.
 *
 * Visuals: the 5-level bar is a background gradient (logoInk → running →
 * logoGold, colored per character by position) with an ambient shimmer
 * band sweeping over it (ping-pong), so the gradient reads as flowing
 * liquid. Current level (currentIndex) is shown by an inverted
 * bg={pal.bgRunning} segment plus a breathing ▲ caret below; focus
 * (focusIndex) by `▸ label ◂` wrapping in running BOLD. The two use
 * independent visual channels.
 *
 * Auto dot has two states: on → ● green (pal.add on pal.bgAdd), off →
 * ● red (pal.del on pal.bgDel); toggling tweens the dot color. While
 * Auto is on, the bar desaturates to pal.border, labels dim, ▲ hides,
 * and focus falls back to the Auto dot.
 *
 * Per-character `<span bg={...}>` inside `<text>` is the core trick here:
 * TextNodeOptions supports bg and the reconciler writes it per instance.
 * gradAt(t) is a 3-stop linear RGB gradient (mixHex interpolation);
 * shimmer adds a triangular white window (mixHex(base, pal.accent,
 * glow * 0.6)) over the base gradient per character.
 *
 * Animation budget: 2 ambient (shimmer loop + ▲/focus pulse, both
 * alternate loops driven by onUpdate setState) + triggered one-shots on
 * tlTrigger (level-change flash ~400ms; Auto dot green↔red tween), kept
 * on a separate timeline so budgets never overlap.
 *
 * useTimeline trap: every render news a Timeline but only the
 * first-render instance is registered with the engine; later ones are
 * silently dead. All instances are captured in refs on first render so
 * .add()/.once()/.play() hit the stable refs (see design-5 for the same
 * pattern).
 *
 * Colors come 100% from tuiPalette; hex degrades by terminal capability
 * inside the renderer — no hand-written ANSI at app level.
 */
import { useEffect, useRef, useState } from "react";
import type { ReactElement, ReactNode } from "react";
import { TextAttributes, type Timeline } from "@opentui/core";
import { useTimeline } from "@opentui/react";
import { tuiPalette } from "../theme.js";
import {
  EFFORT_LEVELS,
  type EffortLevel,
  type ThinkingDesign,
  type ThinkingDesignProps,
} from "./_contract.js";

// ── Constants ─────────────────────────────────────────────────────────
/** Full shimmer cycle (one alternate ping-pong round). */
const SHIMMER_MS = 2800;
/** ▲ caret / Auto focus pulse half-cycle. */
const PULSE_MS = 900;
/** Level-change flash rise + fall durations. */
const FLASH_UP_MS = 160;
const FLASH_DOWN_MS = 240;
/** Auto dot toggle tween duration. */
const DOT_TWEEN_MS = 240;

/** Total bar width (5 segments × 5 chars = 25). */
const BAR_LEN = 25;
const SEG_LEN = 5;

/** 5 segment labels, same order as EFFORT_LEVELS in _contract. */
const LEVEL_LABELS: ReadonlyArray<string> = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

// ── Color utils ───────────────────────────────────────────────────────
/** `#rrggbb` → [r, g, b]∈[0,1]³; falls back to white on bad hex. */
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

/** Linear mix of two colors at t∈[0,1] → `#rrggbb`. */
function mixHex(a: string, b: string, t: number): string {
  const [ar, ag, ab] = hexToRgb(a);
  const [br, bg, bb] = hexToRgb(b);
  const k = Math.max(0, Math.min(1, t));
  const r = Math.round((ar + (br - ar) * k) * 255);
  const g = Math.round((ag + (bg - ag) * k) * 255);
  const bl = Math.round((ab + (bb - ab) * k) * 255);
  return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${bl.toString(16).padStart(2, "0")}`;
}

/**
 * 3-stop linear gradient logoInk(0) → running(0.5) → logoGold(1).
 * Source of each bar char's base bg color (segmented by position).
 */
function gradAt(t: number): string {
  const k = Math.max(0, Math.min(1, t));
  if (k <= 0.5) return mixHex(tuiPalette.logoInk, tuiPalette.running, k * 2);
  return mixHex(tuiPalette.running, tuiPalette.logoGold, (k - 0.5) * 2);
}

/**
 * Triangular light window: strongest near center, 0 at ±halfWidth.
 * Shimmer overlays this on top of the base gradient.
 */
function lightGlow(pos: number, center: number, halfWidth: number): number {
  return Math.max(0, 1 - Math.abs(pos - center) / halfWidth);
}

// ── Rendering component ───────────────────────────────────────────────
function BgFlowRender(props: ThinkingDesignProps): ReactNode {
  const pal = tuiPalette;
  const { model } = props;
  const { autoOn, currentIndex, focusIndex, open } = model;
  const levels = EFFORT_LEVELS as readonly EffortLevel[];

  // ── Timeline instance lock: useTimeline news one per render but only
  //  the first-render one is registered. Three timelines: shimmer (ambient
  //  bg flow), pulse (caret/focus breathing), trigger (flash / Auto toggle
  //  one-shots). First-render instances are pinned in refs so every
  //  add/once/play lands on the engine-held stable refs.
  const shimmerFirst = useTimeline({
    duration: SHIMMER_MS * 2,
    loop: true,
  });
  const shimmerRef = useRef<Timeline | null>(null);
  if (shimmerRef.current === null) shimmerRef.current = shimmerFirst;
  const tlShimmer = shimmerRef.current;

  const pulseFirst = useTimeline({
    duration: PULSE_MS * 2,
    loop: true,
  });
  const pulseRef = useRef<Timeline | null>(null);
  if (pulseRef.current === null) pulseRef.current = pulseFirst;
  const tlPulse = pulseRef.current;

  const triggerFirst = useTimeline({
    duration: 1000,
    autoplay: false,
  });
  const triggerRef = useRef<Timeline | null>(null);
  if (triggerRef.current === null) triggerRef.current = triggerFirst;
  const tlTrigger = triggerRef.current;

  // ── Ambient animation state (setState on every onUpdate frame)
  const [phase, setPhase] = useState(0); // shimmer phase 0..1
  const [pulse, setPulse] = useState(0); // pulse 0..1 alternate

  // ── Triggered animation refs (timeline mutates refs directly; force
  //  setState to re-render)
  const flashRef = useRef<{ g: number }>({ g: 0 });
  const dotRef = useRef<{ mix: number }>({ mix: autoOn ? 1 : 0 });
  const [, force] = useState(0);

  // Ambient 1: shimmer phase 0→1→0 alternate loop (seamless, no snap)
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

  // Ambient 2: pulse 0→1→0 alternate (drives ▲ caret breathing; coexists with shimmer)
  useEffect(() => {
    const target = { q: 0 };
    tlPulse.add(target, {
      q: 1,
      duration: PULSE_MS,
      ease: "inOutSine",
      loop: true,
      alternate: true,
      onUpdate: () => setPulse(target.q),
    });
  }, [tlPulse]);

  // Trigger 1: currentIndex change → current segment flash 0→1→0 (~400ms bright pulse)
  const prevIdxRef = useRef<number>(currentIndex);
  useEffect(() => {
    if (prevIdxRef.current === currentIndex) return;
    prevIdxRef.current = currentIndex;
    flashRef.current.g = 0;
    tlTrigger.resetItems();
    tlTrigger.add(flashRef.current, {
      g: 1,
      duration: FLASH_UP_MS,
      ease: "outQuad",
      onUpdate: () => force((x) => x + 1),
    });
    tlTrigger.add(flashRef.current, {
      g: 0,
      duration: FLASH_DOWN_MS,
      ease: "inOutSine",
      onUpdate: () => force((x) => x + 1),
    });
    tlTrigger.play();
  }, [currentIndex, tlTrigger]);

  // Trigger 2: autoOn change → dotMix 0↔1 (green↔red gradient)
  const prevAutoRef = useRef<boolean>(autoOn);
  useEffect(() => {
    if (prevAutoRef.current === autoOn) return;
    prevAutoRef.current = autoOn;
    tlTrigger.resetItems();
    tlTrigger.add(dotRef.current, {
      mix: autoOn ? 1 : 0,
      duration: DOT_TWEEN_MS,
      ease: "inOutSine",
      onUpdate: () => force((x) => x + 1),
    });
    tlTrigger.play();
  }, [autoOn, tlTrigger]);

  // ── Derived: Auto dot color (green↔red mix)
  const dotMix = dotRef.current.mix;
  const dotFg = mixHex(pal.add, pal.del, dotMix);
  const dotBg = mixHex(pal.bgAdd, pal.bgDel, dotMix);
  const dotGlyph = autoOn ? "●" : "○";
  const dotLabel = autoOn
    ? "adaptive (server picks effort)"
    : "concrete effort";

  // ── Derived: per-char bg / fg for the bar
  // shimmer band center (indexed 0..BAR_LEN)
  const lightCenter = phase * (BAR_LEN - 1);
  const flashG = flashRef.current.g;
  const curSegStart = currentIndex * SEG_LEN;

  /**
   * Char i's visual color: past segments (0..currentIndex-1) = gradient +
   * shimmer; current segment = bgRunning inversion + flash overlay; future
   * segments (currentIndex+1..4) = desaturated dim.
   */
  function colorAt(i: number): { bg: string; fg: string } {
    if (autoOn) {
      // Auto on (disabled): fully desaturated
      return { bg: pal.border, fg: pal.dim };
    }
    const segIdx = Math.floor(i / SEG_LEN);
    if (segIdx > currentIndex) {
      // Unfilled future segment
      return { bg: pal.border, fg: pal.dim };
    }
    if (segIdx === currentIndex) {
      // Current segment: bgRunning inversion + flash overlay
      const lit = mixHex(pal.bgRunning, pal.accent, flashG * 0.55);
      const fg = mixHex(pal.bgRunning, pal.running, flashG);
      return { bg: lit, fg };
    }
    // Filled gradient segment: base gradient + shimmer band
    const t = i / Math.max(1, BAR_LEN - 1);
    const base = gradAt(t);
    const glow = lightGlow(i, lightCenter, BAR_LEN * 0.32);
    const lit = mixHex(base, pal.accent, glow * 0.6);
    // fg darkened toward logoInk for the liquid "gradient bg + dark glyph" feel
    const fg = mixHex(lit, pal.logoInk, 0.5);
    return { bg: lit, fg };
  }

  // ── Derived: level-name row (focus ▸ ◂ wrapping + current bg inversion)
  interface LabelSeg {
    readonly text: string;
    readonly fg: string;
    readonly bg: string | undefined;
    readonly bracket: boolean;
    readonly bold: boolean;
  }
  function labelFor(i: number): LabelSeg {
    const text = LEVEL_LABELS[i] ?? "";
    if (autoOn) {
      return { text, fg: pal.dim, bg: undefined, bracket: false, bold: false };
    }
    const isFocused = i === focusIndex && open;
    const isCurrent = i === currentIndex;
    if (isCurrent && isFocused) {
      return {
        text,
        fg: pal.text,
        bg: pal.bgRunning,
        bracket: true,
        bold: true,
      };
    }
    if (isCurrent) {
      return {
        text,
        fg: pal.running,
        bg: pal.bgRunning,
        bracket: false,
        bold: true,
      };
    }
    if (isFocused) {
      return {
        text,
        fg: pal.running,
        bg: undefined,
        bracket: true,
        bold: true,
      };
    }
    return { text, fg: pal.dim, bg: undefined, bracket: false, bold: false };
  }

  // ── Derived: ▲ caret position + breathing color
  const showCaret = !autoOn && open;
  const caretOffset = curSegStart + Math.floor(SEG_LEN / 2);
  const caretFg = mixHex(pal.dim, pal.running, pulse);

  // ── Key hints
  const hint = autoOn
    ? "[Tab/Space] 切 Auto · [Enter] 确认 · [Esc] 取消"
    : "[←/→] 切档 · [Tab/Space] 切 Auto · [Enter] 确认 · [Esc] 取消";

  return (
    <box flexDirection="column" paddingX={1} paddingY={0}>
      {/* Title row */}
      <text>
        <span fg={pal.running} attributes={TextAttributes.BOLD}>
          ◈
        </span>
        <span fg={pal.text} attributes={TextAttributes.BOLD}>
          {"  THINKING  ·  BG FLOW"}
        </span>
        <span fg={pal.dim}>{"  ·  背景渐变流光"}</span>
      </text>

      {/* Auto row: dot (green/red fg+bg token pair) + AUTO + state label */}
      <text>
        <span fg={dotFg} bg={dotBg} attributes={TextAttributes.BOLD}>
          {dotGlyph}
        </span>
        <span
          fg={autoOn ? pal.running : pal.dim}
          attributes={TextAttributes.BOLD}
        >
          {"  AUTO"}
        </span>
        <span fg={pal.dim}>{`  ·  ${dotLabel}`}</span>
      </text>

      {/* Level-name row: focusIndex wrapped by ▸◂ (focus cursor); current bgRunning inversion */}
      <text>
        {levels.map((_lv, i) => {
          const seg = labelFor(i);
          const displayText = seg.bracket ? `▸ ${seg.text} ◂` : seg.text;
          const sep = i < levels.length - 1 ? "  " : "";
          return (
            <span
              key={i}
              fg={seg.fg}
              bg={seg.bg}
              attributes={seg.bold ? TextAttributes.BOLD : TextAttributes.NONE}
            >
              {displayText}
              {sep}
            </span>
          );
        })}
      </text>

      {/* bg gradient flow bar: 5 segments × 5 chars, per-char span + bg tint */}
      <text>
        {Array.from({ length: BAR_LEN }, (_, i) => {
          const { bg, fg } = colorAt(i);
          return (
            <span key={i} bg={bg} fg={fg}>
              █
            </span>
          );
        })}
      </text>

      {/* ▲ current-level caret (independent channel; pulse-driven breathing; shown only when Auto off) */}
      {showCaret && (
        <text>
          <span fg={pal.dim}>{" ".repeat(Math.max(0, caretOffset))}</span>
          <span fg={caretFg} attributes={TextAttributes.BOLD}>
            ▲
          </span>
          <span fg={pal.dim}>
            {" ".repeat(Math.max(0, BAR_LEN - caretOffset - 1))}
          </span>
        </text>
      )}

      {/* Key hints */}
      <text fg={pal.dim}>{hint}</text>
    </box>
  );
}

// ── Export ────────────────────────────────────────────────────────────
export const design16: ThinkingDesign = {
  meta: {
    id: "design-16-bg-flow",
    name: "背景渐变流光",
    tag: "BG Gradient Flow",
    summary:
      "每字符 span bg 染色 + 3-stop 线性渐变 logoInk→running→logoGold + 三角窗 shimmer 光带 ping-pong；当前档 bgRunning 反衬 + ▲ 游标呼吸；焦点游标 ▸◂ 包裹与当前档正交；Auto 圆点绿/红 token pair 切换。",
  },
  render: (props: ThinkingDesignProps): ReactElement =>
    (<BgFlowRender {...props} />) as ReactElement,
};
