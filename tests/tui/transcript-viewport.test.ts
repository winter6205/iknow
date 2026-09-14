/**
 * tests/tui/transcript-viewport.test.ts
 *
 * ChatView 视口挂载纯函数：决定哪一段 messages 进 OpenTUI 树。
 * 高度来自调用方传入的实测/占位，本模块不估算 markdown 行数。
 * 同时测 `listenScrollBoxTop`（订阅 OpenTUI `verticalScrollBar` `change`）
 * 与 `shouldCommitScrollTop`（量化 React 提交，spec invariant 8）。
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
    // spec invariant 4：内容全部落在「视口 + overscan」内时，结果必须与
    // 全量 visibleMessages.map 相同（全挂、零 spacer）。
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
    // spec invariant 4：挂载范围只看 scrollTop + 视口 + overscan，禁止
    // 「内容总高低于 N 个视口则全量挂载」的固定 N 屏短路。20 条 × 4 行 =
    // 80 行 > 视口 12，窗口仍短于总条数。
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

  test("overscan: 默认小于一屏（视口 >= 2 行），显式值不再被抬到一屏", () => {
    // spec invariant 4 / EXIT：viewport.height >= 2 时默认 overscan 严格小于
    // 一屏；显式传入的小值被尊重（小于默认 → 取默认）。
    for (const vh of [2, 4, 12, 40, 200]) {
      expect(defaultViewportOverscan(vh)).toBeLessThan(vh);
    }
    // 退化：视口 <= 1 行不存在「小于一屏」的正 overscan，实现取可达最小
    // 值 1（`Math.max(1, ...)`），该值不小于视口。spec
    // `specs/tui-transcript-viewport.md`（overscan / 提交量化条）显式记录
    // 此退化，不得被读成「恒小于一屏」。
    expect(defaultViewportOverscan(1)).toBe(1);
    expect(defaultViewportOverscan(0)).toBe(1);
    const viewportHeight = 40;
    const overscan = defaultViewportOverscan(viewportHeight);
    expect(overscan).toBeGreaterThan(0);
    expect(overscan).toBeLessThan(viewportHeight);
    // 量化步长 ≤ overscan（亚阈值滚动不会让挂载窗口追不上视口）；
    // 且 ≤ 一次滚轮步长（滚轮一步必须能推动窗口；单次滚轮能否提交由
    // chat-view-scroll.test.tsx 的行为测试认证）。
    expect(resolveScrollCommitStep(viewportHeight)).toBeLessThanOrEqual(overscan);

    // 显式更小的 overscan 被抬到默认（overscan < 默认 → 默认），
    // 显式更大的被原样尊重。窗口长度用整段挂载高度反查（height ÷ 4）。
    const explicitSmall = selectViewportMountWindow(ids(50), {
      scrollTop: 0,
      viewportHeight,
      heights: uniformHeights(50, 4),
      overscan: 2,
    });
    expect(explicitSmall.mounted.length).toBeLessThan(50);
    expect(explicitSmall.spacerAfter).toBe((50 - explicitSmall.mounted.length) * 4);
    // 默认 overscan = 视口/4 = 10 行 → 窗口覆盖视口 + overscan = 50 行；
    // 每条 4 行 → 挂载 ceil(50/4) = 13 条（区间右端取覆盖到 50 行的首条）。
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
    // 5 条 × 4 行 = 20 行 > 视口 12 + 两侧 overscan → 窗口切片（不再整段全挂）；
    // 本节只认证两次调用互不影响。
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
    // step 非有限 / <1 → 1 行：整行位移仍提交（不因坏参数吞掉真实滚动），
    // 亚行位移不作为提交（最小量子就是 1 行）。
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
    expect(shouldCommitScrollTop(40, 42, OPTS)).toBe(false); // 上滚 2 行
    expect(shouldCommitScrollTop(40, 37.1, OPTS)).toBe(false); // 下滚 <3 行
    expect(shouldCommitScrollTop(40, 43, OPTS)).toBe(true); // 跨一个量化步长
    expect(shouldCommitScrollTop(40, 37, OPTS)).toBe(true);
    expect(shouldCommitScrollTop(40, 100, OPTS)).toBe(true); // 贴底
    expect(shouldCommitScrollTop(40, 99, OPTS)).toBe(true); // 贴底（亚阈值也提交）
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
      expect(step).toBeLessThanOrEqual(
        defaultViewportOverscan(viewportHeight)
      );
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
