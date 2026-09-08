/** @jsxImportSource @opentui/react */
/**
 * tests/tui/completed-tool-preview-view.test.tsx
 *
 * 完成态 write_file 代码预览须复用 markdown c4 CodeBlock（深灰底 + 语法高亮），
 * 不得裸 <text> 无底色行。
 */
import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { RGBA } from "@opentui/core";
import { CompletedToolPreviewView } from "../../src/tui/completed-tool-preview-view.js";
import { completedToolPreview } from "../../src/tui/tool-summary.js";
import { tuiPalette } from "../../src/tui/theme.js";

type Setup = Awaited<ReturnType<typeof testRender>>;

function rgbaEq(a: RGBA, b: RGBA): boolean {
  return a.r === b.r && a.g === b.g && a.b === b.b;
}

function findSpan(
  setup: Setup,
  pred: (span: { text: string; fg: RGBA; bg: RGBA }) => boolean
) {
  const { lines } = setup.captureSpans();
  for (const line of lines) {
    for (const span of line.spans) {
      if (pred(span)) return span;
    }
  }
  return undefined;
}

function writeFileCodePreview() {
  return completedToolPreview(
    "write_file",
    { path: "a.ts", content: "export const x = 1;\n" },
    { oldContent: "", newContent: "export const x = 1;\n" }
  );
}

describe("CompletedToolPreviewView write_file code c4", () => {
  test("kind=code 渲染携带 codeBlockBg 背景", async () => {
    const preview = writeFileCodePreview();
    expect(preview.kind).toBe("code");

    const setup = await testRender(
      <CompletedToolPreviewView preview={preview} cols={80} />,
      { width: 80, height: 10 }
    );
    await setup.renderOnce();

    const expectedBg = RGBA.fromHex(tuiPalette.codeBlockBg);
    const { lines } = setup.captureSpans();
    expect(lines.some((l) => l.spans.length > 0)).toBe(true);
    for (const line of lines) {
      for (const span of line.spans) {
        if (span.text.includes("export") || span.text.includes("const")) {
          expect(rgbaEq(span.bg, expectedBg)).toBe(true);
        }
      }
    }
    await setup.renderer.destroy();
  });

  test("kind=code 关键字 export 走 syntaxKeyword", async () => {
    const preview = writeFileCodePreview();
    const setup = await testRender(
      <CompletedToolPreviewView preview={preview} cols={80} />,
      { width: 80, height: 10 }
    );
    await setup.renderOnce();

    const expectedKw = RGBA.fromHex(tuiPalette.syntaxKeyword);
    const span = findSpan(
      setup,
      (s) => s.text === "export" && rgbaEq(s.fg, expectedKw)
    );
    expect(span).toBeDefined();
    await setup.renderer.destroy();
  });

  test("kind=diff 仍走 DiffView，不套 CodeBlock", async () => {
    const preview = completedToolPreview(
      "edit_file",
      { path: "a.ts", old_str: "old", new_str: "new" },
      {
        oldContent: "line1\nline2\nold\n",
        newContent: "line1\nline2\nnew\n",
      }
    );
    expect(preview.kind).toBe("diff");

    const setup = await testRender(
      <CompletedToolPreviewView preview={preview} cols={80} />,
      { width: 80, height: 20 }
    );
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    expect(frame).toMatch(/-old/);
    expect(frame).toMatch(/\+new/);
    await setup.renderer.destroy();
  });
});

// -- #693 T4 D4:CompletedToolPreviewView resultPreview 通道 ----------------

import { type ResultPreview } from "../../src/tui/tool-summary.js";

