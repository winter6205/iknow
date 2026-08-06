/**
 * tests/tui/render-smoke.test.tsx
 *
 * #146 渲染冒烟（原型 smoke-adaptive 同款模式：renderToString 多宽度断言）：
 *  - banner（2026-08-06 二轮）：占满行宽圆角线框（╭/╰/╮/╯），完整眼居左
 *    （24×12 braille，不裁切）+ info 栏（Version/Cwd/Data dir）居右；
 *    多宽度（MIN/120/160）无溢出行；每行占满 cols（无水平居中）；
 *    窄终端降级返回 []；SHORT 档单行；眼睛尺寸断言（24×12 近方形）。
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
import { EYE_LINES } from "../../src/tui/banner-art.js";
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

describe("banner 渲染（2026-08-06 二轮：占满行宽圆角框 + 完整眼居左 24×12 + info 居右）", () => {
  const info = {
    version: "0.1.0",
    cwd: "/home/u/proj",
    dataDir: "/home/u/.iknow",
  };

  it("BANNER_MIN_COLS / +24 / +64 列：多行输出且无溢出行", () => {
    for (const cols of [
      BANNER_MIN_COLS,
      BANNER_MIN_COLS + 24,
      BANNER_MIN_COLS + 64,
    ]) {
      const lines = renderBanner(info, { cols, short: false });
      expect(lines.length).toBeGreaterThan(1);
      assertNoOverflow(lines.join("\n"), cols);
    }
  });

  it("banner 占满行宽：每行宽度 == cols（无水平居中，与输入框一致）", () => {
    for (const cols of [
      BANNER_MIN_COLS,
      BANNER_MIN_COLS + 24,
      BANNER_MIN_COLS + 64,
    ]) {
      const lines = renderBanner(info, { cols, short: false });
      const plain = lines.map(stripAnsi);
      for (const [i, line] of plain.entries()) {
        expect(visualWidth(line), `第 ${i} 行应占满 ${cols} 列`).toBe(cols);
      }
    }
  });

  it("圆角外框：╭/╮ 顶、╰/╯ 底 + 左对齐 title + 竖线 | 边", () => {
    const lines = renderBanner(info, { cols: 120, short: false });
    const plain = lines.map(stripAnsi);
    // 首行 = 框顶：╭ + title（左对齐）+ ─… + ╮
    const top = plain[0]!;
    expect(top).toMatch(/^╭◆ iknow tui─+╮$/);
    // 末行 = 框底：╰─…─╯
    const bottom = plain[plain.length - 1]!;
    expect(bottom).toMatch(/^╰─+╯$/);
    // 中段行 = │ 内文 │
    for (let i = 1; i < plain.length - 1; i++) {
      expect(plain[i]).toMatch(/^│.*│$/);
    }
    // 每行都占满 120 列（圆角框撑满行宽）
    for (const line of plain) {
      expect(visualWidth(line)).toBe(120);
    }
  });

  it("小眼睛居左 + info 栏（Version/Cwd/Data dir）渲染在框内", () => {
    const lines = renderBanner(info, { cols: 120, short: false });
    const plain = stripAnsi(lines.join("\n"));
    expect(plain).toContain("Version");
    expect(plain).toContain("Cwd");
    expect(plain).toContain("Data dir");
    expect(plain).toContain("0.1.0");
    expect(plain).toContain("proj");
    expect(plain).toContain(".iknow");
    // 眼睛图标（braille 点阵）必须渲染在框内
    expect(plain).toContain("⣷"); // EYE_LINES 内任一 braille 码点
  });

  it("info 栏长值中段截断：保留首段 + 尾段文件名", () => {
    const longInfo = {
      version: "0.1.0",
      cwd: "/home/u/proj",
      dataDir: "/home/u/.local/share/iknow/sessions",
    };
    const lines = renderBanner(longInfo, {
      cols: BANNER_MIN_COLS,
      short: false,
    });
    const plain = stripAnsi(lines.join("\n"));
    // 中段截断符 + 末段保留 sessions（文件名）
    expect(plain).toContain("…");
    expect(plain).toContain("sessions");
    expect(plain).not.toMatch(/share\/iknow\s*$/);
  });

  it("窄终端降级：cols < BANNER_MIN_COLS → []", () => {
    const lines = renderBanner(info, {
      cols: BANNER_MIN_COLS - 1,
      short: false,
    });
    expect(lines).toEqual([]);
  });

  it("SHORT 档（矮终端）：单行简化", () => {
    const lines = renderBanner(info, {
      cols: BANNER_MIN_COLS,
      short: true,
    });
    expect(lines.length).toBe(1);
    expect(stripAnsi(lines[0]!)).toContain("iknow");
  });

  it("UI 层无 emoji", () => {
    const lines = renderBanner(info, { cols: 120, short: false });
    expect(EMOJI_RE.test(stripAnsi(lines.join("\n")))).toBe(false);
  });

  it("眼睛尺寸：完整眼不裁切（24 列 × 12 行；终端显示比 ≈ COLS/(ROWS*2) ≈ 1.0 近方形）", () => {
    // 2026-08-06 二轮：首轮 16×6 是「瞳孔/虹膜 ±95px 裁窗」，用户复看裁定
    // "把眼睛裁掉了"，改用 eyeshape.png 重生成完整眼（24×12 braille，含眼睑/
    // 眼框/R 符文/下眼睑）。"眼睛依旧不要放太大"——24 列仍是小号，但完整。
    const w = visualWidth(EYE_LINES[0] ?? "");
    const h = EYE_LINES.length;
    expect(w).toBe(24);
    expect(h).toBe(12);
    expect(w / (h * 2)).toBeCloseTo(1.0, 1); // 近方形（非瘦高）
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
