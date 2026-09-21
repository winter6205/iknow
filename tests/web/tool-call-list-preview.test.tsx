// @vitest-environment happy-dom
/**
 * tests/web/tool-call-list-preview.test.tsx
 *
 * ToolCallList render-layer asserts (consumes the wire `outputPreview` under the
 * same rule as the TUI):
 *  - expanded multi-line bash → 5-line tail preview + `… +N 行` ("+N lines") overflow label;
 *  - `isError=true` → output pre gets danger colors (border / text-danger), text unchanged;
 *  - read_file / empty outputPreview / ANSI-only etc. → still no OutputBlock when
 *    expanded (no second `<pre>` emitted).
 *
 * happy-dom + @testing-library/react fireEvent.click drives ToolCallList's internal
 * useState expand branch — simulating a user expanding a tool call.
 */
import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { fireEvent, render } from "@testing-library/react";
import { ToolCallList } from "../../web/src/components/ToolCallList";
import type { ToolCallView } from "../../web/src/api/types";

function tool(overrides: Partial<ToolCallView>): ToolCallView {
  return {
    id: "t1",
    name: "bash",
    inputPreview: "{}",
    outputPreview: "ok",
    isError: false,
    truncated: false,
    ...overrides,
  };
}

function setup(tools: readonly ToolCallView[]): {
  container: HTMLElement;
  expandAll: () => void;
  html: () => string;
} {
  const result = render(<ToolCallList toolCalls={tools} />);
  const expandAll = (): void => {
    // Expand items one by one: each ToolCallItem's expand button is its first <button>.
    // Here there is a single tool.
    const buttons = result.container.querySelectorAll("button");
    for (const button of buttons) fireEvent.click(button);
  };
  const html = (): string => result.container.innerHTML;
  return {
    container: result.container,
    expandAll,
    html,
  };
}

describe("ToolCallList output preview — D4 / D6 规则一致", () => {
  it("bash 多行输出（>5 行）展开后:5 行尾部 + `… +N 行` 溢出标签", () => {
    const stdout = Array.from({ length: 12 }, (_, i) => `line-${i}`).join("\n");
    const env = setup([
      tool({
        name: "bash",
        outputPreview: JSON.stringify({
          code: 0,
          stdout,
          stderr: "",
        }),
      }),
    ]);
    // collapsed state: no <pre>
    assert.equal(env.html().includes("<pre"), false);
    // expand
    env.expandAll();
    const expanded = env.html();
    // tail 5 lines: line-7..line-11 must appear in <pre> (line-6 or earlier must not)
    assert.ok(
      expanded.includes("line-7"),
      "must show line-7 (tail position 0)"
    );
    assert.ok(
      expanded.includes("line-11"),
      "must show line-11 (tail position 4)"
    );
    assert.equal(
      expanded.includes("line-6"),
      false,
      "must NOT show line-6 (above tail window)"
    );
    // overflow label
    assert.ok(/…\s*\+7\s*行/.test(expanded), "overflow label: … +7 行");
    // input + output <pre> should both be mounted
    const preCount = (expanded.match(/<pre/g) ?? []).length;
    assert.ok(preCount >= 2, "must render input + output <pre>");
  });

  it("bash 单行输出展开后:无溢出标签,1 行内容", () => {
    const env = setup([
      tool({
        name: "bash",
        outputPreview: JSON.stringify({
          code: 0,
          stdout: "single line",
          stderr: "",
        }),
      }),
    ]);
    env.expandAll();
    const html = env.html();
    assert.ok(html.includes("single line"));
    // a single line never yields `… +N 行`
    assert.equal(/…\s*\+\d+\s*行/.test(html), false);
  });

  it("bash 错误输出展开后:pre 套 danger 边框色（border-danger）", () => {
    const env = setup([
      tool({
        name: "bash",
        isError: true,
        outputPreview: JSON.stringify({
          code: 1,
          stdout: "fail output\nmore fail",
          stderr: "",
        }),
      }),
    ]);
    env.expandAll();
    const html = env.html();
    // failed output is all red: border-danger + text-danger appear together
    assert.ok(html.includes("border-danger"), "danger border class");
    assert.ok(html.includes("text-danger"), "danger text class");
    // text stays readable
    assert.ok(html.includes("fail output"));
  });

  it("read_file 展开后:<pre> 只剩 input（无 OutputBlock,OutputBlock 返回 null）", () => {
    const env = setup([
      tool({
        name: "read_file",
        outputPreview: "x".repeat(300),
      }),
    ]);
    env.expandAll();
    const html = env.html();
    assert.ok(html.includes("read_file"));
    // only the input <pre> (1), no output <pre>
    const preCount = (html.match(/<pre/g) ?? []).length;
    assert.equal(preCount, 1, "only input <pre> remains");
  });

  it("空 outputPreview 的 bash 展开后:只 input pre（OutputBlock 返回 null）", () => {
    const env = setup([
      tool({
        name: "bash",
        outputPreview: "",
      }),
    ]);
    env.expandAll();
    const html = env.html();
    assert.ok(html.includes("bash"));
    // bash but empty → OutputBlock not mounted; only the input pre remains
    const preCount = (html.match(/<pre/g) ?? []).length;
    assert.equal(preCount, 1, "only input <pre>; empty bash → no output block");
  });

  it("全空白 stdout 展开后:OutputBlock 不渲染(只剩 input pre)", () => {
    const env = setup([
      tool({
        name: "bash",
        outputPreview: JSON.stringify({
          code: 0,
          stdout: "   \n\t\n  ",
          stderr: "",
        }),
      }),
    ]);
    env.expandAll();
    const html = env.html();
    const preCount = (html.match(/<pre/g) ?? []).length;
    assert.equal(
      preCount,
      1,
      "whitespace-only stdout should not produce output <pre>"
    );
  });

  it("ANSI-only stdout 展开后:OutputBlock 不渲染", () => {
    const env = setup([
      tool({
        name: "bash",
        outputPreview: JSON.stringify({
          code: 0,
          stdout: "\x1b[31m\x1b[0m",
          stderr: "",
        }),
      }),
    ]);
    env.expandAll();
    const html = env.html();
    const preCount = (html.match(/<pre/g) ?? []).length;
    assert.equal(
      preCount,
      1,
      "ANSI-only stdout should not produce output <pre>"
    );
  });

  it("skill 多行 展开后:5 行尾部 + 溢出标签（与 bash 同窗口）", () => {
    const body = Array.from({ length: 10 }, (_, i) => `body-${i}`).join("\n");
    const env = setup([
      tool({
        name: "skill",
        outputPreview: body,
      }),
    ]);
    env.expandAll();
    const html = env.html();
    assert.ok(html.includes("body-5"), "tail position 0");
    assert.ok(html.includes("body-9"), "tail position 4");
    assert.ok(/…\s*\+5\s*行/.test(html), "overflow: … +5 行");
  });
});
