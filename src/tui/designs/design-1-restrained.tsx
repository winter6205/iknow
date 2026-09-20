/** @jsxImportSource @opentui/react */
/**
 * Thinking panel, variant 1: Restrained Business (demo gallery candidate).
 *
 * Visual discipline:
 *  - Monochrome accent only: `pal.running` gold + `pal.dim` gray +
 *    `pal.accent` white; no gradient ramps — color transitions go through
 *    opacity blending (Auto dot ● gold ↔ ○ gray).
 *  - Rounded border (`borderStyle="rounded"`, consistent with the whole
 *    TUI): `pal.border` gray when idle, `pal.running` gold when focused
 *    (model.open).
 *  - Restrained motion, 100–250ms, no bounce / spring / looping pulses:
 *      · panel entry fade: opacity 0 → 1, 150ms, ease "inOutQuad";
 *      · gold anchor slide on Enter confirm: translateX from old
 *        currentIndex to new, 200ms, ease "outQuad"; the anchor is a
 *        stable-state indicator, while the focus cursor (`pal.accent`
 *        BOLD) only reflects focusIndex and never slides (orthogonal);
 *      · Auto dot color transition: ● gold ↔ ○ gray, 150ms, ease
 *        "inOutSine".
 *
 * Animation wiring (learned from design-4-minimal's lazy-ref +
 * engine.register model):
 *  - `useTimeline` news up a Timeline on every render but only registers
 *    the first with the engine (@opentui/react useTimeline); later
 *    instances are unregistered and never advanced by engine.update, so
 *    animations fail silently. Hence all three timelines are lazy-created
 *    via `useRef` (same instance kept), registered in the mount effect,
 *    and `pause + unregister`ed on unmount (cancel-on-close).
 *  - Gold anchor: absolute `<box>` + translateX. translateX is **never** a
 *    React prop (the reconciler would overwrite the setter with the stale
 *    value on every re-render); it is driven only by imperative assignment
 *    at mount and the timeline's `add({translateX: target})`.
 *  - Panel fade-in: target = whole panel `BoxRenderable.opacity` (native
 *    Renderable support). The panel `<box>` starts with `opacity={0}` as a
 *    prop; the timeline writes each frame. The reconciler only sets when
 *    old and new props differ (updateProperties diff), so React never
 *    resets opacity mid-fade.
 *  - Auto dot: `<text opacity={dotBlend}>` wraps two `<span>`s: ● gold +
 *    ○ gray; text opacity is React state, the timeline's onUpdate uses
 *    `animation.progress` (already ease-mapped to [0,1]) to `setDotBlend`
 *    → React re-render → blended transition. No mixHex interpolation
 *    needed.
 *
 * Panel structure (7 rows): rounded border (top/bottom rows) + title
 * THINKING + Auto row + level row (5 levels inline + gold anchor
 * `▸ level ◂` absolutely overlaid) + level visualization bar
 * `▁▂▃▄▅▆▇█` (8 cells, current level segment in gold) + key hint row.
 */
import { useEffect, useRef, useState } from "react";
import type { ReactElement, ReactNode } from "react";
import type { KeyEvent } from "@opentui/core";
import { BoxRenderable, TextAttributes, Timeline, engine } from "@opentui/core";
import { tuiPalette } from "../theme.js";
import { EFFORT_LEVELS } from "./_contract.js";
import type {
  PickerEvent,
  PickerModel,
  ThinkingDesign,
  ThinkingDesignProps,
} from "./_contract.js";

/** Panel entry fade duration (inOutQuad). */
const FADE_MS = 150;
/** Gold anchor slide duration on Enter confirm (outQuad). */
const SLIDE_MS = 200;
/** Auto dot on/off color transition duration (inOutSine). */
const DOT_MS = 150;

/** 8-cell ascending unicode blocks (low → high). */
const BLOCKS: ReadonlyArray<string> = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];

/** Level display labels (renders `xhigh` readably as `x-high`). */
const LEVEL_LABELS: ReadonlyArray<string> = EFFORT_LEVELS.map((level) =>
  level === "xhigh" ? "x-high" : level
);

/** Key hint line (dot-separated). */
const HINT: string = "←/→ 档位 · Tab/Space Auto · Enter 确认 · Esc 取消";

