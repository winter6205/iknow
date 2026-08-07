/**
 * tests/tui/chat-view-banner-scroll.test.tsx
 *
 * Banner STICKY + 行级窗口回归电池（2026-08-08 banner-sticky 修复定稿）：
 *  - banner 是 ChatView 的独立 sticky 段，**永不裁剪**；
 *  - 消息区用独立 row window（高 = viewport - bannerRows）；
 *  - scroll=0 消息窗口底 = 消息段底（auto-follow 最新消息）；
 *  - scroll>0 消息窗口上移 scroll 行（clamp 到 maxScroll = messageRows - messageViewport）；
 *  - 无「↑ N 行历史」指示、无「↓ N 行正在生成」折叠（2026-08-07 移除）；
 *  - banner 缺省（未传）→ bannerRows=0 → 消息区 = 全 viewport（回归兼容）。
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

describe("banner 行级窗口语义：banner sticky 恒见，消息区独立滚动", () => {
  // 40 条 user 消息 × 2 rows = 80；banner 14 行。STICKY：banner 恒 [0,14) 完整
  // 渲染，不参与消息滚动。消息段 messageRows = 80，viewport=20 → messageViewport
  // = 20 - 14 = 6。maxScroll = 80 - 6 = 74。

  it("scroll=0：auto-follow 底，最新消息 + banner 恒完整可见", () => {
    // STICKY：banner 恒 [0,14)。消息窗口 = [80-6, 80) = [74, 80)。
    // 消息段 0-based startRow：m-37@74, m-38@76, m-39@78 在窗口内。
    const plain = strip(
      render({ scrollRows: 0, msgCount: 40, bannerLines: BANNER })
    );
    // 最新消息可见（auto-follow 底）
    expect(plain).toContain("m-39");
    expect(plain).toContain("m-38");
    // STICKY：banner 恒见（不再与消息共享 scroll space 被顶掉）
    expect(plain).toContain("banner-row-0");
    expect(plain).toContain("banner-row-13");
    // 无滚动指示
    expect(plain).not.toContain("行历史");
    expect(plain).not.toContain("行正在生成");
  });

  it("scroll>0：banner 恒见，消息窗口上移到顶（最早消息可见）", () => {
    // scroll=999 → clamp 74 → 消息窗口 [80-6-74, 80-74) = [0, 6)。
    // banner [0,14) 恒全见；m-0@0, m-1@2, m-2@4 进入消息窗口。
    const plain = strip(
      render({ scrollRows: 999, msgCount: 40, bannerLines: BANNER })
    );
    // 完整 banner 恒见（sticky，不依赖 scroll）
    for (let i = 0; i < BANNER.length; i++) {
      expect(plain, `banner row ${i}`).toContain(`banner-row-${i}`);
    }
    // 较早消息可见
    expect(plain).toContain("m-0");
    expect(plain).toContain("m-1");
    // 最新消息被消息窗口底切
    expect(plain).not.toContain("m-39");
    // 无滚动指示
    expect(plain).not.toContain("行历史");
    expect(plain).not.toContain("行正在生成");
  });

  it("scroll=999：clamp 到 maxScroll=74；消息窗口上移 74 行至消息流顶", () => {
    // STICKY：banner 14 恒见；消息段 messageRows=80，maxScroll = 80-6 = 74。
    // scroll=999 → clamp 74 → 消息窗口 [0, 6)：露出消息流顶段（m-0..m-2）。
    const plain = strip(
      render({ scrollRows: 999, msgCount: 40, bannerLines: BANNER })
    );
    // 内容顶段可见（banner sticky 恒见 + 最早消息）
    expect(plain).toContain("banner-row-0");
    expect(plain).toContain("m-0");
    // 渲染 = banner(14) + 消息窗口(6) = 20 行，末尾 margin 折叠 → 19。
    // 最新消息在屏外
    expect(plain.replace(/\n+$/, "").split("\n").length).toBe(VP - 1);
    expect(plain).not.toContain("m-39");
  });

  it("scroll 中间档：消息窗口夹在中间（banner 恒完整，顶部/底部消息均被裁）", () => {
    // STICKY：banner 14 恒见。消息窗口 scroll=30 → endRow = 80-30 = 50,
    // startRow = 50-6 = 44 → [44, 50)。消息段 0-based startRow：m-22@44…m-24@48
    // 在窗口内；m-0 在消息段顶之外、m-39 在窗口底之下被切。
    const plain = strip(
      render({ scrollRows: 30, msgCount: 40, bannerLines: BANNER })
    );
    // 中间窗口可见
    expect(plain).toContain("m-22");
    expect(plain).toContain("m-24");
    // 顶部被裁：早消息（banner 恒见，不被裁）
    expect(plain).toContain("banner-row-0");
    expect(plain).not.toContain("m-0");
    // 底部被裁：最新消息
    expect(plain).not.toContain("m-39");
  });

  it("banner 缺省（未传 bannerLines）：滚动行为完全不变", () => {
    // header 缺省 → bannerRows=0，messageRows = 80，messageViewport = viewport=20。
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

/**
 * ── 边界电池：banner STICKY（TDD RED，2026-08-08）──
 *
 * 目标语义（app.tsx:213-216 注释：「banner 任何时候都保持完整眼」）：
 * banner 是 ChatView 的**独立 sticky 段**，不参与消息的 row window 滚动。
 * 消息区用独立 row window（高 = viewport - bannerRows）。
 *
 * 当前实现（chat-view.tsx）把 banner 当作 row-window 第一段内容（与消息
 * 共享 scroll space）。当 contentRows > viewport 且 scroll=0（auto-follow
 * 底）时 banner 顶被窗口 [contentRows - viewport, contentRows) 顶掉——与
 * 目标语义冲突。以下 5 个测试在**当前实现下必须 RED**（TDD）。
 *
 * 每测试的期望断言 = 新语义（sticky banner）下应成立的真值。
 */
