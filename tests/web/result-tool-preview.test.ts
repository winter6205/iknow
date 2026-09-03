/**
 * tests/web/result-tool-preview.test.ts
 *
 * Web-side mirror of TUI's `resultToolPreview` rule（src/tui/tool-summary.ts T4 D4）。
 * D6 web 一致性：5 行尾部窗口 + 溢出 `… +N 行` + ANSI 透传 + 空 / 全空白 /
 * ANSI-only 不渲染。
 *
 * 测试形态同构 `tests/tui/tool-summary.test.ts` 「resultToolPreview」describe
 * block（输出形态同源，便于规则一致性审计）。
 */
import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
  RESULT_PREVIEW_WINDOW,
  resultPreviewOverflowLabel,
  resultToolPreview,
  stripAnsi,
} from "../../web/src/components/result-tool-preview";

describe("stripAnsi: 剥 CSI / OSC 转义序列", () => {
  it("CSI SGR 颜色序列（git/npm 输出）全部吞掉", () => {
    assert.equal(stripAnsi("\x1b[31mERROR\x1b[0m"), "ERROR");
    assert.equal(stripAnsi("\x1b[1;32mok\x1b[0m"), "ok");
    assert.equal(stripAnsi("\x1b[38;5;208mwarn\x1b[39m"), "warn");
  });

  it("OSC 序列（含 BEL 终止）一并吞掉", () => {
    assert.equal(stripAnsi("\x1b]0;title\x07body"), "body");
    assert.equal(stripAnsi("\x1b]8;;https://x\x07link\x1b]8;;\x07"), "link");
  });

  it("无 ANSI 字符串原样", () => {
    assert.equal(stripAnsi("plain text"), "plain text");
    assert.equal(stripAnsi(""), "");
    assert.equal(stripAnsi("测".repeat(5)), "测".repeat(5));
  });
});

describe("resultPreviewOverflowLabel: `… +N 行` 文案", () => {
  it("N=0 → `… +0 行`（调用方负责仅在 hidden>0 时挂上）", () => {
    assert.equal(resultPreviewOverflowLabel(0), "… +0 行");
  });
  it("N>0 → `… +N 行`", () => {
    assert.equal(resultPreviewOverflowLabel(3), "… +3 行");
    assert.equal(resultPreviewOverflowLabel(100), "… +100 行");
  });
});

