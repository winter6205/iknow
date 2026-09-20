/** @jsxImportSource @opentui/react */
/**
 * Design 20 — Ripple Diffuse thinking panel.
 *
 * - Double border whose whole borderColor pulses 2000ms alternate
 *   inOutSine between pal.running and pal.logoGold (ambient 1).
 * - Title `≋ THINKING ≋` (triple-wave glyph wrapper, pal.running BOLD).
 * - Auto dot ●/○: when on, ● breathes 1000ms alternate inOutSine between
 *   running/logoGold (ambient 2, mounted only when Auto on); when off, ○
 *   is static pal.dim.
 * - Level-change ripple: when focusIndex changes (user ←/→ navigation),
 *   three phases `· → ○ → ●` propagate outward from the new level over
 *   ~350ms:
 *      ·  t=0   : whole row `·` (water still, ripple not yet risen)
 *      ·  t=100 : center=○ pal.logoGold (first ring rises at center)
 *      ·  t=200 : center=● pal.running + neighbors=○ pal.logoGold (reaches ring 1)
 *      ·  t=350 : settled — center=● pal.running + neighbors=`·` pal.dim
 *    The phases fire via `useTimeline.call(cb, timePoint)` at 0/100/200ms
 *    + setRipplePhase / setRippleDone at t=350ms — a one-shot, not ambient.
 * - 5-level visualization row: 5 cells (1 char + 1 space each) drawn by
 *   cellRender; with Auto on the whole row degrades to `·` pal.dim.
 * - Current pointer ▼ (under currentIndex when Auto off, pal.running BOLD)
 *   — a stable state indicator, separate from the focus cursor.
 * - Focus cursor ▸ (under focusIndex when picker open + Auto off, pal.text
 *   BOLD) — the user's interaction position; a concept distinct from the
 *   current level.
 * - Level names render in Chinese; the current one is BOLD +
 *   pal.running, the rest pal.dim.
 * - Key hints: Auto on omits `[←/→]`.
 *
 * Colors come 100% from existing tuiPalette tokens, no new constants.
 *
 * Ambient budget ≤ 2:
 *   1: border breathing 2000ms inOutSine alternate loop.
 *   2: Auto dot fg pulse 1000ms inOutSine alternate loop (only when Auto
 *      on; explicitly `tl.dot.pause()` when off).
 *   One-shot (not counted): the ripple call sequence (3 phases + settle).
 *
 * useTimeline trap (@opentui/react 0.5): the hook's mount effect registers
 * only the first-render Timeline with the engine; later renders return
 * fresh instances that update never advances. `useRef(initialValue)`
 * consumes the first-render initial value, so `tlRefs.current` always
 * points at the engine-held stable instance and every
 * `.add()`/`.call()`/`.pause()`/`.play()`/`.resetItems()` lands on it.
 */
import { useEffect, useRef, useState } from "react";
import type { ReactElement, ReactNode } from "react";
import { useTimeline } from "@opentui/react";
import { TextAttributes, type Timeline } from "@opentui/core";
import { tuiPalette } from "../theme.js";
import {
  EFFORT_LEVELS,
  type EffortLevel,
  type ThinkingDesign,
  type ThinkingDesignProps,
} from "./_contract.js";

// ── Constants ─────────────────────────────────────────────────────────

/** 5 Chinese level names (product requirement; values below). */
const LEVEL_NAMES_CN = ["低", "中", "高", "超高", "最大"] as const;

/** Ripple's 3-state glyphs, ordered diffuse-dot → mid-ring → solid. */
const RIPPLE_CHARS = ["·", "○", "●"] as const;

/** Ripple phase 0→1→2 time points (ms). */
const RIPPLE_T0 = 0;
const RIPPLE_T1 = 100;
const RIPPLE_T2 = 200;
const RIPPLE_DONE = 350;

/** Border pulse half-cycle (alternate ping-pong = 2× this). */
const BORDER_PULSE_MS = 2000;

/** Auto dot fg pulse half-cycle (alternate ping-pong = 2× this). */
const DOT_PULSE_MS = 1000;

// ── Color utils ───────────────────────────────────────────────────────

