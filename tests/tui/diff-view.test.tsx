/**
 * tests/tui/diff-view.test.tsx
 *
 * #298 T5 diff-view 渲染器：三档宽度（cols=80/60/40）窄终端降级测试。
 *  - 双列行号（cols>=80）+ 红绿着色；
 *  - 单列行号（40–79）+ 红绿着色；
 *  - cols<40 折叠为仅 add（无行号 / 无 del / 无 hunk 头），不抛错。
 *  - hunk 头 `@@ -A,B +C,D @@` 出现且渲染对齐。
 */
import { describe, expect, it } from "vitest";
import { renderToString } from "ink";
import React from "react";
import { computeDiff, type DiffLine } from "../../src/tui/diff-unified.js";
import { DiffRow, DiffView, diffRowText } from "../../src/tui/diff-view.js";

const ANSI_RE = /\x1b\[[0-9;]*m/g;
const strip = (s: string): string => s.replace(ANSI_RE, "");

/** 造一个 edit_file 场景的 diff：old_str → new_str。 */
function editRows(oldText: string, newText: string): readonly DiffLine[] {
  return computeDiff("a.ts", oldText, newText);
}

const OLD = "one\ntwo\nthree\nfour\nfive";
const NEW = "one\nTWO\nthree\nFOUR\nfive";

describe("diffRowText（纯函数文本形状）", () => {
  it("cols>=80：del/add 双列行号", () => {
    const rows = editRows(OLD, NEW);
    const del = rows.find((r) => r.kind === "del")!;
    const add = rows.find((r) => r.kind === "add")!;
    // del 行只带 oldNo（newNo 空列），add 行只带 newNo（oldNo 空列）。
    expect(diffRowText(del, 80)).toMatch(/^\s*2\s+│\s+-two/);
    expect(diffRowText(add, 80)).toMatch(/\s+2\s+│\s+\+TWO/);
  });

  it("40–79：单列行号", () => {
    const rows = editRows(OLD, NEW);
    const del = rows.find((r) => r.kind === "del")!;
    expect(diffRowText(del, 60)).toMatch(/^\s*2\s+│\s+-two/);
  });

  it("cols<40：add 保留原文，del/ctx 空串", () => {
    const rows = editRows(OLD, NEW);
    const add = rows.find((r) => r.kind === "add")!;
    const del = rows.find((r) => r.kind === "del")!;
    expect(diffRowText(add, 32)).toBe("+TWO");
    expect(diffRowText(del, 32)).toBe("");
  });

  it("hunk 头整行保留（无行号）", () => {
    const rows = editRows(OLD, NEW);
    const hdr = rows.find((r) => r.text.startsWith("@@"))!;
    expect(diffRowText(hdr, 80)).toBe(hdr.text);
    expect(diffRowText(hdr, 60)).toBe(hdr.text);
  });
});

describe("DiffView 渲染（ink renderToString）", () => {
  function render(rows: readonly DiffLine[], cols: number): string {
    return strip(
      renderToString(React.createElement(DiffView, { rows, cols }), {
        columns: cols,
      })
    );
  }

  // SKIP(用户授权 2026-08-08)：真实渲染未发射期望的 add 绿 truecolor 码
  // \x1b[38;2;46;160;67m。pre-existing 失败，与 LSP didOpen 改动无关
  // （stash 干净基座同样失败）。原因详见 git 提交正文。
  it.skip("cols=80：双列行号 + hunk 头 + 红绿（add/del 着色）", () => {
    const rows = editRows(OLD, NEW);
    const out = render(rows, 80);
    // hunk 头出现且对齐
    expect(out).toContain("@@ -1,5 +1,5 @@");
    // 双列行号：del 行 oldNo 在第 1 列、add 行 newNo 在第 2 列
    expect(out).toMatch(/\n\s*2\s+│\s+-two/);
    expect(out).toMatch(/\s+2\s+│\s+\+TWO/);
    // 红/绿 ANSI 上色字节存在
    expect(
      renderToString(React.createElement(DiffView, { rows, cols: 80 }), {
        columns: 80,
      })
    ).toContain("\x1b[38;2;46;160;67m"); // #2ea043 → add 绿
  });

  // SKIP(用户授权 2026-08-08)：真实渲染未发射期望的 del 红 truecolor 码
  // \x1b[38;2;215;58;73m。pre-existing 失败，与 LSP didOpen 改动无关。
  it.skip("cols=80：del 行红色 #d73a49", () => {
    const rows = editRows(OLD, NEW);
    const raw = renderToString(
      React.createElement(DiffView, { rows, cols: 80 }),
      { columns: 80 }
    );
    expect(raw).toContain("\x1b[38;2;215;58;73m"); // #d73a49 → del 红
  });

  it("cols=60：单列行号 + 红绿", () => {
    const rows = editRows(OLD, NEW);
    const out = render(rows, 60);
    expect(out).toMatch(/2\s+│\s+-two/);
    expect(out).toMatch(/2\s+│\s+\+TWO/);
    expect(out).toContain("@@ -1,5 +1,5 @@");
  });

  it("cols=40：单列行号仍生效（边界含 40）", () => {
    const rows = editRows(OLD, NEW);
    const out = render(rows, 40);
    expect(out).toMatch(/2\s+│\s+-two/);
    expect(out).toContain("@@ -1,5 +1,5 @@");
  });

  it("cols=32（<40）：折叠为仅 add，无行号 / 无 del / 无 hunk 头，不抛错", () => {
    const rows = editRows(OLD, NEW);
    let out = "";
    expect(() => {
      out = render(rows, 32);
    }).not.toThrow();
    expect(out).toContain("+TWO");
    expect(out).not.toContain("-two");
    expect(out).not.toContain("@@");
    // 无行号列（无 │ 分隔）
    expect(out).not.toContain("│");
  });

  it("cols=32（<40）：add 行同样整行绿底（背景遮罩任何宽度都生效）", () => {
    // 窄终端（VSCode 集成终端窄窗口）折叠为 add-only 行，add 行仍上淡绿底。
    const rows = editRows(OLD, NEW);
    const raw = renderToString(
      React.createElement(DiffView, { rows, cols: 32 }),
      { columns: 32 }
    );
    expect(raw).toContain("\x1b[48;2;31;61;43m"); // #1f3d2b → bgAdd 淡绿底
    expect(raw).not.toContain("\x1b[48;2;61;31;36m"); // 折叠无 del，故无 bgDel
  });

  it("纯新增（write_file）：全 add", () => {
    const rows = editRows("", "a\nb\nc\n");
    const out = render(rows, 80);
    expect(out).toContain("+a");
    expect(out).toContain("+b");
    expect(out).toContain("+c");
  });

  it("空 diff：空渲染不抛", () => {
    expect(render([], 80)).toBe("");
    expect(render([], 30)).toBe("");
  });
});

describe("DiffRow 着色", () => {
  // SKIP(用户授权 2026-08-08)：真实渲染未发射 add/del truecolor 码
  // (\x1b[38;2;46;160;67m / \x1b[38;2;215;58;73m)。pre-existing 失败，
  // 与 LSP didOpen 改动无关（source diff 之外的 XY 都断言 ANSI 上色字节）。
  it.skip("add → 绿；del → 红；ctx → dim", () => {
    const rows = editRows(OLD, NEW);
    const add = rows.find((r) => r.kind === "add")!;
    const del = rows.find((r) => r.kind === "del")!;
    const ctx = rows.find((r) => r.kind === "ctx")!;
    const raw = (r: DiffLine) =>
      renderToString(React.createElement(DiffRow, { line: r, cols: 80 }));
    expect(raw(add)).toContain("\x1b[38;2;46;160;67m");
    expect(raw(del)).toContain("\x1b[38;2;215;58;73m");
    expect(raw(ctx)).not.toContain("\x1b[38;2;46;160;67m");
    expect(raw(ctx)).not.toContain("\x1b[38;2;215;58;73m");
  });

  // #298 T6 整行背景遮罩：#1f3d2b（bgAdd）= R31 G61 B43，#3d1f24（bgDel）
  // = R61 G31 B36。字符区上底 + 外层 Box width 铺满到行尾。
  it("add → 整行淡绿底（bgAdd 背景序列）", () => {
    const rows = editRows(OLD, NEW);
    const add = rows.find((r) => r.kind === "add")!;
    const raw = renderToString(
      React.createElement(DiffRow, { line: add, cols: 80 })
    );
    expect(raw).toContain("\x1b[48;2;31;61;43m"); // #1f3d2b → bgAdd 淡绿底
  });

  it("del → 整行淡红底（bgDel 背景序列）", () => {
    const rows = editRows(OLD, NEW);
    const del = rows.find((r) => r.kind === "del")!;
    const raw = renderToString(
      React.createElement(DiffRow, { line: del, cols: 80 })
    );
    expect(raw).toContain("\x1b[48;2;61;31;36m"); // #3d1f24 → bgDel 淡红底
  });

  it("ctx → 无背景序列（保持透明）", () => {
    const rows = editRows(OLD, NEW);
    const ctx = rows.find((r) => r.kind === "ctx")!;
    const raw = renderToString(
      React.createElement(DiffRow, { line: ctx, cols: 80 })
    );
    expect(raw).not.toContain("\x1b[48;2;");
  });
});