describe("resultToolPreview: bash / skill / 兜底", () => {
  it("bash 单行 stdout（JSON envelope）→ 1 行 result（无 overflow）", () => {
    const p = resultToolPreview(
      "bash",
      JSON.stringify({ code: 0, stdout: "ok", stderr: "" })
    );
    assert.equal(p.kind, "result");
    if (p.kind !== "result") return;
    assert.deepEqual([...p.lines], ["ok"]);
    assert.equal(p.hiddenLineCount, 0);
  });

  it("bash 多行 stdout → 取尾部 RESULT_PREVIEW_WINDOW 行 + 溢出 +N", () => {
    const stdout = Array.from({ length: 12 }, (_, i) => `line-${i}`).join("\n");
    const p = resultToolPreview(
      "bash",
      JSON.stringify({ code: 0, stdout, stderr: "" })
    );
    assert.equal(p.kind, "result");
    if (p.kind !== "result") return;
    assert.equal(p.lines.length, RESULT_PREVIEW_WINDOW);
    // 尾部 5 行:line-7..line-11
    assert.equal(p.lines[0], "line-7");
    assert.equal(p.lines[4], "line-11");
    assert.equal(p.hiddenLineCount, 7);
  });

  it("bash 含 stderr 的 JSON envelope → 头尾拼接 + 尾部截断", () => {
    // 8 行 (5 stdout + 3 stderr) → 5 tail = stderr 3 + stdout 末 2
    const stdout = Array.from({ length: 5 }, (_, i) => `out-${i}`).join("\n");
    const stderr = "err-0\nerr-1\nerr-2";
    const p = resultToolPreview(
      "bash",
      JSON.stringify({ code: 0, stdout, stderr })
    );
    assert.equal(p.kind, "result");
    if (p.kind !== "result") return;
    assert.deepEqual(
      [...p.lines],
      ["out-3", "out-4", "err-0", "err-1", "err-2"]
    );
    assert.equal(p.hiddenLineCount, 3);
  });

  it("bash 全空白 stdout → empty（不渲染空块）", () => {
    const p = resultToolPreview(
      "bash",
      JSON.stringify({
        code: 0,
        stdout: "   \n\t\n  ",
        stderr: "",
      })
    );
    assert.equal(p.kind, "empty");
  });

  it("bash ANSI-only stdout（仅转义序列）→ empty", () => {
    const p = resultToolPreview(
      "bash",
      JSON.stringify({
        code: 0,
        stdout: "\x1b[31m\x1b[0m",
        stderr: "",
      })
    );
    assert.equal(p.kind, "empty");
  });

  it("bash 空 outputPreview / 缺字段 → empty", () => {
    assert.equal(resultToolPreview("bash", "").kind, "empty");
    assert.equal(resultToolPreview("bash", "{}").kind, "empty");
    assert.equal(
      resultToolPreview(
        "bash",
        JSON.stringify({ code: 1, stdout: "", stderr: "" })
      ).kind,
      "empty"
    );
  });

  it("bash non-JSON outputPreview（executor 退路）→ 整段作 stdout", () => {
    const rawText = "raw line-0\nraw line-1\nraw line-2";
    const p = resultToolPreview("bash", rawText);
    assert.equal(p.kind, "result");
    if (p.kind !== "result") return;
    assert.deepEqual([...p.lines], ["raw line-0", "raw line-1", "raw line-2"]);
  });

  it("bash ANSI 透传：SGR 序列保留在行内容里（仅在「可见性判定」剥离）", () => {
    const stdout = "\x1b[31mERROR\x1b[0m line\n\x1b[32mOK\x1b[0m line";
    const p = resultToolPreview(
      "bash",
      JSON.stringify({ code: 0, stdout, stderr: "" })
    );
    assert.equal(p.kind, "result");
    if (p.kind !== "result") return;
    // 颜色码不重新染色 → 原样透传,行内仍含 ESC 序列。
    assert.equal(p.lines[0], "\x1b[31mERROR\x1b[0m line");
    assert.equal(p.lines[1], "\x1b[32mOK\x1b[0m line");
  });

  it("bash 单行 ANSI-strip 保护:整段 ANSI 不计列", () => {
    // 8 行：line-0..line-7 → 取尾部 5 → line-3..line-7
    const stdout = Array.from({ length: 8 }, (_, i) =>
      i % 2 === 0 ? `\x1b[31mline-${i}\x1b[0m` : `line-${i}`
    ).join("\n");
    const p = resultToolPreview(
      "bash",
      JSON.stringify({ code: 0, stdout, stderr: "" })
    );
    assert.equal(p.kind, "result");
    if (p.kind !== "result") return;
    assert.equal(p.lines.length, 5);
    assert.ok(p.lines[0]?.includes("line-3"));
    assert.ok(p.lines[4]?.includes("line-7"));
    assert.equal(p.hiddenLineCount, 3);
  });

  it("bash ANSI 序列不被切断（行级截断不切字符,仅按行数）", () => {
    // 单行含多个 SGR:行内整体保留
    const stdout = "\x1b[31m\x1b[1m\x1b[4mUNDERLINE_RED_BOLD\x1b[0m";
    const p = resultToolPreview(
      "bash",
      JSON.stringify({ code: 0, stdout, stderr: "" })
    );
    assert.equal(p.kind, "result");
    if (p.kind !== "result") return;
    assert.equal(p.lines[0]?.startsWith("\x1b[31m"), true);
    assert.equal(p.lines[0]?.endsWith("\x1b[0m"), true);
  });

  it("skill 多行 resultText → 5 行尾部 + 溢出", () => {
    const body = Array.from({ length: 10 }, (_, i) => `body-${i}`).join("\n");
    const p = resultToolPreview("skill", body);
    assert.equal(p.kind, "result");
    if (p.kind !== "result") return;
    assert.deepEqual(
      [...p.lines],
      ["body-5", "body-6", "body-7", "body-8", "body-9"]
    );
    assert.equal(p.hiddenLineCount, 5);
  });

  it("skill 单行 resultText → 1 行", () => {
    const p = resultToolPreview("skill", "Loaded skill body");
    assert.equal(p.kind, "result");
    if (p.kind !== "result") return;
    assert.deepEqual([...p.lines], ["Loaded skill body"]);
  });

  it("skill 空 outputPreview → empty", () => {
    assert.equal(resultToolPreview("skill", "").kind, "empty");
  });

  it("read_file 不显示内容预览（spec D4 边界）", () => {
    const p = resultToolPreview("read_file", "x".repeat(200));
    assert.equal(p.kind, "empty");
  });

  it("write_file / edit_file 不显示内容预览（走自己的 6 行通道）", () => {
    assert.equal(resultToolPreview("write_file", "ok").kind, "empty");
    assert.equal(resultToolPreview("edit_file", "ok").kind, "empty");
  });

  it("未知工具 / 无 preview 声明 → empty（兜底）", () => {
    assert.equal(resultToolPreview("mystery", "hello").kind, "empty");
    assert.equal(resultToolPreview("grep", "matched").kind, "empty");
    assert.equal(resultToolPreview("glob", "a.ts").kind, "empty");
  });
});
