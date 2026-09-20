/** @jsxImportSource @opentui/react */
/**
 * Design 18 — Rising Waterfall thinking panel.
 *
 * - Visual anchor: a bottom row of 8 step glyphs `▁▂▃▄▅▆▇█` acting as a
 *   water level. The current level's column is the wave peak; neighbors
 *   fall off triangularly, and the whole staircase "rises" from low to
 *   high on each change (tide coming in).
 * - The rise: on level/Auto changes a single waveClock 0→1 linear
 *   timeline drives all 8 columns' local progress
 *   (localT = waveClock * RISE_TOTAL/RISE_MS − i * STAGGER_MS/RISE_MS);
 *   per-block easing + glyph mapping render it as a left-to-right
 *   column-by-column surge whose color fades gray→gold.
 * - Border breathing (ambient 1): borderColor alternates
 *   pal.border ↔ pal.running over 2600ms inOutSine — a water-surface shimmer.
 * - Auto dot breathing (ambient 2, only when Auto on): ● pulses
 *   pal.running ↔ pal.logoGold at 1200ms; when Auto is off the dot is a
 *   static `○ dim`, freeing the ambient slot.
 * - Entry (one-shot): outer box slides in, marginTop -3 → 0, 360ms outQuad.
 * - Auto on drains the water level to 0 (low tide); otherwise the peak
 *   follows focusIndex while the picker is open, else currentIndex.
 * - Focus cursor `▸` (pal.accent BOLD) prefixes the focused level name,
 *   independent from the current level (gold BOLD name).
 *
 * Colors come 100% from tuiPalette; the renderer degrades hex by terminal
 * capability — no hand-written ANSI.
 *
 * useTimeline trap: each render news a Timeline but only the first is
 * registered by the hook's mount effect. This design pins the first
 * instances via lazy useRef so .add()/.play()/.pause() always hit the
 * stable refs (pattern from design-2 / design-5).
 */
import { useEffect, useRef, useState } from "react";
import type { ReactElement, ReactNode } from "react";
import { TextAttributes, type Timeline as TimelineT } from "@opentui/core";
import { useTimeline } from "@opentui/react";
import { tuiPalette } from "../theme.js";
import {
  EFFORT_LEVELS,
  type ThinkingDesign,
  type ThinkingDesignProps,
} from "./_contract.js";

// ── Constants ─────────────────────────────────────────────────────────
/** Water-step glyphs (8 levels U+2581–2588, low to high). */
const BLOCKS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"] as const;
const BLOCKS_LEN = BLOCKS.length;

/** Number of wave columns = BLOCKS_LEN (one cell each). */
const WAVE_BLOCKS = BLOCKS_LEN;

/** Time for one column to rise from 0 to its target height. */
const RISE_MS = 260;
/** Per-column stagger delay (wave sweeps left → right). */
const STAGGER_MS = 32;
/** Total staircase duration = RISE_MS + (WAVE_BLOCKS-1) * STAGGER_MS. */
const RISE_TOTAL_MS = RISE_MS + (WAVE_BLOCKS - 1) * STAGGER_MS;

/** Border breathing cycle (alternate ping-pong = 2 × item duration). */
const BORDER_BREATH_MS = 2600;
/** Auto dot breathing cycle. */
const DOT_BREATH_MS = 1200;
/** Panel entry slide duration. */
const ENTRY_MS = 360;

/** Per-column target height falloff (peak at peakCol, linear decline to both sides). */
const PEAK_FALLOFF = 2.6;

/** Current level → center column of the 8-column space (linear map). */
function levelCenter(levelIdx: number): number {
  const t = levelIdx / (EFFORT_LEVELS.length - 1);
  return t * (WAVE_BLOCKS - 1);
}

/** A column's target height (0..1); null peak (Auto on) means drained to 0. */
function targetHeightOf(blockIdx: number, peakCol: number | null): number {
  if (peakCol === null) return 0;
  const d = Math.abs(blockIdx - peakCol);
  return Math.max(0, 1 - d / PEAK_FALLOFF);
}

/** outQuad ([0,1] → [0,1]), the per-block local easing for glyph mapping. */
function easeOutQuad(t: number): number {
  const k = Math.max(0, Math.min(1, t));
  return 1 - (1 - k) * (1 - k);
}

// ── Color utils ───────────────────────────────────────────────────────
/** `#rrggbb` → {r,g,b}∈[0,255]; falls back to white on bad input (same convention as design-2). */
function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex);
  if (!m) return { r: 255, g: 255, b: 255 };
  const v = parseInt(m[1] as string, 16);
  return { r: (v >> 16) & 0xff, g: (v >> 8) & 0xff, b: v & 0xff };
}

