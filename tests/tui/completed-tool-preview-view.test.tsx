/** @jsxImportSource @opentui/react */
/**
 * tests/tui/completed-tool-preview-view.test.tsx
 *
 * The completed write_file code preview must reuse the markdown c4
 * CodeBlock (dark-gray background + syntax highlighting), never bare <text>
 * rows without a background.
 */
import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { RGBA } from "@opentui/core";
import {
  CompletedToolPreviewView,
  completedToolPreviewTextLines,
} from "../../src/tui/completed-tool-preview-view.js";
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

// -- CompletedToolPreviewView resultPreview channel --------------------------

import { type ResultPreview } from "../../src/tui/tool-summary.js";

describe("CompletedToolPreviewView resultPreview: │ gutter 5 行尾部 + 溢出", () => {
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
    expect(frame).not.toContain("│ ");
    await setup.renderer.destroy();
  });

  test("仅 resultPreview 有内容时：│ gutter 行渲染", async () => {
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
    expect(frame).toContain("│ out-1");
    expect(frame).toContain("│ out-2");
    expect(frame).not.toContain("> out-1");
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
    expect(frame).not.toContain("> … +7 行");
    expect(frame).not.toContain("> …");
    expect(frame).toContain("│ l7");
    expect(frame).toContain("│ l11");
    await setup.renderer.destroy();
  });

  test("preview + resultPreview 同时存在：write/edit 预览与结果预览共存", async () => {
    const writePreview = completedToolPreview(
      "write_file",
      { path: "a.ts", content: "export const x = 1;\n" },
      { oldContent: "", newContent: "export const x = 1;\n" }
    );
    // Simulate an odd tool that both writes a file and emits stdout (never
    // happens in practice; exercises rendering).
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
    expect(frame).toContain("│ side-effect-output");
    expect(frame).not.toContain("> side-effect-output");
    await setup.renderer.destroy();
  });
});

// -- resultPreview content lines are no longer dim ----------------------------
//
// Invariant: decorative elements (the `│` gutter, the `… +N 行` overflow)
// stay dim so readers recognize them as auxiliary at a glance; body content
// (actual bash stdout/stderr) uses the normal text color, consistent with
// the rest of the terminal — avoiding "a gray blob of result preview nobody
// can read". The rule is: dim belongs only to decoration (gutter /
// overflow), not to the successful-bash tail.

describe("CompletedToolPreviewView squeeze（spec D5）", () => {
  test("squeezed 投影 = 只留标题行 `Wrote N lines to <path>`，正文预览整段让位", async () => {
    const preview = completedToolPreview(
      "write_file",
      { path: "a.ts", content: "l1\nl2\nl3" },
      { oldContent: "", newContent: "l1\nl2\nl3", squeezed: true }
    );
    expect(preview.kind).toBe("squeeze");
    if (preview.kind !== "squeeze") return;
    // The title line is the only human-readable surface
    // (`Wrote N lines to path`).
    expect(preview.line).toBe("Wrote 3 lines to a.ts");
    // The body fully yields (not truncated to 10 lines): preview row count
    // = 0, the title is assembled by the caller.
    expect(completedToolPreviewTextLines(preview, 80)).toEqual([]);
    const setup = await testRender(
      <CompletedToolPreviewView preview={preview} cols={80} />,
      { width: 80, height: 10 }
    );
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    expect(frame).not.toContain("l1");
    await setup.renderer.destroy();
  });
});

describe("CompletedToolPreviewView resultPreview: 内容行不再 dim（仅装饰 dim）", () => {
  test("内容行 fg = palette.text（不再是 dim）；│ gutter 保持 dim", async () => {
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
    // Body span: any span containing "RESULT_CONTENT_LINE" must use the text
    // color.
    const contentSpan = lines
      .flatMap((l) => l.spans)
      .find((s) => s.text.includes("RESULT_CONTENT_LINE"));
    expect(contentSpan).toBeDefined();
    expect(rgbaEq(contentSpan!.fg, expectedText)).toBe(true);
    expect(rgbaEq(contentSpan!.fg, expectedDim)).toBe(false);
    // Gutter span: any span containing "│" must keep the dim color, and `>`
    // no longer appears.
    const prefixSpan = lines
      .flatMap((l) => l.spans)
      .find((s) => s.text.includes("│"));
    expect(prefixSpan).toBeDefined();
    expect(rgbaEq(prefixSpan!.fg, expectedDim)).toBe(true);
    expect(
      lines.flatMap((l) => l.spans).some((s) => s.text.includes(">"))
    ).toBe(false);
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
    expect(overflowSpan!.text.includes(">")).toBe(false);
    expect(overflowSpan!.text.startsWith("> ")).toBe(false);
    await setup.renderer.destroy();
  });
});
