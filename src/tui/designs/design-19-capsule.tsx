/** @jsxImportSource @opentui/react */
/**
 * Design 19 — Capsule Neon thinking panel (reverse-video capsule buttons).
 *
 * - Rounded border; pal.running gold focus frame while the picker is open.
 * - The 5 concrete-effort levels render as equal-width 8-column capsules
 *   `[  label  ]` with the label centered in a 6-column inner box; the fixed metric
 *   makes slide alignment between capsules trivial.
 * - Current capsule (brackets included) uses TextAttributes.INVERSE:
 *   fg pal.bgRunning gray-green / bg pal.running↔pal.logoGold gradient
 *   pulse. INVERSE swaps fg↔bg (SGR 7), so the capsule reads as gold text
 *   on gray-green — a pressed metal button. fg owns the (static) capsule
 *   background, bg owns the (pulsing) glyph color, so the glow timeline
 *   animates exactly one prop value.
 * - Level change slides the overlay capsule: an absolutely positioned box
 *   whose translateX tweens old→new x over 200ms inOutQuad. translateX is
 *   only ever written by the mount effect and the timeline — never a JSX
 *   prop, since the reconciler would overwrite the setter with the stale
 *   prop on re-render. The parent row's height comes from the 5 in-flow
 *   texts, so the absolute overlay lands exactly on the button row.
 * - Focus cursor ▲ and current capsule are separate concepts: the
 *   capsule is the stable confirmed state; the cursor is an
 *   accent↔dim pulsing triangle showing the "pending" position while
 *   the picker is open.
 * - Auto toggle: ●/○ dot plus the `[ AUTO ]` capsule itself going
 *   INVERSE (same glow) when on; the 5 level capsules then render
 *   double-dim (pal.dim + DIM attribute).
 * - Animation budget: ≤ 2 ambient — capsule glow (1400ms alternate
 *   inOutSine) and cursor pulse (700ms alternate inOutSine). The two are
 *   mutually exclusive by autoOn (whichever capsule holds the glow).
 *
 * Colors come 100% from tuiPalette; the renderer degrades hex by terminal
 * capability — no hand-written ANSI.
 */
import { useEffect, useRef, useState } from "react";
import type { ReactElement, ReactNode } from "react";
import {
  TextAttributes,
  type BoxRenderable,
  type Timeline,
} from "@opentui/core";
import { useTimeline } from "@opentui/react";
import { tuiPalette } from "../theme.js";
import { type ThinkingDesign, type ThinkingDesignProps } from "./_contract.js";

// ── Constants ─────────────────────────────────────────────────────────
/** Slide duration on level change (inOutQuad). */
const SLIDE_MS = 200;
/** Capsule glow half-cycle (alternate ping-pong = 2 × half). */
const GLOW_MS = 1400;
/** Focus cursor color pulse half-cycle. */
const CURSOR_MS = 700;
/** Panel entry fade duration. */
const ENTRY_MS = 280;

/** Capsule width including brackets. */
const BUTTON_W = 8;
/** Gap between capsules. */
const GAP = 2;
/** One step = capsule width + gap. */
const STEP = BUTTON_W + GAP;

/** 5 Chinese level labels + display width (terminal columns). */
const LEVEL_LABELS: ReadonlyArray<{ label: string; width: number }> = [
  { label: "低", width: 2 },
  { label: "中", width: 2 },
  { label: "高", width: 2 },
  { label: "超高", width: 4 },
  { label: "最大", width: 4 },
];

/** AUTO label centered in a 4-column capsule. */
const AUTO_LABEL = "AUTO";
const AUTO_WIDTH = 4;

/** Column offset of the ▲ cursor inside the capsule row (aimed at the 8-wide capsule center). */
const LEVEL_CURSOR_X = (i: number): number => i * STEP + 4;
/** AUTO capsule center column (dot(1) + gap(1) + center of `[ AUTO ]` ≈ 6). */
const AUTO_CURSOR_X = 6;

// ── Text utils ────────────────────────────────────────────────────────
/**
 * Center `label` inside the 6-column inner box and return the full 8-column
 * capsule `[<inner>]`. All capsule strings share one width, so slide
 * alignment between neighbors is exact to a single column.
 */
function capsuleText(label: string, width: number): string {
  const inner = 6;
  const padTotal = inner - width;
  const padLeft = Math.max(0, Math.floor(padTotal / 2));
  const padRight = Math.max(0, padTotal - padLeft);
  return "[" + " ".repeat(padLeft) + label + " ".repeat(padRight) + "]";
}

const AUTO_CAPSULE = capsuleText(AUTO_LABEL, AUTO_WIDTH);

