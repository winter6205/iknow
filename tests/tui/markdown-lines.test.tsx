/**
 * tests/tui/markdown-lines.test.tsx
 *
 * #189 修复版：markdown-lines.ts（markdown → 物理行 SSOT）+ wrapTextVisual
 * 单元测试。行账逐 token 镜像 markdown.tsx renderToken（#279 项 1：块解析
 * 换 marked.lexer；折行换 wrap-ansi 词感知，与 ink wrap="wrap" 同源）；
 * 边界类（empty / max<=0 / 长 token / 未闭合 fence / 半截表格 / CJK）显式
 * 覆盖（architecture gate defensive-contract 要求）。末尾 describe 直接
 * ink renderToString 与 markdownToLines 行数对拍（parity 锁，chat-view
 * parity 测试之外的第二道防线）。
 */
import { describe, expect, it } from "vitest";
import { renderToString } from "ink";
import { markdownToLines } from "../../src/tui/markdown-lines.js";
import { Markdown } from "../../src/tui/markdown.js";
import { wrapTextVisual } from "../../src/tui/text.js";

const ANSI_RE = /\x1b\[[0-9;]*m/g;
const stripAnsi = (s: string): string => s.replace(ANSI_RE, "");

describe("wrapTextVisual（视觉宽度折行 SSOT）", () => {
  it("边界：空字符串 → ['']", () => {
    expect(wrapTextVisual("", 80)).toEqual([""]);
  });

  it("边界：max <= 0 → [s]（不折）", () => {
    expect(wrapTextVisual("xyz", 0)).toEqual(["xyz"]);
    expect(wrapTextVisual("xyz", -3)).toEqual(["xyz"]);
  });

  it("边界：长 token 超宽按宽度硬切（不溢出）", () => {
    const out = wrapTextVisual("abcdefghij", 3);
    expect(out).toEqual(["abc", "def", "ghi", "j"]);
  });

  it("边界：显式换行符预切（每段独立折行）", () => {
    expect(wrapTextVisual("a\nb", 80)).toEqual(["a", "b"]);
    expect(wrapTextVisual("abcd\nef", 2)).toEqual(["ab", "cd", "ef"]);
  });

  it("CJK：每字符 2 列，按视觉宽度折（不按字符数低估）", () => {
    expect(wrapTextVisual("一二三四五六七八九十", 10)).toEqual([
      "一二三四五",
      "六七八九十",
    ]);
    expect(wrapTextVisual("一二三四五六七八九十", 8)).toEqual([
      "一二三四",
      "五六七八",
      "九十",
    ]);
  });

  it("混合 ASCII + CJK 边界折", () => {
    expect(wrapTextVisual("abc一二三def四五", 10)).toEqual([
      "abc一二三d",
      "ef四五",
    ]);
  });
});

describe("markdownToLines（markdown → 物理行 SSOT）", () => {
  it("plain 段落：1 行", () => {
    expect(markdownToLines("hello world", 80)).toEqual(["hello world"]);
  });

  it("h1：前置空格行（marginTop=1）+ 文本行", () => {
    expect(markdownToLines("# T", 80)).toEqual([" ", "T"]);
  });

  it("h2：无前置空行", () => {
    expect(markdownToLines("## T", 80)).toEqual(["T"]);
  });

  it("列表：bullet 记号 + 缩进", () => {
    expect(markdownToLines("- a\n- b", 80)).toEqual(["• a", "• b"]);
    expect(markdownToLines("- a\n  - a1", 80)).toEqual(["• a", "  • a1"]);
  });

  it("有序列表：数字 + 点", () => {
    expect(markdownToLines("1. one\n2. two", 80)).toEqual(["1. one", "2. two"]);
  });

  it("引用：`│ ` 前缀", () => {
    expect(markdownToLines("> quoted", 80)).toEqual(["│ quoted"]);
  });

  it("边界：blank → 空格行（不折叠）", () => {
    expect(markdownToLines("a\n\nb", 80)).toEqual(["a", " ", "b"]);
  });

  it("fence：┌┐ 边框 + lang + 内容 + └┘", () => {
    const out = markdownToLines("```ts\nx\n```", 80);
    expect(out[0]).toMatch(/^┌─/);
    expect(out[1]).toBe("│ ts");
    expect(out[2]).toBe("│ x");
    expect(out[out.length - 1]).toMatch(/^└─/);
  });

  it("边界：未闭合 fence 吞到文末", () => {
    const out = markdownToLines("```\nx\ny", 80);
    // marked 与旧 parseFence 同行为：无闭合 ``` 时 code token 吞到 EOF
    expect(out[0]).toMatch(/^┌─/);
    expect(out).toContain("│ x");
    expect(out).toContain("│ y");
  });

  it("边界：空 fence 体 → 仅 ┌┐ + └┘", () => {
    const out = markdownToLines("```\n```", 80);
    expect(out.length).toBe(2);
  });

  it("table：cell padEndVisual(max+2) 连接，header 行 + 分隔行被跳过", () => {
    const out = markdownToLines("| a |\n|---|\n| b |", 80);
    expect(out).toEqual(["a  ", "b  "]);
  });

  it("边界：cols=0 不崩（width 下界 1）", () => {
    const out = markdownToLines("abc", 0);
    expect(out.length).toBeGreaterThanOrEqual(1);
  });

  it("CJK 段落按视觉宽度折行", () => {
    const out = markdownToLines("一二三四五六七八九十", 10);
    expect(out).toEqual(["一二三四五", "六七八九十"]);
  });

  it("边界：空文本 → 单空格占位行（与渲染侧 <Text> </Text> 对齐）", () => {
    expect(markdownToLines("", 80)).toEqual([" "]);
  });

  it("边界：裸引用 `>` → 单行 `│ ` 占位", () => {
    expect(markdownToLines(">", 80)).toEqual(["│  "]);
  });

  it("边界：流式半截表格（有分隔行无数据行）→ 仅 header 行", () => {
    expect(markdownToLines("| h |\n|---|", 80)).toEqual(["h  "]);
  });

  it("del / link 行内扁平化：定界符与 URL 不占列", () => {
    expect(markdownToLines("~~gone~~", 80)).toEqual(["gone"]);
    expect(markdownToLines("[锚文本](https://x.y/z)", 80)).toEqual(["锚文本"]);
  });

  it("html 块：逐行原文（GFM 新增能力）", () => {
    expect(markdownToLines("<div>\nx\n</div>", 80)).toEqual([
      "<div>",
      "x",
      "</div>",
    ]);
  });

  it("hr：占位空格行（不引入新行高）", () => {
    expect(markdownToLines("---", 80)).toEqual([" "]);
  });

  it("setext 标题：h1 等价（前置空格行 + 文本行）", () => {
    expect(markdownToLines("Title\n=====", 80)).toEqual([" ", "Title"]);
  });

  it("窄终端 CJK fence：内容宽 cols-4 按视觉宽度折", () => {
    const out = markdownToLines("```\n一二三四五六\n```", 10);
    expect(out).toEqual([
      "┌────────┐",
      "│ 一二三",
      "│ 四五六",
      "└────────┘",
    ]);
  });

  it("ASCII 段落词感知折行（wrap-ansi 整词换行，非硬切）", () => {
    // cols=8：硬切会算 3 行（"alpha be" / "ta gamma" / " delta"），wrap-ansi
    // 整词换行 → 4 行。`trim: false` 保留词间尾随空格——与 ink wrap="wrap"
    // 同源（行账 SSOT 保留可见列内容）。
    expect(markdownToLines("alpha beta gamma delta", 8)).toEqual([
      "alpha ",
      "beta ",
      "gamma ",
      "delta",
    ]);
    // cols=12：alpha beta / gamma delta（同样保留词间尾随空格）。
    expect(markdownToLines("alpha beta gamma delta", 12)).toEqual([
      "alpha beta ",
      "gamma delta",
    ]);
  });

  it("边界：超宽单词硬切（wrap-ansi hard）", () => {
    expect(markdownToLines("abcdefghij", 3)).toEqual([
      "abc",
      "def",
      "ghi",
      "j",
    ]);
  });

  it("loose list：多项多段落以空格分隔（不粘连）", () => {
    expect(markdownToLines("- a\n\n  b\n- c", 80)).toEqual(["• a b", "• c"]);
  });
});

/**
 * #279 项 1 parity 锁：markdownToLines 行数 === <Markdown> ink 实测渲染行数
 * （正常 / 边界 / 窄终端 CJK 三类 fixture × 三档宽度）。chat-view parity
 * 测试走全链路行账；此处直接对拍渲染器与行账 SSOT，定位更快。
 */
describe("markdownToLines ↔ <Markdown> 渲染行数 parity（#279）", () => {
  const fixtures: ReadonlyArray<string> = [
    "hello world",
    // ASCII 散文词感知折行对拍（wrap="wrap" 整词换行 vs 旧硬切漂移）。
    "alpha beta gamma delta",
    "# T",
    "## 标题\n\n正文第一段。\n\n- 列表项一\n- 列表项二\n\n```ts\nconst x = 1;\n```",
    // 嵌套 + 有序列表。
    "1. first\n   - sub a\n   - sub b\n2. second",
    // loose list（项内多段落）。
    "- alpha\n\n  beta\n- gamma",
    // hr / setext / html。
    "Title\n=====\n\n---\n\n<div>\nx\n</div>",
    // 宽表格行（窄终端触发折行）。
    "| long header cell | another wide cell |\n|---|---|\n| value one | value two |",
    // 宽代码行（窄终端触发折行）。
    "```\nconst veryLongVariableName = someFunction(argumentOne, argumentTwo);\n```",
    "> quoted",
    "| a |\n|---|\n| b |",
    "```\nx\ny", // 未闭合 fence（流式草稿）
    "~~gone~~ **b** `c` *d*",
    "一二三四五六七八九十",
  ];
  for (const cols of [80, 24, 12, 8]) {
    it(`cols=${cols}：全部 fixture 行数对拍`, async () => {
      for (const md of fixtures) {
        const expected = markdownToLines(md, cols).length;
        const output = await renderToString(
          <Markdown text={md} width={cols} />,
          { columns: cols }
        );
        const actual = stripAnsi(output).split("\n").length;
        expect(actual, `fixture=${JSON.stringify(md)}`).toBe(expected);
      }
    });
  }
});
