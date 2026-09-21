/**
 * tests/tui/transcript-viewport.test.ts
 *
 * ChatView viewport-mount pure functions: decide which slice of messages
 * enters the OpenTUI tree. Heights come from caller-supplied measurements /
 * placeholders; this module never estimates markdown line counts. Also tests
 * `listenScrollBoxTop` (subscribing to OpenTUI `verticalScrollBar` `change`)
 * and `shouldCommitScrollTop` (quantized React commits).
 */
import { EventEmitter } from "node:events";
import { describe, expect, test } from "bun:test";
import {
  VIEWPORT_PLACEHOLDER_HEIGHT,
  defaultViewportOverscan,
  listenScrollBoxTop,
  resolveScrollCommitStep,
  selectViewportMountWindow,
  shouldCommitScrollTop,
} from "../../src/tui/transcript-viewport.js";
import { CHAT_WHEEL_SCROLL_MULTIPLIER } from "../../src/tui/wheel-scroll.js";

function ids(n: number): ReadonlyArray<string> {
  return Array.from({ length: n }, (_, i) => `m-${i}`);
}

function uniformHeights(n: number, h: number): number[] {
  return Array.from({ length: n }, () => h);
}

describe("selectViewportMountWindow", () => {
  test("empty: 空数组 start=end=0，spacer 均为 0", () => {
    const w = selectViewportMountWindow([], {
      scrollTop: 0,
      viewportHeight: 12,
    });
    expect(w.startIndex).toBe(0);
    expect(w.endIndex).toBe(0);
    expect(w.spacerBefore).toBe(0);
    expect(w.spacerAfter).toBe(0);
    expect(w.mounted).toEqual([]);
  });

  test("negative: 负 scrollTop / 非正 viewport 仍能 clamp", () => {
    const messages = ids(10);
    const w = selectViewportMountWindow(messages, {
      scrollTop: -40,
      viewportHeight: 12,
      heights: uniformHeights(10, 4),
    });
    expect(w.startIndex).toBe(0);
    expect(w.mounted.length).toBeGreaterThan(0);
    expect(w.mounted[0]).toBe("m-0");

    const badHeight = selectViewportMountWindow(messages, {
      scrollTop: 0,
      viewportHeight: 12,
      heights: [Number.NaN, -3, 0, 4, 4, 4, 4, 4, 4, 4],
    });
    expect(badHeight.mounted.length).toBeGreaterThan(0);
    expect(badHeight.startIndex).toBe(0);

    const zeroViewport = selectViewportMountWindow(ids(80), {
      scrollTop: 0,
      viewportHeight: 0,
    });
    expect(zeroViewport.mounted.length).toBeGreaterThan(0);
    expect(zeroViewport.mounted.length).toBeLessThan(80);
  });

  test("overflow: 三屏以上只挂视口+overscan，顶含首、底含末", () => {
    const messages = ids(100);
    const heights = uniformHeights(100, 4);
    const viewportHeight = 12;
    const top = selectViewportMountWindow(messages, {
      scrollTop: 0,
      viewportHeight,
      heights,
    });
    expect(top.mounted.length).toBeLessThan(100);
    expect(top.mounted.length).toBeGreaterThan(0);
    expect(top.startIndex).toBe(0);
    expect(top.mounted[0]).toBe("m-0");
    expect(top.spacerBefore).toBe(0);
    expect(top.spacerAfter).toBeGreaterThan(0);

    const contentHeight = 100 * 4;
    const scrollTop = contentHeight - viewportHeight;
    const bottom = selectViewportMountWindow(messages, {
      scrollTop,
      viewportHeight,
      heights,
    });
    expect(bottom.mounted.length).toBeLessThan(100);
    expect(bottom.mounted.at(-1)).toBe("m-99");
    expect(bottom.endIndex).toBe(100);
    expect(bottom.spacerAfter).toBe(0);
    expect(bottom.spacerBefore).toBeGreaterThan(0);

    const inf = selectViewportMountWindow(messages, {
      scrollTop: Number.POSITIVE_INFINITY,
      viewportHeight,
      heights,
    });
    expect(inf.mounted.at(-1)).toBe("m-99");
  });

  test("overflow: 内容全部落在视口+overscan 内 → 与全量 map 等价", () => {
    // Invariant 4: when all content fits within "viewport + overscan", the
    // result must equal the full visibleMessages.map (everything mounted, zero spacers).
    const messages = ids(3);
    const w = selectViewportMountWindow(messages, {
      scrollTop: 0,
      viewportHeight: 40,
      heights: uniformHeights(3, 4),
    });
    expect(w.mounted).toEqual([...messages]);
    expect(w.startIndex).toBe(0);
    expect(w.endIndex).toBe(3);
    expect(w.spacerBefore).toBe(0);
    expect(w.spacerAfter).toBe(0);
  });

  test("overflow: 超过一屏但不足三屏 → 仍按视口+overscan 切片", () => {
    // Invariant 4: the mount range depends only on scrollTop + viewport + overscan;
    // "if total content height is below N viewports then mount everything" short-circuits are banned. 20 items x 4 rows = 80 rows > viewport 12, yet the window is still shorter than the total count.
    const messages = ids(20);
    const heights = uniformHeights(20, 4);
    const top = selectViewportMountWindow(messages, {
      scrollTop: 0,
      viewportHeight: 12,
      heights,
    });
    expect(top.mounted.length).toBeLessThan(20);
    expect(top.mounted[0]).toBe("m-0");
    expect(top.startIndex).toBe(0);
    expect(top.spacerAfter).toBeGreaterThan(0);

    const bottom = selectViewportMountWindow(messages, {
      scrollTop: 20 * 4 - 12,
      viewportHeight: 12,
      heights,
    });
    expect(bottom.mounted.length).toBeLessThan(20);
    expect(bottom.mounted.at(-1)).toBe("m-19");
    expect(bottom.endIndex).toBe(20);
    expect(bottom.spacerAfter).toBe(0);
    expect(bottom.spacerBefore).toBeGreaterThan(0);
  });

  test("contentOriginHeight: scrollTop 先减 origin 再映射消息坐标", () => {
    // 20×4=80 行消息内容，viewport 12 → overscan 3，origin 15（banner）。
    // 真实 scrollTop 30 的视口顶 = 消息坐标 15 → range [12, 30]。
    const w = selectViewportMountWindow(ids(20), {
      scrollTop: 30,
      viewportHeight: 12,
      heights: uniformHeights(20, 4),
      contentOriginHeight: 15,
    });
    expect(w.startIndex).toBe(3);
    expect(w.spacerBefore).toBe(12);
    expect(w.endIndex).toBe(8);
  });

  test("contentOriginHeight: scrollTop 落在 origin 区间内 → 钉在消息 0", () => {
    const w = selectViewportMountWindow(ids(20), {
      scrollTop: 5,
      viewportHeight: 12,
      heights: uniformHeights(20, 4),
      contentOriginHeight: 15,
    });
    expect(w.startIndex).toBe(0);
    expect(w.spacerBefore).toBe(0);
  });

  test("contentOriginHeight: 缺省 / 非法值退化为 0（旧调用行为不变）", () => {
    const base = {
      scrollTop: 30,
      viewportHeight: 12,
      heights: uniformHeights(20, 4),
    };
    const legacy = selectViewportMountWindow(ids(20), base);
    for (const bad of [
      undefined,
      0,
      -9,
      Number.NaN,
      Number.POSITIVE_INFINITY,
    ]) {
      const w = selectViewportMountWindow(ids(20), {
        ...base,
        contentOriginHeight: bad,
      });
      expect(w).toEqual(legacy);
    }
  });

  test("contentOriginHeight: 底部 / Infinity 仍收敛到尾窗", () => {
    const w = selectViewportMountWindow(ids(20), {
      scrollTop: Number.POSITIVE_INFINITY,
      viewportHeight: 12,
      heights: uniformHeights(20, 4),
      contentOriginHeight: 15,
    });
    expect(w.mounted.at(-1)).toBe("m-19");
    expect(w.endIndex).toBe(20);
    expect(w.spacerAfter).toBe(0);
  });

  test("overscan: 默认小于一屏（视口 >= 2 行），显式值不再被抬到一屏", () => {
    // Invariant 4 / EXIT: when viewport.height >= 2 the default overscan is
    // strictly less than one screen; an explicit smaller value is respected
    // (below default -> default is taken).
    for (const vh of [2, 4, 12, 40, 200]) {
      expect(defaultViewportOverscan(vh)).toBeLessThan(vh);
    }
    // Degenerate: with viewport <= 1 there is no positive overscan "smaller
    // than one screen"; the implementation takes the reachable minimum 1
    // (`Math.max(1, ...)`), a value not below the viewport. This degeneration
    // is recorded explicitly and must not be read as "always less than one screen".
    expect(defaultViewportOverscan(1)).toBe(1);
    expect(defaultViewportOverscan(0)).toBe(1);
    const viewportHeight = 40;
    const overscan = defaultViewportOverscan(viewportHeight);
    expect(overscan).toBeGreaterThan(0);
    expect(overscan).toBeLessThan(viewportHeight);
    // Quantized step ≤ overscan (sub-threshold scrolling never leaves the mount
    // window behind the viewport); and ≤ one wheel step (a single wheel tick
    // must be able to move the window; whether one wheel event commits is
    // certified by the behavior test in chat-view-scroll.test.tsx).
    expect(resolveScrollCommitStep(viewportHeight)).toBeLessThanOrEqual(
      overscan
    );

    // An explicit smaller overscan is raised to the default (overscan < default
    // → default); an explicit larger one is respected verbatim. Window length is
    // derived from total mounted height (height ÷ 4).
    const explicitSmall = selectViewportMountWindow(ids(50), {
      scrollTop: 0,
      viewportHeight,
      heights: uniformHeights(50, 4),
      overscan: 2,
    });
    expect(explicitSmall.mounted.length).toBeLessThan(50);
    expect(explicitSmall.spacerAfter).toBe(
      (50 - explicitSmall.mounted.length) * 4
    );
    // Default overscan = viewport/4 = 10 rows → window covers viewport +
    // overscan = 50 rows; 4 rows per item → mount ceil(50/4) = 13 items (the
    // right edge takes the first item covering up to row 50).
    expect(explicitSmall.mounted.length).toBe(
      Math.ceil((viewportHeight + overscan) / 4)
    );

    const explicitBig = selectViewportMountWindow(ids(50), {
      scrollTop: 0,
      viewportHeight,
      heights: uniformHeights(50, 4),
      overscan: 100,
    });
    expect(explicitBig.mounted.length).toBeGreaterThan(
      explicitSmall.mounted.length
    );
  });

  test("concurrent: 纯函数两次调用互不影响 // N/A: pure", async () => {
    const [a, b] = await Promise.all([
      Promise.resolve(
        selectViewportMountWindow(ids(100), {
          scrollTop: 0,
          viewportHeight: 12,
          heights: uniformHeights(100, 4),
        })
      ),
      Promise.resolve(
        selectViewportMountWindow(ids(5), {
          scrollTop: 0,
          viewportHeight: 12,
          heights: uniformHeights(5, 4),
        })
      ),
    ]);
    expect(a.mounted[0]).toBe("m-0");
    expect(a.mounted.length).toBeLessThan(100);
    // 5 items × 4 rows = 20 rows > viewport 12 + overscan both sides → window
    // slicing (no more whole-segment mount); this section only certifies the
    // two calls do not interfere.
    expect(b.mounted.length).toBeLessThan(5);
    expect(b.mounted[0]).toBe("m-0");
    expect(b.spacerBefore).toBe(0);
    expect(b.spacerAfter).toBeGreaterThan(0);
  });

  test("exception: messages 非数组抛 TypeError", () => {
    expect(() =>
      selectViewportMountWindow(null as unknown as ReadonlyArray<string>, {
        scrollTop: 0,
        viewportHeight: 12,
      })
    ).toThrow(TypeError);
  });

  test("未测高条目使用与内容无关的占位高度", () => {
    expect(VIEWPORT_PLACEHOLDER_HEIGHT).toBeGreaterThan(0);
    const w = selectViewportMountWindow(ids(80), {
      scrollTop: 0,
      viewportHeight: 12,
    });
    expect(w.mounted.length).toBeLessThan(80);
    expect(w.spacerAfter).toBe(
      (80 - w.mounted.length) * VIEWPORT_PLACEHOLDER_HEIGHT
    );
  });
});

