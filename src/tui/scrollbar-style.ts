/**
 * Look-and-feel policy for OpenTUI `<scrollbox>` vertical scrollbars: barely
 * visible at rest, only colored on pointer hover.
 *
 * Background: the scrollbar is fully OpenTUI-built (the app layer only
 * overrides colors via `verticalScrollbarOptions`). The default thumb
 * `#9a9ea3` is always opaque and the track `#252527` nearly matches the chat
 * background — visually an always-lit white bar. This module squeezes it to
 * "almost invisible at rest, obvious on hover"; the track stays invisible so
 * the color change concentrates on the thumb.
 *
 * Colors use 8-digit hex (`#RRGGBBAA`): OpenTUI slider rendering goes through
 * `setCellWithAlphaBlending`, so alpha truly participates in blending
 * (verified by in-frame pixel sampling) — not darkened colors faking
 * transparency.
 *
 * Hover is driven by the scrollbar renderable base class's `onMouseOver` /
 * `onMouseOut` (the `Slider` itself only handles down/drag/up, no hover; see
 * `attachScrollbarHover`).
 */

/** Idle thumb: extremely faint, just a hint of position. */
export const SCROLLBAR_THUMB_IDLE_ALPHA = 60;
/** Hover thumb: full color (opaque, max contrast). */
export const SCROLLBAR_THUMB_HOVER_ALPHA = 255;

/** Thumb base color (neutral bright gray, pops as foreground on dark terminals). */
const THUMB_RGB = [154, 158, 163] as const;
/** Track base color: matches the chat background; alpha 0 = fully invisible. */
const TRACK_RGB = [37, 37, 39] as const;

function clampAlpha(alpha: number): number {
  if (!Number.isFinite(alpha)) return 0; // EXIT: NaN|Infinity → fully transparent, never falsely gain visibility
  return Math.max(0, Math.min(255, Math.trunc(alpha)));
}

/** Lowercase hex (same style as theme.ts palette; OpenTUI accepts either case). */
function toHex(alpha: number): string {
  return clampAlpha(alpha).toString(16).padStart(2, "0");
}

/** `#rrggbbaa` — RGB taken from the base triplet, alpha from the argument. */
function rgbaHex(
  rgb: readonly [number, number, number],
  alpha: number
): string {
  const body = rgb
    .map((c) =>
      Math.max(0, Math.min(255, Math.trunc(c)))
        .toString(16)
        .padStart(2, "0")
    )
    .join("");
  return `#${body}${toHex(alpha)}`;
}

/**
 * Vertical scrollbar track color: always fully transparent.
 *
 * The track matches the chat background; showing it would only add noise —
 * the "colorize" semantics belong entirely to the thumb. Returns alpha 0
 * rather than omitting the option — omission falls back to OpenTUI's visible
 * default `#252527`.
 */
export function scrollbarTrackColor(): string {
  return rgbaHex(TRACK_RGB, 0);
}

/**
 * Vertical scrollbar thumb color: `idle` faint / `hover` colored.
 *
 * @param hovered whether the pointer currently rests on the scrollbar
 */
export function scrollbarThumbColor(hovered: boolean): string {
  return rgbaHex(
    THUMB_RGB,
    hovered ? SCROLLBAR_THUMB_HOVER_ALPHA : SCROLLBAR_THUMB_IDLE_ALPHA
  );
}

/**
 * Hover mounting surface: needs only the two writable slots
 * `onMouseOver` / `onMouseOut`.
 *
 * Method shorthand (rather than property-style function types) is deliberate:
 * OpenTUI declares the slots as `(event: MouseEvent) => void`; property style
 * is rejected under contravariance while method shorthand is accepted under
 * bivariance — this module writes only zero-arg handlers and neither needs
 * nor should import OpenTUI's event types.
 */
export interface ScrollbarHoverTarget {
  onMouseOver?(event: never): void;
  onMouseOut?(event: never): void;
}

/**
 * Map pointer enter/leave onto `setHovered`, return an uninstall function.
 *
 * `setHovered` is called only on real state flips — terminals dispatch `over`
 * events per movement frame; without dedupe every frame would trigger a
 * pointless resize/redraw.
 *
 * EXIT: when target lacks the `onMouseOver`/`onMouseOut` slots (non-OpenTUI
 * object / stub), return a no-op uninstall function instead of throwing —
 * a degraded look must not take down the session view.
 */
export function attachScrollbarHover(
  target: ScrollbarHoverTarget | null | undefined,
  setHovered: (hovered: boolean) => void
): () => void {
  if (target == null || typeof target !== "object") return () => {}; // EXIT
  let hovered = false;
  const update = (next: boolean): void => {
    if (next === hovered) return; // dedupe: per-frame moves must not replay the same state
    hovered = next;
    setHovered(next);
  };
  target.onMouseOver = () => update(true);
  target.onMouseOut = () => update(false);
  return () => {
    update(false);
    target.onMouseOver = undefined;
    target.onMouseOut = undefined;
  };
}
