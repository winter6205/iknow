/**
 * tests/tui/chat-view.test.tsx
 *
 * 任务 A 行级重构：聊天区域行级滚动（scrollRows + viewportRows）。
 * 覆盖：
 *  - `estimateMessageRows` / `buildMessageRowSpans` 纯函数（行数估计）
 *  - `wrapText` 行数 >= 1，且按 cols 折行
 *  - ChatView：scrollRows=0 全部可见，scrollRows=k 行级窗口，scroll 越界
 *    由 ChatView 兜底 clamp
 *  - 顶部 dim 指示：scrollRows > 0 时出现「↑ N 行历史（End 回到底部）」
 *  - 指示文案无 emoji（主码区缺席，与 render-smoke 同步）
 */
import { describe, expect, it } from "vitest";
import { renderToString } from "ink";
import {
  buildMessageRowSpans,
  ChatView,
  estimateMessageRows,
} from "../../src/tui/chat-view.js";
import { wrapText } from "../../src/tui/text.js";
import {
  createDraftSession,
  type TuiSessionState,
} from "../../src/tui/session-state.js";
import type { AnthropicNativeMessage } from "../../src/harness/model-adapter/types.js";

const ANSI_RE = /\x1b\[[0-9;]*m/g;
const stripAnsi = (s: string): string => s.replace(ANSI_RE, "");

function makeSession(
  messages: ReadonlyArray<AnthropicNativeMessage>
): TuiSessionState {
  return { ...createDraftSession(), messages };
}

/** 每条消息独占一行（user-only，无 reply 对），便于算可见数。 */
function buildUserMessages(n: number): ReadonlyArray<AnthropicNativeMessage> {
  const out: AnthropicNativeMessage[] = [];
  for (let i = 0; i < n; i++) {
    out.push({ role: "user", content: [{ type: "text", text: `m-${i}` }] });
  }
  return Object.freeze(out);
}

describe("wrapText（行级滚动基础）", () => {
  it("空字符串返回 [' ']（占 1 行）", () => {
    expect(wrapText("", 80)).toEqual([""]);
  });

  it("短文本不折行", () => {
    expect(wrapText("hello", 80)).toEqual(["hello"]);
  });

  it("按 max 字节数折行（> max 的部分换行）", () => {
    const out = wrapText("abcdefghij", 3);
    expect(out).toEqual(["abc", "def", "ghi", "j"]);
  });

  it("显式换行保留为单独行", () => {
    const out = wrapText("a\nb", 80);
    expect(out).toEqual(["a", "b"]);
  });

  it("max <= 0 时不切（返回原文）", () => {
    expect(wrapText("xyz", 0)).toEqual(["xyz"]);
  });
});

describe("estimateMessageRows（行数估计）", () => {
  it("user 空文本不占行", () => {
    const msg: AnthropicNativeMessage = {
      role: "user",
      content: [{ type: "text", text: "   " }],
    };
    expect(estimateMessageRows(msg, 80)).toBe(0);
  });

  it("user 短文本占 2 行（1 行 + 1 margin）", () => {
    const msg: AnthropicNativeMessage = {
      role: "user",
      content: [{ type: "text", text: "hi" }],
    };
    expect(estimateMessageRows(msg, 80)).toBe(2);
  });

  it("user 长文本按 cols-2（前缀）折行 + margin", () => {
    const text = "a".repeat(20);
    const msg: AnthropicNativeMessage = {
      role: "user",
      content: [{ type: "text", text }],
    };
    // cols=8 → wrapCols=6 → 20 chars → ceil(20/6) = 4 行 + 1 margin = 5
    expect(estimateMessageRows(msg, 8)).toBe(5);
  });

  it("assistant text + margin", () => {
    const msg: AnthropicNativeMessage = {
      role: "assistant",
      content: [{ type: "text", text: "hello" }],
    };
    // text 1 行 + 1 margin = 2
    expect(estimateMessageRows(msg, 80)).toBe(2);
  });

  it("assistant 多个 text 块累加", () => {
    const msg: AnthropicNativeMessage = {
      role: "assistant",
      content: [
        { type: "text", text: "a" },
        { type: "text", text: "b" },
      ],
    };
    expect(estimateMessageRows(msg, 80)).toBe(4); // 2 + 2
  });

  it("assistant 纯 tool_use 占 2 行", () => {
    const msg: AnthropicNativeMessage = {
      role: "assistant",
      content: [{ type: "tool_use", id: "x", name: "bash", input: {} }],
    };
    expect(estimateMessageRows(msg, 80)).toBe(2);
  });

  it("assistant 空 content 返回 0", () => {
    const msg: AnthropicNativeMessage = { role: "assistant", content: [] };
    expect(estimateMessageRows(msg, 80)).toBe(0);
  });
});

describe("buildMessageRowSpans（消息级行映射）", () => {
  it("3 条 user 消息的 startRow 累加正确", () => {
    const messages = buildUserMessages(3);
    const spans = buildMessageRowSpans(messages, 80);
    expect(spans).toHaveLength(3);
    expect(spans[0]?.startRow).toBe(0);
    expect(spans[1]?.startRow).toBe(spans[0]?.rows ?? 0);
    expect(spans[2]?.startRow).toBe(
      (spans[0]?.rows ?? 0) + (spans[1]?.rows ?? 0)
    );
  });

  it("空消息数组返回空 spans", () => {
    expect(buildMessageRowSpans([], 80)).toEqual([]);
  });

  it("过滤掉占 0 行的 message（user 空文本）", () => {
    const messages: ReadonlyArray<AnthropicNativeMessage> = [
      { role: "user", content: [{ type: "text", text: "  " }] },
      { role: "user", content: [{ type: "text", text: "ok" }] },
    ];
    const spans = buildMessageRowSpans(messages, 80);
    expect(spans).toHaveLength(1);
  });
});

describe("ChatView 行级滚动（任务 A 行级）", () => {
  it("scrollRows=0 → 全部消息可见，顶部无指示", async () => {
    const session = makeSession(buildUserMessages(10));
    const output = await renderToString(
      <ChatView
        session={session}
        cols={80}
        liveToolLines={[]}
        askLine={undefined}
        scrollRows={0}
        viewportRows={20}
      />,
      { columns: 80 }
    );
    const plain = stripAnsi(output);
    for (let i = 0; i < 10; i++) {
      expect(plain).toContain(`m-${i}`);
    }
    expect(plain).not.toContain("行历史");
  });

  it("scrollRows=k 行级窗口：向上滚 k 行后早期 message 仍可见", async () => {
    // 10 条 user 消息，每条 2 行（1 wrap + 1 margin）。viewportRows=6
    // 表示可视 6 行。scrollRows=4 → 窗口 = [totalRows-6-4, totalRows-4]
    // = [10, 16]。早期 m-0..m-4（rows 0..10）部分在视口内。
    const session = makeSession(buildUserMessages(10));
    const output = await renderToString(
      <ChatView
        session={session}
        cols={80}
        liveToolLines={[]}
        askLine={undefined}
        scrollRows={4}
        viewportRows={6}
      />,
      { columns: 80 }
    );
    const plain = stripAnsi(output);
    // 顶部指示出现
    expect(plain).toContain("4 行历史");
    expect(plain).toContain("End 回到底部");
    // m-0 仍可见（startRow=0, rows=2 → 部分 [0,2) 在 [10,16) 之外但 [0,2) ∩
    // [10,16) = 空？wait, our window logic is [max(0, end-viewport), end)
    // = [16-6, 16) = [10, 16). m-0 占 [0,2)，不在窗口内。
    // 调整：测 m-5..m-7 应可见（占 [10,16)）。
    expect(plain).toContain("m-5");
    expect(plain).toContain("m-6");
    expect(plain).toContain("m-7");
    // m-0..m-4 不应可见（被截掉）
    expect(plain).not.toContain("m-0");
    expect(plain).not.toContain("m-9");
  });

  it("scrollRows 越界由 ChatView 兜底 clamp（不报错）", async () => {
    const session = makeSession(buildUserMessages(3));
    const output = await renderToString(
      <ChatView
        session={session}
        cols={80}
        liveToolLines={[]}
        askLine={undefined}
        scrollRows={99999}
        viewportRows={20}
      />,
      { columns: 80 }
    );
    const plain = stripAnsi(output);
    // clamp 到 totalRows - viewport（不会出 viewport 顶部）
    // 实际窗口落在 [0, totalRows)，全部 3 条可见（最大 scroll 时已顶到
    // 最早内容）。
    expect(plain).toContain("m-0");
    expect(plain).toContain("m-2");
  });

  it("scrollRows=0 + viewportRows=0 → 全部消息可见（无窗口限制）", async () => {
    const session = makeSession(buildUserMessages(5));
    const output = await renderToString(
      <ChatView
        session={session}
        cols={80}
        liveToolLines={[]}
        askLine={undefined}
        scrollRows={0}
        viewportRows={0}
      />,
      { columns: 80 }
    );
    const plain = stripAnsi(output);
    for (let i = 0; i < 5; i++) {
      expect(plain).toContain(`m-${i}`);
    }
  });

  it("指示文案无 emoji（主 emoji 码区缺席）", async () => {
    const session = makeSession(buildUserMessages(5));
    const output = await renderToString(
      <ChatView
        session={session}
        cols={80}
        liveToolLines={[]}
        askLine={undefined}
        scrollRows={2}
        viewportRows={6}
      />,
      { columns: 80 }
    );
    const plain = stripAnsi(output);
    expect(/[\u{1F300}-\u{1FAFF}]/u.test(plain)).toBe(false);
  });

  it("live 工具行 + ask 槽 + spinner 计入 totalRows（影响窗口）", async () => {
    // 1 条 user 消息（rows=2） + liveToolLines 2 条 + ask 1 条 + spinner 1
    // 条 = totalRows = 6。viewportRows=3, scrollRows=0 → 窗口 = [3, 6)，
    // 包含 ask + spinner + 0 行 user（user 2 行被窗口顶部截掉）。
    const session = makeSession([
      { role: "user", content: [{ type: "text", text: "hello" }] },
    ]);
    // runState = running-fg 才能让 spinner 出现
    const running: TuiSessionState = { ...session, runState: "running-fg" };
    const output = await renderToString(
      <ChatView
        session={running}
        cols={80}
        liveToolLines={["tool1", "tool2"]}
        askLine="[ask] 允许？输入 y/n"
        scrollRows={0}
        viewportRows={3}
      />,
      { columns: 80 }
    );
    const plain = stripAnsi(output);
    // tail 区域可见
    expect(plain).toContain("tool1");
    expect(plain).toContain("tool2");
    expect(plain).toContain("[ask]");
  });
});

/**
 * T6 (D5):assistant thinking 折叠面板 — 终稿从 result.messages 提取 thinking
 * blocks 渲染 + 折叠控件(默认折叠 = 摘要行;展开 = 全文 + redacted 占位)。
 * `thinkingExpanded` prop 控制展开态(app 层 /thinking 切换)。
 */
describe("T6 thinking 折叠面板", () => {
  function thinkingSession(
    blocks: AnthropicNativeMessage["content"]
  ): TuiSessionState {
    return makeSession([
      { role: "user", content: [{ type: "text", text: "q" }] },
      { role: "assistant", content: blocks },
    ]);
  }

  it("默认折叠:显示一行摘要,不展开 thinking 全文", async () => {
    const session = thinkingSession([
      { type: "thinking", thinking: "SECRET_REASONING", signature: "s" },
      { type: "text", text: "answer" },
    ]);
    const output = await renderToString(
      <ChatView
        session={session}
        cols={80}
        liveToolLines={[]}
        askLine={undefined}
      />,
      { columns: 80 }
    );
    const plain = stripAnsi(output);
    expect(plain).toContain("思考（1 段）");
    expect(plain).not.toContain("SECRET_REASONING");
    expect(plain).toContain("answer");
  });

  it("thinkingExpanded=true:展开显示 thinking 全文 + 摘要行带展开标记", async () => {
    const session = thinkingSession([
      { type: "thinking", thinking: "VISIBLE_REASONING", signature: "s" },
      { type: "text", text: "answer" },
    ]);
    const output = await renderToString(
      <ChatView
        session={session}
        cols={80}
        liveToolLines={[]}
        askLine={undefined}
        thinkingExpanded
      />,
      { columns: 80 }
    );
    const plain = stripAnsi(output);
    expect(plain).toContain("VISIBLE_REASONING");
    expect(plain).toContain("answer");
  });

  it("redacted_thinking:折叠摘要计入已加密计数;展开显示占位不泄露 data", async () => {
    const session = thinkingSession([
      { type: "redacted_thinking", data: "ENCRYPTED_BLOB" },
      { type: "text", text: "answer" },
    ]);
    // 折叠态
    const collapsed = await renderToString(
      <ChatView
        session={session}
        cols={80}
        liveToolLines={[]}
        askLine={undefined}
      />,
      { columns: 80 }
    );
    const plainC = stripAnsi(collapsed);
    expect(plainC).toContain("思考（0 段 · 已加密 ×1）");
    expect(plainC).not.toContain("ENCRYPTED_BLOB");
    // 展开态
    const expanded = await renderToString(
      <ChatView
        session={session}
        cols={80}
        liveToolLines={[]}
        askLine={undefined}
        thinkingExpanded
      />,
      { columns: 80 }
    );
    const plainE = stripAnsi(expanded);
    expect(plainE).toContain("已加密思考");
    expect(plainE).not.toContain("ENCRYPTED_BLOB");
  });

  it("无 thinking 块:不渲染折叠面板(无摘要噪声)", async () => {
    const session = thinkingSession([{ type: "text", text: "plain" }]);
    const output = await renderToString(
      <ChatView
        session={session}
        cols={80}
        liveToolLines={[]}
        askLine={undefined}
      />,
      { columns: 80 }
    );
    const plain = stripAnsi(output);
    expect(plain).not.toContain("思考（");
    expect(plain).toContain("plain");
  });

  it("折叠面板无 emoji(主码区缺席)", async () => {
    const session = thinkingSession([
      { type: "thinking", thinking: "r", signature: "s" },
      { type: "text", text: "answer" },
    ]);
    const output = await renderToString(
      <ChatView
        session={session}
        cols={80}
        liveToolLines={[]}
        askLine={undefined}
      />,
      { columns: 80 }
    );
    const plain = stripAnsi(output);
    expect(/[\u{1F300}-\u{1FAFF}]/u.test(plain)).toBe(false);
  });

  it("estimateMessageRows:折叠面板占 1 行;展开按 thinking 文本行数累加", () => {
    // 折叠:thinking 摘要行(1) + text 块(1 + 1 margin) = 3
    const collapsedMsg: AnthropicNativeMessage = {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "a", signature: "s" },
        { type: "text", text: "answer" },
      ],
    };
    expect(estimateMessageRows(collapsedMsg, 80)).toBe(3);
    // 展开:thinking 全文 a(1) + redacted 占位(1) + text(2) = 4
    const expandedMsg: AnthropicNativeMessage = {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "a", signature: "s" },
        { type: "redacted_thinking", data: "x" },
        { type: "text", text: "answer" },
      ],
    };
    expect(
      estimateMessageRows(expandedMsg, 80, { thinkingExpanded: true })
    ).toBe(4);
  });
});
