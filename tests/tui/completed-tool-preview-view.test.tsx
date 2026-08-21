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