/**
 * Gold segment of the current level's visualization bar (4-block sliding
 * window; 5 levels × 4 blocks ≈ 8 cells).
 * from/to are 0-based inclusive, with to clamped to 7 (BLOCKS.length-1).
 */
function goldSegment(currentIndex: number): {
  readonly from: number;
  readonly to: number;
} {
  const clamped = Math.max(0, Math.min(EFFORT_LEVELS.length - 1, currentIndex));
  const from = clamped;
  const to = Math.min(BLOCKS.length - 1, clamped + 3);
  return { from, to };
}

/**
 * Absolute X of the level anchor (relative to level-row content-start).
 * Row structure: `"  " + labels.join("  ") + "  "` (2-cell phantom margins
 * at both ends), so the `▸ name ◂` anchor spans exactly `sep + name + sep`:
 * the 2-cell prefix covers the left sep, `name` the center, the 2-cell
 * suffix the right sep. First/last anchor X = sum_{j<k}(len(j)+2); the 5
 * levels land at 0 / 5 / 13 / 19 / 27 (see LEVEL_LABELS lengths).
 */
function anchorX(currentIndex: number): number {
  const clamped = Math.max(0, Math.min(EFFORT_LEVELS.length - 1, currentIndex));
  let x = 0;
  for (let j = 0; j < clamped; j++) {
    x += (LEVEL_LABELS[j] ?? "").length + 2;
  }
  return x;
}

