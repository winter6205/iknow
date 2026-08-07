/**
 * tests/tui/chat-view-banner-scroll.test.tsx
 *
 * 滚动对齐（方案 B）：banner = row window 第一段，与消息同 scroll space。
 *  - scroll=0 满屏底 → 长内容时 banner 滚出顶部（窗口底显示最新消息 + tail）；
 *  - 滚到 maxScroll → banner 完整回到顶部（行 0..bannerRows-1）；
 *  - 中段滚动 → banner 按窗口行区间裁剪；
 *  - banner 缺省（未传）→ 行为与之前完全一致（回归电池）。
 *
 * 输入框 / 状态栏由 app.tsx 在 ChatView 之外固定挂载，本组件测只覆盖内容窗。
 */
import { describe, it, expect } from "vitest";
import { renderToString } from "ink";
import React from "react";
import { ChatView } from "../../src/tui/chat-view.js";
import { createDraftSession } from "../../src/tui/session-state.js";
import type { AnthropicNativeMessage } from "../../src/harness/model-adapter/types.js";

const ANSI_RE = /\x1b\[[0-9;]*m/g;
const strip = (s: string): string => s.replace(ANSI_RE, "");
const cols = 80;
const VP = 20;

const BANNER = Array.from({ length: 14 }, (_, i) => `banner-row-${i}`);

function users(n: number): AnthropicNativeMessage[] {
  return Array.from({ length: n }, (_, i) => ({
    role: "user",
    content: [{ type: "text", text: `m-${i}` }],
  }));
}

function linesOf(args: {
  scrollRows: number;
  msgCount: number;
  bannerLines?: ReadonlyArray<string>;
}): string[] {
  const output = renderToString(
    React.createElement(ChatView, {
      session: { ...createDraftSession(), messages: users(args.msgCount) },
      cols,
      liveToolLines: [],
      askLine: undefined,
      scrollRows: args.scrollRows,
      viewportRows: VP,
      bannerLines: args.bannerLines,
    }),
    { columns: cols }
  );
  return strip(output).replace(/\n+$/, "").split("\n");
}

function render(args: {
  scrollRows: number;
  msgCount: number;
  bannerLines?: ReadonlyArray<string>;
}): string {
  return renderToString(
    React.createElement(ChatView, {
      session: { ...createDraftSession(), messages: users(args.msgCount) },
      cols,
      liveToolLines: [],
      askLine: undefined,
      scrollRows: args.scrollRows,
      viewportRows: VP,
      bannerLines: args.bannerLines,
    }),
    { columns: cols }
  );
}

describe("banner 与消息同 scroll space（输入框固定在底部）", () => {
  it("空会话 scroll=0：banner 完整可见，无消息时 maxScroll=0", () => {
    const plain = strip(
      render({ scrollRows: 0, msgCount: 0, bannerLines: BANNER })
    );
    // 14 行 banner 全在窗口内
    for (let i = 0; i < BANNER.length; i++) {
      expect(plain, `banner row ${i}`).toContain(`banner-row-${i}`);
    }
    expect(plain).not.toContain("行历史");
  });

  it("scroll=max → banner 完整回到顶部，后面是消息", () => {
    // 每条 user 消息 1 行 + 1 行外层 margin → totalRows = 2。
    // messageCursor = 40 × 2 = 80；contentRows = 14 + 80 = 94；
    // budgetScrolled = 18（VP=20 - INDICATOR_ROWS=2）；maxScroll = 94 - 18 = 76。
    const plain = strip(
      render({ scrollRows: 999, msgCount: 40, bannerLines: BANNER })
    );
    // scroll=999 → clamp 76 → endRow=18, startRow=0 → banner 14 行 + 头几条消息
    expect(plain).toContain("banner-row-0");
    expect(plain).toContain("banner-row-13");
    expect(plain).toContain("行历史");
  });

  it("scroll=0 长会话：banner 已被滚出顶部，仅显示底部消息", () => {
    const plain = strip(
      render({ scrollRows: 0, msgCount: 40, bannerLines: BANNER })
    );
    // scroll=0 → endRow=94; startRow = max(0, 94 - budget). budget=18（chrome=2）,
    // startRow = 76。banner 段 [0,14) 全部 < 76 → banner 不渲染
    expect(plain).not.toContain("banner-row-0");
    // 最新消息（m-39）可见（行 14+78=92 ≤ 94）
    expect(plain).toContain("m-39");
    expect(plain).not.toContain("行历史");
  });

  it("中段滚动：banner 按窗口行区间裁剪（不全见、也不全隐）", () => {
    // contentRows=94, maxScroll=76. scroll=70 → endRow=24, startRow=6.
    // banner 段 [0,14) → 裁剪 [6,14) → banner-row-6..13 可见。
    const plain = strip(
      render({ scrollRows: 70, msgCount: 40, bannerLines: BANNER })
    );
    expect(plain).toContain("banner-row-6");
    expect(plain).toContain("banner-row-13");
    // 滚出去的 banner 行不渲染
    expect(plain).not.toContain("banner-row-0");
    expect(plain).not.toContain("banner-row-5");
  });

  it("banner 缺省（未传 bannerLines）：滚动行为完全不变", () => {
    // 回归：未传 bannerLines 时等价于 bannerRows=0，旧 chat-view 数学。
    const baseline = linesOf({ scrollRows: 0, msgCount: 40 });
    for (const s of [3, 6, 12, 24, 999]) {
      expect(
        linesOf({ scrollRows: s, msgCount: 40 }).length,
        `scroll=${s} 行数`
      ).toBe(baseline.length);
    }
  });
});