describe("shouldCommitScrollTop / resolveScrollCommitStep", () => {
  const OPTS = { step: 3, maxScrollTop: 100 };

  test("empty: 首次提交（prev 未设）必提交；垃圾位置不提交", () => {
    expect(shouldCommitScrollTop(Number.POSITIVE_INFINITY, 40, OPTS)).toBe(
      true
    );
    expect(shouldCommitScrollTop(Number.NaN, 40, OPTS)).toBe(true);
    expect(shouldCommitScrollTop(40, Number.NaN, OPTS)).toBe(false);
    expect(shouldCommitScrollTop(40, Number.POSITIVE_INFINITY, OPTS)).toBe(
      false
    );
  });

  test("negative: 负位置按置顶提交（首条必须挂上）", () => {
    expect(shouldCommitScrollTop(40, -5, OPTS)).toBe(true);
    expect(shouldCommitScrollTop(40, 0, OPTS)).toBe(true);
  });

  test("overflow: 坏步长退化为最小量子 1（不会退化成 0 或无穷）", () => {
    // step non-finite / <1 → 1 row: a whole-row displacement still commits
    // (bad params must not swallow real scrolling); a sub-row displacement does
    // not commit (the minimum quantum is one row).
    for (const step of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(shouldCommitScrollTop(40, 41, { step, maxScrollTop: 100 })).toBe(
        true
      );
      expect(shouldCommitScrollTop(40, 40.5, { step, maxScrollTop: 100 })).toBe(
        false
      );
    }
  });

  test("亚阈值连续 change 不提交；跨步长/贴底/置顶提交", () => {
    expect(shouldCommitScrollTop(40, 42, OPTS)).toBe(false); // scrolled up 2 rows
    expect(shouldCommitScrollTop(40, 37.1, OPTS)).toBe(false); // scrolled down <3 rows
    expect(shouldCommitScrollTop(40, 43, OPTS)).toBe(true); // crosses one quantized step
    expect(shouldCommitScrollTop(40, 37, OPTS)).toBe(true);
    expect(shouldCommitScrollTop(40, 100, OPTS)).toBe(true); // at bottom
    expect(shouldCommitScrollTop(40, 99, OPTS)).toBe(true); // at bottom (commits even sub-threshold)
  });

  test("concurrent: 纯函数两次调用互不影响 // N/A: pure", async () => {
    const [a, b] = await Promise.all([
      Promise.resolve(shouldCommitScrollTop(40, 41, OPTS)),
      Promise.resolve(shouldCommitScrollTop(40, 43, OPTS)),
    ]);
    expect(a).toBe(false);
    expect(b).toBe(true);
    expect(shouldCommitScrollTop(40, 41, OPTS)).toBe(false);
  });

  test("exception: maxScrollTop 非有限 → 跳过贴底规则，不抛", () => {
    expect(
      shouldCommitScrollTop(40, 41, { step: 3, maxScrollTop: Number.NaN })
    ).toBe(false);
    expect(
      shouldCommitScrollTop(40, 43, { step: 3, maxScrollTop: Number.NaN })
    ).toBe(true);
  });

  test("量化步长随视口收敛：≥1、≤ 一滚轮步长、≤ 默认 overscan", () => {
    for (const viewportHeight of [1, 4, 12, 40, 200]) {
      const step = resolveScrollCommitStep(viewportHeight);
      expect(step).toBeGreaterThanOrEqual(1);
      expect(step).toBeLessThanOrEqual(CHAT_WHEEL_SCROLL_MULTIPLIER);
      expect(step).toBeLessThanOrEqual(defaultViewportOverscan(viewportHeight));
    }
  });
});

