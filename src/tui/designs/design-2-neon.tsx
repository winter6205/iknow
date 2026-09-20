/** @jsxImportSource @opentui/react */
/**
 * Thinking-effort panel — Design 2: Cyber Neon (NEON-GRID).
 *
 * One of the visual candidates in the demo gallery. Each design is pure
 * rendering on top of `_contract.ts`'s `PickerModel`; this file only adds
 * styles and animation, touching no production module.
 *
 * Visual style elements:
 *  1. heavy border (`BorderStyle="heavy"`).
 *  2. Border color breathes: `pal.running` ↔ `pal.logoGold`, 2000ms
 *     alternate, ease "inOutSine".
 *  3. Entry: box `marginTop` -2 → 0, 400ms ease "outBack" spring-back;
 *     entry animation runs once at mount (one-shot onComplete cleanup).
 *  4. Title row `⚡ THINKING` (`pal.running` BOLD) + scanline decoration
 *     `═══ · ═══ · ═══` (`pal.logoGold`).
 *  5. 5-level color ramp: low=pal.add / medium=pal.accent /
 *     high=pal.running / xhigh=pal.logoGold / max=pal.error. The level
 *     visualization bar uses 5 height-ascending `▁▂▃▄▅▆▇█` chars (evenly
 *     sampled from 8 steps). When focused (picker open = `model.open`),
 *     all uniformly switch to `pal.running` BOLD.
 *  6. Current-level underline pulse: `BOLD|UNDERLINE` ↔ `BOLD`, 800ms
 *     alternate, ease "inOutSine". When Auto is on, this slot is yielded
 *     to the Auto dot breathing.
 *  7. Auto dot `●` breathes `pal.running` ↔ `pal.logoGold`, 1000ms
 *     alternate, ease "inOutSine" (only when Auto on).
 *  8. Current-level pointer `▲` (U+25B2) directly below the current level
 *     char (only when Auto off).
 *  9. Key hints: [←/→] switch level · [Tab/Space] toggle Auto ·
 *     [Enter] confirm · [Esc] cancel (`[←/→]` omitted when Auto on).
 *
 * Persistent animation budget: base ≤ 2 (border breathing + current-level
 * underline pulse). When Auto is on it switches to "border breathing +
 * Auto dot breathing" — still exactly 2 slots. Entry is one-shot. The
 * level-switch flash uses plain React state + setTimeout (no timeline, not
 * counted as "persistent").
 *
 * Period non-resonance check:
 *   border 2000ms / underline 800ms / dot 1000ms.
 *   LCM(2000, 800, 1000) = 4000ms; mod 4000ms the phases never align at
 *   extremes at once, avoiding additive visual flicker. Each timeline
 *   duration is 2× item duration (one alternate ping-pong round = 2 ×
 *   item duration), so `loop=true`'s resetItems lands exactly at the
 *   start — no visible jump.
 *
 * Color discipline: every color comes 100% from `tuiPalette` (theme.ts),
 * no new color constants; the OpenTUI renderer degrades hex strings by
 * terminal capability, the app layer never writes ANSI.
 *
 * `useTimeline` caveat (@opentui/react 0.5.1): the hook's mount effect
 * runs only on the first render and registers that Timeline with the
 * engine; later renders return brand-new Timelines the engine ignores. So
 * this component captures the first-render instance in `useRef` and calls
 * all `.add()` / `.pause()` / `.play()` on the stable ref to avoid hook
 * reference drift.
 */
import { useEffect, useRef, useState } from "react";
import type { ReactElement, ReactNode } from "react";
import { useTimeline } from "@opentui/react";
import { TextAttributes, type Timeline } from "@opentui/core";
import { tuiPalette } from "../theme.js";
import {
  EFFORT_LEVELS,
  type EffortLevel,
  type PickerModel,
  type ThinkingDesign,
} from "./_contract.js";

// ── constants ─────────────────────────────────────────────────────────
const FIVE_BARS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"] as const;
const FIVE_BARS_HEIGHT = FIVE_BARS.length; // 8