/** Main panel component: hooks (3 lazy timelines + mount registration) + render. */
function Panel(props: ThinkingDesignProps): ReactNode {
  const pal = tuiPalette;
  const { model, cols } = props;
  const { autoOn, currentIndex, focusIndex, open } = model;

  // refs — see file header: translateX driven only by imperative assignment + timeline.
  const panelRef = useRef<BoxRenderable | null>(null);
  const anchorRef = useRef<BoxRenderable | null>(null);
  const fadeTlRef = useRef<Timeline | null>(null);
  const slideTlRef = useRef<Timeline | null>(null);
  const dotTlRef = useRef<Timeline | null>(null);
  if (fadeTlRef.current === null)
    fadeTlRef.current = new Timeline({ autoplay: false });
  if (slideTlRef.current === null)
    slideTlRef.current = new Timeline({ autoplay: false });
  if (dotTlRef.current === null)
    dotTlRef.current = new Timeline({ autoplay: false });

  // Auto dot blend progress [0,1]: ● on top (opacity = dotOn), ○ below always visible.
  const [dotOn, setDotOn] = useState<number>(autoOn ? 1 : 0);

  // mount/unmount: register three timelines, place initial anchor, kick
  // entry fade; cleanup unregisters everything (cancel-on-close).
  useEffect(() => {
    const fade = fadeTlRef.current;
    const slide = slideTlRef.current;
    const dot = dotTlRef.current;
    if (fade) engine.register(fade);
    if (slide) engine.register(slide);
    if (dot) engine.register(dot);

    if (anchorRef.current) {
      anchorRef.current.translateX = anchorX(model.currentIndex);
    }
    if (panelRef.current && fade) {
      fade.resetItems();
      fade.add(panelRef.current, {
        opacity: 1,
        duration: FADE_MS,
        ease: "inOutQuad",
      });
      fade.play();
    }

    return () => {
      if (fade) {
        fade.pause();
        engine.unregister(fade);
      }
      if (slide) {
        slide.pause();
        engine.unregister(slide);
      }
      if (dot) {
        dot.pause();
        engine.unregister(dot);
      }
    };
    // mount/unmount only; model stays out of deps.
  }, []);

  // Gold anchor slide on Enter confirm: currentIndex change → 200ms outQuad to anchorX.
  // focusIndex untouched (focus cursor is white BOLD, rendered directly by spans below).
  const prevIndexRef = useRef<number>(model.currentIndex);
  useEffect(() => {
    const anchor = anchorRef.current;
    const tl = slideTlRef.current;
    if (!anchor || !tl) return;
    if (prevIndexRef.current === model.currentIndex) return;
    prevIndexRef.current = model.currentIndex;
    tl.resetItems();
    tl.add(anchor, {
      translateX: anchorX(model.currentIndex),
      duration: SLIDE_MS,
      ease: "outQuad",
    });
    tl.play();
  }, [model.currentIndex]);

  // Auto dot color transition: autoOn toggle → 150ms inOutSine, dotOn 0↔1.
  const prevAutoRef = useRef<boolean>(model.autoOn);
  useEffect(() => {
    const tl = dotTlRef.current;
    if (!tl) return;
    if (prevAutoRef.current === model.autoOn) return;
    prevAutoRef.current = model.autoOn;
    tl.resetItems();
    tl.add(
      { t: 0 },
      {
        t: 1,
        duration: DOT_MS,
        ease: "inOutSine",
        onUpdate: (a) => setDotOn(a.targets[0].t),
      }
    );
    tl.play();
  }, [model.autoOn]);

  const seg = goldSegment(currentIndex);
  const showAnchor =
    !autoOn && currentIndex >= 0 && currentIndex < EFFORT_LEVELS.length;
  const focusedNameIsCurrent = showAnchor && focusIndex === currentIndex;
  const borderColor = open ? pal.running : pal.border;
  const curLabel = LEVEL_LABELS[currentIndex] ?? "";

  return (
    <box
      ref={panelRef}
      flexDirection="column"
      borderStyle="rounded"
      borderColor={borderColor}
      paddingX={1}
      opacity={0}
      width={Math.max(1, cols)}
    >
      {/* title row */}
      <text fg={pal.running} attributes={TextAttributes.BOLD}>
        THINKING
      </text>

      {/* Auto row: ●/○ blend + state note */}
      <box flexDirection="row">
        <text>
          <span>{"Auto  "}</span>
        </text>
        <text opacity={autoOn ? dotOn : 1 - dotOn}>
          <span fg={pal.running} attributes={TextAttributes.BOLD}>
            ●
          </span>
          <span fg={pal.dim}>○</span>
        </text>
        <text fg={pal.dim}>
          {autoOn
            ? "  adaptive (server picks / no concrete effort)"
            : "  concrete effort"}
        </text>
      </box>

      {/* level row: 5 levels inline (phantom margins at both ends keep the
         first/last anchor in bounds) + gold anchor absolutely overlaid
         (translateX driven by timeline) */}
      <box width="100%" flexDirection="row">
        <text wrapMode="none">
          {LEVEL_LABELS.map((label, i) => {
            const isFocused = !autoOn && i === focusIndex;
            return (
              <span
                key={i}
                fg={isFocused ? pal.accent : pal.text}
                attributes={
                  isFocused ? TextAttributes.BOLD : TextAttributes.NONE
                }
              >
                {(i === 0 ? "  " : "  ") + label}
              </span>
            );
          })}
          <span>{"  "}</span>
        </text>
      </box>
      {showAnchor && (
        <box width="100%" flexDirection="row">
          <box ref={anchorRef} position="absolute" left={0}>
            <text
              fg={pal.running}
              attributes={TextAttributes.BOLD}
              wrapMode="none"
            >
              <span>{"▸ "}</span>
              <span
                fg={focusedNameIsCurrent ? pal.accent : pal.running}
                attributes={TextAttributes.BOLD}
              >
                {curLabel}
              </span>
              <span>{" ◂"}</span>
            </text>
          </box>
        </box>
      )}

      {/* level visualization bar, 8 cells */}
      <text wrapMode="none">
        {BLOCKS.map((block, i) => {
          const lit = !autoOn && i >= seg.from && i <= seg.to;
          return (
            <span key={i} fg={lit ? pal.running : pal.dim}>
              {block}
            </span>
          );
        })}
      </text>
      {/* key hints (own row, so they don't crowd the level bar in narrow terminals) */}
      <text>
        <span fg={pal.dim}>{HINT}</span>
      </text>
    </box>
  );
}

/** Key routing: this design needs no custom keys (demo defaults cover ←/→/Tab/Space/Enter/Esc). */
function reduceKey(_event: KeyEvent, _model: PickerModel): PickerEvent | null {
  return null;
}

export const design1: ThinkingDesign = {
  meta: {
    id: "design-1-restrained",
    name: "克制商务风",
    tag: "Restrained Business",
    summary:
      "低饱和、单色强调、动效 100–250ms 无弹跳。金锚点稳定，焦点白色游标正交。",
  },
  render: ({ model, cols }) =>
    (<Panel model={model} cols={cols} />) as ReactElement,
  reduceKey,
};
