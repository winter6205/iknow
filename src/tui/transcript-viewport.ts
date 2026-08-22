/**
 * src/tui/transcript-viewport.ts
 *
 * 视口挂载（非行账、非条数尾窗）：根据 scrollTop + viewport + overscan
 * 决定 ChatView 把哪一段 messages 挂进 OpenTUI 树。高度由调用方传入
 * （布局实测或常量占位），本模块不估算 markdown 行数。
 * 约 8 屏以内全量挂载（普通会话与 #591 相同）；更长才按视口+overscan 切片。
 */
export const VIEWPORT_PLACEHOLDER_HEIGHT = 4;

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
  if (raw === undefined || !Number.isFinite(raw) || raw < viewportHeight) {
    return viewportHeight; // EXIT: missing|below one viewport
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

function fullWindow<T>(messages: ReadonlyArray<T>): ViewportMountWindow<T> {
  return {
    mounted: messages,
    startIndex: 0,
    endIndex: messages.length,
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

/** 约 8 屏以内全量挂载（普通会话 ≡ #591）；更长才按视口切片。 */
const FULL_MOUNT_VIEWPORTS = 8;

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
  if (contentHeight <= viewportHeight * FULL_MOUNT_VIEWPORTS) {
    return fullWindow(messages);
  }

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

/** OpenTUI ScrollBox 滚动位置；只需 on/off + 回读 scrollTop。 */
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
