/** @jsxImportSource @opentui/react */
/**
 * Design 14 — Scan Neon thinking panel.
 *
 * - Double border whose whole borderColor pulses 1500ms alternate
 *   inOutSine between pal.running and pal.logoGold (breathing).
 * - Independent top scanline: 24 `─` segments; a timeline drives the lit
 *   position 0→23 in a linear loop (120ms per step ≈ 2.88s full sweep).
 *   Lit segment is pal.running BOLD, rest pal.dim DIM — a constant
 *   horizontal sweep just under the title.
 * - Title `▓▒░ THINKING ░▒▓` in pal.running BOLD with an UNDERLINE rule.
 * - Auto dot ●/○: when on, ● gets terminal-native BLINK (SGR 5) plus a
 *   timeline-driven fg pulse between running/logoGold, so terminals
 *   without BLINK still see motion; when off, ○ is static pal.dim.
 * - 5-level bar `▁▂▃▄▅` + Chinese level names; current char is
 *   UNDERLINE + BOLD + pal.running.
 * - On level change the current char flashes red→running over 250ms
 *   outQuad (flashMix 1→0).
 * - While Auto is on, all bars/labels drop to pal.dim and the current
 *   pointer ▶ is hidden (the user handed control to Auto).
 * - Current pointer ▶ and focus cursor ▸ are deliberately separate
 *   elements: stable state vs. user interaction position.
 *
 * Colors: 100% existing tuiPalette tokens, no new constants.
 * Animation budget: ≤ 2 ambient (border pulse + scan sweep); Auto on
 * adds 1 (dot pulse), still ≤ 3. Flash is a one-shot timeline.
 *
 * useTimeline note: the hook only registers the first-render Timeline
 * with the engine; later renders return fresh instances that are never
 * processed. This component captures the first instances in a ref and
 * calls .add()/.pause()/.play()/.resetItems() only on those.
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
/** Rising-density bars for the 5 levels. */
const FIVE_BARS = ["▁", "▂", "▃", "▄", "▅"] as const;
/** Chinese level names (product requirement). */
const LEVEL_NAMES_CN = ["低", "中", "高", "超高", "最大"] as const;

/** Scanline row width (24 `─` segments). */
const SCAN_POSITIONS = 24;
const SCAN_SWEEP_MS = 120; // dwell per segment
const SCAN_CYCLE_MS = SCAN_SWEEP_MS * SCAN_POSITIONS; // ≈ 2.88s full sweep

/** Border pulse half-cycle (alternate → full cycle = 2×). */
const BORDER_PULSE_MS = 1500;

/** Auto-dot fg pulse half-cycle (mounted only when Auto is on). */
const DOT_PULSE_MS = 700;

/** Level-change flash decay duration. */
const FLASH_MS = 250;

// ── Color utils ───────────────────────────────────────────────────────
/** `#rrggbb` → [r, g, b]∈[0,1]³ for `mixHex`. */
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

