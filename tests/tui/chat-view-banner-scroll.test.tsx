/**
 * tests/tui/chat-view-banner-scroll.test.tsx
 *
 * Sticky 头语义回归电池（2026-08-07 用户复看裁定）：
 *  - banner 常驻 ChatView 顶部（不参与 row window 滚动），消息在下面独立
 *    row window 滚动；
 *  - 「对话跟logo应在同一个窗口」= 同一聊天区，logo 不滚走；
 *  - scroll>0 时「↑ N 行历史」指示出现且 clamp 到 maxScroll；scroll=0 时
 *    banner + 最新消息均可见，banner 永远不滚出窗口；
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

describe("sticky 头语义：banner 常驻顶部（不参与 row window 滚动）", () => {
  it("scroll=0：banner 永远全见 + 最新消息全见，无指示", () => {
    const plain = strip(
      render({ scrollRows: 0, msgCount: 40, bannerLines: BANNER })
    );
    // Sticky 头：banner 14 行全部在 ChatView 顶部渲染，不随消息滚出。
    for (let i = 0; i < BANNER.length; i++) {
      expect(plain, `banner row ${i}`).toContain(`banner-row-${i}`);
    }
    // 最新消息（m-39）也可见（消息 row window 仍按原逻辑跑）
    expect(plain).toContain("m-39");
    // scroll=0 无指示
    expect(plain).not.toContain("行历史");
  });

  it("scroll>0：banner 仍全见（sticky），顶部出现「↑ N 行历史」指示", () => {
    const plain = strip(
      render({ scrollRows: 999, msgCount: 40, bannerLines: BANNER })
    );
    // Sticky 头：无论 scroll 多大，banner 14 行始终在顶部渲染。
    for (let i = 0; i < BANNER.length; i++) {
      expect(plain, `banner row ${i}`).toContain(`banner-row-${i}`);
    }
    // 滚到顶 → 顶部 dim「↑ N 行历史」指示出现（消息行 window 反映历史）
    expect(plain).toContain("行历史");
  });

  it("scroll=999：clamp 到 maxScroll；指示数字 = maxScroll（消息行 window 行为不变）", () => {
    // 每条 user 消息 1 content + 1 margin = 2 rows。messageCursor=80。
    // viewport=20, chromeScrolled=2 (no tail) → budgetScrolled=18。
    // maxScroll=max(0, 80-18)=62；scroll=999 → clamp 62 → 指示「↑ 62 行历史」。
    const plain = strip(
      render({ scrollRows: 999, msgCount: 40, bannerLines: BANNER })
    );
    expect(plain).toMatch(/↑ 62 行历史/);
  });

  it("banner 缺省（未传 bannerLines）：滚动行为完全不变", () => {
    // 回归：未传 bannerLines 时等价于 bannerRows=0，消息行 window 行为与原
    // 一致——所有 scroll 档渲染行数都等于 scroll=0 基线（指示器换内容，行数
    // 不变；用 split-line count 比 raw length 准）。
    const linesOf = (s: number): string[] =>
      strip(render({ scrollRows: s, msgCount: 40 }))
        .replace(/\n+$/, "")
        .split("\n");
    const baseline = linesOf(0);
    for (const s of [3, 6, 12, 24, 999]) {
      expect(linesOf(s).length, `scroll=${s} 行数`).toBe(baseline.length);
    }
  });
});