function fakeScrollSource(scrollTop: number): {
  scrollTop: number;
  verticalScrollBar: EventEmitter;
} {
  return { scrollTop, verticalScrollBar: new EventEmitter() };
}

describe("listenScrollBoxTop", () => {
  test("empty: payload 无 position 时回读 source.scrollTop", () => {
    const source = fakeScrollSource(7);
    const seen: number[] = [];
    const stop = listenScrollBoxTop(source, (position) => {
      seen.push(position);
    });
    source.verticalScrollBar.emit("change", {});
    expect(seen).toEqual([7]);
    stop();
  });

  test("negative: NaN position 回读 source.scrollTop，0 仍转发", () => {
    const source = fakeScrollSource(9);
    const seen: number[] = [];
    const stop = listenScrollBoxTop(source, (position) => {
      seen.push(position);
    });
    source.verticalScrollBar.emit("change", { position: Number.NaN });
    source.verticalScrollBar.emit("change", { position: 0 });
    expect(seen).toEqual([9, 0]);
    stop();
  });

  test("overflow: 极大 position 原样转发（clamp 留给窗口函数）", () => {
    const source = fakeScrollSource(1);
    const seen: number[] = [];
    const stop = listenScrollBoxTop(source, (position) => {
      seen.push(position);
    });
    source.verticalScrollBar.emit("change", {
      position: Number.MAX_SAFE_INTEGER,
    });
    expect(seen).toEqual([Number.MAX_SAFE_INTEGER]);
    stop();
  });

  test("concurrent: 连续 change 都送达，off 后不再回调", () => {
    const source = fakeScrollSource(3);
    const seen: number[] = [];
    const stop = listenScrollBoxTop(source, (position) => {
      seen.push(position);
    });
    source.verticalScrollBar.emit("change", { position: 12 });
    source.verticalScrollBar.emit("change", { position: 18 });
    expect(seen).toEqual([12, 18]);
    stop();
    source.verticalScrollBar.emit("change", { position: 20 });
    expect(seen).toEqual([12, 18]);
  });

  test("exception: source / bar 非法抛 TypeError", () => {
    expect(() => listenScrollBoxTop(null as never, () => undefined)).toThrow(
      TypeError
    );
    expect(() => listenScrollBoxTop({} as never, () => undefined)).toThrow(
      TypeError
    );
  });
});

