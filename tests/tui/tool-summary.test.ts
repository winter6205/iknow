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
  toolPreviewLines,
} from "../../src/tui/tool-summary.js";
import { visualWidth } from "../../src/tui/banner.js";
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

describe("summarizeToolCall(cols): 窄终端宽度收口（行账不漂移）", () => {
  it("窄终端：终稿形态 [运行中] name · detail 单行放得下", () => {
    const cols = 60;
    const { detail } = summarizeToolCall(
      "bash",
      { command: "x".repeat(300) },
      cols
    );
    const finalLine = `[运行中] bash · ${detail}`;
    expect(visualWidth(finalLine)).toBeLessThanOrEqual(cols);
  });

  it("窄终端：live 完成形态 name · detail · failed 单行放得下", () => {
    const cols = 60;
    const { detail } = summarizeToolCall(
      "bash",
      { command: "x".repeat(300) },
      cols
    );
    const liveLine = `bash · ${detail} · failed`;
    expect(visualWidth(liveLine)).toBeLessThanOrEqual(cols);
  });

  it("CJK 内容按视觉宽度收口（字符数截断会低估列数 → 折行）", () => {
    const cols = 50;
    const { detail } = summarizeToolCall(
      "bash",
      { command: "测".repeat(200) },
      cols
    );
    expect(visualWidth(`[运行中] bash · ${detail}`)).toBeLessThanOrEqual(cols);
  });

  it("宽终端：不超过 legacy 80 上限", () => {
    const { detail } = summarizeToolCall(
      "bash",
      { command: "x".repeat(300) },
      200
    );
    expect(visualWidth(detail)).toBeLessThanOrEqual(80);
  });

  it("不传 cols → legacy 行为不变（80 字符截断）", () => {
    const { detail } = summarizeToolCall("bash", { command: "x".repeat(300) });
    expect(detail.length).toBeLessThanOrEqual(80);
  });
});

describe("toolPreviewLines: 写/改文件内容可见", () => {
  it("write_file → 逐行预览（│ 前缀），内容可见", () => {
    const lines = toolPreviewLines(
      "write_file",
      { path: "a.ts", content: "const a = 1;\nconst b = 2;" },
      80
    );
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("const a = 1;");
    expect(lines[1]).toContain("const b = 2;");
    for (const l of lines) expect(l.startsWith("  │ ")).toBe(true);
  });

  it("write_file 超 30 行 → 封顶 + 余行提示", () => {
    const content = Array.from({ length: 78 }, (_, i) => `l${i}`).join("\n");
    const lines = toolPreviewLines("write_file", { path: "a.ts", content }, 80);
    expect(lines).toHaveLength(31);
    expect(lines[30]).toContain("余 48 行未显示");
  });

  it("edit_file → old（-）/ new（+）片段", () => {
    const lines = toolPreviewLines(
      "edit_file",
      { path: "a.ts", old_str: "foo", new_str: "bar" },
      80
    );
    expect(lines.some((l) => l.includes("- foo"))).toBe(true);
    expect(lines.some((l) => l.includes("+ bar"))).toBe(true);
  });

  it("edit_file old/new 各封顶 10 行 + 余行提示", () => {
    const big = Array.from({ length: 25 }, (_, i) => `l${i}`).join("\n");
    const lines = toolPreviewLines(
      "edit_file",
      { path: "a.ts", old_str: big, new_str: big },
      80
    );
    // 10 内容 + 1 余行提示，old/new 各一份 = 22
    expect(lines).toHaveLength(22);
    expect(lines.filter((l) => l.includes("余 15 行"))).toHaveLength(2);
  });

  it("其余工具 / 空内容 → 无预览行", () => {
    expect(toolPreviewLines("bash", { command: "ls" }, 80)).toHaveLength(0);
    expect(toolPreviewLines("write_file", { path: "a" }, 80)).toHaveLength(0);
  });

  it("长内容行按视觉宽度截断到 cols 内（预览行不折行）", () => {
    const lines = toolPreviewLines(
      "write_file",
      { path: "a.ts", content: "x".repeat(300) },
      60
    );
    for (const l of lines) expect(visualWidth(l)).toBeLessThanOrEqual(60);
  });
});
