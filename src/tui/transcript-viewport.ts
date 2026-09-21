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
  /**
   * Rows the scroll content occupies before message 0 (the banner is the
   * first scroll segment). `scrollTop` arrives in real content coordinates;
   * the window math maps message coordinates, so it subtracts this origin
   * first. Missing / non-finite / negative → 0 (pre-origin behavior).
   */
  readonly contentOriginHeight?: number;
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

function resolveContentOrigin(raw: number | undefined): number {
  if (raw === undefined || !Number.isFinite(raw) || raw <= 0) {
    return 0; // EXIT: missing|invalid|zero → message 0 sits at content top
  }
  return Math.trunc(raw);
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

/**
 * Resolved-height prefix sums cached per heights-array identity.
 *
 * Scroll commits re-run `selectViewportMountWindow` with the *same*
 * `itemHeights` reference (measurement only replaces it when a mounted row's
 * height actually changed). Re-resolving and re-summing O(N) heights per
 * commit is exactly the repeated computation this cut removes; the WeakMap
 * follows the array's lifetime so no eviction policy is needed. `n` /
 * `placeholder` are validated on hit because the messages list can grow
 * while the heights array stays the old reference.
 */
interface HeightsPrefix {
  readonly n: number;
  readonly placeholder: number;
  /** prefix[i] = sum of resolved heights for rows [0, i); non-decreasing
   *  (a resolved height can be 0 — `Math.trunc` of a raw height in (0, 1)).
   *  Length n + 1. */
  readonly prefix: ReadonlyArray<number>;
}

const prefixCache = new WeakMap<ReadonlyArray<number>, HeightsPrefix>();

function heightsPrefix(
  heights: ReadonlyArray<number> | undefined,
  n: number,
  placeholder: number
): HeightsPrefix {
  if (heights !== undefined) {
    const cached = prefixCache.get(heights);
    if (
      cached !== undefined &&
      cached.n === n &&
      cached.placeholder === placeholder
    ) {
      return cached; // EXIT: same array + same shape → reuse sums
    }
  }
  const prefix: number[] = new Array<number>(n + 1);
  prefix[0] = 0;
  for (let i = 0; i < n; i++) {
    prefix[i + 1] = prefix[i]! + resolveItemHeight(heights?.[i], placeholder);
  }
  const entry: HeightsPrefix = { n, placeholder, prefix };
  if (heights !== undefined) prefixCache.set(heights, entry);
  return entry;
}

/** Binary search over the non-decreasing prefix — same decisions as the
 *  retired linear scan: first row whose running end passes rangeStart, first
 *  row from there whose running start reaches rangeEnd. */
function findVisibleSpanFast(
  prefix: ReadonlyArray<number>,
  n: number,
  rangeStart: number,
  rangeEnd: number
): { startIndex: number; endIndex: number } {
  // startIndex = first i with prefix[i + 1] > rangeStart.
  let lo = 1;
  let hi = n + 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (prefix[mid]! > rangeStart) hi = mid;
    else lo = mid + 1;
  }
  if (lo > n) {
    // EXIT: rangeStart past all content → same last-row fallback as the scan.
    return { startIndex: Math.max(0, n - 1), endIndex: n };
  }
  const startIndex = lo - 1;
  // endIndex = first i >= startIndex with prefix[i] >= rangeEnd.
  let a = startIndex;
  let b = n + 1;
  while (a < b) {
    const mid = (a + b) >> 1;
    if (prefix[mid]! >= rangeEnd) b = mid;
    else a = mid + 1;
  }
  return { startIndex, endIndex: a > n ? n : a };
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

  const { prefix } = heightsPrefix(opts.heights, n, placeholder);
  const contentHeight = prefix[n]!;
  const viewportHeight = resolveViewport(opts.viewportHeight);
  const overscan = resolveOverscan(opts.overscan, viewportHeight);
  const scrollTop = clampScrollTop(
    opts.scrollTop - resolveContentOrigin(opts.contentOriginHeight),
    contentHeight,
    viewportHeight
  );
  const rangeStart = Math.max(0, scrollTop - overscan);
  const rangeEnd = Math.min(
    contentHeight,
    scrollTop + viewportHeight + overscan
  );
  const { startIndex, endIndex } = findVisibleSpanFast(
    prefix,
    n,
    rangeStart,
    rangeEnd
  );
  return {
    mounted: messages.slice(startIndex, endIndex),
    startIndex,
    endIndex,
    spacerBefore: prefix[startIndex]!,
    spacerAfter: contentHeight - prefix[endIndex]!,
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
