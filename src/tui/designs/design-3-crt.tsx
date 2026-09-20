/** @jsxImportSource @opentui/react */
/**
 * Thinking panel, variant 3: retro terminal / CRT phosphor (demo gallery
 * candidate).
 *
 * Design highlights:
 *  - Primary `pal.add` (green #2ea043) as phosphor; the current level adds
 *    `pal.bgRunning` / `pal.running` emphasis.
 *  - Single border (thin line, retro terminal feel) in `pal.add`; the
 *    whole panel fg slowly oscillates between `pal.add` ↔ `pal.bgRunning`
 *    (1500ms alternate inOutSine) to simulate CRT noise breathing — done
 *    via timeline + numeric interpolation (`mixHex`), not fg string
 *    stepping.
 *  - Title `[ THINKING ]` in brackets, revealed typewriter-style
 *    left-to-right (60ms/char) through a `useTimeline` + `call` delay
 *    chain; useTimeline auto `pause + unregister` on unmount
 *    (cancel-on-close).
 *  - 5-level `#` density ramp (`#` … `#####`, low → high); the current
 *    level's `#` carries `TextAttributes.INVERSE` to mimic "cursor
 *    selection".
 *  - Auto dot `●` (on) / `○` (off): when on, the char gets
 *    `TextAttributes.BLINK` toggled by an 80ms alternate linear timeline
 *    (on terminals without BLINK support the fg still pulses; on
 *    supporting terminals the native blink rate wins — both paths run in
 *    parallel; see trade-off notes below).
 *  - Entry: outer `box` `marginTop -3 → 0` slide-down, 280ms outQuad, no
 *    bounce.
 *  - Key hint row: `*` separated (terminal style).
 *
 * Trade-off notes (blink vs BLINK attribute):
 *  - "CRT noise" and "Auto dot" are two different effects:
 *      · CRT noise = fg numeric interpolation, timeline-driven → visible
 *        on all terminals, since fg always renders;
 *      · Auto dot = native BLINK attribute + continuous timeline toggle →
 *        BLINK-capable terminals blink natively (most accurate);
 *        terminals with BLINK off (most modern GUI terminals) still get
 *        the 80ms attribute flip — visually degraded to invisible, but fg
 *        stays `pal.add` so readability is unaffected. If a fallback is
 *        ever needed, swap to fg interpolation when BLINK is detected
 *        off; this design keeps the native path for now.
 */
import { useEffect, useState, type ReactElement, type ReactNode } from "react";
import { TextAttributes } from "@opentui/core";
import { useTimeline } from "@opentui/react";
import { tuiPalette } from "../theme.js";
import {
  EFFORT_LEVELS,
  type ThinkingDesign,
  type ThinkingDesignProps,
} from "./_contract.js";

/** Typewriter title (bracketed, monospace terminal feel). */
const CRT_TITLE = "[ THINKING ]";
const TYPE_STEP_MS = 60;

/** 5-level `#` density ramp (low → high), derived from level count so it can't drift from EFFORT_LEVELS. */
const LEVEL_HASHES: ReadonlyArray<string> = EFFORT_LEVELS.map((_, i) =>
  "#".repeat(i + 1)
);

/** Key hint tokens (`*` separated, terminal style). */
const CRT_HINT_TOKENS: ReadonlyArray<string> = [
  " tab/space toggle auto ",
  " arrows change level ",
  " enter confirm ",
  " esc cancel ",
];

/** "Long enough" timeline duration (1h), dodging the `loop: true` resetItems re-capture trap:
 *  - infinite looping lives on the item (`loop: true, alternate: true`);
 *  - the timeline-level duration is large and non-looping, so update
 *    never triggers `resetItems` and item initialValues are never
 *    re-captured (animation value can't get stuck at the loop end state). */
const INFINITE_MS = 3_600_000;

/** Panel entry slide duration (outQuad, no bounce). */
const ENTER_MS = 280;

/** CRT noise one-way duration (alternate → full up-down cycle = 2× this). */
const CRT_FLICKER_MS = 1500;

/** Auto dot BLINK toggle one-way duration (alternate → full blink period = 2× this). */
const DOT_BLINK_MS = 80;

/** 6-digit hex (`#rrggbb`) → integer RGB (alpha ignored). */
function parseHex(hex: string): { r: number; g: number; b: number } {
  const v = parseInt(hex.slice(1), 16);
  return { r: (v >> 16) & 0xff, g: (v >> 8) & 0xff, b: v & 0xff };
}

/** Linear interpolation between two `pal.*` hex colors, t∈[0,1]; always returns a 6-digit `#rrggbb`. */
function mixHex(a: string, b: string, t: number): string {
  const k = Math.max(0, Math.min(1, t));
  const pa = parseHex(a);
  const pb = parseHex(b);
  const r = Math.round(pa.r + (pb.r - pa.r) * k);
  const g = Math.round(pa.g + (pb.g - pa.g) * k);
  const bl = Math.round(pa.b + (pb.b - pa.b) * k);
  const hex = ((r << 16) | (g << 8) | bl).toString(16).padStart(6, "0");
  return `#${hex}`;
}

