/** @jsxImportSource @opentui/react */
/**
 * tests/tui/markdown.test.tsx — #343 T2 Markdown 渲染验收（bun:test）。
 *
 * 覆盖 specs/321 SC4（captureSpans 着色断言：bold / em / code /
 * strikethrough）+ Testing Strategy 五类边界中的 empty（空 / 纯空白输入）、
 * negative（未闭合 fence / 超长无换行单行 / 非法 table）、overflow（表格
 * 超宽压缩 + clipOneLine 语义截断）；围栏代码块 c4（深灰底 + 语法高亮）
 * 着色契约：背景色、关键字/字符串/注释分色、无边框字符 ┌┐└┘、无 title、
 * diff 行 +/- 复用 palette.add/del。
 */
import { expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { RGBA, TextAttributes } from "@opentui/core";
import { Markdown, tokenizeCodeLine } from "../../src/tui/markdown.js";
import { tuiPalette } from "../../src/tui/theme.js";

type Setup = Awaited<ReturnType<typeof testRender>>;

const WIDTH = 40;

/** 渲染 markdown 并等一帧；调用方负责 destroy。 */
async function renderMd(mdText: string, width = WIDTH): Promise<Setup> {
  const setup = await testRender(<Markdown text={mdText} width={width} />, {
    width,
    height: 30,
  });
  await setup.renderOnce();
  return setup;
}

/** captureSpans 全帧 span 扫描：找第一个满足谓词的 span。 */
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

/** captureCharFrame 逐行拆分。 */
function frameLines(setup: Setup): string[] {
  return setup.captureCharFrame().split("\n");
}

/**
 * 两块内容行「之间」的空白行数。锚点用内容子串定位，只数两锚点之间的
 * 区间——testRender 固定高度的帧尾填充行不参与计数。
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

/** 首个内容行之前的空白行数（前导空白）。 */
function leadingBlankLines(setup: Setup): number {
  const lines = frameLines(setup);
  const first = lines.findIndex((l) => l.trim() !== "");
  return first < 0 ? 0 : first;
}

/** RGBA 颜色相等（r/g/b 三通道，alpha 略）。 */
function rgbaEq(a: RGBA, b: RGBA): boolean {
  return a.r === b.r && a.g === b.g && a.b === b.b;
}

// ── SC4：captureSpans 着色断言（bold / em / code / strikethrough）──

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

// ── overflow：表格超宽压缩 + clipOneLine 语义 ──────────────────────

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
  // 压缩后仍是表格结构（列分隔线在）。
  expect(frame).toContain("│");
  // clipOneLine 语义：超长单元格被截断并以 … 收尾。
  expect(frame).toContain("…");
  // 原始超长内容不整串出现（已被压缩裁切）。
  expect(frame.includes(longA)).toBe(false);
  expect(frame.includes(longB)).toBe(false);
  // 帧内每一行的可视宽度不超过容器宽度（不溢出）。
  for (const line of frameLines(setup)) {
    expect(line.length).toBeLessThanOrEqual(WIDTH);
  }
  await setup.renderer.destroy();
});

// ── negative：畸形 markdown 不崩不溢出 ─────────────────────────────

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

// ── 围栏代码块 c4（深灰底 + 语法高亮）着色契约 ─────────────────────

/** c4 代码块背景色断言：所有 span 都携带 codeBlockBg 背景。 */
test("代码块 c4：所有 span 携带 codeBlockBg 背景色", async () => {
  const setup = await renderMd("```ts\nconst x = 1;\n```");
  const expectedBg = RGBA.fromHex(tuiPalette.codeBlockBg);
  const { lines } = setup.captureSpans();
  // 至少有 span（不是空块）。
  expect(lines.some((l) => l.spans.length > 0)).toBe(true);
  for (const line of lines) {
    for (const s of line.spans) {
      if (s.text.trim() !== "" || s.text === "") {
        // code 行内所有 span 背景 = codeBlockBg（含 padding 空格与 trailing 填充）。
        expect(rgbaEq(s.bg, expectedBg)).toBe(true);
      }
    }
  }
  await setup.renderer.destroy();
});

/** c4 关键字着色：export 走 syntaxKeyword。 */
test("代码块 c4：关键字走 syntaxKeyword 紫色", async () => {
  const setup = await renderMd("```ts\nexport const x = 1;\n```");
  const expected = RGBA.fromHex(tuiPalette.syntaxKeyword);
  const span = findSpan(setup, (s) => rgbaEq(s.fg, expected));
  expect(span).toBeDefined();
  await setup.renderer.destroy();
});

/** c4 字符串着色：双引号字符串走 syntaxString。 */
test("代码块 c4：字符串走 syntaxString 橙色", async () => {
  const setup = await renderMd('```ts\nconst s = "hello";\n```');
  const expected = RGBA.fromHex(tuiPalette.syntaxString);
  const span = findSpan(setup, (s) => rgbaEq(s.fg, expected));
  expect(span).toBeDefined();
  await setup.renderer.destroy();
});

/** c4 注释着色：`// ...` 走 syntaxComment + DIM + ITALIC。 */
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

/** c4 数字着色：字面数字走 syntaxNumber。 */
test("代码块 c4：数字走 syntaxNumber 浅青", async () => {
  const setup = await renderMd("```ts\nconst n = 42;\n```");
  const expected = RGBA.fromHex(tuiPalette.syntaxNumber);
  const span = findSpan(setup, (s) => rgbaEq(s.fg, expected));
  expect(span).toBeDefined();
  await setup.renderer.destroy();
});

