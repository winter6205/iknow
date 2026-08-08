/**
 * tests/tui/chat-view-tool-visibility.test.tsx
 *
 * 三个用户可见性缺陷的回归锁（PR：TUI 可见性修复）：
 *
 * 1. 窄终端「内容跟着工具行折叠进去」：工具摘要 detail 旧实现固定 80 字符
 *    截断，cols < 80+装饰 时 ink 折行 → 渲染行 > 行账 → 底部内容被顶出
 *    可视区。回归：渲染总行数 ≤ viewport + headroom，且工具行之后的文本可见。
 * 2. 「写代码不展示」：write_file / edit_file 完成后渲染封顶内容预览行。
 * 3. 行账一致（parity）：全可见路径渲染行数 == messageRender totalRows
 *    合计（含预览行），保证滚动窗口映射不漂移。
 */
import { describe, it, expect } from "vitest";
import { renderToString } from "ink";
import React from "react";
import { ChatView } from "../../src/tui/chat-view.js";
import { createDraftSession } from "../../src/tui/session-state.js";
import { messageRender } from "../../src/tui/message-rows.js";
import type { AnthropicNativeMessage } from "../../src/harness/model-adapter/types.js";

const ANSI_RE = /\x1b\[[0-9;]*m/g;
const strip = (s: string): string => s.replace(ANSI_RE, "");

function frame(
  messages: AnthropicNativeMessage[],
  opts: { cols: number; viewportRows: number; scrollRows?: number }
): string[] {
  const output = renderToString(
    React.createElement(ChatView, {
      session: { ...createDraftSession(), messages },
      cols: opts.cols,
      liveToolLines: [],
      askLine: undefined,
      scrollRows: opts.scrollRows ?? 0,
      viewportRows: opts.viewportRows,
    }),
    { columns: opts.cols }
  );
  return strip(output).replace(/\n+$/, "").split("\n");
}

const LONG_CMD = "cat /home/winner/projects/iknow/package.json && echo ===";

function toolSession(): AnthropicNativeMessage[] {
  return [
    { role: "user", content: [{ type: "text", text: "干活" }] },
    {
      role: "assistant",
      content: [
        { type: "text", text: "我先看看目录。" },
        {
          type: "tool_use",
          id: "tu-1",
          name: "bash",
          input: { command: `${LONG_CMD} ${"x".repeat(200)}` },
        },
      ],
    },
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "tu-1", content: "ok" }],
    },
    {
      role: "assistant",
      content: [{ type: "text", text: "收尾答案文本-VISIBILITY-MARKER" }],
    },
  ];
}

describe("窄终端工具行不折行：内容不被顶出可视区", () => {
  it("cols=60：渲染行数 ≤ viewport + headroom（无折行溢出）", () => {
    const cols = 60;
    const vp = 20;
    const lines = frame(toolSession(), { cols, viewportRows: vp });
    // marginTop headroom 1 行；超出即说明有行被 ink 折行多占。
    expect(lines.length).toBeLessThanOrEqual(vp + 1);
  });

  it("cols=60：工具行之后的 assistant 文本仍可见", () => {
    const lines = frame(toolSession(), { cols: 60, viewportRows: 20 });
    expect(lines.join("\n")).toContain("收尾答案文本-VISIBILITY-MARKER");
  });

  it("cols=100（宽终端）回归：内容完整可见", () => {
    const lines = frame(toolSession(), { cols: 100, viewportRows: 40 });
    expect(lines.join("\n")).toContain("收尾答案文本-VISIBILITY-MARKER");
    expect(lines.join("\n")).toContain("我先看看目录。");
  });
});

describe("write_file 内容可见：预览行渲染", () => {
  function writeSession(): AnthropicNativeMessage[] {
    return [
      { role: "user", content: [{ type: "text", text: "写个文件" }] },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tu-w",
            name: "write_file",
            input: {
              path: "scripts/a.ts",
              content: "const PREVIEW_CODE_MARKER = 1;\nconsole.log(2);",
            },
          },
        ],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tu-w", content: "ok" }],
      },
    ];
  }

  it("write_file 所写代码出现在渲染帧里", () => {
    const lines = frame(writeSession(), { cols: 80, viewportRows: 40 });
    const joined = lines.join("\n");
    expect(joined).toContain("PREVIEW_CODE_MARKER");
    expect(joined).toContain("console.log(2);");
    expect(joined).toContain("write_file");
  });

  it("超长 write_file → 完整 diff 渲染（#298 T5，无封顶）", () => {
    const content = Array.from({ length: 60 }, (_, i) => `line-${i}`).join(
      "\n"
    );
    const msgs: AnthropicNativeMessage[] = [
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tu-w",
            name: "write_file",
            input: { path: "big.ts", content },
          },
        ],
      },
    ];
    const joined = frame(msgs, { cols: 80, viewportRows: 100 }).join("\n");
    expect(joined).toContain("line-0");
    expect(joined).toContain("line-59");
    // 完整 60 行 add diff 全部可见（hunk 头出现）
    expect(joined).toContain("@@ -1,0 +1,60 @@");
  });
});

describe("行账 parity：全可见渲染行数 == messageRender totalRows", () => {
  it("含 write_file 预览 + 长 bash 摘要的消息（cols=60）", () => {
    const cols = 60;
    const msgs = [
      ...toolSession(),
      {
        role: "assistant" as const,
        content: [
          {
            type: "tool_use" as const,
            id: "tu-w2",
            name: "write_file",
            input: {
              path: "s.ts",
              content: Array.from({ length: 50 }, (_, i) => `x${i}`).join("\n"),
            },
          },
        ],
      },
    ];
    // 无限视口 → 全部渲染；行数必须与行账 SSOT 完全一致（± headroom 1 行）。
    const lines = frame(msgs, { cols, viewportRows: 0 });
    const expected = msgs.reduce(
      (n, m) => n + messageRender(m, cols).totalRows,
      0
    );
    // frame 去尾空行：外层 margin 的尾行可能被去掉，允许 -1。
    expect([expected, expected - 1]).toContain(lines.length - 1);
  });
});
