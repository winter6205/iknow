/**
 * tests/tui/markdown-lines.test.ts
 *
 * #189 修复版：markdown-lines.ts（markdown → 物理行 SSOT）+ wrapTextVisual
 * 单元测试。行账逐块镜像 markdown.tsx renderBlock（chat-view parity 测试
 * 交叉验证）；边界 5 类（empty / max<=0 / 长 token / 未闭合 fence / CJK）
 * 显式覆盖（architecture gate defensive-contract 要求）。
 */
import { describe, expect, it } from "vitest";
import {
  markdownToLines,
  stripInlineMarkers,
} from "../../src/tui/markdown-lines.js";
import { wrapTextVisual } from "../../src/tui/text.js";

describe("stripInlineMarkers（行内记号剥离）", () => {
  it("粗体 / 斜体 / 行内代码定界符剥离", () => {
    expect(stripInlineMarkers("**bold**")).toBe("bold");
    expect(stripInlineMarkers("*it*")).toBe("it");
    expect(stripInlineMarkers("_it_")).toBe("it");
    expect(stripInlineMarkers("`code`")).toBe("code");
  });

  it("混合：a **b** `c` *d*", () => {
    expect(stripInlineMarkers("a **b** `c` *d*")).toBe("a b c d");
  });

  it("无记号原样返回", () => {
    expect(stripInlineMarkers("plain text")).toBe("plain text");
  });
});

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
    // parseFence 无闭合 ``` 时 i += 1 越界退出 → lines = ["x", "y"]
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
});
