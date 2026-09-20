/**
 * src/tui/transcript-viewport.ts
 *
 * Viewport mounting (not row accounting, not a count-based tail window):
 * decides which slice of messages ChatView mounts into the OpenTUI tree from
 * scrollTop + viewport + overscan. Heights are supplied by the caller (layout
 * measurement or a constant placeholder); this module never estimates markdown
 * row counts.
 *
 * specs/tui-transcript-viewport.md invariant 4: the mount range depends only
 * on scrollTop + viewport.height + an overscan smaller than one screen, and
 * never on total content height — there is no "mount everything when content
 * is under N screens" short-circuit. When all content fits within the viewport
 * + overscan, the range conversion yields the same result as a full map.
 */
import { CHAT_WHEEL_SCROLL_MULTIPLIER } from "./wheel-scroll.js";

export const VIEWPORT_PLACEHOLDER_HEIGHT = 4;

/**
 * Default overscan = one quarter of the viewport (quantized to rows, floor 1).
 *
 * spec invariant 4 requires the overscan to be **smaller than one screen**: a
 * one-screen overscan would grow the mount range to 3 screens (1 above +
 * viewport + 1 below), which both violates "subtree size follows the viewport"
 * and makes unmeasured entries repeatedly enter and leave the window while
 * scrolling. A quarter screen is enough to cover the quantized commit step
 * (see `resolveScrollCommitStep`: step ≤ overscan, so during sub-threshold
 * scrolling entries in the viewport are necessarily still inside the window),
 * while keeping the window at about 1.5 screens.
 *
 * Degenerate case: with a viewport ≤ 1 row there is no positive overscan
 * "smaller than one screen", so the floor of 1 is the reachable minimum (real
 * terminals never hit this).
 */
export function defaultViewportOverscan(viewportHeight: number): number {
  if (!Number.isFinite(viewportHeight) || viewportHeight <= 0) return 1;
  // floor, not round: fractions below one row round down (viewport 4–7 rows → overscan 1),
  // guaranteeing overscan only grows with the viewport without jumping (round would turn a
  // 4–5-row fraction into 2 and double the window); floor also absorbs non-integer viewports.
  return Math.max(1, Math.floor(viewportHeight / 4));
}

/**
 * Named re-export (no standalone behaviour): value =
 * `CHAT_WHEEL_SCROLL_MULTIPLIER` (single source of truth), used as the upper
 * bound of the React commit quantization step.
 *
 * Scroll position comes from `verticalScrollBar`'s per-frame `change`: without
 * quantization every change calls `setScrollTop` and the whole ChatView tree
 * (including markdown rendering) recomputes. The step cap is set to one wheel
 * step because the wheel is the primary scrolling entry for long transcripts:
 * if the quantization step were larger than one wheel displacement, a single
 * wheel turn would never reach the next quantization boundary and the window
 * would be permanently left behind. The floor is 1 row
 * (`resolveScrollCommitStep`) = the smallest commit quantum: sub-row
 * displacements don't trigger whole-tree recomputes, whole-row displacements
 * aren't swallowed, independent of wheel step; further bounded by the default
 * overscan so viewport content is never unmounted due to skipped commits.
 */
export const SCROLL_COMMIT_STEP_ROWS = CHAT_WHEEL_SCROLL_MULTIPLIER;

/** Quantized step: ≥1, ≤ one wheel step, ≤ the default overscan for that viewport. */
export function resolveScrollCommitStep(viewportHeight: number): number {
  const overscan = defaultViewportOverscan(viewportHeight);
  return Math.max(1, Math.min(SCROLL_COMMIT_STEP_ROWS, overscan));
}

export interface ViewportMountOpts {
  readonly scrollTop: number;
  readonly viewportHeight: number;
  readonly heights?: ReadonlyArray<number>;
  readonly overscan?: number;
  readonly placeholderHeight?: number;
}