describe("CompletedToolPreviewView resultPreview: > dim 5 行尾部 + 溢出", () => {
  test("kind=empty 时不挂载（不渲染空块）", async () => {
    const setup = await testRender(
      <CompletedToolPreviewView
        preview={{ kind: "empty" }}
        cols={80}
        resultPreview={{ kind: "empty" }}
      />,
      { width: 80, height: 10 }
    );
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    expect(frame).not.toContain("> ");
    await setup.renderer.destroy();
  });

  test("仅 resultPreview 有内容时：⏵ 风格 dim 行渲染", async () => {
    const preview: ResultPreview = {
      kind: "result",
      lines: ["out-1", "out-2"],
      hiddenLineCount: 0,
    };
    const setup = await testRender(
      <CompletedToolPreviewView
        preview={{ kind: "empty" }}
        cols={80}
        resultPreview={preview}
      />,
      { width: 80, height: 10 }
    );
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    expect(frame).toContain("> out-1");
    expect(frame).toContain("> out-2");
    await setup.renderer.destroy();
  });

  test("hiddenLineCount>0 时：`… +N 行` 首行 + N 行尾部", async () => {
    const preview: ResultPreview = {
      kind: "result",
      lines: ["l7", "l8", "l9", "l10", "l11"],
      hiddenLineCount: 7,
    };
    const setup = await testRender(
      <CompletedToolPreviewView
        preview={{ kind: "empty" }}
        cols={80}
        resultPreview={preview}
      />,
      { width: 80, height: 12 }
    );
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    expect(frame).toContain("… +7 行");
    expect(frame).toContain("> l7");
    expect(frame).toContain("> l11");
    await setup.renderer.destroy();
  });

  test("preview + resultPreview 同时存在：write/edit 预览与结果预览共存", async () => {
    const writePreview = completedToolPreview(
      "write_file",
      { path: "a.ts", content: "export const x = 1;\n" },
      { oldContent: "", newContent: "export const x = 1;\n" }
    );
    // 模拟一个奇怪的工具既写文件又产出 stdout（实际不发生，验渲染）。
    const resultPreview: ResultPreview = {
      kind: "result",
      lines: ["side-effect-output"],
      hiddenLineCount: 0,
    };
    const setup = await testRender(
      <CompletedToolPreviewView
        preview={writePreview}
        cols={80}
        resultPreview={resultPreview}
      />,
      { width: 80, height: 12 }
    );
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    expect(frame).toContain("export");
    expect(frame).toContain("> side-effect-output");
    await setup.renderer.destroy();
  });
});

// -- #tui-render-overhaul T1:resultPreview 内容行不再 dim ----------------------
//
// 不变式：装饰元素（`>` 前缀、`… +N 行` 溢出）保留 dim，让读者一眼识别
// 为辅助形态；正文内容（bash stdout/stderr 实际产出）走正文色，与终端其
// 余渲染一致——避免「结果预览一坨灰、读者看不到内容」。spec D4 词条由
// 「dim 只属成功 bash 尾巴」改为「dim 只属装饰（前缀/溢出）」。

describe("CompletedToolPreviewView resultPreview: 内容行不再 dim（仅装饰 dim）", () => {
  test("内容行 fg = palette.text（不再是 dim）；> 前缀保持 dim", async () => {
    const preview: ResultPreview = {
      kind: "result",
      lines: ["RESULT_CONTENT_LINE"],
      hiddenLineCount: 0,
    };
    const setup = await testRender(
      <CompletedToolPreviewView
        preview={{ kind: "empty" }}
        cols={80}
        resultPreview={preview}
      />,
      { width: 80, height: 10 }
    );
    await setup.renderOnce();
    const expectedText = RGBA.fromHex(tuiPalette.text);
    const expectedDim = RGBA.fromHex(tuiPalette.dim);
    const { lines } = setup.captureSpans();
    // 正文 span: 含 "RESULT_CONTENT_LINE" 字符的 span 必须走 text 色。
    const contentSpan = lines
      .flatMap((l) => l.spans)
      .find((s) => s.text.includes("RESULT_CONTENT_LINE"));
    expect(contentSpan).toBeDefined();
    expect(rgbaEq(contentSpan!.fg, expectedText)).toBe(true);
    expect(rgbaEq(contentSpan!.fg, expectedDim)).toBe(false);
    // 前缀 span: 含 ">" 字符的 span 必须保留 dim 色。
    const prefixSpan = lines
      .flatMap((l) => l.spans)
      .find((s) => s.text.includes(">"));
    expect(prefixSpan).toBeDefined();
    expect(rgbaEq(prefixSpan!.fg, expectedDim)).toBe(true);
    await setup.renderer.destroy();
  });

  test("溢出行 `… +N 行` 仍 dim（装饰，前缀同一族）", async () => {
    const preview: ResultPreview = {
      kind: "result",
      lines: ["l7"],
      hiddenLineCount: 3,
    };
    const setup = await testRender(
      <CompletedToolPreviewView
        preview={{ kind: "empty" }}
        cols={80}
        resultPreview={preview}
      />,
      { width: 80, height: 10 }
    );
    await setup.renderOnce();
    const expectedDim = RGBA.fromHex(tuiPalette.dim);
    const { lines } = setup.captureSpans();
    const overflowSpan = lines
      .flatMap((l) => l.spans)
      .find((s) => s.text.includes("… +3 行"));
    expect(overflowSpan).toBeDefined();
    expect(rgbaEq(overflowSpan!.fg, expectedDim)).toBe(true);
    await setup.renderer.destroy();
  });
});
