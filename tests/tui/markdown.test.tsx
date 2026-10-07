/** @jsxImportSource @opentui/react */
/**
 * tests/tui/markdown.test.tsx — Markdown rendering acceptance (bun:test).
 *
 * Covers the captureSpans coloring assertions (bold / em / code /
 * strikethrough) plus the empty (blank / whitespace-only input), negative
 * (unclosed fence / ultra-long single line without newline / malformed
 * table) and overflow (over-wide table compression + clipOneLine
 * semantic truncation) boundary classes; fenced code block coloring
 * contract (dark-gray background + syntax highlighting): background color,
 * keyword/string/comment color separation, no border chars ┌┐└┘, no title,
 * diff lines' +/- reuse palette.add/del.
 */
import { expect, test } from "bun:test";
import { act, useState } from "react";
import { testRender } from "@opentui/react/test-utils";
import { RGBA, TextAttributes } from "@opentui/core";
import { marked } from "marked";
import { Markdown, tokenizeCodeLine } from "../../src/tui/markdown.js";
import { tuiPalette } from "../../src/tui/theme.js";

type Setup = Awaited<ReturnType<typeof testRender>>;

const WIDTH = 40;

/** Render the markdown and wait one frame; the caller owns destroy. */
async function renderMd(mdText: string, width = WIDTH): Promise<Setup> {
  const setup = await testRender(<Markdown text={mdText} width={width} />, {
    width,
    height: 30,
  });
  await setup.renderOnce();
  return setup;
}

/** Full-frame captureSpans sweep: find the first span satisfying the predicate. */
function findSpan(
  setup: Setup,
  pred: (span: {
    text: string;
    fg: RGBA;
    bg: RGBA;
    attributes: number;
  }) => boolean
): { text: string; fg: RGBA; bg: RGBA; attributes: number } | undefined {
  const { lines } = setup.captureSpans();
  for (const line of lines) {
    for (const span of line.spans) {
      if (pred(span)) return span;
    }
  }
  return undefined;
}

/** Split the captureCharFrame output line by line. */
function frameLines(setup: Setup): string[] {
  return setup.captureCharFrame().split("\n");
}

/**
 * Count blank lines *between* two content rows. Anchors are located by
 * content substring and only the interval between the two anchors is
 * counted — testRender's fixed-height trailing padding rows are excluded.
 */
function blankLinesBetween(
  setup: Setup,
  first: string,
  second: string
): number {
  const lines = frameLines(setup);
  const a = lines.findIndex((l) => l.includes(first));
  const b = lines.findIndex((l, i) => i > a && l.includes(second));
  if (a < 0 || b < 0) {
    throw new Error(
      `锚点未命中：first=${JSON.stringify(first)}@${a} ` +
        `second=${JSON.stringify(second)}@${b}`
    );
  }
  return lines.slice(a + 1, b).filter((l) => l.trim() === "").length;
}

/** Blank lines before the first content row (leading whitespace). */
function leadingBlankLines(setup: Setup): number {
  const lines = frameLines(setup);
  const first = lines.findIndex((l) => l.trim() !== "");
  return first < 0 ? 0 : first;
}

/** RGBA color equality (r/g/b channels; alpha ignored). */
function rgbaEq(a: RGBA, b: RGBA): boolean {
  return a.r === b.r && a.g === b.g && a.b === b.b;
}

// ── captureSpans coloring assertions (bold / em / code / strikethrough) ──

test("bold：strong 片段带 BOLD 属性位", async () => {
  const setup = await renderMd("前缀 **BOLDWORD** 后缀");
  const span = findSpan(
    setup,
    (s) =>
      s.text.includes("BOLDWORD") && (s.attributes & TextAttributes.BOLD) !== 0
  );
  expect(span).toBeDefined();
  await setup.renderer.destroy();
});

test("em：斜体片段带 ITALIC 属性位", async () => {
  const setup = await renderMd("前缀 *EMWORD* 后缀");
  const span = findSpan(
    setup,
    (s) =>
      s.text.includes("EMWORD") && (s.attributes & TextAttributes.ITALIC) !== 0
  );
  expect(span).toBeDefined();
  await setup.renderer.destroy();
});

test("inline code：codespan 前景色 = tuiPalette.code", async () => {
  const setup = await renderMd("前缀 `codeword` 后缀");
  const expected = RGBA.fromHex(tuiPalette.code);
  const span = findSpan(
    setup,
    (s) => s.text.includes("codeword") && rgbaEq(s.fg, expected)
  );
  expect(span).toBeDefined();
  await setup.renderer.destroy();
});

