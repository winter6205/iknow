/**
 * tests/tui/live-tool-preview.test.tsx
 *
 * #298 T5 live-tool-preview 抽取：liveToolPreviewBox 渲染（红绿 diff + 行号 +
 * hunk 头）与行账（liveToolPreviewRows / liveToolPreviewTextLines）一致。
 */
import { describe, expect, it } from "vitest";
import { renderToString } from "ink";
import React from "react";
import {
  liveToolPreviewBox,
  liveToolPreviewRows,
  liveToolPreviewTextLines,
} from "../../src/tui/live-tool-preview.js";
import type { LiveToolRun } from "../../src/tui/live-tool-state.js";

const ANSI_RE = /\x1b\[[0-9;]*m/g;
const strip = (s: string): string => s.replace(ANSI_RE, "");

function render(box: React.ReactElement, cols: number): string {
  return strip(renderToString(box, { columns: cols }));
}

describe("liveToolPreviewBox（live 工具 tail 渲染）", () => {
  const editRun: LiveToolRun = {
    id: "tu-1",
    name: "edit_file",
    status: "ok",
    input: { path: "a.ts", old_str: "old", new_str: "new" },
    detail: "编辑 a.ts：old → new",
    oldContent: "line1\nline2\nold\nline4\nline5\n",
    newContent: "line1\nline2\nnew\nline4\nline5\n",
  };

  it("cols=80：状态行 + hunk 头 + 红绿 + 双列行号", () => {
    const out = render(
      React.createElement(() => liveToolPreviewBox(editRun, 80)),
      80
    );
    expect(out).toContain("编辑 a.ts：old → new");
    expect(out).toContain("@@ -1,5 +1,5 @@");
    expect(out).toMatch(/\n\s*3\s+│\s+-old/);
    expect(out).toMatch(/\s+3\s+│\s+\+new/);
  });

  it("cols=60：单列行号", () => {
    const out = render(
      React.createElement(() => liveToolPreviewBox(editRun, 60)),
      60
    );
    expect(out).toMatch(/\n\s*3\s+│\s+-old/);
    expect(out).toContain("@@ -1,5 +1,5 @@");
  });

  it("cols=32：折叠为仅 add，无 del / hunk 头", () => {
    const out = render(
      React.createElement(() => liveToolPreviewBox(editRun, 32)),
      32
    );
    expect(out).toContain("+new");
    expect(out).not.toContain("-old");
    expect(out).not.toContain("@@");
  });

  it("渲染行数与行账一致（parity）", () => {
    const out = render(
      React.createElement(() => liveToolPreviewBox(editRun, 80)),
      80
    );
    const n = out.replace(/\n+$/, "").split("\n").length;
    expect(n).toBe(liveToolPreviewRows(editRun, 80));
  });

  it("running 状态：仅状态行，无预览", () => {
    const running: LiveToolRun = {
      id: "tu-2",
      name: "bash",
      status: "running",
      input: {},
    };
    const out = render(
      React.createElement(() => liveToolPreviewBox(running, 80)),
      80
    );
    expect(out).toContain("[运行中] bash");
    expect(liveToolPreviewRows(running, 80)).toBe(1);
  });
});

describe("liveToolPreviewTextLines（flat 行，给 flatContentLines 用）", () => {
  it("已完成：状态行 + 可见 diff 行", () => {
    const run: LiveToolRun = {
      id: "r",
      name: "write_file",
      status: "ok",
      input: { path: "a.ts", content: "x" },
      detail: "写入 a.ts（1 行）",
      oldContent: "",
      newContent: "hello\n",
    };
    const rows = liveToolPreviewTextLines(run, 80);
    expect(rows[0]).toBe("write_file · 写入 a.ts（1 行） · ok");
    expect(rows.some((r) => r.includes("+hello"))).toBe(true);
    expect(rows.length).toBe(liveToolPreviewRows(run, 80));
  });
});
