/**
 * tests/tui/chat-view-banner-scroll.test.tsx
 *
 * Banner + 行级窗口回归电池（2026-08-07 用户复看定稿）：
 *  - banner 是 ChatView row window 的第一段内容（与消息同一 scroll space）；
 *  - scroll=0 窗口底 = 内容底（auto-follow）：最新消息可见，banner 在长会话
 *    里随内容滚出顶部；
 *  - scroll>0 窗口上移：banner 段重新进入窗口，较早消息可见；
 *  - scroll 越界由 ChatView clamp 到 maxScroll = contentRows - viewport；
 *  - 无「↑ N 行历史」指示、无「↓ N 行正在生成」折叠（2026-08-07 移除）；
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

describe("banner 行级窗口语义：banner 与消息共享 scroll space", () => {
  // 40 条 user 消息 × 2 rows = 80；banner 14 行。contentRows = 94。
  // viewport = 20。maxScroll = 94 - 20 = 74。

  it("scroll=0：auto-follow 底，最新消息可见，长会话中 banner 滚出顶部", () => {
    // 窗口 = [94-20, 94) = [74, 94)。消息 startRow = 14 + 2i：
    // m-37 @88, m-38 @90, m-39 @92 在窗口内；banner 行 [0,14) < 74 → 被顶掉。
    const plain = strip(
      render({ scrollRows: 0, msgCount: 40, bannerLines: BANNER })
    );
    // 最新消息可见（auto-follow 底）
    expect(plain).toContain("m-39");
    expect(plain).toContain("m-38");
    // banner 段在长会话滚动下被窗口顶掉（与消息共享同一 scroll space）
    expect(plain).not.toContain("banner-row-0");
    expect(plain).not.toContain("banner-row-13");
    // 无滚动指示
    expect(plain).not.toContain("行历史");
    expect(plain).not.toContain("行正在生成");
  });

  it("scroll>0：窗口上移，banner 段重新进入窗口（滚到顶见完整 banner）", () => {
    // scroll=999 → clamp 74 → 窗口 = [94-20-74, 94-74) = [0, 20)。
    // banner [0,14) 全见 + m-0 @14, m-1 @16, m-2 @18 进入窗口。
    const plain = strip(
      render({ scrollRows: 999, msgCount: 40, bannerLines: BANNER })
    );
    // 完整 banner 可见
    for (let i = 0; i < BANNER.length; i++) {
      expect(plain, `banner row ${i}`).toContain(`banner-row-${i}`);
    }
    // 较早消息可见
    expect(plain).toContain("m-0");
    expect(plain).toContain("m-1");
    // 最新消息被窗口底切
    expect(plain).not.toContain("m-39");
    // 无滚动指示
    expect(plain).not.toContain("行历史");
    expect(plain).not.toContain("行正在生成");
  });

  it("scroll=999：clamp 到 maxScroll=74；窗口上移 74 行至内容顶", () => {
    // contentRows = 14 + 80 = 94，viewport = 20 → maxScroll = 74。
    // scroll=999 → clamp 74 → 窗口 [0, 20)：露出内容流顶段（banner + 早消息）。
    const plain = strip(
      render({ scrollRows: 999, msgCount: 40, bannerLines: BANNER })
    );
    // 内容顶段可见
    expect(plain).toContain("banner-row-0");
    expect(plain).toContain("m-0");
    // 窗口盖住一屏（viewport-1：末尾 margin 行 ink 折叠）；最新消息在屏外
    expect(plain.replace(/\n+$/, "").split("\n").length).toBe(VP - 1);
    expect(plain).not.toContain("m-39");
  });

  it("scroll 中间档：窗口夹在中间，顶部与底部内容均被裁", () => {
    // scroll=30：endRow = 94-30 = 64, startRow = 64-20 = 44。
    // 消息 startRow = 14+2i：m-15 @44, …, m-24 @62。banner [0,14) < 44 被顶掉；
    // m-25 @64+ 在窗口底之下被切。
    const plain = strip(
      render({ scrollRows: 30, msgCount: 40, bannerLines: BANNER })
    );
    // 中间窗口可见
    expect(plain).toContain("m-15");
    expect(plain).toContain("m-24");
    // 顶部被裁：banner + 早消息
    expect(plain).not.toContain("banner-row-0");
    expect(plain).not.toContain("m-0");
    // 底部被裁：最新消息
    expect(plain).not.toContain("m-39");
  });

  it("banner 缺省（未传 bannerLines）：滚动行为完全不变", () => {
    // header 缺省 → bannerRows=0，contentRows = 80。viewport=20。
    // 对任意 scroll 档窗口始终高 viewport 行（scroll 越界 clamp 到 60），
    // 渲染行数恒等于 viewport-1（末尾 margin 行 ink 折叠，split-line count
    // 比 raw length 准）。回归断言：各 scroll 档行数 = 基线行数。
    const linesOf = (s: number): string[] =>
      strip(render({ scrollRows: s, msgCount: 40 }))
        .replace(/\n+$/, "")
        .split("\n");
    const baseline = linesOf(0);
    for (const s of [3, 6, 12, 24, 999]) {
      expect(linesOf(s).length, `scroll=${s} 行数`).toBe(baseline.length);
    }
    expect(baseline.length).toBe(VP - 1);
  });
});