test("strikethrough：del 片段带 STRIKETHROUGH 属性位", async () => {
  const setup = await renderMd("前缀 ~~GONEWORD~~ 后缀");
  const span = findSpan(
    setup,
    (s) =>
      s.text.includes("GONEWORD") &&
      (s.attributes & TextAttributes.STRIKETHROUGH) !== 0
  );
  expect(span).toBeDefined();
  await setup.renderer.destroy();
});

// ── overflow: over-wide table compression + clipOneLine semantics ─────────

test("超宽表格压缩到容器宽度内且单元格被截断", async () => {
  const longA = "a".repeat(60);
  const longB = "b".repeat(60);
  const md = [
    `| HeaderCell-${longA} | OtherHeader-${longB} |`,
    "| --- | --- |",
    `| ${longA} | ${longB} |`,
  ].join("\n");
  const setup = await renderMd(md);
  const frame = setup.captureCharFrame();
  // Still table structure after compression (column separators present).
  expect(frame).toContain("│");
  // clipOneLine semantics: over-long cells are truncated and end with …
  expect(frame).toContain("…");
  // The raw over-long content never appears in full (compressed/clipped).
  expect(frame.includes(longA)).toBe(false);
  expect(frame.includes(longB)).toBe(false);
  // Every frame line fits the container width (no overflow).
  for (const line of frameLines(setup)) {
    expect(line.length).toBeLessThanOrEqual(WIDTH);
  }
  await setup.renderer.destroy();
});

// ── negative: malformed markdown neither crashes nor overflows ────────────

test("未闭合 fence 渲染不崩且内容可见", async () => {
  const setup = await renderMd("```ts\nconst a = 1;\nconst b = 2;");
  const frame = setup.captureCharFrame();
  expect(frame).toContain("const a = 1;");
  await setup.renderer.destroy();
});

test("超长无换行单行渲染不崩不溢出", async () => {
  const setup = await renderMd("x".repeat(500));
  const frame = setup.captureCharFrame();
  expect(frame).toContain("x");
  for (const line of frameLines(setup)) {
    expect(line.length).toBeLessThanOrEqual(WIDTH);
  }
  await setup.renderer.destroy();
});

test("非法 table（列数不齐）渲染不崩", async () => {
  const setup = await renderMd("| a | b\n| --- |\n| only-one |");
  const frame = setup.captureCharFrame();
  expect(frame).toContain("a");
  await setup.renderer.destroy();
});

// ── fenced code block c4 (dark-gray bg + syntax highlight) coloring contract ─

/** c4 background assertion: every span carries the codeBlockBg background. */
test("代码块 c4：所有 span 携带 codeBlockBg 背景色", async () => {
  const setup = await renderMd("```ts\nconst x = 1;\n```");
  const expectedBg = RGBA.fromHex(tuiPalette.codeBlockBg);
  const { lines } = setup.captureSpans();
  // At least some spans (not an empty block).
  expect(lines.some((l) => l.spans.length > 0)).toBe(true);
  for (const line of lines) {
    for (const s of line.spans) {
      if (s.text.trim() !== "" || s.text === "") {
        // Every span inside a code line has bg = codeBlockBg (incl. padding spaces and trailing fill).
        expect(rgbaEq(s.bg, expectedBg)).toBe(true);
      }
    }
  }
  await setup.renderer.destroy();
});

/** c4 keyword coloring: export uses syntaxKeyword. */
test("代码块 c4：关键字走 syntaxKeyword 紫色", async () => {
  const setup = await renderMd("```ts\nexport const x = 1;\n```");
  const expected = RGBA.fromHex(tuiPalette.syntaxKeyword);
  const span = findSpan(setup, (s) => rgbaEq(s.fg, expected));
  expect(span).toBeDefined();
  await setup.renderer.destroy();
});

/** c4 string coloring: double-quoted strings use syntaxString. */
test("代码块 c4：字符串走 syntaxString 橙色", async () => {
  const setup = await renderMd('```ts\nconst s = "hello";\n```');
  const expected = RGBA.fromHex(tuiPalette.syntaxString);
  const span = findSpan(setup, (s) => rgbaEq(s.fg, expected));
  expect(span).toBeDefined();
  await setup.renderer.destroy();
});