describe("selectViewportMountWindow: prefix-sum cache", () => {
  // Seeded LCG so failures reproduce.
  function lcg(seed: number): () => number {
    let s = seed >>> 0;
    return () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 0x100000000;
    };
  }

  test("warm (repeated same-array) selects equal cold selects across a random sweep", () => {
    const rnd = lcg(1079);
    for (let trial = 0; trial < 300; trial++) {
      const n = 1 + Math.floor(rnd() * 40);
      const messages = ids(n);
      const heights = Array.from({ length: n }, () => {
        const roll = rnd();
        if (roll < 0.1) return 0; // invalid → placeholder
        if (roll < 0.15) return Number.NaN; // invalid → placeholder
        return 1 + Math.floor(rnd() * 9);
      });
      const opts = {
        scrollTop: Math.floor(rnd() * n * 10),
        viewportHeight: 1 + Math.floor(rnd() * 12),
        heights,
        overscan: Math.floor(rnd() * 5),
        placeholderHeight: 1 + Math.floor(rnd() * 6),
      };
      const cold = selectViewportMountWindow(messages, {
        ...opts,
        heights: [...heights],
      });
      const warm1 = selectViewportMountWindow(messages, opts);
      const warm2 = selectViewportMountWindow(messages, opts);
      expect(warm1).toEqual(cold);
      expect(warm2).toEqual(cold);
    }
  });

  test("cache entry is keyed on shape: grown list / changed placeholder rebuild", () => {
    const base = [3, 5, 2];
    const opts = { scrollTop: 6, viewportHeight: 4, heights: base };
    const same = selectViewportMountWindow(ids(3), opts);
    // Heights array stays short while the message list grows: missing tail
    // rows resolve to the placeholder, not to stale sums.
    const grownCold = selectViewportMountWindow(ids(5), {
      ...opts,
      heights: [...base],
    });
    const grownWarm = selectViewportMountWindow(ids(5), opts);
    expect(grownWarm).toEqual(grownCold);
    // A different placeholder for the same array must not reuse old sums.
    const phCold = selectViewportMountWindow(ids(3), {
      ...opts,
      placeholderHeight: 7,
      heights: [...base],
    });
    const phWarm = selectViewportMountWindow(ids(3), {
      ...opts,
      placeholderHeight: 7,
    });
    expect(phWarm).toEqual(phCold);
    expect(same.mounted.length).toBeGreaterThan(0);
  });

  test("placeholder validation branch alone: same array + same n, two placeholderHeight values", () => {
    // heights shorter than the message list: the missing tail rows resolve
    // through `placeholder`, so the sums genuinely differ per placeholder
    // value and a stale cache hit cannot hide behind `n` divergence.
    // scrollTop 0 + viewport 5 cuts inside the placeholder rows, making
    // spacerAfter depend on the placeholder value.
    const heights = [3];
    const opts = { scrollTop: 0, viewportHeight: 5, heights };
    const coldFor = (placeholderHeight: number) =>
      selectViewportMountWindow(ids(3), {
        ...opts,
        placeholderHeight,
        heights: [...heights],
      });
    // Warm the cache entry (n = 3, placeholder = 4) …
    const warm4 = selectViewportMountWindow(ids(3), {
      ...opts,
      placeholderHeight: 4,
    });
    expect(warm4).toEqual(coldFor(4));
    // … then hit the SAME array identity with the SAME n but a different
    // placeholder: only the `placeholder` check can reject the cached sums.
    const warm7 = selectViewportMountWindow(ids(3), {
      ...opts,
      placeholderHeight: 7,
    });
    expect(warm7).toEqual(coldFor(7));
    expect(warm7).not.toEqual(warm4);
    // And back to 4 against the entry last cached at 7: still validated.
    const warm4again = selectViewportMountWindow(ids(3), {
      ...opts,
      placeholderHeight: 4,
    });
    expect(warm4again).toEqual(coldFor(4));
  });
});
