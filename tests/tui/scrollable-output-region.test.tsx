/** @jsxImportSource @opentui/react */
/**
 * tests/tui/scrollable-output-region.test.tsx — T3 固定高度工具输出区验收。
 *
 * 覆盖范围（bun:test）：
 *  - 空 lines：渲染不崩，ref scrollbox 不为 null，无滚动（scrollHeight ≤ 视口）；
 *  - lines ≤ height：所有行可见（首行与末行都在帧内），无滚动；
 *  - lines > height：ref 直查 scrollHeight > viewport.height，sticky 贴底
 *    （scrollTop === maxScrollTop），末行可见、首行不可见；
 *  - 强制滚底：handle.scrollToBottom() 上滚后直达底部（scrollTop === maxScrollTop）；
 *  - cols 收口：每行视觉宽度 ≤ cols（wrapMode none 截断不折行）。
 *
 * ref 直查纪律（同 chat-view-scroll）：testRender 后 waitForVisualIdle 再取 ref，
 * 滚动状态经 ScrollBoxRenderable.scrollTop / scrollHeight / viewport.height 实测，
 * 不做行数估算。
 */
import { expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import type { ScrollBoxRenderable } from "@opentui/core";
import { useEffect, useRef } from "react";
import {
  ScrollableOutputRegion,
  type ScrollableOutputRegionHandle,
  scrollableOutputRegionRows,
} from "../../src/tui/scrollable-output-region.js";

const COLS = 30;
const HEIGHT = 6;

interface Api {
  getHandle(): ScrollableOutputRegionHandle | null;
}

function Harness(props: {
  readonly lines: ReadonlyArray<string>;
  readonly cols?: number;
  readonly height?: number;
  readonly title?: string;
  readonly register: (api: Api) => void;
}): ReturnType<typeof ScrollableOutputRegion> {
  const regionRef = useRef<ScrollableOutputRegionHandle>(null);
  useEffect(() => {
    props.register({ getHandle: () => regionRef.current });
  });
  return (
    <ScrollableOutputRegion
      ref={regionRef}
      lines={props.lines}
      cols={props.cols ?? COLS}
      height={props.height ?? HEIGHT}
      title={props.title}
    />
  );
}

async function renderRegion(opts: {
  readonly lines: ReadonlyArray<string>;
  readonly cols?: number;
  readonly height?: number;
  readonly title?: string;
}): Promise<{
  setup: Awaited<ReturnType<typeof testRender>>;
  getHandle: () => ScrollableOutputRegionHandle | null;
}> {
  let api: Api | null = null;
  const setup = await testRender(
    <Harness
      lines={opts.lines}
      cols={opts.cols}
      height={opts.height}
      title={opts.title}
      register={(a) => {
        api = a;
      }}
    />,
    {
      width: opts.cols ?? COLS,
      height: opts.height ?? HEIGHT,
      exitOnCtrlC: false,
    }
  );
  await setup.waitForVisualIdle();
  if (api === null) throw new Error("harness register 未触发");
  return { setup, getHandle: () => api.getHandle() };
}

function maxScrollTop(sb: ScrollBoxRenderable): number {
  return Math.max(0, sb.scrollHeight - sb.viewport.height);
}

test("空 lines：渲染不崩，ref scrollbox 非 null，无滚动", async () => {
  const { setup, getHandle } = await renderRegion({ lines: [] });
  const sb = getHandle()?.scrollbox ?? null;
  expect(sb).not.toBeNull();
  expect(sb!.scrollTop).toBe(0);
  expect(sb!.scrollHeight).toBeLessThanOrEqual(sb!.viewport.height);
  expect(() => setup.captureCharFrame()).not.toThrow();
  await setup.renderer.destroy();
});

test("lines ≤ height：所有行可见（首行与末行都在帧内），无滚动", async () => {
  const lines = ["alpha", "beta", "gamma"];
  const { setup, getHandle } = await renderRegion({ lines });
  const sb = getHandle()!.scrollbox!;
  expect(sb.scrollHeight).toBeLessThanOrEqual(sb.viewport.height);
  expect(sb.scrollTop).toBe(0);
  const frame = setup.captureCharFrame();
  expect(frame).toContain("alpha");
  expect(frame).toContain("gamma");
  await setup.renderer.destroy();
});

test("lines > height：内部滚动，scrollHeight > viewport，sticky 贴底", async () => {
  // 超 10000 行（plan T3 验收阈值）——viewportCulling 按视口外跳过渲染，
  // 布局不崩、末行可见、首行被内部滚动折叠。
  const lines = Array.from(
    { length: 10000 },
    (_, i) => `line-${String(i).padStart(4, "0")}`
  );
  const { setup, getHandle } = await renderRegion({ lines });
  const sb = getHandle()!.scrollbox!;
  expect(sb.scrollHeight).toBeGreaterThan(sb.viewport.height);
  expect(sb.scrollTop).toBe(maxScrollTop(sb));
  const frame = setup.captureCharFrame();
  expect(frame).toContain("line-9999");
  expect(frame).not.toContain("line-0000");
  await setup.renderer.destroy();
});

test("强制滚底：handle.scrollToBottom() 从顶部直达底部并恢复跟随", async () => {
  const lines = Array.from(
    { length: 20 },
    (_, i) => `row-${String(i).padStart(2, "0")}`
  );
  const { setup, getHandle } = await renderRegion({ lines });
  const handle = getHandle()!;
  const sb = handle.scrollbox!;
  // 上滚到顶部（模拟用户回看历史）。
  sb.scrollTop = 0;
  await setup.waitForVisualIdle();
  expect(sb.scrollTop).toBe(0);
  handle.scrollToBottom();
  await setup.waitForVisualIdle();
  expect(sb.scrollTop).toBe(maxScrollTop(sb));
  expect(setup.captureCharFrame()).toContain("row-19");
  await setup.renderer.destroy();
});

test("cols 收口：每行视觉宽度 ≤ cols（长行截断不折行）", async () => {
  const cols = 20;
  const long = Array.from({ length: 8 }, (_, i) => `v${i}-${"x".repeat(60)}`);
  const { setup } = await renderRegion({ lines: long, cols });
  const frame = setup.captureCharFrame();
  const visible = frame
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => l.length > 0);
  expect(visible.length).toBeGreaterThan(0);
  for (const l of visible) {
    expect(l.length).toBeLessThanOrEqual(cols);
  }
  await setup.renderer.destroy();
});

test("行账函数 scrollableOutputRegionRows：min(lines.length, height)", () => {
  expect(scrollableOutputRegionRows([], 30, 6)).toBe(0);
  expect(scrollableOutputRegionRows(["a", "b"], 30, 6)).toBe(2);
  expect(
    scrollableOutputRegionRows(
      Array.from({ length: 12 }, (_, i) => `r${i}`),
      30,
      6
    )
  ).toBe(6);
});