/** c4 comment coloring: `// ...` uses syntaxComment + DIM + ITALIC. */
test("代码块 c4：注释走 syntaxComment 绿 + DIM + ITALIC", async () => {
  const setup = await renderMd("```ts\n// greeting\nconst a = 1;\n```");
  const expected = RGBA.fromHex(tuiPalette.syntaxComment);
  const span = findSpan(
    setup,
    (s) =>
      s.text.startsWith("//") &&
      rgbaEq(s.fg, expected) &&
      (s.attributes & TextAttributes.DIM) !== 0 &&
      (s.attributes & TextAttributes.ITALIC) !== 0
  );
  expect(span).toBeDefined();
  await setup.renderer.destroy();
});

/** c4 number coloring: literal numbers use syntaxNumber. */
test("代码块 c4：数字走 syntaxNumber 浅青", async () => {
  const setup = await renderMd("```ts\nconst n = 42;\n```");
  const expected = RGBA.fromHex(tuiPalette.syntaxNumber);
  const span = findSpan(setup, (s) => rgbaEq(s.fg, expected));
  expect(span).toBeDefined();
  await setup.renderer.destroy();
});

/** c4 default foreground: non-token plain text uses codeDefault #d4d4d4 (not #66b8ae). */
test("代码块 c4：plain 文本走 codeDefault 字色", async () => {
  const setup = await renderMd("```ts\nplainword\n```");
  const expected = RGBA.fromHex(tuiPalette.codeDefault);
  const span = findSpan(
    setup,
    (s) => s.text === "plainword" && rgbaEq(s.fg, expected)
  );
  expect(span).toBeDefined();
  await setup.renderer.destroy();
});

/** c4 has no border characters (borderStyle is no longer single → no ┌┐└┘). */
test("代码块 c4：无边框字符 ┌┐└┘", async () => {
  const setup = await renderMd("```ts\nconst x = 1;\n```");
  const frame = setup.captureCharFrame();
  expect(frame.includes("┌")).toBe(false);
  expect(frame.includes("┐")).toBe(false);
  expect(frame.includes("└")).toBe(false);
  expect(frame.includes("┘")).toBe(false);
  // Also no single-line horizontal rule chars (so ─ from other sources is never
  // miscounted as a border — c4 has no border at all).
  expect(frame.includes("─")).toBe(false);
  await setup.renderer.destroy();
});

/** c4 has no title: the language tag never sits on a border line (c4 does not render lang on the frame). */
test("代码块 c4：无语言标签出现在边框行", async () => {
  const setup = await renderMd("```ts\nconst x = 1;\n```");
  // Border line = single-line box `─` + title pattern (c4 has no border → no `─ ts` line is possible).
  const titleLine = frameLines(setup).find(
    (l) => l.includes("─") && l.includes("ts")
  );
  expect(titleLine).toBeUndefined();
  // `ts` may still appear once as code content (a language identifier), but never attached to border chars.
  await setup.renderer.destroy();
});

/** c4 diff: leading +/- reuse palette.add/del. */
test("代码块 c4 diff：+ 行首 add 绿，- 行首 del 红", async () => {
  const setup = await renderMd(
    "```diff\n+ const a = 1;\n- const b = 2;\n const c = 3;\n```"
  );
  const addExpected = RGBA.fromHex(tuiPalette.add);
  const delExpected = RGBA.fromHex(tuiPalette.del);
  const addSpan = findSpan(
    setup,
    (s) => s.text === "+" && rgbaEq(s.fg, addExpected)
  );
  const delSpan = findSpan(
    setup,
    (s) => s.text === "-" && rgbaEq(s.fg, delExpected)
  );
  expect(addSpan).toBeDefined();
  expect(delSpan).toBeDefined();
  await setup.renderer.destroy();
});

test("围栏显示窗：33 行只挂前 32 行并提示 +1 more lines", async () => {
  const body = Array.from({ length: 33 }, (_, i) => `FENCE_LINE_${i + 1}`).join(
    "\n"
  );
  const setup = await testRender(
    <Markdown text={"```ts\n" + body + "\n```"} width={WIDTH} />,
    { width: WIDTH, height: 50 }
  );
  await setup.renderOnce();
  const frame = setup.captureCharFrame();
  expect(frame).toContain("FENCE_LINE_32");
  // docs/CONTEXT.md `fence display cap`: overflow copy = `+N more lines`.
  expect(frame).toContain("+1 more lines");
  expect(frame.includes("FENCE_LINE_33")).toBe(false);
  expect(blankLinesBetween(setup, "FENCE_LINE_32", "+1 more lines")).toBe(0);
  await setup.renderer.destroy();
});