describe("banner STICKY 边界（新语义，当前实现应 RED）", () => {
  const B15 = Array.from({ length: 15 }, (_, i) => `banner-row-${i}`);

  it("1. 空会话（0 消息）+ banner 完整：viewport=20 全可见", () => {
    // 当前/目标：banner 15 行 + 0 消息。sticky 语义下 banner 全见。
    const plain = strip(
      render({ scrollRows: 0, msgCount: 0, bannerLines: B15 })
    );
    for (let i = 0; i < B15.length; i++) {
      expect(plain, `空会话 banner row ${i}`).toContain(`banner-row-${i}`);
    }
  });

  it("2. 消息刚超过 viewport：contentRows=25>20，scroll=0 banner 仍全见 + 最新消息可见", () => {
    // banner 15 行 + 5 消息 × 2 行 = 10 → contentRows = 15 + 10 = 25 > 20。
    // 当前 scroll=0 窗口 = [25-20, 25) = [5, 25)：banner-row-0..4 被顶掉。
    // sticky 语义：banner 15 行全见，消息区 5 行窗口贴底 → 最新 m-4 可见。
    const plain = strip(
      render({ scrollRows: 0, msgCount: 5, bannerLines: B15 })
    );
    for (let i = 0; i < B15.length; i++) {
      expect(plain, `scroll=0 banner row ${i}`).toContain(`banner-row-${i}`);
    }
    expect(plain).toContain("m-4");
  });

  it("3. scroll=999 长会话：clamp 后 banner 仍完整 + 最早消息可见", () => {
    // banner 14 行 + 40 消息 × 2 = 80 → contentRows = 94。viewport=20。
    // sticky 语义：banner 14 行恒见；消息区 6 行窗口 clamp 在消息流顶 →
    // 最早消息可见。
    const B14 = Array.from({ length: 14 }, (_, i) => `banner-row-${i}`);
    const plain = strip(
      render({ scrollRows: 999, msgCount: 40, bannerLines: B14 })
    );
    for (let i = 0; i < B14.length; i++) {
      expect(plain, `clamp banner row ${i}`).toContain(`banner-row-${i}`);
    }
    expect(plain).toContain("m-0");
  });

  it("4. scroll=0 长会话 auto-follow（用户主诉场景）：banner 仍完整 + 最新消息可见", () => {
    // banner 14 行 + 40 消息 × 2 = 80 → contentRows = 94 > viewport=20。
    // 当前 scroll=0 窗口 = [74, 94)：banner [0,14) < 74 全被顶掉。
    // sticky 语义：banner 14 行全见；消息区 6 行窗口贴底 → 最新 m-39 可见。
    const B14 = Array.from({ length: 14 }, (_, i) => `banner-row-${i}`);
    const plain = strip(
      render({ scrollRows: 0, msgCount: 40, bannerLines: B14 })
    );
    for (let i = 0; i < B14.length; i++) {
      expect(plain, `auto-follow banner row ${i}`).toContain(`banner-row-${i}`);
    }
    expect(plain).toContain("m-39");
  });

  it("5. banner 缺省（不传 bannerLines）：行为完全不变（消息区 = 全 viewport）", () => {
    // 不传 bannerLines → bannerRows=0 → sticky 语义下 messageViewport = viewport，
    // 与当前实现完全一致。回归：行数恒 = viewport-1（末尾 margin 折叠）。
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