// ── Color utils ───────────────────────────────────────────────────────
/** `#rrggbb` → [r, g, b]∈[0,1]³. */
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

/** Linear mix of two colors at t∈[0,1] → `#rrggbb`; used by glow / cursor pulses. */
function mixHex(a: string, b: string, t: number): string {
  const [ar, ag, ab] = hexToRgb(a);
  const [br, bg, bb] = hexToRgb(b);
  const k = Math.max(0, Math.min(1, t));
  const r = Math.round((ar + (br - ar) * k) * 255);
  const g = Math.round((ag + (bg - ag) * k) * 255);
  const bl = Math.round((ab + (bb - ab) * k) * 255);
  return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${bl.toString(16).padStart(2, "0")}`;
}

// ── Rendering component ───────────────────────────────────────────────
function CapsuleDesign(props: ThinkingDesignProps): ReactNode {
  const pal = tuiPalette;
  const { model } = props;
  const autoOn = model.autoOn;
  const currentIndex = model.currentIndex;
  const focusIndex = model.focusIndex;
  const open = model.open;

  // refs — see header: translateX/opacity are written only by mount/timeline, never JSX props.
  const panelRef = useRef<BoxRenderable | null>(null);
  const capsuleRef = useRef<BoxRenderable | null>(null);

  // Three useTimeline instances: keep the first-render injected Timelines
  // (later renders' fresh instances are never registered with the engine;
  // autoplay fires from useTimeline's internal first-render effect).
  const glowTimeline = useTimeline({
    duration: GLOW_MS * 2, // one alternate ping-pong round = 2 × half-cycle
    loop: true,
    autoplay: true,
  });
  const cursorTimeline = useTimeline({
    duration: CURSOR_MS * 2,
    loop: true,
    autoplay: true,
  });
  const slideTimeline = useTimeline({
    duration: SLIDE_MS,
    autoplay: false,
  });
  const tlRefs = useRef<{
    glow: Timeline;
    cursor: Timeline;
    slide: Timeline;
  }>({
    glow: glowTimeline,
    cursor: cursorTimeline,
    slide: slideTimeline,
  });
  const tl = tlRefs.current;

  // State driven by timeline onUpdate callbacks.
  const [capsuleFg, setCapsuleFg] = useState<string>(pal.running);
  const [cursorColor, setCursorColor] = useState<string>(pal.accent);

  const glowRef = useRef<{ p: number }>({ p: 0 });
  const cursorRef = useRef<{ p: number }>({ p: 0 });

  // mount-only: register the ambient/one-shot animations + initialize capsule translateX.
  useEffect(() => {
    const panel = panelRef.current;

    // 1) Capsule glow: alternate pulse driving capsuleFg (renderable cell bg).
    tl.glow.add(glowRef.current, {
      duration: GLOW_MS,
      ease: "inOutSine",
      loop: true,
      alternate: true,
      onUpdate: (anim) => {
        const v = anim.targets[0]?.p ?? 0;
        setCapsuleFg(mixHex(pal.running, pal.logoGold, v));
      },
    });

    // 2) Focus cursor color pulse: accent ↔ dim.
    tl.cursor.add(cursorRef.current, {
      duration: CURSOR_MS,
      ease: "inOutSine",
      loop: true,
      alternate: true,
      onUpdate: (anim) => {
        const v = anim.targets[0]?.p ?? 0;
        setCursorColor(mixHex(pal.accent, pal.dim, v));
      },
    });

    // 3) Panel entry fade: opacity 0 → 1 (the panel's JSX opacity prop stays 0;
    //    the timeline writes the renderable directly, so the reconciler skips it).
    if (panel) {
      tl.glow.add(panel, {
        opacity: 1,
        duration: ENTRY_MS,
        ease: "inOutSine",
        once: true,
      });
    }

    // 4) Initialize the capsule translateX.
    const capsule = capsuleRef.current;
    if (capsule) {
      capsule.translateX = currentIndex * STEP;
    }

    // Cleanup is handled uniformly by useTimeline's internal unmount effect (pause + unregister).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Slide on level change: currentIndex change → reset slide timeline + tween to the new translateX.
  const prevIndexRef = useRef<number>(currentIndex);
  useEffect(() => {
    const capsule = capsuleRef.current;
    if (!capsule) return;
    if (prevIndexRef.current === currentIndex) return;
    prevIndexRef.current = currentIndex;
    tl.slide.resetItems();
    tl.slide.add(capsule, {
      translateX: currentIndex * STEP,
      duration: SLIDE_MS,
      ease: "inOutQuad",
    });
    tl.slide.play();
  }, [currentIndex, tl]);

  // autoOn toggle: the overlay remounts, so reset translateX + pause slide.
  useEffect(() => {
    if (autoOn) {
      tl.slide.pause();
      tl.slide.resetItems();
      return;
    }
    const capsule = capsuleRef.current;
    if (capsule) {
      capsule.translateX = currentIndex * STEP;
    }
    tl.slide.pause();
    tl.slide.resetItems();
  }, [autoOn, currentIndex, tl]);

  // Derived
  const borderColor = open ? pal.running : pal.border;
  const descText = autoOn ? "adaptive" : "concrete effort";
  const hintText = autoOn
    ? "[Tab/Space] 切 Auto · [Enter] 确认 · [Esc] 取消"
    : "[←/→] 切档 · [Tab/Space] 切 Auto · [Enter] 确认 · [Esc] 取消";

  // Cursor x: focusIndex === -1 points at the AUTO capsule (when picker open);
  // >= 0 points at the matching level capsule's center.
  const cursorX =
    focusIndex === -1 ? AUTO_CURSOR_X : LEVEL_CURSOR_X(focusIndex);
  const cursorVisible = open;

  // Inverse capsule string for the current level (this overlay is not rendered when autoOn, so never read).
  const curLabel = LEVEL_LABELS[currentIndex] ?? LEVEL_LABELS[1]!;
  const curCapsuleText = capsuleText(curLabel.label, curLabel.width);

  return (
    <box
      ref={panelRef}
      flexDirection="column"
      borderStyle="rounded"
      borderColor={borderColor}
      paddingX={1}
      paddingY={0}
      opacity={0}
    >
      {/* Title */}
      <text>
        <span fg={pal.running} attributes={TextAttributes.BOLD}>
          {"◈ THINKING"}
        </span>
        <span fg={pal.dim}>{"  │  CAPSULE PICKER"}</span>
      </text>

      {/* Auto row: dot + AUTO capsule + description */}
      <box flexDirection="row" marginTop={0}>
        <text wrapMode="none">
          <span
            fg={autoOn ? pal.running : pal.dim}
            attributes={autoOn ? TextAttributes.BOLD : TextAttributes.NONE}
          >
            {autoOn ? "●" : "○"}
          </span>
          <span>{"  "}</span>
          {autoOn ? (
            <span
              fg={pal.bgRunning}
              bg={capsuleFg}
              attributes={TextAttributes.INVERSE | TextAttributes.BOLD}
            >
              {AUTO_CAPSULE}
            </span>
          ) : (
            <span fg={pal.text}>{AUTO_CAPSULE}</span>
          )}
          <span fg={pal.dim}>{`  ${descText}`}</span>
        </text>
      </box>

      {/* 5-capsule row + inverse capsule overlay (when !autoOn) */}
      <box
        width="100%"
        flexDirection="row"
        gap={GAP}
        alignItems="flex-start"
        marginTop={0}
      >
        {LEVEL_LABELS.map((item) => {
          const disabled = autoOn;
          return (
            <text key={item.label} wrapMode="none">
              <span
                fg={disabled ? pal.dim : pal.text}
                attributes={disabled ? TextAttributes.DIM : TextAttributes.NONE}
              >
                {capsuleText(item.label, item.width)}
              </span>
            </text>
          );
        })}
        {!autoOn && (
          <box ref={capsuleRef} position="absolute" left={0} top={0}>
            <text wrapMode="none">
              <span
                fg={pal.bgRunning}
                bg={capsuleFg}
                attributes={TextAttributes.INVERSE | TextAttributes.BOLD}
              >
                {curCapsuleText}
              </span>
            </text>
          </box>
        )}
      </box>

      {/* Focus cursor ▲ (cursor ≠ current: they are independent concepts) */}
      {cursorVisible && (
        <box marginTop={0}>
          <text wrapMode="none">
            <span fg={cursorColor} attributes={TextAttributes.BOLD}>
              {" ".repeat(cursorX) + "▲"}
            </span>
          </text>
        </box>
      )}

      {/* Key hints */}
      <box marginTop={0}>
        <text fg={pal.dim}>{hintText}</text>
      </box>
    </box>
  );
}

// ── Export ────────────────────────────────────────────────────────────
export const design19: ThinkingDesign = {
  meta: {
    id: "design-19-capsule",
    name: "反白胶囊风",
    tag: "Capsule Neon",
    summary:
      "等宽 5 档 [低] [中] [高] [超高] [最大] 胶囊 · 当前档整胶囊 INVERSE + 金↔粉金光晕脉冲 · 200ms inOutQuad translateX 滑入新档 · 焦点游标 ▲ 与当前档独立。",
  },
  render: (props: ThinkingDesignProps): ReactElement =>
    (<CapsuleDesign {...props} />) as ReactElement,
};
