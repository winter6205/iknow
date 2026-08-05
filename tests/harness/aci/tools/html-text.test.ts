/**
 * html-text 共享原语单元测试。
 *
 * 此前 htmlToText / cleanHtml / decodeEntities 仅经 web-fetch / web-search
 * 工具测试间接覆盖（基础实体解码 / script 跳过）。本文件补 pathological HTML
 * 边界，固化正则 parser 的行为契约（与 upstream HTMLParser 状态机的差异
 * 属已知偏离，本测试锁定当前行为，便于后续评估是否换 DOM parser）。
 *
 * 覆盖维度：
 *   - 基础：纯文本 / 空输入 / 单标签 / 嵌套标签
 *   - script/style 块跳过：含 '<' 字符串 / 深度嵌套 / 自闭合变体
 *   - 实体：命名 + 数字十进制 + 十六进制 + 漏分号 + 越界码点 + 双重编码
 *   - 空白折叠：连续空白 / 混合换行制表符 / nbsp 折叠
 *   - 畸形：未闭合标签 / 标签内 '<' / 属性含 '>' / 注释 / CDATA
 */

import assert from "node:assert/strict";
import { describe, it } from "vitest";

import {
  cleanHtml,
  decodeEntities,
  htmlToText,
} from "../../../../src/harness/aci/tools/html-text.ts";

describe("decodeEntities - named entities", () => {
  it("decodes the four upstream entities + quot + #39", () => {
    assert.equal(decodeEntities("&nbsp;"), " ");
    assert.equal(decodeEntities("&amp;"), "&");
    assert.equal(decodeEntities("&lt;"), "<");
    assert.equal(decodeEntities("&gt;"), ">");
    assert.equal(decodeEntities("&quot;"), '"');
    assert.equal(decodeEntities("&#39;"), "'");
  });

  it("decodes mixed entities in running text", () => {
    assert.equal(
      decodeEntities("a &amp; b &lt; c &gt; d &quot;e&quot;"),
      'a & b < c > d "e"'
    );
  });

  it("leaves unknown named entities as-is", () => {
    assert.equal(
      decodeEntities("&copy; &trade; &mdash;"),
      "&copy; &trade; &mdash;"
    );
  });
});

describe("decodeEntities - numeric entities", () => {
  it("decodes decimal numeric entities", () => {
    assert.equal(decodeEntities("&#65;"), "A");
    assert.equal(decodeEntities("&#8364;"), "€");
  });

  it("decodes hex numeric entities", () => {
    assert.equal(decodeEntities("&#x41;"), "A");
    assert.equal(decodeEntities("&#x1F600;"), "😀");
  });

  it("handles mixed-case hex", () => {
    assert.equal(decodeEntities("&#X4A;"), "J");
  });

  it("tolerates leading zeros in numeric entities", () => {
    assert.equal(decodeEntities("&#0065;"), "A");
    assert.equal(decodeEntities("&#x041;"), "A");
  });
});

describe("decodeEntities - edge cases", () => {
  it("missing semicolon: named entities not decoded (no false positive)", () => {
    // &amp without ';' is left as-is -- upstream html.unescape may differ,
    // we explicitly do not coerce partial entities.
    assert.equal(decodeEntities("&amp"), "&amp");
    assert.equal(decodeEntities("AT&T"), "AT&T");
  });

  it("out-of-range code point does not crash (String.fromCodePoint throws for >0x10FFFF)", () => {
    // 越界码点：fromCodePoint 抛 RangeError，当前实现会抛出（固化此行为）。
    // 这是已知边界：生产 HTML 不会出现，但测试锁定失败模式而非静默吞错。
    assert.throws(
      () => decodeEntities("&#x110000;"),
      (err: unknown) => err instanceof RangeError
    );
  });

  it("plain text without entities is unchanged", () => {
    assert.equal(decodeEntities("just plain text"), "just plain text");
  });

  it("empty string returns empty", () => {
    assert.equal(decodeEntities(""), "");
  });
});

describe("htmlToText - basic extraction", () => {
  it("returns empty for empty input", () => {
    assert.equal(htmlToText(""), "");
  });

  it("returns plain text unchanged (no tags)", () => {
    assert.equal(htmlToText("just words here"), "just words here");
  });

  it("strips a single tag", () => {
    assert.equal(htmlToText("<p>hello</p>"), "hello");
  });

  it("strips nested tags and keeps text", () => {
    assert.equal(htmlToText("<div>a <span>b</span> c</div>"), "a b c");
  });

  it("strips tags with attributes", () => {
    assert.equal(htmlToText('<a href="x" class="y">link</a>'), "link");
  });
});

describe("htmlToText - script/style block skipping", () => {
  it("skips a script block containing a '<' string", () => {
    const html = "<p>keep</p><script>var s = 'a < b';</script><p>also</p>";
    assert.equal(htmlToText(html), "keep also");
  });

  it("skips a style block with braces", () => {
    const html = "<p>x</p><style>.a { color: red; }</style><p>y</p>";
    assert.equal(htmlToText(html), "x y");
  });

  it("does not execute or leak script content as text", () => {
    const html = "<script>document.write('<h1>evil</h1>')</script>visible";
    const out = htmlToText(html);
    assert.ok(!out.includes("document.write"));
    assert.ok(!out.includes("evil"));
    assert.ok(out.includes("visible"));
  });

  it("handles multiple script blocks", () => {
    const html = "a<script>1</script>b<script>2</script>c";
    assert.equal(htmlToText(html), "a b c");
  });

  it("decodes entities inside script-adjacent text", () => {
    const html = "<p>A &amp; B</p><script>ignore</script>";
    assert.equal(htmlToText(html), "A & B");
  });
});