export interface ViewportMountWindow<T> {
  readonly mounted: ReadonlyArray<T>;
  readonly startIndex: number;
  readonly endIndex: number;
  readonly spacerBefore: number;
  readonly spacerAfter: number;
}

function resolveItemHeight(
  raw: number | undefined,
  placeholder: number
): number {
  if (raw === undefined || !Number.isFinite(raw) || raw <= 0) {
    return placeholder; // EXIT: missing|invalid height → placeholder, never blank
  }
  return Math.trunc(raw);
}

function resolvePlaceholder(raw: number | undefined): number {
  if (raw === undefined || !Number.isFinite(raw) || raw <= 0) {
    return VIEWPORT_PLACEHOLDER_HEIGHT; // EXIT
  }
  return Math.trunc(raw);
}

function resolveViewport(raw: number): number {
  if (!Number.isFinite(raw) || raw <= 0) return 1; // EXIT: non-positive → 1 so a non-empty list still mounts
  return Math.trunc(raw);
}

function resolveOverscan(
  raw: number | undefined,
  viewportHeight: number
): number {
  const fallback = defaultViewportOverscan(viewportHeight);
  if (raw === undefined || !Number.isFinite(raw) || raw < fallback) {
    return fallback; // EXIT: missing|non-finite|below default → sub-screen default
  }
  return Math.trunc(raw);
}

function clampScrollTop(
  scrollTop: number,
  contentHeight: number,
  viewportHeight: number
): number {
  const maxScroll = Math.max(0, contentHeight - viewportHeight);
  if (Number.isNaN(scrollTop) || scrollTop < 0) return 0; // EXIT: NaN|negative
  if (!Number.isFinite(scrollTop) || scrollTop > maxScroll) return maxScroll; // EXIT: Infinity|overflow
  return scrollTop;
}

function emptyWindow<T>(): ViewportMountWindow<T> {
  return {
    mounted: [],
    startIndex: 0,
    endIndex: 0,
    spacerBefore: 0,
    spacerAfter: 0,
  };
}

function sumRange(
  heights: ReadonlyArray<number>,
  from: number,
  to: number
): number {
  let sum = 0;
  for (let i = from; i < to; i++) sum += heights[i]!;
  return sum;
}

function findVisibleSpan(
  heights: ReadonlyArray<number>,
  rangeStart: number,
  rangeEnd: number
): { startIndex: number; endIndex: number } {
  const n = heights.length;
  let acc = 0;
  let startIndex = 0;
  let endIndex = n;
  let foundStart = false;
  for (let i = 0; i < n; i++) {
    const next = acc + heights[i]!;
    if (!foundStart && next > rangeStart) {
      startIndex = i;
      foundStart = true;
    }
    if (foundStart && acc >= rangeEnd) {
      endIndex = i;
      break;
    }
    acc = next;
  }
  if (!foundStart) {
    return { startIndex: Math.max(0, n - 1), endIndex: n };
  }
  return { startIndex, endIndex };
}

export function selectViewportMountWindow<T>(
  messages: ReadonlyArray<T>,
  opts: ViewportMountOpts
): ViewportMountWindow<T> {
  if (!Array.isArray(messages)) {
    throw new TypeError("selectViewportMountWindow: messages must be an array");
  }
  const n = messages.length;
  const placeholder = resolvePlaceholder(opts.placeholderHeight);
  if (n === 0) return emptyWindow();

  const heights = Array.from({ length: n }, (_, i) =>
    resolveItemHeight(opts.heights?.[i], placeholder)
  );
  const contentHeight = heights.reduce((sum, h) => sum + h, 0);
  const viewportHeight = resolveViewport(opts.viewportHeight);
  const overscan = resolveOverscan(opts.overscan, viewportHeight);
  const scrollTop = clampScrollTop(
    opts.scrollTop,
    contentHeight,
    viewportHeight
  );
  const rangeStart = Math.max(0, scrollTop - overscan);
  const rangeEnd = Math.min(
    contentHeight,
    scrollTop + viewportHeight + overscan
  );
  const { startIndex, endIndex } = findVisibleSpan(
    heights,
    rangeStart,
    rangeEnd
  );
  return {
    mounted: messages.slice(startIndex, endIndex),
    startIndex,
    endIndex,
    spacerBefore: sumRange(heights, 0, startIndex),
    spacerAfter: sumRange(heights, endIndex, n),
  };
}

