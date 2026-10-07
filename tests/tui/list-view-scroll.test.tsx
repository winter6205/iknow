/** @jsxImportSource @opentui/react */
/**
 * tests/tui/list-view-scroll.test.tsx
 *
 * Session-list "search + viewport paging" behavior:
 *  - listEntryMatches pure function: substring match on title / lastFinalText,
 *    case-insensitive, blank query matches everything；
 *  - viewport window: within the rows budget only "search box + header +
 *    visible rows" render; when sessions exceed the viewport a scroll
 *    indicator appears and the overflow is not rendered (prevents whole-frame overflow);
 *  - interaction (mockInput-driven): typing filters, ↑↓ moving past a
 *    viewport edge triggers paging, PageUp/PageDown pages, Home/End jump
 *    top/bottom, Esc clears the search vs. returns to chat, Enter opens
 *    (onOpen callback carries the index).
 */
import { expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import {
  ListView,
  listEntryMatches,
  relativeTime,
  type TuiListEntry,
} from "../../src/tui/list-view.js";

/** Polling frame waiter: mockInput bytes parse asynchronously through stdin,
 *  so renderOnce each pass until the predicate holds (setup.waitFor* breaks
 *  early when the scheduler is idle, unsuitable for typing). */
async function untilFrame(
  setup: Awaited<ReturnType<typeof testRender>>,
  pred: (frame: string) => boolean,
  ms = 3000
): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    await new Promise((r) => setTimeout(r, 15));
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    if (pred(frame)) return frame;
  }
  throw new Error(`untilFrame timeout:\n${setup.captureCharFrame()}`);
}

function makeEntry(
  id: string,
  title: string,
  lastFinalText = "",
  runningBg = false
): TuiListEntry {
  return {
    conversation_id: id,
    updatedAt: new Date().toISOString(),
    lastFinalText,
    title,
    runningBg,
    bindingStatus: "unbound",
  };
}

const manyEntries: ReadonlyArray<TuiListEntry> = Array.from(
  { length: 20 },
  (_, i) =>
    makeEntry(
      `conv-${String(i).padStart(2, "0")}`,
      `会话 ${String(i).padStart(2, "0")} 的摘要`,
      i % 4 === 0 ? `回答 ${i}` : ""
    )
);

function renderList(
  entries: ReadonlyArray<TuiListEntry>,
  opts: {
    rows?: number;
    onOpen?: (index: number) => void;
    onBack?: () => void;
  }
) {
  return testRender(
    <ListView
      entries={entries}
      cols={100}
      rows={opts.rows ?? 11}
      onOpen={opts.onOpen ?? (() => {})}
      onBack={opts.onBack ?? (() => {})}
    />,
    { width: 100, height: 30, exitOnCtrlC: false }
  );
}

test("listEntryMatches：空 / 空白 query → 全部匹配", () => {
  const entry = makeEntry("c1", "部署流程排查", "权限报错 403 access-denied");
  expect(listEntryMatches(entry, "")).toBe(true);
  expect(listEntryMatches(entry, "   ")).toBe(true);
});

test("listEntryMatches：title / lastFinalText 子串匹配（英文不区分大小写）", () => {
  const entry = makeEntry("c1", "部署流程排查", "权限报错 403 access-denied");
  expect(listEntryMatches(entry, "部署")).toBe(true);
  expect(listEntryMatches(entry, "排查")).toBe(true);
  expect(listEntryMatches(entry, "权限报错")).toBe(true);
  expect(listEntryMatches(entry, "403")).toBe(true);
  expect(listEntryMatches(entry, "ACCESS")).toBe(true);
  expect(listEntryMatches(entry, "access")).toBe(true);
  expect(listEntryMatches(entry, "不存在的关键词")).toBe(false);
  expect(listEntryMatches(entry, "xyz")).toBe(false);
});