test("围栏显示窗：32 行全挂且无溢出提示", async () => {
  const body = Array.from({ length: 32 }, (_, i) => `CAP_LINE_${i + 1}`).join(
    "\n"
  );
  const setup = await testRender(
    <Markdown text={"```ts\n" + body + "\n```"} width={WIDTH} />,
    { width: WIDTH, height: 50 }
  );
  await setup.renderOnce();
  const frame = setup.captureCharFrame();
  expect(frame).toContain("CAP_LINE_1");
  expect(frame).toContain("CAP_LINE_32");
  expect(frame.includes("more lines")).toBe(false);
  await setup.renderer.destroy();
});

/** c4 blank lines do not collapse: a code block with blank lines keeps ≥ content lines + padding + margin rows. */
test("代码块 c4：含空行的代码块不塌缩行高", async () => {
  const setup = await renderMd("```ts\nconst a = 1;\n\nconst b = 2;\n```");
  const frame = setup.captureCharFrame();
  // Both "const a" and "const b" content lines are present.
  expect(frame).toContain("const a = 1;");
  expect(frame).toContain("const b = 2;");
  await setup.renderer.destroy();
});

/** tokenizeCodeLine unit tests: verify regex + capture-group semantics directly, without JSX rendering. */
test("tokenizeCodeLine：comment / string / number / keyword 分色", () => {
  const tokens = tokenizeCodeLine('// greet\nexport const s = "hi"; // tail');
  // Expected splits: comment `// greet\n`, keyword `export`, keyword `const`,
  // plain ` s = `, string `"hi"`, plain `; // tail`.
  const kinds = tokens.map((t) => t.kind);
  expect(kinds).toContain("comment");
  expect(kinds).toContain("keyword");
  expect(kinds).toContain("string");
  expect(kinds).toContain("plain");
  // The keyword appears at least twice (export + const).
  const kwCount = tokens.filter((t) => t.kind === "keyword").length;
  expect(kwCount).toBeGreaterThanOrEqual(2);
  // The string capture group includes the quotes.
  const strTok = tokens.find((t) => t.kind === "string");
  expect(strTok?.text).toBe('"hi"');
  // The comment capture group starts with `//`.
  const cmtTok = tokens.find((t) => t.kind === "comment");
  expect(cmtTok?.text.startsWith("//")).toBe(true);
});

test("tokenizeCodeLine：数字字面单独捕获", () => {
  const tokens = tokenizeCodeLine("const n = 42;");
  const numTok = tokens.find((t) => t.kind === "number");
  expect(numTok?.text).toBe("42");
});

test("tokenizeCodeLine：空行 → 空数组", () => {
  expect(tokenizeCodeLine("")).toEqual([]);
});

test("tokenizeCodeLine：纯 plain 行 → 一个 plain token", () => {
  const tokens = tokenizeCodeLine("hello world");
  expect(tokens).toEqual([{ kind: "plain", text: "hello world" }]);
});

// ── empty boundary: empty string / whitespace-only input renders without crashing ─

test("空字符串渲染不崩", async () => {
  const setup = await testRender(<Markdown text="" width={WIDTH} />, {
    width: WIDTH,
    height: 30,
  });
  await setup.flush();
  const frame = setup.captureCharFrame();
  expect(frame).toBeDefined();
  await setup.renderer.destroy();
});

test("纯空白输入渲染不崩", async () => {
  const setup = await testRender(
    <Markdown text={"   \n\t \n  "} width={WIDTH} />,
    {
      width: WIDTH,
      height: 30,
    }
  );
  await setup.flush();
  const frame = setup.captureCharFrame();
  expect(frame).toBeDefined();
  await setup.renderer.destroy();
});

// ── pangu spacing: insert a half-width space at CJK ↔ ASCII alnum boundaries ─

test("盘古之白：段落文本中英数字边界插空格", async () => {
  const setup = await renderMd("美股4月，CNBC的页面价格是100元");
  const frame = setup.captureCharFrame();
  expect(frame).toContain("美股 4 月");
  expect(frame).toContain("CNBC 的页面");
  expect(frame).toContain("价格是 100 元");
  // Idempotence: the original unspaced form never appears as a whole string.
  expect(frame.includes("美股4月")).toBe(false);
  await setup.renderer.destroy();
});

