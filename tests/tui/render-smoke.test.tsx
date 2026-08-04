/**
 * tests/tui/render-smoke.test.tsx
 *
 * #146 渲染冒烟（原型 smoke-adaptive 同款模式：renderToString 多宽度断言）：
 *  - banner：40/80/120 列无溢出行；窄终端降级返回 []；SHORT 档单行；
 *  - ListView：列内容（summary + 相对时间 + [运行中]）+ 伪条目；
 *  - ChatView：markdown 渲染 + 无溢出行（40/80/120）。
 * UI 元素层无 emoji 约束（Q4）：对渲染输出断言常见 emoji 码区缺席。
 */
import { describe, expect, it } from "vitest";
import { renderToString } from "ink";
import {
  BANNER_MIN_COLS,
  renderBanner,
  visualWidth,
} from "../../src/tui/banner.js";
import { ListView, type TuiListEntry } from "../../src/tui/list-view.js";
import { ChatView } from "../../src/tui/chat-view.js";
import {
  createDraftSession,
  turnStarted,
} from "../../src/tui/session-state.js";
import type { AnthropicNativeMessage } from "../../src/harness/model-adapter/types.js";

const ANSI_RE = /\x1b\[[0-9;]*m/g;
const stripAnsi = (s: string): string => s.replace(ANSI_RE, "");
const EMOJI_RE = /[\u{1F300}-\u{1FAFF}]/u;

function assertNoOverflow(output: string, cols: number): void {
  for (const line of stripAnsi(output).split("\n")) {
    expect(
      visualWidth(line),
      `行超出 ${cols} 列：${JSON.stringify(line)}`
    ).toBeLessThanOrEqual(cols);
  }
}

describe("banner 渲染（智慧之眼 V7 定案）", () => {
  const info = {
    version: "0.1.0",
    cwd: "/home/u/proj",
    dataDir: "/home/u/.iknow",
  };

  it("80/120 列：多行输出且无溢出行", () => {
    for (const cols of [80, 120, 160]) {
      const lines = renderBanner(info, { cols, short: false });
      expect(lines.length).toBeGreaterThan(1);
      assertNoOverflow(lines.join("\n"), cols);
    }
  });

  it("窄终端降级：cols < BANNER_MIN_COLS → []（#171 落地清单）", () => {
    const lines = renderBanner(info, {
      cols: BANNER_MIN_COLS - 1,
      short: false,
    });
    expect(lines).toEqual([]);
  });

  it("SHORT 档（矮终端）：单行简化", () => {
    const lines = renderBanner(info, { cols: 80, short: true });
    expect(lines.length).toBe(1);
    expect(stripAnsi(lines[0]!)).toContain("iknow");
  });

  it("UI 层无 emoji", () => {
    const lines = renderBanner(info, { cols: 120, short: false });
    expect(EMOJI_RE.test(stripAnsi(lines.join("\n")))).toBe(false);
  });
});

const sampleEntries: ReadonlyArray<TuiListEntry> = [
  {
    conversation_id: "conv-a",
    updatedAt: new Date().toISOString(),
    lastFinalText: "最近回答",
    summary: "第一个问题：帮我查一下部署流程",
    runningBg: false,
  },
  {
    conversation_id: "conv-b",
    updatedAt: new Date(Date.now() - 3600_000).toISOString(),
    lastFinalText: "另一个回答",
    summary: "第二个问题",
    runningBg: true,
  },
];

describe("ListView 渲染（Q4a/Q4b）", () => {
  it("列内容：伪条目 + summary + 相对时间 + [运行中] 静态标记", async () => {
    const output = await renderToString(
      <ListView
        entries={sampleEntries}
        cols={80}
        onOpen={() => {}}
        onBack={() => {}}
      />,
      { columns: 80 }
    );
    const plain = stripAnsi(output);
    expect(plain).toContain("+ 新建会话");
    expect(plain).toContain("第一个问题：帮我查一下部署流程");
    expect(plain).toContain("第二个问题");
    expect(plain).toContain("[运行中]");
    expect(plain).toContain("1 小时前");
    expect(EMOJI_RE.test(plain)).toBe(false);
  });

  it("空列表：提示 Enter 新建", async () => {
    const output = await renderToString(
      <ListView entries={[]} cols={80} onOpen={() => {}} onBack={() => {}} />,
      { columns: 80 }
    );
    expect(stripAnsi(output)).toContain("暂无会话");
  });

  it("窄宽 40 列无溢出行", async () => {
    const output = await renderToString(
      <ListView
        entries={sampleEntries}
        cols={40}
        onOpen={() => {}}
        onBack={() => {}}
      />,
      { columns: 40 }
    );
    assertNoOverflow(output, 40);
  });
});

const mdMessages: ReadonlyArray<AnthropicNativeMessage> = [
  { role: "user", content: [{ type: "text", text: "介绍一下 markdown" }] },
  {
    role: "assistant",
    content: [
      {
        type: "text",
        text: [
          "## 标题",
          "",
          "正文 **加粗** 与 `code`。",
          "",
          "- 列表项一",
          "- 列表项二",
          "",
          "```ts",
          "const x = 1;",
          "```",
        ].join("\n"),
      },
    ],
  },
];

describe("ChatView 渲染（Q5a/Q5b）", () => {
  it("markdown 消息渲染（标题/列表/代码块）+ 用户行前缀", async () => {
    const session = { ...createDraftSession(), messages: mdMessages };
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
    expect(plain).toContain("介绍一下 markdown");
    expect(plain).toContain("标题");
    expect(plain).toContain("列表项一");
    expect(plain).toContain("const x = 1;");
  });

  it("running-fg 显示 spinner 文案；工具摘要行逐条渲染", async () => {
    const running = turnStarted({
      ...createDraftSession(),
      messages: mdMessages,
    });
    const output = await renderToString(
      <ChatView
        session={running}
        cols={80}
        liveToolLines={["read_file · 读取 a.ts · ok"]}
        askLine={undefined}
      />,
      { columns: 80 }
    );
    const plain = stripAnsi(output);
    expect(plain).toContain("运行中");
    expect(plain).toContain("read_file · 读取 a.ts · ok");
  });

  it("40/80/120 列无溢出行（V7 窗口适配纪律）", async () => {
    for (const cols of [40, 80, 120]) {
      const session = { ...createDraftSession(), messages: mdMessages };
      const output = await renderToString(
        <ChatView
          session={session}
          cols={cols}
          liveToolLines={[]}
          askLine={undefined}
        />,
        { columns: cols }
      );
      assertNoOverflow(output, cols);
    }
  });
});
