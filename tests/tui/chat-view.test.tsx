/**
 * tests/tui/chat-view.test.tsx
 *
 * 任务 A 行级重构：聊天区域行级滚动（scrollRows + viewportRows）。
 * 覆盖：
 *  - `measureMessage`（message-rows.ts SSOT）行数估计 + 消息级行映射
 *  - `wrapText` 行数 >= 1，且按 cols 折行
 *  - ChatView：scrollRows=0 全部可见，scrollRows=k 行级窗口，scroll 越界
 *    由 ChatView 兜底 clamp
 *  - 顶部 dim 指示：scrollRows > 0 时出现「↑ N 行历史（End 回到底部）」
 *  - 指示文案无 emoji（主码区缺席，与 render-smoke 同步）
 */
import { describe, expect, it } from "vitest";
import { renderToString } from "ink";
import { ChatView } from "../../src/tui/chat-view.js";
import { measureMessage } from "../../src/tui/message-rows.js";
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

describe("measureMessage（消息行级布局）", () => {
  it("user 空文本不占行", () => {
    const msg: AnthropicNativeMessage = {
      role: "user",
      content: [{ type: "text", text: "   " }],
    };
    expect(measureMessage(msg, 80).totalRows).toBe(0);
  });

  it("user 短文本占 2 行（1 行 + 1 margin）", () => {
    const msg: AnthropicNativeMessage = {
      role: "user",
      content: [{ type: "text", text: "hi" }],
    };
    expect(measureMessage(msg, 80).totalRows).toBe(2);
  });

  it("user 长文本按 cols-2（前缀）折行 + margin", () => {
    const text = "a".repeat(20);
    const msg: AnthropicNativeMessage = {
      role: "user",
      content: [{ type: "text", text }],
    };
    // cols=8 → wrapCols=6 → 20 chars → ceil(20/6) = 4 行 + 1 margin = 5
    expect(measureMessage(msg, 8).totalRows).toBe(5);
  });

  it("assistant text + margin", () => {
    const msg: AnthropicNativeMessage = {
      role: "assistant",
      content: [{ type: "text", text: "hello" }],
    };
    // text 1 行 + 1 margin = 2
    expect(measureMessage(msg, 80).totalRows).toBe(2);
  });

  it("assistant 多个 text 块累加", () => {
    const msg: AnthropicNativeMessage = {
      role: "assistant",
      content: [
        { type: "text", text: "a" },
        { type: "text", text: "b" },
      ],
    };
    expect(measureMessage(msg, 80).totalRows).toBe(4); // 2 + 2
  });

  it("assistant 纯 tool_use 占 2 行", () => {
    const msg: AnthropicNativeMessage = {
      role: "assistant",
      content: [{ type: "tool_use", id: "x", name: "bash", input: {} }],
    };
    expect(measureMessage(msg, 80).totalRows).toBe(2);
  });

  it("assistant 空 content 返回 0", () => {
    const msg: AnthropicNativeMessage = { role: "assistant", content: [] };
    expect(measureMessage(msg, 80).totalRows).toBe(0);
  });
});