/**
 * BLINK dot mounted only while Auto is on. When Auto is off the whole
 * component unmounts — React unmount + `useTimeline` effect cleanup gives
 * cancel-on-close: the timeline is auto `pause + engine.unregister`ed, so
 * no driver tick leaks.
 */
function CrtBlinkDot(): ReactNode {
  const pal = tuiPalette;
  const tl = useTimeline({ duration: INFINITE_MS });
  const [blinkOn, setBlinkOn] = useState(false);
  useEffect(() => {
    tl.add(
      { b: 0 },
      {
        b: 1,
        duration: DOT_BLINK_MS,
        ease: "linear",
        alternate: true,
        loop: true,
        onUpdate: (a) => setBlinkOn(a.targets[0].b > 0.5),
      }
    );
  }, []);
  return (
    <span
      fg={pal.add}
      attributes={blinkOn ? TextAttributes.BLINK : TextAttributes.NONE}
    >
      ●
    </span>
  );
}

/** Retro terminal / CRT phosphor main panel. Hooks inside drive entry,
 *  typewriter and CRT noise; assembled and exported by `design3.render`. */
function CrtPanel(props: ThinkingDesignProps): ReactNode {
  const pal = tuiPalette;
  const { model, cols } = props;
  const { autoOn, currentIndex } = model;

  // Entry: marginTop -3 → 0 slide-down, 280ms outQuad.
  const enterTl = useTimeline({ duration: ENTER_MS });
  const [enterY, setEnterY] = useState(-3);
  useEffect(() => {
    enterTl.add(
      { y: -3 },
      {
        y: 0,
        duration: ENTER_MS,
        ease: "outQuad",
        onUpdate: (a) => setEnterY(Math.round(a.targets[0].y)),
      }
    );
  }, []);

  // Typewriter: append one char per TYPE_STEP_MS via timeline call delay chain.
  const typeTl = useTimeline({
    duration: CRT_TITLE.length * TYPE_STEP_MS + 120,
  });
  const [chars, setChars] = useState(0);
  useEffect(() => {
    for (let i = 1; i <= CRT_TITLE.length; i++) {
      typeTl.call(() => setChars(i), i * TYPE_STEP_MS);
    }
  }, []);

  // CRT noise: panel-wide fg oscillates pal.add ↔ pal.bgRunning.
  // Quantized to 1/32 steps to cut per-frame setState re-render frequency.
  const flickerTl = useTimeline({ duration: INFINITE_MS });
  const [flicker, setFlicker] = useState(0);
  useEffect(() => {
    flickerTl.add(
      { t: 0 },
      {
        t: 1,
        duration: CRT_FLICKER_MS,
        ease: "inOutSine",
        alternate: true,
        loop: true,
        onUpdate: (a) => {
          const v = Math.round(a.targets[0].t * 32) / 32;
          setFlicker(v);
        },
      }
    );
  }, []);

  const crtFg = mixHex(pal.add, pal.bgRunning, flicker);

  return (
    <box
      flexDirection="column"
      borderStyle="single"
      borderColor={pal.add}
      paddingX={1}
      marginTop={enterY}
      width={Math.max(1, cols)}
    >
      <text fg={pal.add} attributes={TextAttributes.BOLD}>
        {CRT_TITLE.slice(0, chars)}
      </text>
      <text fg={pal.add}>
        {autoOn ? <CrtBlinkDot /> : <span>○</span>}
        {"  AUTO"}
      </text>
      {LEVEL_HASHES.map((hash, i) => {
        const current = i === currentIndex;
        return (
          <text key={i} fg={current ? pal.add : crtFg}>
            <span
              fg={current ? pal.add : crtFg}
              attributes={
                current ? TextAttributes.INVERSE : TextAttributes.NONE
              }
            >
              {hash}
            </span>
            <span> {EFFORT_LEVELS[i]}</span>
          </text>
        );
      })}
      <text fg={pal.dim}>
        <span fg={pal.add}>*</span>
        {CRT_HINT_TOKENS.map((seg, i) => (
          <span key={i}>
            <span>{seg}</span>
            <span fg={pal.add}>*</span>
          </span>
        ))}
      </text>
    </box>
  );
}

export const design3: ThinkingDesign = {
  meta: {
    id: "design-3-crt",
    name: "复古终端风",
    tag: "Retro CRT",
    summary: "单线边框 + 磷光绿 + 打字机标题 + #密度阶梯 + 字符闪烁模拟 CRT。",
  },
  render: ({ model, cols }) =>
    (<CrtPanel model={model} cols={cols} />) as ReactElement,
};