/** Linear mix of two colors at t∈[0,1] → `#rrggbb`. */
function mixHex(a: string, b: string, t: number): string {
  const [ar, ag, ab] = hexToRgb(a);
  const [br, bg, bb] = hexToRgb(b);
  const r = Math.round((ar + (br - ar) * t) * 255);
  const g = Math.round((ag + (bg - ag) * t) * 255);
  const bl = Math.round((ab + (bb - ab) * t) * 255);
  return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${bl.toString(16).padStart(2, "0")}`;
}

/** Shared ramp for border pulse + dot pulse (pal.running ↔ pal.logoGold). */
const mixRunningGold = (t: number): string =>
  mixHex(tuiPalette.running, tuiPalette.logoGold, t);

// ── Rendering component ───────────────────────────────────────────────
function Design14Scan(props: ThinkingDesignProps): ReactNode {
  const pal = tuiPalette;
  const { model } = props;
  const autoOn = model.autoOn;
  const currentIndex = model.currentIndex;
  const focusIndex = model.focusIndex;
  const focused = model.open;
  const levels = EFFORT_LEVELS as readonly EffortLevel[];

  // ── Border breathing (ambient) ────────────────────────────────────
  const [borderColor, setBorderColor] = useState<string>(pal.running);
  const borderTargetRef = useRef<{ p: 0 }>({ p: 0 });

  // ── Scanline band position (ambient) ──────────────────────────────
  const [scanPos, setScanPos] = useState<number>(0);
  const scanTargetRef = useRef<{ p: 0 }>({ p: 0 });

  // ── Auto-dot fg pulse (mounted when Auto is on) ───────────────────
  const [dotColor, setDotColor] = useState<string>(pal.running);
  const dotTargetRef = useRef<{ p: 0 }>({ p: 0 });

  // ── Level-change flash (triggered) ────────────────────────────────
  const [flashMix, setFlashMix] = useState<number>(0); // 0=settled, 1=full flash
  const flashTargetRef = useRef<{ p: number }>({ p: 0 });

  // ── Timeline refs (lock first-render instances, dodge hook ref drift) ─
  const borderTimeline = useTimeline({
    duration: BORDER_PULSE_MS * 2, // alternate ping-pong = 2× item duration
    loop: true,
    autoplay: true,
  });
  const scanTimeline = useTimeline({
    duration: SCAN_CYCLE_MS,
    loop: true,
    autoplay: true,
  });
  const dotTimeline = useTimeline({
    duration: DOT_PULSE_MS * 2,
    loop: true,
    autoplay: true,
  });
  const flashTimeline = useTimeline({
    duration: FLASH_MS,
    autoplay: false,
  });
  const tlRefs = useRef<{
    border: Timeline;
    scan: Timeline;
    dot: Timeline;
    flash: Timeline;
  }>({
    border: borderTimeline,
    scan: scanTimeline,
    dot: dotTimeline,
    flash: flashTimeline,
  });
  const tl = tlRefs.current;

  // ── Mount-only effect: attach animation items once (no remount) ───
  useEffect(() => {
    // Border pulse (alternate ping-pong, interpolating running/logoGold).
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

    // Scan band: target.p ramps 0→1 linearly; each frame quantizes the
    // progress into 0..SCAN_POSITIONS-1 → setScanPos(). onComplete zeroes
    // p manually to dodge the timeline.loop=true resetItems trap (same
    // pattern as design-5).
    tl.scan.add(scanTargetRef.current, {
      duration: SCAN_CYCLE_MS,
      ease: "linear",
      onComplete: () => {
        scanTargetRef.current.p = 0;
      },
      onUpdate: (anim) => {
        const v = anim.targets[0]?.p ?? 0;
        const next = Math.floor(v * SCAN_POSITIONS) % SCAN_POSITIONS;
        setScanPos((prev) => (prev === next ? prev : next));
      },
    });

    // Auto-dot fg pulse (alternate ping-pong): running ↔ logoGold.
    // Active only when Auto is on.
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

    // Initial gating: start the dot pulse only when Auto is on; pause off.
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

  // ── Level-change flash: when currentIndex changes, snap flashMix to 1
  //  then decay to 0 over 250ms outQuad (color slides pal.error → pal.running).
  const prevIndexRef = useRef<number>(currentIndex);
  useEffect(() => {
    if (prevIndexRef.current === currentIndex) return;
    prevIndexRef.current = currentIndex;
    flashTargetRef.current.p = 1;
    setFlashMix(1);
    tl.flash.resetItems();
    tl.flash.add(flashTargetRef.current, {
      p: 0,
      duration: FLASH_MS,
      ease: "outQuad",
      onUpdate: (anim) => {
        const v = Math.round((anim.targets[0]?.p ?? 0) * 16) / 16;
        setFlashMix(v);
      },
    });
    tl.flash.play();
  }, [currentIndex, tl]);

  // ── Current bar / level-name char attributes ──────────────────────
  const currentAttr = ((): number => {
    if (autoOn) return TextAttributes.BOLD; // disabled state: BOLD + dim
    return TextAttributes.BOLD | TextAttributes.UNDERLINE;
  })();

  // Current bar color: interpolates pal.error → pal.running during the
  // flash; drops to pal.dim (disabled look) when Auto is on.
  const currentBarColor = autoOn
    ? pal.dim
    : mixHex(pal.running, pal.error, flashMix);

  // ── Scanline row rendering ────────────────────────────────────────
  const renderScanline = (): ReactNode[] => {
    const chars: ReactNode[] = [];
    for (let i = 0; i < SCAN_POSITIONS; i++) {
      const lit = i === scanPos;
      chars.push(
        <span
          key={`scan-${i}`}
          fg={lit ? pal.running : pal.dim}
          attributes={lit ? TextAttributes.BOLD : TextAttributes.DIM}
        >
          {"─"}
        </span>
      );
    }
    return chars;
  };

  // ── Current-pointer ▶ sits directly under the current bar (when Auto
  //  off). Bar chars are width 1 with 1-space gap → offset before index i = i*2.
  const renderCurrentPointer = (): ReactNode | null => {
    if (autoOn) return null;
    const safeIndex = Math.max(0, Math.min(levels.length - 1, currentIndex));
    const leftPad = " ".repeat(safeIndex * 2);
    const trail = " ".repeat(Math.max(0, (levels.length - 1 - safeIndex) * 2));
    return (
      <text>
        <span fg={pal.running} attributes={TextAttributes.BOLD}>
          {`${leftPad}▶${trail}`}
        </span>
      </text>
    );
  };

  // ── Focus cursor ▸ before the focusIndex level name (only when picker
  //  open and autoOn=false). Level name width = 1 (single CJK char), gap =
  //  2 spaces, so offset before index i = i * 3. ──
  const renderFocusCursor = (): ReactNode | null => {
    if (!focused || autoOn) return null;
    const safeIndex = Math.max(0, Math.min(levels.length - 1, focusIndex));
    const leftPad = " ".repeat(safeIndex * 3);
    const totalWidth = levels.length * 3 - 2; // 5×3 - 2 = 13 chars (no trailing gap)
    const trail = " ".repeat(Math.max(0, totalWidth - safeIndex * 3 - 1));
    return (
      <text>
        <span fg={pal.text} attributes={TextAttributes.BOLD}>
          {`${leftPad}▸${trail}`}
        </span>
      </text>
    );
  };

  // ── Level bar glyph ───────────────────────────────────────────────
  const barOf = (i: number): string => FIVE_BARS[i] ?? "▅";

  // ── Level name (CN/EN pairing shown elsewhere) ────────────────────
  const nameOf = (i: number): string =>
    LEVEL_NAMES_CN[i] ?? EFFORT_LEVELS[i] ?? "";

  // ── Key hints ─────────────────────────────────────────────────────
  const hint = autoOn
    ? "[Tab/Space] 切 Auto · [Enter] 确认 · [Esc] 取消"
    : "[←/→] 切档 · [Tab/Space] 切 Auto · [Enter] 确认 · [Esc] 取消";

  // ── Title decoration ──────────────────────────────────────────────
  const titlePrefix = "▓▒░ THINKING ░▒▓";

  return (
    <box
      flexDirection="column"
      borderStyle="double"
      borderColor={borderColor}
      paddingX={1}
      paddingY={0}
    >
      {/* Title row: block-char wrapping + full-width UNDERLINE rule */}
      <text>
        <span fg={pal.running} attributes={TextAttributes.BOLD}>
          {titlePrefix}
        </span>
        <span fg={pal.running} attributes={TextAttributes.UNDERLINE}>
          {"  "}
        </span>
      </text>

      {/* Scanline row (24 `─` segments, ambient lit-position loop) */}
      <text>{renderScanline()}</text>

      {/* Auto row: ●/○ (on → BLINK + fg pulse, off → ○ dim) */}
      <text>
        {autoOn ? (
          <>
            <span fg={dotColor} attributes={TextAttributes.BLINK}>
              {"●"}
            </span>
            <span fg={pal.text}>{"  AUTO  · "}</span>
            <span fg={pal.running}>{"adaptive"}</span>
            <span fg={pal.dim}>{"（跟随 env/provider 默认）"}</span>
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

      {/* 5-level bars (rising) + current UNDERLINE + change flash */}
      <text>
        {levels.map((level, i) => {
          const isCurrent = i === currentIndex;
          const color = autoOn
            ? pal.dim
            : isCurrent
              ? currentBarColor
              : pal.dim;
          const attr = isCurrent ? currentAttr : TextAttributes.BOLD;
          return (
            <span key={`bar-${level}`} fg={color} attributes={attr}>
              {`${barOf(i)}${i < levels.length - 1 ? " " : ""}`}
            </span>
          );
        })}
      </text>

      {/* Current-pointer ▶ (when Auto off) */}
      {renderCurrentPointer()}

      {/* Level names (Chinese) — current UNDERLINE + BOLD + running */}
      <text>
        {levels.map((level, i) => {
          const isCurrent = i === currentIndex;
          const color = autoOn ? pal.dim : isCurrent ? pal.running : pal.dim;
          const attr = isCurrent ? currentAttr : TextAttributes.NONE;
          return (
            <span key={`lbl-${level}`} fg={color} attributes={attr}>
              {`${nameOf(i)}${i < levels.length - 1 ? "  " : ""}`}
            </span>
          );
        })}
      </text>

      {/* Focus cursor ▸ (only when picker open and autoOn=false, white) */}
      {renderFocusCursor()}

      {/* Key hints */}
      <text fg={pal.dim}>{hint}</text>
    </box>
  );
}

// ── Export ────────────────────────────────────────────────────────────
export const design14: ThinkingDesign = {
  meta: {
    id: "design-14-scan",
    name: "扫描线霓虹",
    tag: "Scan Neon",
    summary:
      "double 双线呼吸边框 + 顶部扫描线光带位置循环 + Auto 圆点 BLINK + 当前档 UNDERLINE + 切档 flash 红闪 + 焦点游标与当前档指针独立分离。",
  },
  render: ({ model, cols }) =>
    (<Design14Scan model={model} cols={cols} />) as ReactElement,
};
