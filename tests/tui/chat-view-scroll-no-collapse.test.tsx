/**
 * tests/tui/chat-view-scroll-no-collapse.test.tsx
 *
 * Regression for the "消息减少" symptom (TUI wheel-up collapses the message
 * window instead of sliding it). The invariant: scrolling must NEVER shrink
 * the rendered message window — it slides the window, never collapses it.
 *
 * Root cause: ChatView clamp max = messageCursor + tailRows let `scroll` grow
 * until endRow = messageCursor - scroll dropped below the window height
 * `budget`; startRow was floored at 0, so the window shrank from the bottom
 * instead of stopping at the top.
 *
 * Fix: maxScroll = max(0, messageCursor - budgetScrolled) for limited viewport
 * (and the same expression handles unlimited correctly). Short content
 * (messageCursor <= budget) has nothing to scroll up to → maxScroll = 0 and
 * the indicator never appears.
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

function userMessages(n: number): AnthropicNativeMessage[] {
  const out: AnthropicNativeMessage[] = [];
  for (let i = 0; i < n; i++) {
    out.push({ role: "user", content: [{ type: "text", text: `m-${i}` }] });
  }
  return out;
}

function linesOf(scrollRows: number, msgCount: number): string[] {
  const output = renderToString(
    React.createElement(ChatView, {
      session: { ...createDraftSession(), messages: userMessages(msgCount) },
      cols,
      liveToolLines: [],
      askLine: undefined,
      scrollRows,
      viewportRows: VP,
    }),
    { columns: cols }
  );
  return strip(output).replace(/\n+$/, "").split("\n");
}

describe("wheel-up slides the window, never collapses messages", () => {
  it("TALL transcript: rendered row count never shrinks below the scroll=0 baseline", () => {
    const baseline = linesOf(0, 40).length;
    for (const s of [3, 6, 9, 12, 15, 18, 21, 62, 999]) {
      const lines = linesOf(s, 40);
      expect(lines.length, `scroll=${s} rows`).toBe(baseline);
    }
  });

  it("TALL over-scroll clamps at the top: shows m-0 with full-height window", () => {
    const plain = strip(renderToStringAt(999, 40));
    expect(plain).toContain("m-0");
    expect(plain).toContain("m-1");
    // 朴素滚动无「↑ N 行历史」指示（2026-08-07 移除）。
    expect(plain).not.toContain("行历史");
    expect(linesOf(999, 40).length).toBe(linesOf(0, 40).length);
  });

  it("SHORT transcript (fits viewport): every scroll keeps all messages visible", () => {
    for (const s of [0, 3, 6, 9, 999]) {
      const plain = strip(renderToStringAt(s, 3));
      expect(plain, `scroll=${s} m-0`).toContain("m-0");
      expect(plain, `scroll=${s} m-1`).toContain("m-1");
      expect(plain, `scroll=${s} m-2`).toContain("m-2");
    }
  });

  it("SHORT transcript: row count never shrinks below baseline", () => {
    const baseline = linesOf(0, 3).length;
    for (const s of [3, 6, 9, 999]) {
      expect(linesOf(s, 3).length, `scroll=${s} rows`).toBe(baseline);
    }
  });
});

function renderToStringAt(scrollRows: number, msgCount: number): string {
  return renderToString(
    React.createElement(ChatView, {
      session: { ...createDraftSession(), messages: userMessages(msgCount) },
      cols,
      liveToolLines: [],
      askLine: undefined,
      scrollRows,
      viewportRows: VP,
    }),
    { columns: cols }
  );
}