/** 5-level color ramp (existing `tuiPalette` tokens only; no new colors). */
const COLORS = [
  tuiPalette.add, // low
  tuiPalette.accent, // medium
  tuiPalette.running, // high
  tuiPalette.logoGold, // xhigh
  tuiPalette.error, // max
] as const;

/** Pulse periods in ms — deliberately non-resonant (see header). */
const BORDER_PULSE_MS = 2000;
const UNDERLINE_PULSE_MS = 800;
const DOT_PULSE_MS = 1000;
const ENTRY_MS = 400;

// ── color utils ───────────────────────────────────────────────────────
/** `#rrggbb` → [r, g, b]∈[0,1]³. Used by `mixHex`. */
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

/** Linear mix of two colors over t∈[0,1] → `#rrggbb` string. The border
 *  pulse / dot breathing map a single 0..1 value back to a hex string for
 *  the `borderColor` / `fg` prop. */
function mixHex(a: string, b: string, t: number): string {
  const [ar, ag, ab] = hexToRgb(a);
  const [br, bg, bb] = hexToRgb(b);
  const r = Math.round((ar + (br - ar) * t) * 255);
  const g = Math.round((ag + (bg - ag) * t) * 255);
  const bl = Math.round((ab + (bb - ab) * t) * 255);
  return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${bl.toString(16).padStart(2, "0")}`;
}

/** Shared palette pair for border and dot (pal.running ↔ pal.logoGold) —
 *  one function generating strings with different semantics, no duplicated helpers. */
const mixRunningGold = (t: number): string =>
  mixHex(tuiPalette.running, tuiPalette.logoGold, t);

// ── render component ─────────────────────────────────────────────────
function Design2Neon(props: { readonly model: PickerModel }): ReactNode {
  const pal = tuiPalette;
  const { model } = props;
  const autoOn = model.autoOn;
  const currentIndex = model.currentIndex;
  const focused = model.open; // picker open = focused state
  const levels = EFFORT_LEVELS as readonly EffortLevel[];

  // ── entry animation ──────────────────────────────────────────────
  const [entryShift, setEntryShift] = useState<number>(-2);
  const entryTargetRef = useRef<{ shift: number }>({ shift: -2 });

  // ── border breathing (persistent) ────────────────────────────────
  const [borderColor, setBorderColor] = useState<string>(pal.running);
  const borderTargetRef = useRef<{ p: 0 }>({ p: 0 });

  // ── current-level underline pulse (persistent when Auto off) ─────
  const [underlineOn, setUnderlineOn] = useState<boolean>(false);
  const underlineTargetRef = useRef<{ p: 0 }>({ p: 0 });

  // ── Auto dot breathing (persistent when Auto on) ─────────────────
  const [dotColor, setDotColor] = useState<string>(pal.running);
  const dotTargetRef = useRef<{ p: 0 }>({ p: 0 });

  // ── level-switch flash (lightweight) ─────────────────────────────
  const [flashOn, setFlashOn] = useState<boolean>(false);

  // ── timeline refs ────────────────────────────────────────────────
  // Each useTimeline's internal mount effect only registers the
  // first-render Timeline; later renders return fresh objects the engine
  // never sees. `useRef`'s initializer re-evaluates every render but
  // `.current` keeps the first-render reference, so `.add()` / `.pause()`
  // / `.play()` all hit the engine-owned instances.
  const entryTimeline = useTimeline({
    duration: ENTRY_MS,
    autoplay: true,
  });
  const borderTimeline = useTimeline({
    duration: BORDER_PULSE_MS * 2, // alternate ping-pong = 2× item duration
    loop: true,
    autoplay: true,
  });
  const underlineTimeline = useTimeline({
    duration: UNDERLINE_PULSE_MS * 2,
    loop: true,
    autoplay: true,
  });
  const dotTimeline = useTimeline({
    duration: DOT_PULSE_MS * 2,
    loop: true,
    autoplay: true,
  });
  const tlRefs = useRef<{
    entry: Timeline;
    border: Timeline;
    underline: Timeline;
    dot: Timeline;
  }>({
    entry: entryTimeline,
    border: borderTimeline,
    underline: underlineTimeline,
    dot: dotTimeline,
  });
  const tl = tlRefs.current;

  // ── mount-only effect: attach animation items (once, never re-attached)
  // deps = [tl] (stable first-render ref), guaranteeing this effect runs
  // only at mount, so later renders don't accumulate `.add()` calls on
  // fresh entryTimeline objects.
  useEffect(() => {
    tl.entry.add(entryTargetRef.current, {
      duration: ENTRY_MS,
      ease: "outBack",
      once: true,
      onUpdate: (anim) => {
        const v = anim.targets[0]?.shift ?? 0;
        setEntryShift(Math.round(v * 100) / 100);
      },
      onComplete: () => {
        setEntryShift(0);
      },
    });
    tl.border.add(borderTargetRef.current, {
      duration: BORDER_PULSE_MS,
      ease: "inOutSine",
      loop: true,
      alternate: true,
      onUpdate: (anim) => {
        const v = anim.targets[0]?.p ?? 0;
        setBorderColor(mixRunningGold(v));
      },
    });
    tl.underline.add(underlineTargetRef.current, {
      duration: UNDERLINE_PULSE_MS,
      ease: "inOutSine",
      loop: true,
      alternate: true,
      onUpdate: (anim) => {
        const v = anim.targets[0]?.p ?? 0;
        setUnderlineOn(v > 0.5);
      },
    });
    tl.dot.add(dotTargetRef.current, {
      duration: DOT_PULSE_MS,
      ease: "inOutSine",
      loop: true,
      alternate: true,
      onUpdate: (anim) => {
        const v = anim.targets[0]?.p ?? 0;
        setDotColor(mixRunningGold(v));
      },
    });
    // Initial gating: dot breathing only when Auto on; underline pulse
    // only when Auto off. useTimeline autoplays all timelines, then we
    // immediately pause the unwanted one — keeping the "persistent ≤2"
    // budget.
    if (autoOn) {
      tl.underline.pause();
      setUnderlineOn(false);
    } else {
      tl.dot.pause();
      setDotColor(pal.running);
    }
    // Note: mount-only; cleanup is handled by useTimeline's internal unmount effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tl]);

  // ── autoOn switch gating (keeps animation slot budget ≤2) ─────────
  useEffect(() => {
    if (autoOn) {
      tl.underline.pause();
      setUnderlineOn(false);
      tl.dot.play();
    } else {
      tl.dot.pause();
      setDotColor(pal.running);
      tl.underline.play();
    }
  }, [autoOn, tl, pal.running]);

  // ── switch flash: 150ms color highlight when current level changes ─
  const prevIndexRef = useRef<number>(currentIndex);
  useEffect(() => {
    if (prevIndexRef.current === currentIndex) return;
    prevIndexRef.current = currentIndex;
    setFlashOn(true);
    const t = setTimeout(() => setFlashOn(false), 150);
    return () => clearTimeout(t);
  }, [currentIndex]);

  // ── derived: current-level char attributes ───────────────────────
  const currentAttr = ((): number => {
    let base = TextAttributes.BOLD;
    if (!autoOn && underlineOn) base |= TextAttributes.UNDERLINE;
    return base;
  })();

  // ── scanline decoration ──────────────────────────────────────────
  const scanline = `═══ · ═══ · ═══`;

  // ── key hints ────────────────────────────────────────────────────
  const hintLines = autoOn
    ? `[Tab/Space] 切 Auto · [Enter] 确认 · [Esc] 取消`
    : `[←/→] 切档 · [Tab/Space] 切 Auto · [Enter] 确认 · [Esc] 取消`;

  // ── 5-level bar chars (even 8-step → 5-step mapping) ─────────────
  const barOf = (levelIdx: number): string => {
    const h = Math.min(
      FIVE_BARS_HEIGHT - 1,
      Math.round((levelIdx * (FIVE_BARS_HEIGHT - 1)) / 4)
    );
    return FIVE_BARS[h] ?? "█";
  };

  // ── current-level color (when focused all levels unify to
  //  pal.running; otherwise the 5-level ramp). During the flash the
  //  current level briefly switches to pal.accent for extra feedback.
  const colorOf = (i: number, isCurrent: boolean): string => {
    if (isCurrent && flashOn) return pal.accent;
    if (focused) return pal.running;
    return COLORS[i] ?? pal.dim;
  };

  return (
    <box
      flexDirection="column"
      marginTop={entryShift}
      borderStyle="heavy"
      borderColor={borderColor}
      paddingX={1}
      paddingY={0}
    >
      {/* title row: ⚡ THINKING + scanline */}
      <box flexDirection="row">
        <text>
          <span fg={pal.running} attributes={TextAttributes.BOLD}>
            ⚡
          </span>
          <span fg={pal.running} attributes={TextAttributes.BOLD}>
            {"  THINKING  "}
          </span>
          <span fg={pal.logoGold}>{scanline}</span>
        </text>
      </box>

      {/* Auto row */}
      <box flexDirection="row" marginTop={0}>
        <text>
          {autoOn ? (
            <span fg={dotColor} attributes={TextAttributes.BOLD}>
              ●
            </span>
          ) : (
            <span fg={pal.dim}>○</span>
          )}
          <span>
            {"  AUTO  · adaptive (server picks effort / no concrete effort)"}
          </span>
        </text>
      </box>

      {/* 5-level visualization bar */}
      <box flexDirection="row" marginTop={0}>
        <text>
          {levels.map((level, i) => {
            const isCurrent = i === currentIndex;
            const color = colorOf(i, isCurrent);
            const attr = isCurrent ? currentAttr : TextAttributes.BOLD;
            return (
              <span key={`bar-${level}`} fg={color} attributes={attr}>
                {barOf(i)}
                {i < levels.length - 1 ? " " : ""}
              </span>
            );
          })}
        </text>
      </box>

      {/* level names */}
      <box flexDirection="row" marginTop={0}>
        <text>
          {levels.map((level, i) => {
            const isCurrent = i === currentIndex;
            const color = isCurrent ? pal.running : pal.dim;
            const attr = isCurrent ? currentAttr : TextAttributes.NONE;
            return (
              <span key={`lbl-${level}`} fg={color} attributes={attr}>
                {level}
                {i < levels.length - 1 ? "  " : ""}
              </span>
            );
          })}
        </text>
      </box>

      {/* current-level pointer (Auto off only) */}
      {!autoOn && <CurrentPointer index={currentIndex} count={levels.length} />}

      {/* key hints */}
      <box flexDirection="row" marginTop={0}>
        <text fg={pal.dim}>{hintLines}</text>
      </box>
    </box>
  );
}

// ── current-level pointer (▲ centered under the current level char) ───
/**
 * Bar-row chars are 1 wide with 1-wide separators (single space), so the
 * accumulated offset before index i is i * 2 ASCII columns. The pointer
 * row is (count - 1) * 2 + 1 wide, aligned with the bar row (leading/
 * trailing `▲` sit right under the first/last char).
 */
function CurrentPointer(props: {
  readonly index: number;
  readonly count: number;
}): ReactNode {
  const pal = tuiPalette;
  const { index, count } = props;
  const safeIndex = Math.max(0, Math.min(count - 1, index));
  const leftPad = " ".repeat(safeIndex * 2);
  const trail = " ".repeat(Math.max(0, (count - 1 - safeIndex) * 2));
  return (
    <box flexDirection="row" marginTop={0}>
      <text>
        <span fg={pal.running} attributes={TextAttributes.BOLD}>
          {leftPad}▲{trail}
        </span>
      </text>
    </box>
  );
}

// ── export ───────────────────────────────────────────────────────────
export const design2: ThinkingDesign = {
  meta: {
    id: "design-2-neon",
    name: "动感赛博风",
    tag: "Cyber Neon",
    summary:
      "heavy 边框 + 5档渐变色阶 + 边框呼吸脉冲 + 当前档 underline 脉冲 + outBack 入场。",
  },
  render: ({ model }) => (<Design2Neon model={model} />) as ReactElement,
};