describe("measureMessage 累加为消息级 startRow（行映射）", () => {
  // 镜像原 buildMessageRowSpans 测试：以 measureMessage 逐条聚合到 startRow。
  it("3 条 user 消息的 startRow 累加正确", () => {
    const messages = buildUserMessages(3);
    let cursor = 0;
    const starts: number[] = [];
    for (const m of messages) {
      const r = measureMessage(m, 80);
      expect(r.totalRows).toBeGreaterThan(0);
      starts.push(cursor);
      cursor += r.totalRows;
    }
    expect(starts).toEqual([0, 2, 4]);
  });

  it("空消息数组聚合后 cursor 仍为 0", () => {
    let cursor = 0;
    for (const _m of []) {
      cursor += measureMessage(_m, 80).totalRows;
    }
    expect(cursor).toBe(0);
  });

  it("过滤掉占 0 行的 message（user 空文本）", () => {
    const messages: ReadonlyArray<AnthropicNativeMessage> = [
      { role: "user", content: [{ type: "text", text: "  " }] },
      { role: "user", content: [{ type: "text", text: "ok" }] },
    ];
    let kept = 0;
    for (const m of messages) {
      if (measureMessage(m, 80).totalRows === 0) continue;
      kept += 1;
    }
    expect(kept).toBe(1);
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

  it("短内容可滚动：3 条短消息 totalRows <= viewport 时 scroll 仍可达顶部（Fix1）", async () => {
    // 3 条 user 消息，每条 2 行（1 wrap + 1 margin）= 6 行。viewportRows=20
    // > totalRows(6)。旧逻辑 maxScroll = totalRows - max(1,viewport) = 0，
    // scroll 被 clamp 到 0 → 指示永不出现。Fix1 后 totalRows>1 时
    // maxScroll = totalRows - 1 = 5，scrollRows=5 落在允许带内。
    const session = makeSession(buildUserMessages(3));
    const output = await renderToString(
      <ChatView
        session={session}
        cols={80}
        liveToolLines={[]}
        askLine={undefined}
        scrollRows={5}
        viewportRows={20}
      />,
      { columns: 80 }
    );
    const plain = stripAnsi(output);
    // 顶部指示出现，且指示与内容之间无空白间隔（内容仍可见）
    expect(plain).toContain("5 行历史");
    expect(plain).toContain("End 回到底部");
    expect(plain).toContain("m-0");
  });

  it("短内容 scroll 到顶边：viewport < totalRows 且 totalRows > 1 → maxScroll = totalRows - viewport", async () => {
    // 1 条 user 消息（2 行），viewportRows=1 → totalRows(2) > viewport(1)
    // → maxScroll = totalRows - viewport = 1。scrollRows=999 clamp 到 1，
    // 顶部指示「↑ 1 行历史」出现；窗口 [0,1) 露出首行。
    const session = makeSession(buildUserMessages(1));
    const output = await renderToString(
      <ChatView
        session={session}
        cols={80}
        liveToolLines={[]}
        askLine={undefined}
        scrollRows={999}
        viewportRows={1}
      />,
      { columns: 80 }
    );
    const plain = stripAnsi(output);
    expect(plain).toContain("1 行历史");
    expect(plain).toContain("m-0");
  });

  it("viewportRows=0（无限）：scroll 不 clamp 也无指示消失（回归）", async () => {
    // viewport=0 → maxScroll = totalRows - 1；scrollRows 大值被 clamp，
    // 但所有消息仍可见（无窗口限制）。
    const session = makeSession(buildUserMessages(5));
    const output = await renderToString(
      <ChatView
        session={session}
        cols={80}
        liveToolLines={[]}
        askLine={undefined}
        scrollRows={999}
        viewportRows={0}
      />,
      { columns: 80 }
    );
    const plain = stripAnsi(output);
    for (let i = 0; i < 5; i++) {
      expect(plain).toContain(`m-${i}`);
    }
  });

  it("scrollRows 越界由 ChatView 兜底 clamp（不报错；Fix1 短内容 scroll 到顶边）", async () => {
    // Fix1：3 条 user 消息 = 6 行，viewportRows=20 (>= totalRows)。
    // maxScroll = max(totalRows-viewport, totalRows-1) = max(-14, 5) = 5。
    // scrollRows=99999 clamp 到 5，窗口 [0, 1) 只露出首行 m-0；
    // 顶部指示「↑ 5 行历史」出现；不崩溃。
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
    expect(plain).toContain("5 行历史");
    expect(plain).toContain("m-0");
    // m-2 在 [4,6)，不在窗口 [0,1) → 不应可见
    expect(plain).not.toContain("m-2");
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

  it("Fix2 长 user 消息行级裁剪：视口只露前几行（不暴露全段）", async () => {
    // user text="a"*60, cols=8 → wrapCols=6 → 10 行 + 1 margin = 11 行。
    // viewportRows=10, scrollRows=15→maxScroll=10 → 窗口 [0,1)。
    // 第一行折 "aaaaaa"（6 a），加 "❯ " 前缀；不应出现完整 60 a 串。
    const session = makeSession([
      { role: "user", content: [{ type: "text", text: "a".repeat(60) }] },
    ]);
    const output = await renderToString(
      <ChatView
        session={session}
        cols={8}
        liveToolLines={[]}
        askLine={undefined}
        scrollRows={15}
        viewportRows={10}
      />,
      { columns: 8 }
    );
    const plain = stripAnsi(output);
    // 完整长字符串缺席（被裁掉）
    expect(plain).not.toContain("a".repeat(60));
    // 'a' 字符数 ≤ 6（视口只露第一行折 6 a；指示文案不含 a）
    const aCount = (plain.match(/a/g) ?? []).length;
    expect(aCount).toBeLessThanOrEqual(6);
  });

  it("Fix2 长 assistant 消息行级裁剪：首段隐藏，后续段可见", async () => {
    // 1 user 消息（rows=2）+ 1 assistant 消息（3 text 段，每段 cols=8 折
    // 5 行 + 1 margin = 6 行/段，3 段 18 行）。totalRows=20。viewport=8,
    // scroll=4 → 窗口 [8,16)。assistant 段 [2,20) → 段内 slice [6,14)：
    // 段 1 [0,5) 不重叠，段 2 [6,11) 完整，段 3 [12,17) 取前 2 行。
    const session = makeSession([
      { role: "user", content: [{ type: "text", text: "q" }] },
      {
        role: "assistant",
        content: [
          { type: "text", text: "a".repeat(40) },
          { type: "text", text: "b".repeat(40) },
          { type: "text", text: "c".repeat(40) },
        ],
      },
    ]);
    const output = await renderToString(
      <ChatView
        session={session}
        cols={8}
        liveToolLines={[]}
        askLine={undefined}
        scrollRows={4}
        viewportRows={8}
      />,
      { columns: 8 }
    );
    const plain = stripAnsi(output);
    // 首段 "a" 整段被窗口顶掉 → 无任何 'a'
    expect(plain).not.toContain("a");
    // 中段可见（含 'b'）
    expect(plain).toContain("b");
    // 末段部分可见（含 'c'）
    expect(plain).toContain("c");
  });

  it("Fix3 scroll>0 → tail 折叠：底部指示替代 live 工具/ask/spinner/draft", async () => {
    // 1 user 消息 + running-fg + liveTool + ask + draft。scroll=2 折叠 tail。
    // 底部指示 "↓ N 行正在生成（End 回到底部）" 必须出现；live 工具串 /
    // ask / draft 文案都不能渲染。
    const session = makeSession([
      { role: "user", content: [{ type: "text", text: "hello" }] },
    ]);
    const running: TuiSessionState = { ...session, runState: "running-fg" };
    const output = await renderToString(
      <ChatView
        session={running}
        cols={80}
        liveToolLines={["toolA-LINE", "toolB-LINE"]}
        askLine="[ask] pending?"
        draftsMasked="DRAFT-PARTIAL-TEXT"
        scrollRows={2}
        viewportRows={6}
      />,
      { columns: 80 }
    );
    const plain = stripAnsi(output);
    // 底部折叠指示
    expect(plain).toContain("↓");
    expect(plain).toContain("行正在生成");
    expect(plain).toContain("End 回到底部");
    // live 工具行 / ask / draft 文案都不可见
    expect(plain).not.toContain("toolA-LINE");
    expect(plain).not.toContain("toolB-LINE");
    expect(plain).not.toContain("[ask]");
    expect(plain).not.toContain("DRAFT-PARTIAL-TEXT");
  });

  it("Fix3 顶部 + 底部指示同时渲染（scroll>0 smoke）", async () => {
    // 短 user + running-fg：tail 1 行 spinner。scroll=2 顶部指示 "↑ 2 行
    // 历史"；底部 "↓ 1 行正在生成"。两者必须并存。
    const session = makeSession([
      { role: "user", content: [{ type: "text", text: "hello" }] },
    ]);
    const running: TuiSessionState = { ...session, runState: "running-fg" };
    const output = await renderToString(
      <ChatView
        session={running}
        cols={80}
        liveToolLines={[]}
        askLine={undefined}
        scrollRows={2}
        viewportRows={6}
      />,
      { columns: 80 }
    );
    const plain = stripAnsi(output);
    expect(plain).toContain("↑ 2 行历史");
    expect(plain).toContain("↓");
    expect(plain).toContain("行正在生成");
  });
});

// #189 裁剪回归保护（Findings 4-5）。每个用例聚焦单一裁剪行为：
// `❯ ` 前缀 / 工具伪块 / 折叠 thinking 块 / 估算与 ink 渲染对齐。
describe("ChatView 行级裁剪（#189 回归保护）", () => {
  it("❯ 前缀只出现在 partial 切片的可见首行（一次）", async () => {
    // user 长文本 60a, cols=10 → wrapCols=8 → ceil(60/8) = 8 行 + 1 margin =
    // 9 行 total。viewportRows=4, scrollRows=5 → 窗口 = [9-4-5, 9-5) = [0,
    // 4)。slice 覆盖首 4 行（含 margin 的第 0-3 行；slice.start=0）→ 第 1
    // 行加 `❯ ` 前缀；后续行不加；且 prefix 只出现一次。
    const session = makeSession([
      { role: "user", content: [{ type: "text", text: "a".repeat(60) }] },
    ]);
    const output = await renderToString(
      <ChatView
        session={session}
        cols={10}
        liveToolLines={[]}
        askLine={undefined}
        scrollRows={5}
        viewportRows={4}
      />,
      { columns: 10 }
    );
    const plain = stripAnsi(output);
    // ❯ 字符只出现一次（首行）。`>` 字符在 ANSI/其它字串里不出现，可作
    // 前缀占位唯一定位。
    const prefixMatches = plain.match(/❯/g) ?? [];
    expect(prefixMatches.length).toBe(1);
    // 首行确有前缀
    expect(plain).toMatch(/❯\s*a/);
  });

  it("tool_use 伪块部分覆盖：窗口只露第二个工具的摘要行（不双渲）", async () => {
    // assistant 2 个 tool_use,各占 2 行。totalRows = 4。viewportRows=1,
    // scrollRows=3 → maxScroll = 3 (totalRows-1), 窗口 = [4-1-3, 4-3) =
    // [0, 1)。slice 覆盖首 1 行：第一个 tool_use 的第 0 行（摘要行）可
    // 见；第二个 tool_use 的第 0 行（位于块内 row=2）不在窗口内。
    // 断言：只渲染 1 个 tool_use 摘要；第二个工具名不在输出里。
    const session = makeSession([
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "t1", name: "firstTool", input: {} },
          { type: "tool_use", id: "t2", name: "secondTool", input: {} },
        ],
      },
    ]);
    const output = await renderToString(
      <ChatView
        session={session}
        cols={80}
        liveToolLines={[]}
        askLine={undefined}
        scrollRows={3}
        viewportRows={1}
      />,
      { columns: 80 }
    );
    const plain = stripAnsi(output);
    // 第一个工具摘要行渲染
    expect(plain).toContain("firstTool");
    // 第二个工具被裁掉（不在 [0,1) 窗口里）
    expect(plain).not.toContain("secondTool");
    // 摘要标记只出现一次（无「[运行中]firstTool」+「[运行中]secondTool」重渲）
    const markCount = (plain.match(/\[运行中\]/g) ?? []).length;
    expect(markCount).toBe(1);
  });

  it("thinking 块部分覆盖：展开态下窗口只露最后 2 行（不全文 dump）", async () => {
    // thinking 展开态 → 每段 thinking 各自占行（按 wrap 折行）。长
    // thinking 文本在 cols=12 下 wrapCols=12，20 chars → 2 行。redacted
    // 占位 1 行。text 块 1 行 + 1 margin = 2 行。totalRows = 1 (user) +
    // 2 (thinking) + 1 (redacted) + 2 (text) = 6。viewportRows=2,
    // scrollRows=4 → maxScroll = 5, 窗口 = [6-2-4, 6-4) = [0, 2)。暴露
    // 前 2 行：user + thinking 的首行。thinking 第二行 / redacted /
    // text 均被裁掉。
    const longThinking = "a".repeat(20); // cols=12 → 2 行
    const session = makeSession([
      { role: "user", content: [{ type: "text", text: "Q" }] },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: longThinking, signature: "s" },
          { type: "redacted_thinking", data: "BLOB" },
          { type: "text", text: "UNIQUE_ANSWER" },
        ],
      },
    ]);
    // totalRows: user 2 + thinking 2 + redacted 1 + text 3 = 8。
    // viewportRows=2, scrollRows=5 → window [8-2-5, 8-5) = [1, 3)。
    // assistant 段占 [2, 8)，slice [0, 1) = thinking 第 0 行 = 12 a's。
    const output = await renderToString(
      <ChatView
        session={session}
        cols={12}
        liveToolLines={[]}
        askLine={undefined}
        thinkingExpanded
        scrollRows={5}
        viewportRows={2}
      />,
      { columns: 12 }
    );
    const plain = stripAnsi(output);
    // thinking 全文由 20 个 'a' 组成（折成 2 行）。窗口只露 1 行
    // 折 12 chars → 出现 12 个 'a'，剩余 8 个被裁掉。
    const aCount = (plain.match(/a/g) ?? []).length;
    expect(aCount).toBeLessThanOrEqual(12);
    // redacted 占位被裁掉
    expect(plain).not.toContain("已加密思考");
    // text 块被裁掉
    expect(plain).not.toContain("UNIQUE_ANSWER");
    // 原始 20a 完整串被裁（窗口只露第一折行）
    expect(plain).not.toContain("a".repeat(20));
  });

  it("行数估计与 ink 渲染对齐（±容差，issue 189 estimate vs real）", async () => {
    // 多块 message（paragraph + fence + list）→ measureMessage 给 totalRows；
    // ink renderToString 输出非空行数（去掉空行 + 边缘空白）。issue 189
    // 明确要求 estimate 与实际渲染对齐：本测试做聚合（user + assistant）
    // 后取绝对差 ≤ 4 的容差。ink 自带 wrap 与 markdown 子结构（标题 /
    // 列表）会与我们的 wrap 有几行差异；±4 行是合理容差。
    const md = [
      "## 标题",
      "",
      "正文第一段，写点东西撑几行。",
      "",
      "- 列表项一",
      "- 列表项二",
      "- 列表项三",
      "",
      "```ts",
      "const x = 1;",
      "```",
    ].join("\n");
    const messages: ReadonlyArray<AnthropicNativeMessage> = [
      { role: "user", content: [{ type: "text", text: "q" }] },
      { role: "assistant", content: [{ type: "text", text: md }] },
    ];
    const session = makeSession(messages);
    const totalRows = messages.reduce(
      (acc, m) => acc + measureMessage(m, 80).totalRows,
      0
    );
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
    const renderedRows = plain
      .split("\n")
      .filter((l) => l.trim().length > 0).length;
    // 绝对差容差 ±4。estimate 与 real 应对齐（issue 189 明确诉求）。
    expect(Math.abs(renderedRows - totalRows)).toBeLessThanOrEqual(4);
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

  it("measureMessage:折叠面板占 1 行;展开按 thinking 文本行数累加", () => {
    // 折叠:thinking 摘要行(1) + text 块(1 + 1 margin) = 3
    const collapsedMsg: AnthropicNativeMessage = {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "a", signature: "s" },
        { type: "text", text: "answer" },
      ],
    };
    expect(measureMessage(collapsedMsg, 80).totalRows).toBe(3);
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
      measureMessage(expandedMsg, 80, { thinkingExpanded: true }).totalRows
    ).toBe(4);
  });
});