test("relativeTime：分钟 / 小时 / 天前分档", () => {
  const now = new Date("2026-08-09T12:00:00Z");
  const iso = (minus: number) =>
    new Date(now.getTime() - minus * 60_000).toISOString();
  expect(relativeTime(iso(0), now)).toBe("刚刚");
  expect(relativeTime(iso(3), now)).toBe("3 分钟前");
  expect(relativeTime(iso(120), now)).toBe("2 小时前");
  expect(relativeTime(iso(60 * 24 * 2), now)).toBe("2 天前");
  expect(relativeTime("not-a-date", now)).toBe("");
});

test("视口窗口：rows 预算内有限可视行，超出部分不渲染", async () => {
  const setup = await renderList(manyEntries, { rows: 11 });
  await setup.renderOnce();
  const frame = setup.captureCharFrame();
  expect(frame).toContain("搜索会话");
  expect(frame).toContain("会话列表");
  // Row accounting SSOT: 6-row viewport (rows=11 → viewHeight=6) = pseudo-entry + 5 visible sessions.
  expect(frame).toContain("+ 新建会话");
  expect(frame).toContain("会话 00 的摘要");
  expect(frame).toContain("会话 04 的摘要");
  // From the 6th session (index 5) on, rows are clipped by the viewport.
  expect(frame).not.toContain("会话 05 的摘要");
  // Bottom scroll indicator appears.
  expect(frame).toContain("↓ 更多");
  await setup.renderer.destroy();
});

test("视口窗口：预算内全部可见 → 无滚动指示", async () => {
  const setup = await renderList(manyEntries.slice(0, 5), { rows: 11 });
  await setup.renderOnce();
  const frame = setup.captureCharFrame();
  expect(frame).not.toContain("↓ 更多");
  expect(frame).not.toContain("↑ 更多");
  expect(frame).not.toContain("会话 05");
  await setup.renderer.destroy();
});

test("空列表 → 提示 Enter 新建", async () => {
  const setup = await renderList([], { rows: 11 });
  await setup.renderOnce();
  expect(setup.captureCharFrame()).toContain("暂无会话");
  await setup.renderer.destroy();
});

test("键入搜索过滤：只显示匹配会话", async () => {
  const setup = await renderList(manyEntries, { rows: 8 });
  await setup.renderOnce();
  await setup.mockInput.typeText("04");
  const frame = await untilFrame(setup, (f) => f.includes("会话 04 的摘要"));
  expect(frame).not.toContain("会话 03 的摘要");
  expect(frame).not.toContain("会话 05 的摘要");
  await setup.renderer.destroy();
});

test("无匹配 → 提示「无匹配会话」，伪条目仍在", async () => {
  const setup = await renderList(manyEntries, { rows: 8 });
  await setup.renderOnce();
  await setup.mockInput.typeText("zzz");
  const frame = await untilFrame(setup, (f) => f.includes("无匹配会话"));
  expect(frame).toContain("+ 新建会话");
  expect(frame).not.toContain("会话 00 的摘要");
  await setup.renderer.destroy();
});

test("Esc 清空搜索（非返回）；再 Esc 返回聊天视图", async () => {
  let backCalled = 0;
  const setup = await renderList(manyEntries, {
    rows: 8,
    onBack: () => {
      backCalled += 1;
    },
  });
  await setup.renderOnce();
  await setup.mockInput.typeText("04");
  await untilFrame(setup, (f) => f.includes("会话 04 的摘要"));
  // Esc → clears the search, the full list returns, and onBack is not triggered.
  setup.mockInput.pressEscape();
  await untilFrame(setup, (f) => f.includes("会话 00 的摘要"));
  expect(backCalled).toBe(0);
  // Esc again → back to the chat view.
  setup.mockInput.pressEscape();
  await untilFrame(setup, () => backCalled === 1);
  expect(backCalled).toBe(1);
  await setup.renderer.destroy();
});

test("Backspace 删除搜索字符", async () => {
  const setup = await renderList(manyEntries, { rows: 8 });
  await setup.renderOnce();
  await setup.mockInput.typeText("04x");
  await untilFrame(setup, (f) => f.includes("无匹配会话"));
  setup.mockInput.pressBackspace();
  const frame = await untilFrame(setup, (f) => f.includes("会话 04 的摘要"));
  expect(frame).not.toContain("无匹配会话");
  await setup.renderer.destroy();
});

