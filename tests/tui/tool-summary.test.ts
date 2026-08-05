/**
 * tests/tui/tool-summary.test.ts
 *
 * #146 Q5b=B 工具摘要行：参数摘要 + tool_use_id 精确配对状态回填。
 */
import { describe, expect, it } from "vitest";
import {
  formatLiveToolEvent,
  projectToolLines,
  summarizeToolCall,
} from "../../src/tui/tool-summary.js";
import type { AnthropicNativeMessage } from "../../src/harness/model-adapter/types.js";

describe("summarizeToolCall: 参数摘要（生成/编辑类增强）", () => {
  it("write_file → 路径 + 行数（生成了什么）", () => {
    const { detail } = summarizeToolCall("write_file", {
      path: "docs/a.md",
      content: "l1\nl2\nl3",
    });
    expect(detail).toBe("写入 docs/a.md（3 行）");
  });

  it("edit_file → 路径 + old→new（变更对比摘要）", () => {
    const { detail } = summarizeToolCall("edit_file", {
      path: "src/x.ts",
      old_str: "foo",
      new_str: "bar",
    });
    expect(detail).toContain("编辑 src/x.ts");
    expect(detail).toContain("foo");
    expect(detail).toContain("bar");
  });

  it("bash → 命令摘要；read_file/grep/glob → 各自动词", () => {
    expect(summarizeToolCall("bash", { command: "npm test" }).detail).toBe(
      "npm test"
    );
    expect(summarizeToolCall("read_file", { path: "a.ts" }).detail).toBe(
      "读取 a.ts"
    );
    expect(summarizeToolCall("grep", { pattern: "foo" }).detail).toBe(
      "搜索 foo"
    );
    expect(summarizeToolCall("glob", { pattern: "*.ts" }).detail).toBe(
      "匹配 *.ts"
    );
  });

  it("未知工具 → JSON 参数摘要；超长裁剪到 80 字符内", () => {
    const { detail } = summarizeToolCall("mystery", { a: "x".repeat(200) });
    expect(detail.length).toBeLessThanOrEqual(80);
    expect(detail.endsWith("…")).toBe(true);
  });
});

describe("projectToolLines: tool_use_id 配对状态", () => {
  const toolUseMsg: AnthropicNativeMessage = {
    role: "assistant",
    content: [
      { type: "text", text: "我来写个文件" },
      {
        type: "tool_use",
        id: "tu-1",
        name: "write_file",
        input: { path: "a.txt", content: "x" },
      },
      {
        type: "tool_use",
        id: "tu-2",
        name: "bash",
        input: { command: "false" },
      },
    ],
  };

  it("tool_result 到达 → ok/failed 精确配对（is_error）", () => {
    const toolResultMsg: AnthropicNativeMessage = {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "tu-1", content: "wrote 1 bytes" },
        {
          type: "tool_result",
          tool_use_id: "tu-2",
          content: "err",
          is_error: true,
        },
      ],
    };
    const lines = projectToolLines([toolUseMsg, toolResultMsg]);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ toolName: "write_file", status: "ok" });
    expect(lines[1]).toMatchObject({ toolName: "bash", status: "failed" });
  });

  it("tool_result 未到达（cancelled 中断）→ unknown", () => {
    const lines = projectToolLines([toolUseMsg]);
    expect(lines.every((l) => l.status === "unknown")).toBe(true);
  });

  it("无工具调用的 messages → 空数组", () => {
    const msgs: AnthropicNativeMessage[] = [
      { role: "user", content: [{ type: "text", text: "hi" }] },
      { role: "assistant", content: [{ type: "text", text: "hello" }] },
    ];
    expect(projectToolLines(msgs)).toHaveLength(0);
  });
});

describe("formatLiveToolEvent", () => {
  it("运行时事件文案：工具名 · 参数摘要 · 状态", () => {
    const line = formatLiveToolEvent({
      toolName: "read_file",
      input: { path: "a.ts" },
      kind: "ok",
    });
    expect(line).toBe("read_file · 读取 a.ts · ok");
  });

  it("非 ok kind → failed", () => {
    const line = formatLiveToolEvent({
      toolName: "bash",
      input: { command: "x" },
      kind: "execution_failed",
    });
    expect(line.endsWith("· failed")).toBe(true);
  });
});
