/**
 * tests/tui/transcript-viewport.test.ts
 *
 * ChatView 视口挂载纯函数：决定哪一段 messages 进 OpenTUI 树。
 * 高度来自调用方传入的实测/占位，本模块不估算 markdown 行数。
 * 同时测 `listenScrollBoxTop`：订阅 OpenTUI `verticalScrollBar` `change`。
 */
import { EventEmitter } from "node:events";
import { describe, expect, test } from "bun:test";
import {
  VIEWPORT_PLACEHOLDER_HEIGHT,
  listenScrollBoxTop,
  selectViewportMountWindow,
} from "../../src/tui/transcript-viewport.js";

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

  test("overflow: 短会话整段落在视口内 → 全量挂载、无 spacer", () => {
    const messages = ids(3);
    const w = selectViewportMountWindow(messages, {
      scrollTop: 0,
      viewportHeight: 40,
      heights: uniformHeights(3, 4),
    });
    expect(w.mounted).toEqual([...messages]);
    expect(w.spacerBefore).toBe(0);
    expect(w.spacerAfter).toBe(0);
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
    expect(b.mounted).toHaveLength(5);
    expect(b.spacerBefore).toBe(0);
    expect(b.spacerAfter).toBe(0);
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