test("↑↓ 移出视口边缘翻页；Home/End 跳顶/跳底", async () => {
  const setup = await renderList(manyEntries, { rows: 11 });
  await setup.renderOnce();
  // Initial viewport is 6 rows (rows=11 → viewHeight=6): pseudo-entry + sessions 00..04.
  let frame = setup.captureCharFrame();
  expect(frame).toContain("会话 00 的摘要");
  expect(frame).not.toContain("会话 05 的摘要");
  // Repeated ↓ past the viewport bottom triggers paging; cursor reaches index 8 (session 07).
  for (let i = 0; i < 8; i++) setup.mockInput.pressArrow("down");
  frame = await untilFrame(setup, (f) => f.includes("会话 05 的摘要"));
  expect(frame).toContain("会话 07 的摘要");
  // End → jump to bottom: last session visible, bottom indicator gone.
  setup.mockInput.pressKey("END");
  frame = await untilFrame(setup, (f) => f.includes("会话 19 的摘要"));
  expect(frame).not.toContain("↓ 更多");
  // Home → jump to top: back to session 00, top indicator gone.
  setup.mockInput.pressKey("HOME");
  frame = await untilFrame(setup, (f) => f.includes("会话 00 的摘要"));
  expect(frame).not.toContain("↑ 更多");
  await setup.renderer.destroy();
});

test("PageDown/PageUp 整页翻页（滚动指示随之出现 / 消失）", async () => {
  const setup = await renderList(manyEntries, { rows: 11 });
  await setup.renderOnce();
  // viewHeight=6: one PageDown → scrollTop=6, sessions from 05 become visible and the top indicator appears.
  setup.mockInput.pressKey("\u001b[6~"); // PageDown
  let frame = await untilFrame(setup, (f) => f.includes("会话 06 的摘要"));
  expect(frame).toContain("↑ 更多");
  // PageUp back to the top.
  setup.mockInput.pressKey("\u001b[5~"); // PageUp
  frame = await untilFrame(setup, (f) => f.includes("会话 00 的摘要"));
  expect(frame).not.toContain("↑ 更多");
  await setup.renderer.destroy();
});

test("Enter 打开：伪条目 onOpen(0)；↓ 后 Enter onOpen(1)", async () => {
  const opened: number[] = [];
  const setup = await renderList(manyEntries, {
    rows: 11,
    onOpen: (i) => {
      opened.push(i);
    },
  });
  await setup.renderOnce();
  setup.mockInput.pressEnter();
  await untilFrame(setup, () => opened.length === 1);
  expect(opened).toEqual([0]);
  setup.mockInput.pressArrow("down");
  await untilFrame(setup, (f) => f.includes("> 会话 00 的摘要"));
  setup.mockInput.pressEnter();
  await untilFrame(setup, () => opened.length === 2);
  expect(opened).toEqual([0, 1]);
  await setup.renderer.destroy();
});

test("running-bg 会话行带 [运行中] 静态标记", async () => {
  const setup = await renderList(
    [makeEntry("c-run", "运行中的会话", "", true)],
    { rows: 11 }
  );
  await setup.renderOnce();
  expect(setup.captureCharFrame()).toContain("[运行中]");
  await setup.renderer.destroy();
});

test("空标题会话行回退为 (未命名)，不再渲染 (空)", async () => {
  // The store's presentation projection hides blank titles, except an invalid
  // workspace binding — which stays listed so it can be rebound. That exception
  // is the one path where a blank title still reaches the picker, so the row
  // fallback label is the user-visible contract pinned here.
  const setup = await renderList([makeEntry("c-blank", "")], { rows: 11 });
  await setup.renderOnce();
  const frame = setup.captureCharFrame();
  expect(frame).toContain("(未命名)");
  expect(frame).not.toContain("(空)");
  await setup.renderer.destroy();
});