/** Commit decision parameters for one scroll change. */
export interface ScrollCommitOpts {
  /** Quantization step (rows); non-finite / <1 treated as 1 (never swallow a real displacement due to a bad param). */
  readonly step: number;
  /** Bottom position = max(0, scrollHeight - viewport.height). */
  readonly maxScrollTop: number;
}

/**
 * Whether this `change`'s position should be committed to React (the
 * quantization clause of spec invariant 8).
 *
 * Rules (in priority order):
 *  1. `prev` non-finite (first commit, incl. NaN seed) → commit;
 *  2. `next` non-finite → drop (garbage positions must not change the window);
 *  3. `next <= 0` → commit (at top: the first bubble must be mounted);
 *  4. `next >= maxScrollTop` → commit (at bottom: sticky must not lag);
 *  5. otherwise: commit only when the displacement ≥ the quantization step; sub-threshold
 *     consecutive changes do not trigger a React commit.
 *
 * While commits are skipped the window stays at the old scrollTop, but
 * overscan ≥ quantization step (guaranteed by `resolveScrollCommitStep`), so
 * entries in the viewport remain inside the mount range.
 */
export function shouldCommitScrollTop(
  prev: number,
  next: number,
  opts: ScrollCommitOpts
): boolean {
  if (!Number.isFinite(prev)) return true; // EXIT: first commit
  if (!Number.isFinite(next)) return false; // EXIT: garbage position
  if (next <= 0) return true; // EXIT: top — first message must mount
  if (Number.isFinite(opts.maxScrollTop) && next >= opts.maxScrollTop) {
    return true; // EXIT: bottom — sticky must not lag
  }
  const step =
    Number.isFinite(opts.step) && opts.step >= 1 ? Math.trunc(opts.step) : 1;
  return Math.abs(next - prev) >= step;
}

/** OpenTUI ScrollBox scroll position; only on/off + reading scrollTop back are needed. */
export interface ScrollTopSource {
  readonly scrollTop: number;
  readonly verticalScrollBar: {
    on(
      event: "change",
      listener: (evt: { position?: number }) => void
    ): unknown;
    off(
      event: "change",
      listener: (evt: { position?: number }) => void
    ): unknown;
  };
}

/**
 * Subscribe to OpenTUI `verticalScrollBar` `change` (the documented path).
 * Assigning `scrollTop` updates the slider, which emits this event.
 * Do not patch the setter or poll with rAF (sticky can still read 0).
 */
export function listenScrollBoxTop(
  source: ScrollTopSource,
  onPosition: (position: number) => void
): () => void {
  if (source == null || typeof source !== "object") {
    throw new TypeError("listenScrollBoxTop: source must be an object");
  }
  const bar = source.verticalScrollBar;
  if (
    bar == null ||
    typeof bar.on !== "function" ||
    typeof bar.off !== "function"
  ) {
    throw new TypeError(
      "listenScrollBoxTop: verticalScrollBar must support on/off"
    );
  }
  if (typeof onPosition !== "function") {
    throw new TypeError("listenScrollBoxTop: onPosition must be a function");
  }
  const handler = (evt: { position?: number } | undefined): void => {
    const fromEvt = evt?.position;
    if (!Number.isFinite(fromEvt)) {
      onPosition(source.scrollTop); // EXIT: missing|NaN|Infinity position → source.scrollTop
      return;
    }
    onPosition(fromEvt as number);
  };
  bar.on("change", handler);
  return () => {
    bar.off("change", handler);
  };
}
