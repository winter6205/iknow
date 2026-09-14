/**
 * src/tui/transcript-viewport.ts
 *
 * 视口挂载（非行账、非条数尾窗）：根据 scrollTop + viewport + overscan
 * 决定 ChatView 把哪一段 messages 挂进 OpenTUI 树。高度由调用方传入
 * （布局实测或常量占位），本模块不估算 markdown 行数。
 *
 * spec `specs/tui-transcript-viewport.md` invariant 4：挂载范围只看
 * scrollTop + viewport.height + 小于一屏的 overscan，**不看内容总高** ——
 * 没有「内容低于 N 屏则全量挂载」的短路。内容全部落在视口 + overscan 内
 * 时，区间换算结果与全量 map 相同。
 */
import { CHAT_WHEEL_SCROLL_MULTIPLIER } from "./wheel-scroll.js";

export const VIEWPORT_PLACEHOLDER_HEIGHT = 4;

/**
 * 默认 overscan = 视口的四分之一（量化到行，下限 1 行）。
 *
 * spec invariant 4 要求 overscan **小于一屏**：一屏 overscan 会让挂载区间
 * 达到 3 屏高（上 1 + 视口 1 + 下 1），既违背「子树规模跟视口走」，又让
 * 未测高条目在滚动时反复进出窗口。四分之一屏足够覆盖量化提交步长
 * （见 `resolveScrollCommitStep`：步长 ≤ overscan，亚阈值滚动期间视口内
 * 条目必然仍在窗口里），同时把窗口压到约 1.5 屏。
 *
 * 退化情形：视口 ≤ 1 行时不存在「小于一屏」的正 overscan，下限 1 行是
 * 可达最小值（真实终端不会出现）。
 */
export function defaultViewportOverscan(viewportHeight: number): number {
  if (!Number.isFinite(viewportHeight) || viewportHeight <= 0) return 1;
  // floor 而非 round：不足 1 行的份额向下取整（视口 4–7 行 → overscan 1），
  // 保证 overscan 随视口只涨不跳（round 会让 4–5 行的份额变成 2，窗口翻倍）；
  // floor 本身也吸收非整数视口。
  return Math.max(1, Math.floor(viewportHeight / 4));
}

/**
 * 命名再导出（无独立行为）：值 = `CHAT_WHEEL_SCROLL_MULTIPLIER`（单一真源），
 * 用作 React 提交量化步长的上限。
 *
 * 滚动位置来自 `verticalScrollBar` 的逐帧 `change`：不量化则每次 change
 * 都 `setScrollTop`，整棵 ChatView（含 markdown 渲染）跟着重算。步长上限
 * 取一次滚轮步长的理由：滚轮是长 transcript 的主要滚动入口，量化步长
 * 大于一次滚轮位移时，单次滚轮永远够不到下一次量化边界，窗口被永久落
 * 在后面。下限是 1 行（`resolveScrollCommitStep`）= 最小提交量子：亚行
 * 位移不触发整树重算，整行位移不被吞，与滚轮步长无关；再由默认 overscan
 * 收敛，保证视口内容不因跳过提交而卸载。
 */
export const SCROLL_COMMIT_STEP_ROWS = CHAT_WHEEL_SCROLL_MULTIPLIER;

/** 量化步长：≥1、≤ 一滚轮步长、≤ 该视口的默认 overscan。 */
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

/** 一次滚动 change 的提交裁决参数。 */
export interface ScrollCommitOpts {
  /** 量化步长（行）；非有限 / <1 按 1 处理（绝不因坏参数吞掉真实位移）。 */
  readonly step: number;
  /** 底部位置 = max(0, scrollHeight - viewport.height)。 */
  readonly maxScrollTop: number;
}

/**
 * 是否需要把本次 `change` 的位置提交给 React（spec invariant 8 的量化条款）。
 *
 * 规则（按优先级）：
 *  1. `prev` 非有限（首次提交，含 NaN 种子）→ 提交；
 *  2. `next` 非有限 → 丢弃（垃圾位置不该改窗口）；
 *  3. `next <= 0` → 提交（置顶：第一个气泡必须挂上）；
 *  4. `next >= maxScrollTop` → 提交（贴底：sticky 不滞后）；
 *  5. 其余：位移 ≥ 量化步长才提交，亚阈值连续 change 不触发 React 提交。
 *
 * 跳过提交期间窗口停在旧 scrollTop，但 overscan ≥ 量化步长
 * （`resolveScrollCommitStep` 保证），视口内条目仍在挂载区间内。
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