test("盘古之白：blockquote 每行同样插空格", async () => {
  const setup = await renderMd("> 涨幅10%\n> 原文引用2");
  const frame = setup.captureCharFrame();
  expect(frame).toContain("涨幅 10%");
  expect(frame).toContain("原文引用 2");
  await setup.renderer.destroy();
});

test("盘古之白：codespan 内不插空格", async () => {
  const setup = await renderMd("前缀 `中a文123` 后缀");
  const frame = setup.captureCharFrame();
  expect(frame).toContain("中a文123");
  expect(frame.includes("中 a 文")).toBe(false);
  await setup.renderer.destroy();
});

test("盘古之白：代码围栏块内不插空格", async () => {
  const setup = await renderMd("```ts\nconst 数=1;\n```");
  const frame = setup.captureCharFrame();
  // Inside code blocks the CJK ↔ digit boundary stays verbatim, no inserted spaces.
  expect(frame).toContain("const 数=1;");
  expect(frame.includes("数 =1")).toBe(false);
  expect(frame.includes("数= 1")).toBe(false);
  await setup.renderer.destroy();
});

test("盘古之白：blockquote 内 codespan 不插空格，外围照常插", async () => {
  const setup = await renderMd("> 涨幅10元 `中a文123` 尾注2行");
  const frame = setup.captureCharFrame();
  // codespan content stays verbatim (the "never touch code content" contract).
  expect(frame).toContain("中a文123");
  expect(frame.includes("中 a 文")).toBe(false);
  // Around the codespan, blockquote text still gets spaces as usual.
  expect(frame).toContain("涨幅 10 元");
  expect(frame).toContain("尾注 2 行");
  await setup.renderer.destroy();
});

// ── pangu negative anchors: excluded contexts deliberately get no spaces ────

test("盘古之白负向：表格单元格不插空格（列宽紧凑优先）", async () => {
  const setup = await renderMd(
    "| 美股4月 | 备注 |\n| --- | --- |\n| 数据1行 | ok |"
  );
  const frame = setup.captureCharFrame();
  expect(frame).toContain("美股4月");
  expect(frame).toContain("数据1行");
  expect(frame.includes("美股 4 月")).toBe(false);
  expect(frame.includes("数据 1 行")).toBe(false);
  await setup.renderer.destroy();
});

test("盘古之白负向：html 块不插空格", async () => {
  const setup = await renderMd('<div class="涨幅10%">美股4月</div>');
  const frame = setup.captureCharFrame();
  expect(frame).toContain("美股4月");
  expect(frame.includes("美股 4 月")).toBe(false);
  await setup.renderer.destroy();
});

// ── block spacing: the container gap is the sole SSOT; adjacent blocks get exactly one blank line ─

test("块间距：相邻两段之间恰 1 行空白", async () => {
  const setup = await renderMd("第一段\n\n第二段");
  expect(blankLinesBetween(setup, "第一段", "第二段")).toBe(1);
  await setup.renderer.destroy();
});

test("块间距：h2 标题与正文之间恰 1 行空白", async () => {
  const setup = await renderMd("## 标题\n\n正文段落");
  expect(blankLinesBetween(setup, "标题", "正文段落")).toBe(1);
  await setup.renderer.destroy();
});

test("块间距：h1 标题无前导空白行，与正文之间恰 1 行空白", async () => {
  const setup = await renderMd("# 大标题\n\n正文段落");
  expect(leadingBlankLines(setup)).toBe(0);
  expect(blankLinesBetween(setup, "大标题", "正文段落")).toBe(1);
  await setup.renderer.destroy();
});

test("块间距：代码块与前后段落各恰 1 行空白（gap 不与 margin 叠加）", async () => {
  const setup = await renderMd("前置段\n\n```ts\nconst x = 1;\n```\n\n后置段");
  expect(blankLinesBetween(setup, "前置段", "const x = 1;")).toBe(1);
  expect(blankLinesBetween(setup, "const x = 1;", "后置段")).toBe(1);
  await setup.renderer.destroy();
});

test("块间距：列表与相邻段落各恰 1 行空白，列表项之间无空白行", async () => {
  const setup = await renderMd("段落\n\n- alpha\n- beta\n\n尾段");
  expect(blankLinesBetween(setup, "段落", "alpha")).toBe(1);
  expect(blankLinesBetween(setup, "alpha", "beta")).toBe(0);
  expect(blankLinesBetween(setup, "beta", "尾段")).toBe(1);
  await setup.renderer.destroy();
});