/** `#rrggbb` → [r, g, b]∈[0,1]³ for `mixHex`. */
function hexToRgb(hex: string): readonly [number, number, number] {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex);
  if (!m) return [1, 1, 1];
  const v = parseInt(m[1] as string, 16);
  return [
    ((v >> 16) & 0xff) / 255,
    ((v >> 8) & 0xff) / 255,
    (v & 0xff & 0xff) / 255,
  ] as const;
}

/** Linear mix of two colors at t∈[0,1] → `#rrggbb` string. */
function mixHex(a: string, b: string, t: number): string {
  const [ar, ag, ab] = hexToRgb(a);
  const [br, bg, bb] = hexToRgb(b);
  const k = Math.max(0, Math.min(1, t));
  const r = Math.round((ar + (br - ar) * k) * 255);
  const g = Math.round((ag + (bg - ag) * k) * 255);
  const bl = Math.round((ab + (bb - ab) * k) * 255);
  return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${bl.toString(16).padStart(2, "0")}`;
}

/** Ramp shared by border / dot (pal.running ↔ pal.logoGold). */
const mixRunningGold = (t: number): string =>
  mixHex(tuiPalette.running, tuiPalette.logoGold, t);

// ── Rendering component ───────────────────────────────────────────────

function RipplePanel(props: ThinkingDesignProps): ReactNode {
  const pal = tuiPalette;
  const { model, cols } = props;
  const autoOn = model.autoOn;
  const currentIndex = model.currentIndex;
  const focusIndex = model.focusIndex;
  const focused = model.open;
  const levels = EFFORT_LEVELS as readonly EffortLevel[];

  // ── Ambient state (timeline-driven) ───────────────────────────────
  const [borderColor, setBorderColor] = useState<string>(pal.running);
  const borderTargetRef = useRef<{ p: number }>({ p: 0 });
  const [dotColor, setDotColor] = useState<string>(pal.running);
  const dotTargetRef = useRef<{ p: number }>({ p: 0 });

  // ── Ripple state (call-sequence driven) ───────────────────────────
  // rippleCenter = ripple source = focusIndex after a change;
  // ripplePhase ∈ {0,1,2} = index into the 3 glyphs (·/○/●);
  // rippleDone = ripple settled (steady state: center=●, rest=·).
  const [rippleCenter, setRippleCenter] = useState<number>(currentIndex);
  const [ripplePhase, setRipplePhase] = useState<0 | 1 | 2>(0);
  const [rippleDone, setRippleDone] = useState<boolean>(true);

  // ── Timeline refs (useRef locks the first-render instance, dodging hook drift) ──
  const borderTimeline = useTimeline({
    duration: BORDER_PULSE_MS * 2,
    loop: true,
    autoplay: true,
  });
  const dotTimeline = useTimeline({
    duration: DOT_PULSE_MS * 2,
    loop: true,
    autoplay: true,
  });
  const rippleTimeline = useTimeline({
    duration: RIPPLE_DONE + 20,
  });
  const tlRefs = useRef<{
    border: Timeline;
    dot: Timeline;
    ripple: Timeline;
  }>({
    border: borderTimeline,
    dot: dotTimeline,
    ripple: rippleTimeline,
  });
  const tl = tlRefs.current;

  // ── mount-only effect: attach ambient animations + initial Auto gating ──
  useEffect(() => {
    // Border breathing (alternate ping-pong, interpolating running/logoGold).
    tl.border.add(borderTargetRef.current, {
      p: 1,
      duration: BORDER_PULSE_MS,
      ease: "inOutSine",
      loop: true,
      alternate: true,
      onUpdate: (anim) => {
        const v = anim.targets[0]?.p ?? 0;
        setBorderColor(mixRunningGold(v));
      },
    });
    // Auto dot fg pulse (alternate ping-pong): mounted only when Auto is on.
    tl.dot.add(dotTargetRef.current, {
      p: 1,
      duration: DOT_PULSE_MS,
      ease: "inOutSine",
      loop: true,
      alternate: true,
      onUpdate: (anim) => {
        const v = anim.targets[0]?.p ?? 0;
        setDotColor(mixRunningGold(v));
      },
    });
    if (!autoOn) {
      tl.dot.pause();
      setDotColor(pal.running);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tl]);

  // ── autoOn gating (dot time-slot switch) ──────────────────────────
  useEffect(() => {
    if (autoOn) {
      tl.dot.play();
    } else {
      tl.dot.pause();
      setDotColor(pal.running);
    }
  }, [autoOn, tl, pal.running]);

  // ── Ripple trigger: on focusIndex change (user ←/→ nav), unfold the 3 states ─
  // Skipped when Auto is on (levels disabled) and when focusIndex<0 (cursor
  // is on Auto). resetItems clears any unfinished prior call so they don't
  // pile up; then call(cb, timePoint) flips setRipplePhase(0|1|2) +
  // setRippleDone(true) at 0/100/200/350ms.
  const prevFocusRef = useRef<number>(focusIndex);
  useEffect(() => {
    if (prevFocusRef.current === focusIndex) return;
    prevFocusRef.current = focusIndex;
    if (autoOn || focusIndex < 0) return;

    setRippleCenter(focusIndex);
    setRippleDone(false);

    const localTl = tl.ripple;
    localTl.resetItems();
    localTl.call(() => setRipplePhase(0), RIPPLE_T0);
    localTl.call(() => setRipplePhase(1), RIPPLE_T1);
    localTl.call(() => setRipplePhase(2), RIPPLE_T2);
    localTl.call(() => setRippleDone(true), RIPPLE_DONE);
    localTl.play();
  }, [focusIndex, autoOn, tl]);

  // ── Cell glyph + color derivation (core ripple rules) ─────────────
  // For cell i (0..4):
  //  · Auto on → `·` pal.dim (whole row degrades to static dim).
  //  · rippleDone → center (i === currentIndex) `●` pal.running, others
  //    `·` pal.dim (settled steady state).
  //  · ripple in flight → d = |i - center|; cells ahead of the wavefront
  //    (d > phase) show `·`; otherwise pick chars[phase - d]:
  //      ·  phase 0 (t=0)  : center `·`, neighbors `·`, outer `·`
  //      ·  phase 1 (t=100): center `○` pal.logoGold, neighbors `·`, outer `·`
  //      ·  phase 2 (t=200): center `●` pal.running, neighbors `○` pal.logoGold,
  //                          outer `·` pal.dim
  // Color rule: `●` = pal.running (only the center reaches it at phase 2),
  // `○` = pal.logoGold (ripple mid-state, propagating), `·` = pal.dim.
  const cellRender = (
    i: number
  ): { readonly ch: string; readonly fg: string; readonly attr: number } => {
    if (autoOn) {
      return { ch: "·", fg: pal.dim, attr: TextAttributes.NONE };
    }
    if (rippleDone) {
      if (i === currentIndex) {
        return {
          ch: "●",
          fg: pal.running,
          attr: TextAttributes.BOLD,
        };
      }
      return { ch: "·", fg: pal.dim, attr: TextAttributes.NONE };
    }
    const d = Math.abs(i - rippleCenter);
    if (d > ripplePhase) {
      return { ch: "·", fg: pal.dim, attr: TextAttributes.NONE };
    }
    const idx = Math.max(0, Math.min(2, ripplePhase - d));
    const ch = RIPPLE_CHARS[idx] ?? "·";
    let fg: string;
    let attr: number;
    if (ch === "●") {
      // Only the center (d=0) can advance to ●, so it is always pal.running BOLD
      fg = pal.running;
      attr = TextAttributes.BOLD;
    } else if (ch === "○") {
      fg = pal.logoGold;
      attr = TextAttributes.BOLD;
    } else {
      fg = pal.dim;
      attr = TextAttributes.NONE;
    }
    return { ch, fg, attr };
  };

  const currentSafe = Math.max(0, Math.min(levels.length - 1, currentIndex));
  const focusSafe = Math.max(0, Math.min(levels.length - 1, focusIndex));

  // ── Current-pointer ▼ (directly under the currentIndex cell when Auto off) ──
  // Ripple-row chars are width 1 with a 1-space gap → offset before index i = i*2.
  const renderCurrentPointer = (): ReactNode | null => {
    if (autoOn) return null;
    const left = " ".repeat(currentSafe * 2);
    const trail = " ".repeat(
      Math.max(0, (levels.length - 1 - currentSafe) * 2)
    );
    return (
      <text>
        <span fg={pal.running} attributes={TextAttributes.BOLD}>
          {`${left}▼${trail}`}
        </span>
      </text>
    );
  };

  // ── Focus cursor ▸ (before the focusIndex level name when focused + Auto off) ──
  // Level name (single CJK char) + 2-space gap → offset before index i = i*3.
  const renderFocusCursor = (): ReactNode | null => {
    if (!focused || autoOn) return null;
    const left = " ".repeat(focusSafe * 3);
    const totalWidth = levels.length * 3 - 2; // 5×3 - 2 = 13 chars
    const trail = " ".repeat(Math.max(0, totalWidth - focusSafe * 3 - 1));
    return (
      <text>
        <span fg={pal.text} attributes={TextAttributes.BOLD}>
          {`${left}▸${trail}`}
        </span>
      </text>
    );
  };

  const hint = autoOn
    ? "[Tab/Space] 切 Auto · [Enter] 确认 · [Esc] 取消"
    : "[←/→] 切档 · [Tab/Space] 切 Auto · [Enter] 确认 · [Esc] 取消";

  return (
    <box
      flexDirection="column"
      borderStyle="double"
      borderColor={borderColor}
      paddingX={1}
      paddingY={0}
      width={Math.max(1, cols)}
    >
      {/* Title: ≋ THINKING ≋ (wave-glyph wrapper) */}
      <text>
        <span fg={pal.running} attributes={TextAttributes.BOLD}>
          {"≋ THINKING ≋"}
        </span>
      </text>

      {/* Auto row: ●/○ (on → fg pulse, off → ○ dim) */}
      <text>
        {autoOn ? (
          <>
            <span fg={dotColor} attributes={TextAttributes.BOLD}>
              {"●"}
            </span>
            <span fg={pal.text}>{"  AUTO  · "}</span>
            <span fg={pal.running}>{"adaptive"}</span>
            <span fg={pal.dim}>{"（跟随 env/provider）"}</span>
          </>
        ) : (
          <>
            <span fg={pal.dim}>{"○"}</span>
            <span fg={pal.text}>{"  AUTO  · "}</span>
            <span fg={pal.dim}>{"manual"}</span>
            <span fg={pal.dim}>{"（用户选 concrete 档位）"}</span>
          </>
        )}
      </text>

      {/* Ripple row: 5 cells side by side (each 1 char + 1 space) */}
      <text wrapMode="none">
        {levels.map((level, i) => {
          const { ch, fg, attr } = cellRender(i);
          return (
            <span key={`ripple-${level}`} fg={fg} attributes={attr}>
              {`${ch}${i < levels.length - 1 ? " " : ""}`}
            </span>
          );
        })}
      </text>

      {/* Current-pointer ▼ (when Auto off) */}
      {renderCurrentPointer()}

      {/* Level names (Chinese) — current BOLD + pal.running */}
      <text wrapMode="none">
        {levels.map((level, i) => {
          const isCurrent = i === currentIndex;
          const color = autoOn ? pal.dim : isCurrent ? pal.running : pal.dim;
          const attr = isCurrent ? TextAttributes.BOLD : TextAttributes.NONE;
          return (
            <span key={`lbl-${level}`} fg={color} attributes={attr}>
              {`${LEVEL_NAMES_CN[i] ?? ""}${i < LEVEL_NAMES_CN.length - 1 ? "  " : ""}`}
            </span>
          );
        })}
      </text>

      {/* Focus cursor ▸ (when focused + Auto off) */}
      {renderFocusCursor()}

      {/* Key hints */}
      <text fg={pal.dim}>{hint}</text>
    </box>
  );
}

// ── Export ────────────────────────────────────────────────────────────
export const design20: ThinkingDesign = {
  meta: {
    id: "design-20-ripple",
    name: "涟漪扩散风",
    tag: "Ripple",
    summary:
      "double 双线呼吸边框 + 切档时涟漪从中心向外扩散（`·→○→●` 三相位 350ms）+ Auto 圆点 fg 脉冲 + 当前档指针与焦点游标正交分离。",
  },
  render: ({ model, cols }: ThinkingDesignProps): ReactElement =>
    (<RipplePanel model={model} cols={cols} />) as ReactElement,
};