/** Linear RGB mix of two colors at t∈[0,1] → `#rrggbb`; used by border breathing and water tinting. */
function mixHex(a: string, b: string, t: number): string {
  const k = Math.max(0, Math.min(1, t));
  const pa = hexToRgb(a);
  const pb = hexToRgb(b);
  const r = Math.round(pa.r + (pb.r - pa.r) * k);
  const g = Math.round(pa.g + (pb.g - pa.g) * k);
  const bl = Math.round(pa.b + (pb.b - pa.b) * k);
  const to2 = (n: number): string =>
    Math.max(0, Math.min(255, n)).toString(16).padStart(2, "0");
  return `#${to2(r)}${to2(g)}${to2(bl)}`;
}

// ── Rendering component ───────────────────────────────────────────────
function RisingWaterfall(props: ThinkingDesignProps): ReactNode {
  const pal = tuiPalette;
  const { model, cols } = props;
  const { autoOn, currentIndex, focusIndex, open } = model;

  // ── Timeline refs (useTimeline swaps instances per render → useRef locks the first ones)
  const entryTimeline = useTimeline({ duration: ENTRY_MS, autoplay: true });
  const borderTimeline = useTimeline({
    duration: BORDER_BREATH_MS * 2,
    loop: true,
    autoplay: true,
  });
  const dotTimeline = useTimeline({
    duration: DOT_BREATH_MS * 2,
    loop: true,
    autoplay: true,
  });
  // Water timeline: autoplay:false (no items at mount, nothing to pre-play);
  // the level-change effect adds an item and calls play() manually.
  const waveTimeline = useTimeline({
    duration: RISE_TOTAL_MS,
    autoplay: false,
  });
  const tlRefs = useRef<{
    entry: TimelineT;
    border: TimelineT;
    dot: TimelineT;
    wave: TimelineT;
  }>({
    entry: entryTimeline,
    border: borderTimeline,
    dot: dotTimeline,
    wave: waveTimeline,
  });
  const tl = tlRefs.current;

  // ── Entry: marginTop -3 → 0, 360ms outQuad.
  const entryTargetRef = useRef<{ y: number }>({ y: -3 });
  const [entryY, setEntryY] = useState<number>(-3);

  // ── Border breathing (ambient 1): borderColor = mix(border, running, t).
  const borderTargetRef = useRef<{ p: number }>({ p: 0 });
  const [borderColor, setBorderColor] = useState<string>(pal.border);

  // ── Auto dot breathing (ambient 2, active only when autoOn): color = mix(running, logoGold, t).
  const dotTargetRef = useRef<{ p: number }>({ p: 0 });
  const [dotColor, setDotColor] = useState<string>(pal.running);

  // ── Water clock (0..1): one target object drives the whole staircase.
  const waveClockRef = useRef<{ waveClock: number }>({ waveClock: 1 });
  const [waveClock, setWaveClock] = useState<number>(1);
  // Don't animate on first render (avoids stacking with entry).
  const isFirstWaveRef = useRef<boolean>(true);

  // ── Derived: effective peak (no peak when autoOn; focusIndex while picker open, else currentIndex)
  const effectivePeak =
    autoOn || focusIndex < 0 || focusIndex >= EFFORT_LEVELS.length
      ? null
      : focusIndex;
  const effectivePeakCol =
    effectivePeak === null ? null : levelCenter(effectivePeak);

  // ── mount-only: attach animation items + dot gating.
  useEffect(() => {
    // Entry: once=true; the timeline plays immediately after add (autoplay:true).
    tl.entry.add(entryTargetRef.current, {
      y: 0,
      duration: ENTRY_MS,
      ease: "outQuad",
      once: true,
      onUpdate: (a) => setEntryY(Math.round(a.targets[0]?.y ?? 0)),
    });
    // Border breathing: item-level loop + alternate (simplified version of
    // design-3's INFINITE_MS pattern).
    tl.border.add(borderTargetRef.current, {
      p: 1,
      duration: BORDER_BREATH_MS,
      ease: "inOutSine",
      loop: true,
      alternate: true,
      onUpdate: (a) => {
        const v = a.targets[0]?.p ?? 0;
        setBorderColor(mixHex(pal.border, pal.running, v));
      },
    });
    // Auto dot breathing: initial gating (autoOn on → keep running; off → pause + fall back to running).
    tl.dot.add(dotTargetRef.current, {
      p: 1,
      duration: DOT_BREATH_MS,
      ease: "inOutSine",
      loop: true,
      alternate: true,
      onUpdate: (a) => {
        const v = a.targets[0]?.p ?? 0;
        setDotColor(mixHex(pal.running, pal.logoGold, v));
      },
    });
    if (!autoOn) {
      tl.dot.pause();
      setDotColor(pal.running);
    }
    // Wave animation may only fire after entry finishes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── autoOn toggle gating: pause/play the dot timeline.
  useEffect(() => {
    if (autoOn) {
      tl.dot.play();
    } else {
      tl.dot.pause();
      setDotColor(pal.running);
    }
  }, [autoOn, tl, pal.running]);

  // ── Level change / autoOn toggle → refill the water.
  useEffect(() => {
    const wt = tl.wave;
    // Reset clock target to 0 (all columns start at lowest glyph / darkest color).
    waveClockRef.current.waveClock = 0;
    // Clear items: the previous wave item (once:true) is usually already
    // spliced by the engine, but wipe manually to be safe.
    wt.items.length = 0;
    wt.currentTime = 0;
    wt.isComplete = false;
    if (isFirstWaveRef.current) {
      // First render skips the animation (it would stack with entry); fill the level instantly.
      isFirstWaveRef.current = false;
      waveClockRef.current.waveClock = 1;
      setWaveClock(1);
      return;
    }
    wt.add(waveClockRef.current, {
      waveClock: 1,
      duration: RISE_TOTAL_MS,
      ease: "linear",
      once: true,
      onUpdate: (a) => {
        const v = a.targets[0]?.waveClock ?? 0;
        setWaveClock(v);
      },
    });
    wt.play();
  }, [effectivePeak, tl]);

  // ── Per-render computation of the 8 columns' glyphs and colors ──
  // waveClock 0..1 → per-column localT = waveClock*ratio − i*staggerFrac (clamped [0,1])
  const ratio = RISE_TOTAL_MS / RISE_MS;
  const staggerFrac = STAGGER_MS / RISE_MS;
  const waveCells: { glyph: string; color: string }[] = [];
  for (let i = 0; i < WAVE_BLOCKS; i++) {
    const localT = Math.max(
      0,
      Math.min(1, waveClock * ratio - i * staggerFrac)
    );
    const eased = easeOutQuad(localT);
    const charIdx = Math.min(
      BLOCKS_LEN - 1,
      Math.round(eased * (BLOCKS_LEN - 1))
    );
    const targetH = targetHeightOf(i, effectivePeakCol);
    // Color: animation progress × target height → dim↔running mix (dark→gold as water rises).
    const colorMix = eased * targetH;
    const fg = mixHex(pal.dim, pal.running, colorMix);
    waveCells.push({ glyph: BLOCKS[charIdx] ?? "▁", color: fg });
  }

  // ── Derived: label row (focus cursor + current highlight + 5 level names) ──
  const labelCells = EFFORT_LEVELS.map((level, i) => {
    const isCurrent = i === currentIndex;
    const isFocused = open && !autoOn && i === focusIndex;
    return { level, isCurrent, isFocused };
  });

  // ── Key hint row ──
  const hintText = autoOn
    ? "[Tab/Space] 切 Auto · [Enter] 确认 · [Esc] 取消"
    : "[←/→] 切档 · [Tab/Space] 切 Auto · [Enter] 确认 · [Esc] 取消";

  return (
    <box
      flexDirection="column"
      borderStyle="double"
      borderColor={borderColor}
      paddingX={1}
      paddingY={0}
      marginTop={entryY}
      width={Math.max(1, cols)}
    >
      {/* Title row: ≋ Thinking (logoGold gradient prefix + running) */}
      <text>
        <span fg={pal.logoGold} attributes={TextAttributes.BOLD}>
          {"≋ "}
        </span>
        <span fg={pal.running} attributes={TextAttributes.BOLD}>
          Thinking
        </span>
      </text>

      {/* Auto row: ●/○ + AUTO + state label */}
      <text>
        <span
          fg={autoOn ? dotColor : pal.dim}
          attributes={autoOn ? TextAttributes.BOLD : TextAttributes.NONE}
        >
          {autoOn ? "●" : "○"}
        </span>
        <span
          fg={autoOn ? pal.running : pal.dim}
          attributes={autoOn ? TextAttributes.BOLD : TextAttributes.NONE}
        >
          {`  AUTO  ·  ${autoOn ? "自适应档位" : "手动档位"}`}
        </span>
      </text>

      {/* Level-name row: focus ▸ cursor + current gold highlight */}
      <text wrapMode="none">
        {labelCells.map(({ level, isCurrent, isFocused }, i) => {
          const fg = isCurrent ? pal.running : isFocused ? pal.accent : pal.dim;
          const attr =
            isCurrent || isFocused ? TextAttributes.BOLD : TextAttributes.NONE;
          return (
            <span key={`lbl-${i}`} fg={fg} attributes={attr}>
              {isFocused ? "▸ " : "  "}
              {level}
              {i < labelCells.length - 1 ? "   " : ""}
            </span>
          );
        })}
      </text>

      {/* Water staircase, 8 columns: one glyph each, color fades dim→running */}
      <text wrapMode="none">
        {waveCells.map((cell, i) => (
          <span key={`wave-${i}`} fg={cell.color}>
            {cell.glyph}
          </span>
        ))}
      </text>

      {/* Key hint row */}
      <text fg={pal.dim}>{hintText}</text>
    </box>
  );
}

// ── Export ────────────────────────────────────────────────────────────
export const design18: ThinkingDesign = {
  meta: {
    id: "design-18-rising",
    name: "阶梯涨潮风",
    tag: "Rising Waterfall",
    summary:
      "double 边框呼吸 + 8 格水位阶梯随切档涨起 + Auto 圆点呼吸 + outQuad 滑落入场。",
  },
  render: (props: ThinkingDesignProps): ReactElement =>
    (<RisingWaterfall {...props} />) as ReactElement,
};