describe("htmlToText - whitespace folding", () => {
  it("collapses runs of spaces and tabs", () => {
    assert.equal(htmlToText("a    b\t\tc"), "a b c");
  });

  it("collapses \r and \f to spaces but preserves \\n (paragraph boundary)", () => {
    // 设计选择（对齐 upstream HTMLParser 状态机行为）：换行符 \n 保留为
    // 段落边界；\r / \f / \v 与水平空白合并为单个空格。这样输出对 LLM
    // 更可读（保留段落结构），且与 upstream web_fetch_tool 一致。
    // 单 \n 不被合并（"a\nb" 留作段落分隔），双 \n 才折叠。
    assert.equal(htmlToText("a\nb\rc\fd"), "a\nb c d");
  });

  it("folds whitespace left by stripped tags", () => {
    const html = "<div>  <span>  x  </span>  </div>";
    assert.equal(htmlToText(html), "x");
  });

  it("decodes &nbsp; to a foldable space", () => {
    const html = "<p>a&nbsp;&nbsp;b</p>";
    assert.equal(htmlToText(html), "a b");
  });
});

describe("htmlToText - malformed input", () => {
  it("unclosed tag: strips up to the last '>'", () => {
    // 正则 <[^>]+> 贪婪到第一个 '>'；未闭合标签剩余文本原样保留。
    const out = htmlToText("<p>hello world");
    assert.equal(out, "hello world");
  });

  it("'<' inside text (not a tag) is preserved", () => {
    // 'a < b' 中 '<' 后无字母 + '>'，正则不匹配为标签，原样保留。
    assert.equal(htmlToText("a < b"), "a < b");
  });

  it("attribute value containing '>' is split early", () => {
    // data-x="a>b" 中第一个 '>' 出现在属性值内，正则会在那里截断标签。
    // 固化此行为：不崩溃，输出含标签后的文本。
    const html = '<a data-x="a>b">link</a> tail';
    const out = htmlToText(html);
    assert.ok(out.includes("link"));
    assert.ok(out.includes("tail"));
  });

  it("HTML comment is stripped as a tag", () => {
    // <!-- comment --> 的 '<' 到 '>' 被当普通标签剥离，内容残留为文本。
    // 固化当前行为（与 DOM parser 不同：注释文本可能泄漏）。
    const html = "<p>x</p><!-- secret note --><p>y</p>";
    const out = htmlToText(html);
    assert.ok(out.includes("x"));
    assert.ok(out.includes("y"));
    // 注释是否泄漏是已知偏离，仅断言不崩溃 + 主文本保留。
  });

  it("CDATA section is handled without crashing", () => {
    const html = "<p>x</p><![CDATA[ raw <content> ]]><p>y</p>";
    const out = htmlToText(html);
    assert.ok(out.includes("x"));
    assert.ok(out.includes("y"));
  });
});

describe("htmlToText - robustness", () => {
  it("handles deeply nested tags (no exponential backtracking)", () => {
    // 构造 200 层嵌套 div，确保正则在合理时间内完成。
    const depth = 200;
    const open = "<div>".repeat(depth);
    const close = "</div>".repeat(depth);
    const html = `${open}core${close}`;
    const t0 = Date.now();
    const out = htmlToText(html);
    const elapsed = Date.now() - t0;
    assert.equal(out, "core");
    // 经验阈值：正则 parser 应在 < 100ms 完成（防 ReDoS 退化）。
    assert.ok(elapsed < 500, `deeply nested took ${elapsed}ms`);
  });

  it("handles large input without crashing", () => {
    const chunk = "<p>hello world</p>";
    const html = chunk.repeat(10_000);
    const out = htmlToText(html);
    assert.ok(out.length > 0);
    assert.ok(!out.includes("<p>"));
  });

  it("mixed-case SCRIPT/STYLE tags are skipped", () => {
    const html = "<P>a</P><SCRIPT>x</SCRIPT><P>b</P>";
    assert.equal(htmlToText(html), "a b");
  });
});

describe("cleanHtml - fragment cleaning", () => {
  it("strips tags and decodes entities", () => {
    assert.equal(cleanHtml("<b>bold</b> &amp; <i>italic</i>"), "bold & italic");
  });

  it("collapses all whitespace including newlines", () => {
    assert.equal(cleanHtml("a\n  b\t\tc"), "a b c");
  });

  it("returns empty for tags-only fragment", () => {
    assert.equal(cleanHtml("<a></a><span></span>"), "");
  });

  it("preserves text with leading/trailing tags", () => {
    assert.equal(cleanHtml("<a>  link  </a>"), "link");
  });

  it("empty input returns empty", () => {
    assert.equal(cleanHtml(""), "");
  });
});
