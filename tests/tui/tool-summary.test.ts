/**
 * tests/tui/tool-summary.test.ts
 *
 * #343 T4：工具摘要行（纯格式化，bun:test 重写归档语义）：
 *  - summarizeToolCall 参数摘要（生成/编辑类增强）+ cols 视觉宽度收口；
 *  - projectToolLines tool_use_id 精确配对状态回填；
 *  - formatLiveToolEvent 运行时事件文案 SSOT；
 *  - toolPreviewRows 统一 diff 预览行（side-channel 精确 diff / intent 回退）。
 */
import { describe, expect, test } from "bun:test";
import {
  SUBAGENT_TOOL_LABEL,
  clipOneLine,
  clipOneLineVisual,
  countBashCalls,
  formatLiveToolEvent,
  formatRanSuffix,
  isSubagentTool,
  projectToolLines,
  subagentDisplayMark,
  summarizeToolCall,
  toolPreviewRows,
  visualWidth,
} from "../../src/tui/tool-summary.js";
import type { AnthropicNativeMessage } from "../../src/harness/model-adapter/types.js";

describe("summarizeToolCall: 参数摘要（生成/编辑类增强）", () => {
  test("write_file → 路径 + 行数（生成了什么）", () => {
    const { detail } = summarizeToolCall("write_file", {
      path: "docs/a.md",
      content: "l1\nl2\nl3",
    });
    expect(detail).toBe("写入 docs/a.md（3 行）");
  });

  test("edit_file → 路径 + old→new（变更对比摘要）", () => {
    const { detail } = summarizeToolCall("edit_file", {
      path: "src/x.ts",
      old_str: "foo",
      new_str: "bar",
    });
    expect(detail).toContain("编辑 src/x.ts");
    expect(detail).toContain("foo");
    expect(detail).toContain("bar");
  });

  test("bash → 命令摘要；read_file/grep/glob → 各自动词", () => {
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

  test("未知工具 → 占位符摘要（避免 JSON 全文外露）", () => {
    const { detail } = summarizeToolCall("mystery", { a: "x".repeat(200) });
    expect(detail).toBe("(mystery)");
    // 未知工具不再 stringify 整个 input —— 不落 JSON 全文。
    expect(detail.includes("x".repeat(200))).toBe(false);
  });

  test("web_search → 搜索 query（聚焦首个关键字段，不落 JSON 全文）", () => {
    const { detail } = summarizeToolCall("web_search", {
      query: "DeepSeek V4 评测",
      max_results: 6,
    });
    expect(detail).toBe("搜索 DeepSeek V4 评测");
    expect(detail.includes('"max_results"')).toBe(false);
  });

  test("web_fetch → 抓取 url", () => {
    const { detail } = summarizeToolCall("web_fetch", {
      url: "https://example.com/a",
      max_chars: 500,
    });
    expect(detail).toBe("抓取 https://example.com/a");
  });

  test("memory_recall / memory_save / tool_search / skill / skill_search 摘要", () => {
    expect(
      summarizeToolCall("memory_recall", { query: "TUI", limit: 5 }).detail
    ).toBe("记忆 召回 TUI");
    expect(
      summarizeToolCall("memory_save", { title: "TUI 折叠", body: "x" }).detail
    ).toBe("记忆 写入 TUI 折叠");
    expect(summarizeToolCall("tool_search", { query: "web" }).detail).toBe(
      "工具 web"
    );
    expect(summarizeToolCall("skill", { name: "playwright-cli" }).detail).toBe(
      "skill playwright-cli"
    );
    expect(summarizeToolCall("skill_search", { query: "tui" }).detail).toBe(
      "skill tui"
    );
  });

  test("spawn_subagent / subagent_result 摘要（task / task_id）", () => {
    expect(
      summarizeToolCall("spawn_subagent", { task: "查 root cause" }).detail
    ).toBe("派发子代理：查 root cause");
    expect(
      summarizeToolCall("subagent_result", { task_id: "t-1" }).detail
    ).toBe("轮询 t-1");
  });

  test("LSP 工具 → LSP <op> file[:line]（不落 JSON 全文）", () => {
    const { detail } = summarizeToolCall("lsp_definition", {
      file: "src/a.ts",
      line: 12,
    });
    expect(detail).toBe("LSP definition src/a.ts:12");
    expect(
      summarizeToolCall("lsp_document_symbol", { file: "b.ts" }).detail
    ).toBe("LSP documentSymbol b.ts");
    expect(
      summarizeToolCall("lsp_workspace_symbol", { query: "foo" }).detail
    ).toBe("LSP workspaceSymbol foo");
  });
});

describe("countBashCalls / formatRanSuffix: 折叠摘要 ran N（T4）", () => {
  const bashMsg: AnthropicNativeMessage = {
    role: "assistant",
    content: [
      { type: "text", text: "试一下" },
      {
        type: "tool_use",
        id: "tu-1",
        name: "bash",
        input: { command: "npm test" },
      },
      { type: "tool_use", id: "tu-2", name: "write_file", input: {} },
      {
        type: "tool_use",
        id: "tu-3",
        name: "bash",
        input: { command: "git status" },
      },
    ],
  };

  test("countBashCalls：仅统计 assistant 消息内 name === bash 的 tool_use", () => {
    expect(countBashCalls(bashMsg)).toBe(2);
    expect(
      countBashCalls({
        role: "user",
        content: [],
      } satisfies AnthropicNativeMessage)
    ).toBe(0);
    expect(
      countBashCalls({
        role: "assistant",
        content: [{ type: "text", text: "x" }],
      })
    ).toBe(0);
  });

  test("formatRanSuffix：1 → ran 1 command，>1 → ran N commands，0 → 空串", () => {
    expect(formatRanSuffix(1)).toBe("，ran 1 command");
    expect(formatRanSuffix(2)).toBe("，ran 2 commands");
    expect(formatRanSuffix(0)).toBe("");
    expect(formatRanSuffix(-1)).toBe("");
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

  test("tool_result 到达 → ok/failed 精确配对（is_error）", () => {
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

  test("tool_result 未到达（cancelled 中断）→ unknown", () => {
    const lines = projectToolLines([toolUseMsg]);
    expect(lines.every((l) => l.status === "unknown")).toBe(true);
  });

  test("无工具调用的 messages → 空数组", () => {
    const msgs: AnthropicNativeMessage[] = [
      { role: "user", content: [{ type: "text", text: "hi" }] },
      { role: "assistant", content: [{ type: "text", text: "hello" }] },
    ];
    expect(projectToolLines(msgs)).toHaveLength(0);
  });
});

describe("formatLiveToolEvent", () => {
  test("运行时事件文案：工具名 · 参数摘要 · 状态", () => {
    const line = formatLiveToolEvent({
      toolName: "read_file",
      input: { path: "a.ts" },
      kind: "ok",
    });
    expect(line).toBe("read_file · 读取 a.ts · ok");
  });

  test("非 ok kind → failed", () => {
    const line = formatLiveToolEvent({
      toolName: "bash",
      input: { command: "x" },
      kind: "execution_failed",
    });
    expect(line.endsWith("· failed")).toBe(true);
  });

  test("显式 detail override 跳过重算（与 reducer state.detail 字节一致）", () => {
    const line = formatLiveToolEvent({
      toolName: "edit_file",
      input: {},
      kind: "ok",
      detail: "编辑 a.ts：old → new",
    });
    expect(line).toBe("edit_file · 编辑 a.ts：old → new · ok");
  });

  test("detail 空 → 省去中间分隔符（无 ` ·  · ` 残留）", () => {
    const line = formatLiveToolEvent({
      toolName: "mystery",
      input: {},
      kind: "ok",
      detail: "",
    });
    expect(line).toBe("mystery · ok");
  });
});

describe("summarizeToolCall(cols): 窄终端宽度收口（行账不漂移）", () => {
  test("窄终端：终稿形态 [运行中] name · detail 单行放得下", () => {
    const cols = 60;
    const { detail } = summarizeToolCall(
      "bash",
      { command: "x".repeat(300) },
      cols
    );
    const finalLine = `[运行中] bash · ${detail}`;
    expect(visualWidth(finalLine)).toBeLessThanOrEqual(cols);
  });

  test("窄终端：live 完成形态 name · detail · failed 单行放得下", () => {
    const cols = 60;
    const { detail } = summarizeToolCall(
      "bash",
      { command: "x".repeat(300) },
      cols
    );
    const liveLine = `bash · ${detail} · failed`;
    expect(visualWidth(liveLine)).toBeLessThanOrEqual(cols);
  });

  test("CJK 内容按视觉宽度收口（字符数截断会低估列数 → 折行）", () => {
    const cols = 50;
    const { detail } = summarizeToolCall(
      "bash",
      { command: "测".repeat(200) },
      cols
    );
    expect(visualWidth(`[运行中] bash · ${detail}`)).toBeLessThanOrEqual(cols);
  });

  test("宽终端：不超过 legacy 80 上限", () => {
    const { detail } = summarizeToolCall(
      "bash",
      { command: "x".repeat(300) },
      200
    );
    expect(visualWidth(detail)).toBeLessThanOrEqual(80);
  });

  test("不传 cols → legacy 行为不变（80 字符截断）", () => {
    const { detail } = summarizeToolCall("bash", { command: "x".repeat(300) });
    expect(detail.length).toBeLessThanOrEqual(80);
  });
});

describe("文本收口助手（替代归档 text.ts 的 T4 范围 SSOT）", () => {
  test("clipOneLine：折叠空白 + 字符数截断补 …", () => {
    expect(clipOneLine("a  b\n c", 100)).toBe("a b c");
    const out = clipOneLine("x".repeat(100), 10);
    expect(out.length).toBe(10);
    expect(out.endsWith("…")).toBe(true);
  });

  test("clipOneLineVisual：CJK 按 2 列收口，结果视觉宽 ≤ max", () => {
    const out = clipOneLineVisual("测".repeat(50), 10);
    expect(visualWidth(out)).toBeLessThanOrEqual(10);
    expect(out.endsWith("…")).toBe(true);
    expect(clipOneLineVisual("abc", 0)).toBe("");
    expect(clipOneLineVisual("abc", 10)).toBe("abc");
  });
});

describe("toolPreviewRows: 写/改文件内容可见（统一 diff）", () => {
  test("write_file → 纯 add diff（kind 全 add，newNo 单调，hunk 头出现）", () => {
    const rows = toolPreviewRows(
      "write_file",
      { path: "a.ts", content: "const a = 1;\nconst b = 2;" },
      80
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.kind === "add" || r.kind === "ctx")).toBe(true);
    expect(rows.filter((r) => r.kind === "add").length).toBe(2);
    const adds = rows.filter((r) => r.kind === "add");
    expect(adds.map((r) => r.newNo)).toEqual([1, 2]);
    expect(rows[0]?.text).toMatch(/^@@ -1,0 \+1,2 @@$/);
  });

  test("write_file 60 行 → diff 行数 = 60 + 1 hunk 头 + 1 尾部标记（无封顶）", () => {
    const content = Array.from({ length: 60 }, (_, i) => `line-${i}`).join(
      "\n"
    );
    const rows = toolPreviewRows("write_file", { path: "a.ts", content }, 80);
    expect(rows).toHaveLength(62);
    expect(rows.filter((r) => r.kind === "add")).toHaveLength(60);
    expect(rows[0]?.text).toMatch(/^@@ -1,0 \+1,60 @@$/);
  });

  test("edit_file → old（del）/ new（add）diff", () => {
    const rows = toolPreviewRows(
      "edit_file",
      { path: "a.ts", old_str: "foo", new_str: "bar" },
      80
    );
    const del = rows.find((r) => r.kind === "del");
    const add = rows.find((r) => r.kind === "add");
    expect(del?.text).toBe("-foo");
    expect(add?.text).toBe("+bar");
    expect(del?.oldNo).toBe(1);
    expect(add?.newNo).toBe(1);
  });

  test("edit_file old == new → 空 diff", () => {
    const big = Array.from({ length: 25 }, (_, i) => `l${i}`).join("\n");
    const rows = toolPreviewRows(
      "edit_file",
      { path: "a.ts", old_str: big, new_str: big },
      80
    );
    expect(rows).toHaveLength(0);
  });

  test("其余工具 → 无预览行", () => {
    expect(toolPreviewRows("bash", { command: "ls" }, 80)).toHaveLength(0);
    expect(toolPreviewRows("read_file", { path: "a.ts" }, 80)).toHaveLength(0);
  });

  test("write_file 空 content → 空 diff（无预览行）", () => {
    expect(
      toolPreviewRows("write_file", { path: "a.ts", content: "" }, 80)
    ).toHaveLength(0);
  });

  test("side-channel 路径：opts.oldContent/newContent 精确 diff", () => {
    const rows = toolPreviewRows(
      "edit_file",
      { path: "a.ts", old_str: "stale", new_str: "stale" },
      80,
      { oldContent: "v1\nv2\nv3\n", newContent: "v1\nv2\nv3b\n" }
    );
    const del = rows.find((r) => r.kind === "del");
    const add = rows.find((r) => r.kind === "add");
    expect(del?.text).toBe("-v3");
    expect(add?.text).toBe("+v3b");
  });

  test("side-channel write_file：old 空串 → 纯 add", () => {
    const rows = toolPreviewRows(
      "write_file",
      { path: "a.ts", content: "ignored" },
      80,
      { oldContent: "", newContent: "x\ny\n" }
    );
    expect(rows.filter((r) => r.kind === "add")).toHaveLength(2);
  });

  test("edit_file 无 old_str/new_str → 空数组", () => {
    expect(toolPreviewRows("edit_file", { path: "a.ts" }, 80)).toHaveLength(0);
  });
});

describe("子代理工具专属显示（isSubagentTool / subagentDisplayMark / SUBAGENT_TOOL_LABEL）", () => {
  test("isSubagentTool：spawn_subagent / subagent_result → true；普通工具 → false", () => {
    expect(isSubagentTool("spawn_subagent")).toBe(true);
    expect(isSubagentTool("subagent_result")).toBe(true);
    expect(isSubagentTool("bash")).toBe(false);
    expect(isSubagentTool("read_file")).toBe(false);
  });

  test("subagentDisplayMark：running → ▣，ok → ✓，failed → ✗", () => {
    expect(subagentDisplayMark("running")).toBe("▣");
    expect(subagentDisplayMark("ok")).toBe("✓");
    expect(subagentDisplayMark("failed")).toBe("✗");
  });

  test('SUBAGENT_TOOL_LABEL === "子代理"', () => {
    expect(SUBAGENT_TOOL_LABEL).toBe("子代理");
  });

  test("formatLiveToolEvent spawn_subagent ok（input 含 task）→ `✓ 子代理 · 派发子代理：…`（无尾部 ` · ok`）", () => {
    const line = formatLiveToolEvent({
      toolName: "spawn_subagent",
      input: { task: "调查渲染层" },
      kind: "ok",
    });
    expect(line).toBe("✓ 子代理 · 派发子代理：调查渲染层");
    // 子代理分支：glyph 已表状态，不再拼尾部 ` · ok/failed`。
    expect(line.endsWith(" · ok")).toBe(false);
    expect(line.endsWith(" · failed")).toBe(false);
  });

  test("formatLiveToolEvent spawn_subagent failed → `✗ 子代理 · …`", () => {
    const line = formatLiveToolEvent({
      toolName: "spawn_subagent",
      input: { task: "调查渲染层" },
      kind: "execution_failed",
    });
    expect(line).toBe("✗ 子代理 · 派发子代理：调查渲染层");
    expect(line.includes("· failed")).toBe(false);
  });

  test("formatLiveToolEvent subagent_result ok → `✓ 子代理 · 轮询 …`", () => {
    const line = formatLiveToolEvent({
      toolName: "subagent_result",
      input: { task_id: "t-1" },
      kind: "ok",
    });
    expect(line).toBe("✓ 子代理 · 轮询 t-1");
  });

  test("formatLiveToolEvent 子代理 detail 空（显式 override）→ `${mark} 子代理`（无 `· ` 残留）", () => {
    // 子代理 summary 器兜底值非空，构造 detail 空走显式 override 路径，
    // 验证子代理分支 detail 空形态（不拼 `· `，也不拼尾部状态）。
    const line = formatLiveToolEvent({
      toolName: "subagent_result",
      input: { task_id: "t-1" },
      kind: "ok",
      detail: "",
    });
    expect(line).toBe("✓ 子代理");
    expect(line.includes("·")).toBe(false);
  });

  test("formatLiveToolEvent bash ok 回归 → `bash · <detail> · ok` 字节不变（普通分支不受影响）", () => {
    const line = formatLiveToolEvent({
      toolName: "bash",
      input: { command: "npm test" },
      kind: "ok",
    });
    expect(line).toBe("bash · npm test · ok");
  });

  test("formatLiveToolEvent tool_search detail 空（普通分支）→ 普通空形态字节不变", () => {
    // 工具 search / 神秘工具在 detail 空时仍走普通分支；子代理分支不被波及。
    const line = formatLiveToolEvent({
      toolName: "tool_search",
      input: {},
      kind: "ok",
      detail: "",
    });
    expect(line).toBe("tool_search · ok");
    expect(line).not.toContain("子代理");
  });
});

// M5 fixup：formatLiveToolEvent opts.cols 透传 —— detail override 缺省时
// 走 summarizeToolCall(name, input, cols) 视觉宽度收口（窄终端 CJK 不溢出）。
describe("formatLiveToolEvent(cols) 透传：detail 空时按视觉宽度收口", () => {
  test("窄 cols + CJK 长 command → 单行 ≤ cols（不在中间换行）", () => {
    // detail 空走 summarizeToolCall；提供 cols 时 detail 按视觉宽度收口。
    const cols = 40;
    const line = formatLiveToolEvent({
      toolName: "bash",
      input: {
        command: "非常长的命令用于测试中文输入时按视觉宽度折行的行为".repeat(4),
      },
      kind: "ok",
      cols,
    });
    expect(visualWidth(line)).toBeLessThanOrEqual(cols);
    expect(line.endsWith("· ok")).toBe(true);
  });

  test("cols 缺省 → legacy 80 字符截断（与既有调用方字节兼容）", () => {
    const line = formatLiveToolEvent({
      toolName: "bash",
      input: { command: "x".repeat(200) },
      kind: "ok",
    });
    // 80 字符截断 + `· ok` 后缀总长不超过 100
    expect(line.length).toBeLessThanOrEqual(100);
    expect(line.startsWith("bash · x")).toBe(true);
  });
});
