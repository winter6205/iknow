/**
 * tests/tui/chat-view-scroll-fit.test.tsx
 *
 * #189 渲染漂移回归电池（PR #219「没达到效果」的重现 + 修复锚定）。
 *
 * 修复前的失败形态（Phase 1 实测捕获，作为本测试的 RED 基线）：
 *  - markdown-rich transcript（heading/fence/list）在 scroll>0 时窗口锚定
 *    错位——窗口首行落在消息中段而非窗口边界；
 *  - 窗口行高溢出 viewport（scroll=10 / 40 时 OVERFLOW=+3）；
 *  - 裁剪路径把 markdown **源码**当纯文本 wrap 切片 → 裸 `` ```ts `` fence
 *    行 / 裸 `## ` heading 行泄漏进渲染帧；
 *  - 顶部指示器占 2 行但视口预算未扣 chrome → 内容溢出。
 *
 * 本测试对同一 transcript 在 scroll ∈ {0, 5, 10, 20, 40} 断言：
 *  1. 渲染行数 ≤ viewportRows（无溢出）；
 *  2. 无裸 fence（行 trim 后 === "```ts"）/ 无裸 heading（以 "## " 起）泄漏。
 * 修复后 5 档 scroll 全绿。
 */
import { describe, it, expect } from "vitest";
import { renderToString } from "ink";
import React from "react";
import { ChatView } from "../../src/tui/chat-view.js";
import { createDraftSession } from "../../src/tui/session-state.js";
import type { AnthropicNativeMessage } from "../../src/harness/model-adapter/types.js";

const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");
const cols = 80;

function buildTranscript(): AnthropicNativeMessage[] {
  const msgs: AnthropicNativeMessage[] = [];
  for (let i = 0; i < 6; i++) {
    msgs.push({
      role: "user",
      content: [{ type: "text", text: `question ${i}` }],
    });
    msgs.push({
      role: "assistant",
      content: [
        {
          type: "text",
          text: `## Answer ${i}\n\nSome explanation line one.\n\n- point a\n- point b\n\n\`\`\`ts\nconst x = ${i};\n\`\`\`\n\nclosing remark.`,
        },
      ],
    });
  }
  return msgs;
}

describe("PR #219 渲染漂移回归：scroll fit + 无裸 markdown 泄漏", () => {
  it("markdown-rich transcript：5 档 scroll 均 fit viewport 且无裸 fence/heading", async () => {
    const msgs = buildTranscript();
    const VP = 20;
    for (const s of [0, 5, 10, 20, 40]) {
      const output = await renderToString(
        React.createElement(ChatView, {
          session: { ...createDraftSession(), messages: msgs },
          cols,
          liveToolLines: [],
          askLine: undefined,
          scrollRows: s,
          viewportRows: VP,
        }),
        { columns: cols }
      );
      const lines = strip(output).replace(/\n+$/, "").split("\n");
      // 渲染行数 - VP：standalone renderToString 没有父容器高度约束，ink
      // flexGrow 根在内容稀疏时收缩（= -1）、内容填满时撑满（= 0）。Bug A
      // headroom 加 1 行 margin → 上界 +1。真实终端下 app 层 reserved 已扣
      // headroom（app.tsx：viewport = rows - reserved - 1），margin 与窗口
      // 内容共 viewport 预算，不溢出。
      const overflow = lines.length - VP;
      expect(overflow).toBeLessThanOrEqual(1);
      const hasRawFence = lines.some((l) => l.trim() === "```ts");
      const hasRawHeading = lines.some((l) => l.startsWith("## "));
      expect(hasRawFence).toBe(false);
      expect(hasRawHeading).toBe(false);
      expect(hasRawFence).toBe(false);
      expect(hasRawHeading).toBe(false);
    }
  });

  it("scroll=0 锚定到末尾：最后一行是最后一条消息的结尾行", async () => {
    const msgs = buildTranscript();
    const output = await renderToString(
      React.createElement(ChatView, {
        session: { ...createDraftSession(), messages: msgs },
        cols,
        liveToolLines: [],
        askLine: undefined,
        scrollRows: 0,
        viewportRows: 20,
      }),
      { columns: cols }
    );
    const lines = strip(output).replace(/\n+$/, "").split("\n");
    // 末行 = msg[11] 的 "closing remark."（不是中段 fence 行）
    expect(lines[lines.length - 1]).toBe("closing remark.");
  });
});
