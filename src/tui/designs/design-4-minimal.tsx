/** @jsxImportSource @opentui/react */
/**
 * Design 4 — minimal flat (one accent colour, no ornament).
 *
 * Visual discipline:
 *  - Nearly no decoration: monochrome `pal.text` (body) + `pal.running`
 *    (focus gold) + `pal.dim` (secondary).
 *  - No block chars / dots / `[]` ornaments: plain level names with a `>`
 *    prefix.
 *  - Auto row uses text states `[auto]` / `[manual]`, no dot.
 *  - One horizontal line at top and bottom (box
 *    `border = ["top","bottom"]`, `borderStyle="single"`).
 *  - Generous whitespace: paddingX=2, flex gap=1 between rows.
 *
 * Animation (only one family):
 *  - Panel-wide fade-in: opacity 0 → 1, 200ms, ease "inOutQuad".
 *  - Horizontal slide of the current-level `>` on switch: translateX from
 *    old offset → new, 150ms, ease "outQuad".
 *
 * How the translateX wiring works:
 *  - `useRef<TextRenderable>(null)` grabs the `>` `<text>` Renderable
 *    (OpenTUI `<text ref>` uses the same reconciler path as
 *    `<scrollbox ref>` — see the sbRef pattern in chat-view.tsx).
 *  - `useTimeline` news up a fresh Timeline every render but only
 *    registers the first one with the engine in its mount effect. That is
 *    fine for one-shot mount-time animations, but here the `>` slide must
 *    `timeline.add(...)` on every currentIndex change — an unregistered
 *    fresh instance is never advanced by `engine.update` and the
 *    animation fails silently. So both slide/fade Timelines are lazy-
 *    created in `useRef` (instance kept), registered via
 *    `engine.register(timeline)` in a dedicated mount effect, and cleaned
 *    up with `pause()` + `unregister()` on unmount.
 *  - Trigger chain: currentIndex change → `useEffect` →
 *    `slideRef.current.resetItems()` clears old animations →
 *    `slideRef.current.add(indicatorRef.current, { translateX: newX,
 *    duration: 150, ease: "outQuad" })` → `play()`. The scheduler calls
 *    `engine.update(deltaTime)` → `timeline.update` → writes the target's
 *    `translateX` setter (OpenTUI Renderable supports set translateX)
 *    until `currentTime >= duration` fires `onComplete`.
 *  - Fade-in uses the other Timeline: at mount `add(panelRef.current,
 *    { opacity: 1, duration: 200, ease: "inOutQuad" })`; the initial
 *    `opacity={0}` comes from the container prop.
 *  - translateX formula: `levelOffset(i)` accumulates preceding level
 *    name widths + GAP, so `>` lands exactly 1 cell before the current
 *    name (at rest `>` is at x=0 with 1 leading space and levels starting
 *    at x=2, hence `>` target = levelOffset(i) ↔ `> medium` with one
 *    space between).
 *
 * Border approach: box `border={["top","bottom"]}` +
 * `borderStyle="single"` + `borderColor={pal.border}`. Left/right draw
 * nothing (OpenTUI BoxRenderable supports `border: BorderSides[]`).
 */
import { useEffect, useRef } from "react";
import type { ReactElement, ReactNode } from "react";
import {
  BoxRenderable,
  TextAttributes,
  TextRenderable,
  Timeline,
  engine,
} from "@opentui/core";
import { tuiPalette } from "../theme.js";
import { EFFORT_LEVELS } from "./_contract.js";
import type {
  PickerModel,
  ThinkingDesign,
  ThinkingDesignProps,
} from "./_contract.js";

/** 3 spaces between level names (matches the rendered "low   medium..." layout). */
const GAP = "   ";

/** Render color of the current-level `>` prefix (no `>` when autoOn; falls back to a 1-cell dim placeholder). */
function indicatorColor(model: PickerModel): string {
  return model.autoOn ? tuiPalette.dim : tuiPalette.running;
}

/** Cumulative horizontal offset between level names (which column the `>` should land on). */
function levelOffset(index: number): number {
  let x = 0;
  for (let k = 0; k < index && k < EFFORT_LEVELS.length; k++) {
    x += (EFFORT_LEVELS[k] ?? "").length + GAP.length;
  }
  return x;
}