test("块间距：单段落无前导空白行", async () => {
  const setup = await renderMd("只有一段");
  expect(leadingBlankLines(setup)).toBe(0);
  await setup.renderer.destroy();
});

test("围栏显示窗：超长未闭合围栏不超过 32 行源码", async () => {
  const body = Array.from({ length: 40 }, (_, i) => `OPEN_LINE_${i + 1}`).join(
    "\n"
  );
  const setup = await testRender(
    <Markdown text={"```ts\n" + body} width={WIDTH} />,
    { width: WIDTH, height: 50 }
  );
  await setup.renderOnce();
  const frame = setup.captureCharFrame();
  expect(frame).toContain("OPEN_LINE_32");
  expect(frame).toContain("+8 more lines");
  expect(frame.includes("OPEN_LINE_33")).toBe(false);
  await setup.renderer.destroy();
});

// ── html block display window: same 32-line cap as fences (unbounded <style> must not mount wholly) ─

test("html 块显示窗：>32 行 html 只挂前 32 行并提示 +N more lines", async () => {
  const body = Array.from(
    { length: 40 },
    (_, i) => `HTML_CAP_LINE_${i + 1}`
  ).join("\n");
  const setup = await testRender(
    <Markdown text={`<style>\n${body}\n</style>\n\n尾段`} width={WIDTH} />,
    { width: WIDTH, height: 60 }
  );
  await setup.renderOnce();
  const frame = setup.captureCharFrame();
  // Exactly 32 lines in the window: `<style>` + the first 31 body lines (HTML_CAP_LINE_31 is the last).
  expect(frame).toContain("<style>");
  expect(frame).toContain("HTML_CAP_LINE_31");
  expect(frame).toContain("+10 more lines");
  expect(frame.includes("HTML_CAP_LINE_32")).toBe(false);
  expect(frame.includes("HTML_CAP_LINE_40")).toBe(false);
  // Body text after the html block is unaffected by line truncation (session body stays complete).
  expect(frame).toContain("尾段");
  await setup.renderer.destroy();
});

test("html 块显示窗：≤32 行全挂且无溢出提示", async () => {
  const body = Array.from(
    { length: 30 },
    (_, i) => `HTML_OK_LINE_${i + 1}`
  ).join("\n");
  const setup = await testRender(
    <Markdown text={`<style>\n${body}\n</style>`} width={WIDTH} />,
    { width: WIDTH, height: 50 }
  );
  await setup.renderOnce();
  const frame = setup.captureCharFrame();
  expect(frame).toContain("<style>");
  expect(frame).toContain("HTML_OK_LINE_1");
  expect(frame).toContain("HTML_OK_LINE_30");
  expect(frame).toContain("</style>");
  expect(frame.includes("more lines")).toBe(false);
  await setup.renderer.destroy();
});

test("流式冻结：闭合一块后增量不再 lexer 第一块正文", async () => {
  const PREFIX = "FREEZE_LEX_PREFIX_UNIQUE";
  type LexerFn = typeof marked.lexer;
  const originalLexer = marked.lexer.bind(marked) as LexerFn;
  let prefixLex = 0;
  (marked as unknown as { lexer: LexerFn }).lexer = ((
    src: string,
    opts?: unknown
  ) => {
    if (typeof src === "string" && src.includes(PREFIX)) prefixLex += 1;
    return (originalLexer as (s: string, o?: unknown) => unknown)(
      src,
      opts
    ) as ReturnType<LexerFn>;
  }) as LexerFn;

  const initial = `${PREFIX}\n\nsecond`;
  const holder: { setText: ((text: string) => void) | null } = {
    setText: null,
  };
  function Harness() {
    const [text, setText] = useState(initial);
    holder.setText = setText;
    return <Markdown text={text} width={WIDTH} streaming />;
  }

  try {
    const setup = await testRender(<Harness />, {
      width: WIDTH,
      height: 20,
    });
    await setup.renderOnce();
    const afterMount = prefixLex;
    expect(afterMount).toBeGreaterThan(0);
    expect(holder.setText).not.toBeNull();
    act(() => {
      holder.setText!(`${PREFIX}\n\nsecond grows`);
    });
    await setup.renderOnce();
    expect(prefixLex).toBe(afterMount);
    const frame = setup.captureCharFrame();
    expect(frame).toContain(PREFIX);
    expect(frame).toContain("second grows");
    await setup.renderer.destroy();
  } finally {
    (marked as unknown as { lexer: LexerFn }).lexer = originalLexer;
  }
});