/** c4 默认字色：非 token 的 plain 文本走 codeDefault #d4d4d4（不是 #66b8ae）。 */
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

/** c4 无边框字符（borderStyle 不再是 single → 无 ┌┐└┘）。 */
test("代码块 c4：无边框字符 ┌┐└┘", async () => {
  const setup = await renderMd("```ts\nconst x = 1;\n```");
  const frame = setup.captureCharFrame();
  expect(frame.includes("┌")).toBe(false);
  expect(frame.includes("┐")).toBe(false);
  expect(frame.includes("└")).toBe(false);
  expect(frame.includes("┘")).toBe(false);
  // 同时无 single 横线（避免误把 ─ 来自其它字符算进边框——c4 完全无边框）。
  expect(frame.includes("─")).toBe(false);
  await setup.renderer.destroy();
});

/** c4 无 title：语言标签不在边框行（c4 不画 lang，c5 才前置）。 */
test("代码块 c4：无语言标签出现在边框行", async () => {
  const setup = await renderMd("```ts\nconst x = 1;\n```");
  const frame = setup.captureCharFrame();
  // 边框行 = 单线框 `─` + title 模式（c4 无边框 → 必然无 `─ ts` 这种行）。
  const titleLine = frameLines(setup).find(
    (l) => l.includes("─") && l.includes("ts")
  );
  expect(titleLine).toBeUndefined();
  // `ts` 仍可作为代码内容出现一次（语言标识符），但不能挂边框字符。
  await setup.renderer.destroy();
});

/** c4 diff：行首 +/- 复用 palette.add/del。 */
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

test("围栏显示窗：33 行只挂前 32 行并提示还有 1 行", async () => {
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
  expect(frame).toContain("还有 1 行");
  expect(frame.includes("FENCE_LINE_33")).toBe(false);
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
  expect(frame.includes("还有")).toBe(false);
  await setup.renderer.destroy();
});

/** c4 空行不塌缩：含空行的代码块行数 ≥ 内容行 + padding + margin。 */
test("代码块 c4：含空行的代码块不塌缩行高", async () => {
  const setup = await renderMd("```ts\nconst a = 1;\n\nconst b = 2;\n```");
  const frame = setup.captureCharFrame();
  // "const a" 与 "const b" 两行内容都在。
  expect(frame).toContain("const a = 1;");
  expect(frame).toContain("const b = 2;");
  await setup.renderer.destroy();
});

/** tokenizeCodeLine 单测：直接验证正则 + 捕获组语义，不经 JSX 渲染。 */
test("tokenizeCodeLine：comment / string / number / keyword 分色", () => {
  const tokens = tokenizeCodeLine('// greet\nexport const s = "hi"; // tail');
  // 期望切出：comment `// greet\n`, keyword `export`, keyword `const`,
  // plain ` s = `, string `"hi"`, plain `; // tail`。
  const kinds = tokens.map((t) => t.kind);
  expect(kinds).toContain("comment");
  expect(kinds).toContain("keyword");
  expect(kinds).toContain("string");
  expect(kinds).toContain("plain");
  // 关键字出现至少两次（export + const）。
  const kwCount = tokens.filter((t) => t.kind === "keyword").length;
  expect(kwCount).toBeGreaterThanOrEqual(2);
  // string 捕获组包含引号。
  const strTok = tokens.find((t) => t.kind === "string");
  expect(strTok?.text).toBe('"hi"');
  // comment 捕获组以 `//` 开头。
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

// ── empty 边界：空字符串 / 纯空白输入渲染不崩 ──────────────────────

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

// ── 盘古之白（pangu spacing）：CJK ↔ ASCII 字母数字边界插半角空格 ───

test("盘古之白：段落文本中英数字边界插空格", async () => {
  const setup = await renderMd("美股4月，CNBC的页面价格是100元");
  const frame = setup.captureCharFrame();
  expect(frame).toContain("美股 4 月");
  expect(frame).toContain("CNBC 的页面");
  expect(frame).toContain("价格是 100 元");
  // 幂等输入不变：原文无空格形态不整串出现。
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
  // 代码块内 CJK ↔ 数字边界保持原样，不插空格。
  expect(frame).toContain("const 数=1;");
  expect(frame.includes("数 =1")).toBe(false);
  expect(frame.includes("数= 1")).toBe(false);
  await setup.renderer.destroy();
});

test("盘古之白：blockquote 内 codespan 不插空格，外围照常插", async () => {
  const setup = await renderMd("> 涨幅10元 `中a文123` 尾注2行");
  const frame = setup.captureCharFrame();
  // codespan 内容保持原样（「代码内容不碰」契约）。
  expect(frame).toContain("中a文123");
  expect(frame.includes("中 a 文")).toBe(false);
  // blockquote 外围中文照常插空格。
  expect(frame).toContain("涨幅 10 元");
  expect(frame).toContain("尾注 2 行");
  await setup.renderer.destroy();
});

// ── 盘古之白负向锚点：排除项刻意不插空格 ────────────────────────────

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

// ── 块间距：容器 gap 唯一 SSOT，相邻块恰空一行 ──────────────────────

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