function Panel(props: ThinkingDesignProps): ReactNode {
  const { model } = props;

  // Two independent timelines: fade-in is one-shot, slide resets and
  // replays on every currentIndex change. useRef lazy-creation keeps the
  // same instance, avoiding useTimeline's per-render new-instance trap.
  const fadeTimelineRef = useRef<Timeline | null>(null);
  const slideTimelineRef = useRef<Timeline | null>(null);

  if (fadeTimelineRef.current === null) {
    fadeTimelineRef.current = new Timeline({ autoplay: false });
  }
  if (slideTimelineRef.current === null) {
    slideTimelineRef.current = new Timeline({ autoplay: false });
  }

  // Register both timelines with the engine at mount; unregister on unmount.
  useEffect(() => {
    const fade = fadeTimelineRef.current;
    const slide = slideTimelineRef.current;
    if (fade) engine.register(fade);
    if (slide) engine.register(slide);
    return () => {
      if (slide) {
        slide.pause();
        engine.unregister(slide);
      }
      if (fade) {
        fade.pause();
        engine.unregister(fade);
      }
    };
  }, []);

  const panelRef = useRef<BoxRenderable | null>(null);
  const indicatorRef = useRef<TextRenderable | null>(null);

  // Entry fade-in: push one opacity 0 → 1 at mount.
  useEffect(() => {
    if (!panelRef.current || !fadeTimelineRef.current) return;
    const fade = fadeTimelineRef.current;
    fade.resetItems();
    fade.add(panelRef.current, {
      opacity: 1,
      duration: 200,
      ease: "inOutQuad",
    });
    fade.play();
  }, [fadeTimelineRef]);

  // `>` horizontal slide on level switch (`>` binds to currentIndex; focusIndex uses BOLD).
  useEffect(() => {
    if (!indicatorRef.current || !slideTimelineRef.current) return;
    const slide = slideTimelineRef.current;
    slide.resetItems();
    slide.add(indicatorRef.current, {
      translateX: levelOffset(model.currentIndex),
      duration: 150,
      ease: "outQuad",
    });
    slide.play();
  }, [model.currentIndex, slideTimelineRef]);

  const autoLabel = model.autoOn ? "[auto]" : "[manual]";
  const hint = "tab toggle auto · arrows change · enter confirm · esc cancel";

  return (
    <box
      ref={panelRef}
      width="100%"
      flexDirection="column"
      paddingX={2}
      gap={1}
      border={["top", "bottom"]}
      borderStyle="single"
      borderColor={tuiPalette.border}
      opacity={0}
    >
      <text attributes={TextAttributes.BOLD} fg={tuiPalette.text}>
        Thinking
      </text>

      <text>
        <span fg={tuiPalette.dim}>Auto </span>
        <span fg={model.autoOn ? tuiPalette.running : tuiPalette.text}>
          {autoLabel}
        </span>
      </text>

      <box width="100%" flexDirection="row">
        <text ref={indicatorRef} fg={indicatorColor(model)}>
          {model.autoOn ? " " : ">"}
        </text>
        <text fg={tuiPalette.text}> </text>
        {EFFORT_LEVELS.map((level, i) => (
          <text
            key={level}
            fg={i === model.focusIndex ? tuiPalette.running : tuiPalette.text}
            attributes={
              i === model.focusIndex ? TextAttributes.BOLD : TextAttributes.NONE
            }
          >
            {level}
            {i < EFFORT_LEVELS.length - 1 ? GAP : ""}
          </text>
        ))}
      </box>

      <text fg={tuiPalette.dim}>{hint}</text>
    </box>
  );
}

/** Re-export a stable ReactElement wrapper so the render field matches the
 *  contract's `ReactElement` return type (OpenTUI JSX namespace declares
 *  Element = ReactNode, so a plain JSX expression is ReactNode, not ReactElement). */
export const design4: ThinkingDesign = {
  meta: {
    id: "design-4-minimal",
    name: "极简扁平风",
    tag: "Minimal Flat",
    summary: "无装饰、单色、留白大，仅 1 个动效：当前档指示横向滑移。",
  },
  render: (props) => (<Panel {...props} />) as ReactElement,
};
