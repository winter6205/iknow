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
  settledClassOfDisplay,
  clipOneLine,
  clipOneLineVisual,
  countBashCalls,
  formatLiveToolEvent,
  formatRanSuffix,
  isSubagentTool,
  projectToolLines,
  registeredToolDisplayNames,
  resultPreviewOverflowLabel,
  resultToolPreview,
  stripAnsi,
  subagentDisplayMark,
  summarizeToolCall,
  RESULT_PREVIEW_WINDOW,
  TOOL_PREVIEW_WINDOW,
  completedToolPreview,
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

  test("memory_recall / memory_save / tool_search / skill 摘要（SC5 删 skill_search）", () => {
    expect(
      summarizeToolCall("memory_recall", { query: "TUI", limit: 5 }).detail
    ).toBe("记忆 召回 TUI");
    expect(
      summarizeToolCall("memory_save", { title: "TUI 折叠", body: "x" }).detail
    ).toBe("记忆 写入 TUI 折叠");
    expect(summarizeToolCall("tool_search", { query: "web" }).detail).toBe(
      "检索工具 web"
    );
    expect(
      summarizeToolCall("tool_search", {
        names: ["web_search", "web_fetch"],
      }).detail
    ).toBe("检索工具名 web_search");
    expect(summarizeToolCall("tool_search", {}).detail).toBe("检索工具 ?");
    expect(summarizeToolCall("skill", { name: "playwright-cli" }).detail).toBe(
      "skill playwright-cli"
    );
  });

  test("unknown name → 走默认 placeholder,不抛(SC5 删 skill_search 后默认 fallback)", () => {
    // 历史 tool_result 仍可能含 skill_search(消息写入在 deletion 之前)。
    // summary 函数对未注册名走默认 placeholder:工具名小括号包住,
    // 不抛、不替未注册名造专属显示。SC5 删 skill_search 后,本测试锁的是
    // 「未知工具 = 默认 placeholder」路径存在且稳定。
    const { detail } = summarizeToolCall("skill_search", { query: "tui" });
    expect(detail).toBe("(skill_search)");
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
  // #693 T1 D7：live 完成行文案收敛为历史形态。
  // #tui-render-overhaul T3：成功态去掉 `[完成]` 前缀（保留 `[运行中]` /
  // `[失败]`），状态由颜色/glyph 表达——避免「已完成工具还在开头挂 `[完成]`」
  // 干扰读者扫读；行首不残留多余空格。不变式：detail 非空 → `name · detail`；
  // detail 空 → `name`（无 ` · ` 残留）。
  test("完成态 ok → `name · detail`（去 [完成] 前缀，与 ToolSummaryRow 同源）", () => {
    const line = formatLiveToolEvent({
      toolName: "read_file",
      input: { path: "a.ts" },
      kind: "ok",
    });
    expect(line).toBe("read_file · 读取 a.ts");
    // 不变式:成功态无状态前缀。
    expect(line.includes("[完成]")).toBe(false);
  });

  test("失败态 → `[失败] name · detail`（保留明示前缀）", () => {
    const line = formatLiveToolEvent({
      toolName: "bash",
      input: { command: "x" },
      kind: "execution_failed",
    });
    expect(line).toBe("[失败] bash · x");
    expect(line.includes("· failed")).toBe(false);
  });

  test("显式 detail override 跳过重算（与 reducer state.detail 字节一致）", () => {
    const line = formatLiveToolEvent({
      toolName: "edit_file",
      input: {},
      kind: "ok",
      detail: "编辑 a.ts：old → new",
    });
    expect(line).toBe("edit_file · 编辑 a.ts：old → new");
  });

  test("detail 空 → `name`（无 ` · ` 残留，无状态前缀）", () => {
    const line = formatLiveToolEvent({
      toolName: "mystery",
      input: {},
      kind: "ok",
      detail: "",
    });
    expect(line).toBe("mystery");
    expect(line.includes(" · ")).toBe(false);
    expect(line.includes("[完成]")).toBe(false);
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

  test("write_file 60 行 create → completed 截断到窗，不是无封顶绿 diff", () => {
    const content = Array.from({ length: 60 }, (_, i) => `line-${i}`).join(
      "\n"
    );
    const preview = completedToolPreview("write_file", {
      path: "a.ts",
      content,
    });
    expect(preview.kind).toBe("code");
    if (preview.kind !== "code") return;
    expect(preview.lines).toHaveLength(TOOL_PREVIEW_WINDOW);
    expect(preview.lines[0]).toBe("line-0");
    expect(preview.hiddenLineCount).toBe(60 - TOOL_PREVIEW_WINDOW);
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

  test("formatLiveToolEvent bash ok 回归 → `bash · <detail>`（#693 T1 D7 统一形态 + #tui-render-overhaul T3 去完成前缀）", () => {
    const line = formatLiveToolEvent({
      toolName: "bash",
      input: { command: "npm test" },
      kind: "ok",
    });
    expect(line).toBe("bash · npm test");
    // 不再有尾缀 ` · ok`（spec D7 消除的不一致）。
    expect(line.endsWith(" · ok")).toBe(false);
    // #tui-render-overhaul T3:成功态无 [完成] 前缀。
    expect(line.includes("[完成]")).toBe(false);
  });

  test("formatLiveToolEvent tool_search detail 空（普通分支）→ `tool_search`（无 `· ` 残留）", () => {
    // 工具 search / 神秘工具在 detail 空时仍走普通分支；子代理分支不被波及。
    const line = formatLiveToolEvent({
      toolName: "tool_search",
      input: {},
      kind: "ok",
      detail: "",
    });
    expect(line).toBe("tool_search");
    expect(line).not.toContain("子代理");
    expect(line).not.toContain("[完成]");
  });
});

describe("completedToolPreview: 完成态分类 + 截断窗", () => {
  test("空 content → 无正文行", () => {
    const preview = completedToolPreview("write_file", {
      path: "a.ts",
      content: "",
    });
    expect(preview.kind).toBe("empty");
  });

  test("缺 path → 空预览", () => {
    expect(completedToolPreview("write_file", { content: "hello" }).kind).toBe(
      "empty"
    );
    expect(
      completedToolPreview("write_file", { path: "", content: "hello" }).kind
    ).toBe("empty");
  });

  test("write_file 且 old 空 → kind 为代码，行来自 content", () => {
    const preview = completedToolPreview("write_file", {
      path: "a.ts",
      content: "const a = 1;\nconst b = 2;",
    });
    expect(preview.kind).toBe("code");
    if (preview.kind !== "code") return;
    expect(preview.lines).toEqual(["const a = 1;", "const b = 2;"]);
    expect(preview.hiddenLineCount).toBe(0);
    expect(preview.lines.some((l) => l.startsWith("+"))).toBe(false);
  });

  test("side-channel old 空串 → 代码，不用 newContent 做整文件绿 diff", () => {
    const preview = completedToolPreview(
      "write_file",
      { path: "a.ts", content: "ignored" },
      { oldContent: "", newContent: "x\ny\n" }
    );
    expect(preview.kind).toBe("code");
    if (preview.kind !== "code") return;
    expect(preview.lines).toEqual(["x", "y"]);
  });

  test("write_file 覆盖（old 非空）→ kind 为 diff", () => {
    const preview = completedToolPreview(
      "write_file",
      { path: "a.ts", content: "b" },
      { oldContent: "a\n", newContent: "b\n" }
    );
    expect(preview.kind).toBe("diff");
    if (preview.kind !== "diff") return;
    expect(preview.rows.some((r) => r.kind === "del")).toBe(true);
    expect(preview.rows.some((r) => r.kind === "add")).toBe(true);
  });

  test("edit_file → kind 为 diff", () => {
    const preview = completedToolPreview("edit_file", {
      path: "a.ts",
      old_str: "foo",
      new_str: "bar",
    });
    expect(preview.kind).toBe("diff");
    if (preview.kind !== "diff") return;
    expect(preview.rows.find((r) => r.kind === "del")?.text).toBe("-foo");
    expect(preview.rows.find((r) => r.kind === "add")?.text).toBe("+bar");
  });

  test("edit_file old_str 空串 → kind 为 diff 不是 code", () => {
    const preview = completedToolPreview("edit_file", {
      path: "a.ts",
      old_str: "",
      new_str: "x",
    });
    expect(preview.kind).toBe("diff");
  });

  test("正文长于可见窗 → 只产出窗内行 + 溢出计数", () => {
    const content = Array.from({ length: 20 }, (_, i) => `L${i}`).join("\n");
    const preview = completedToolPreview("write_file", {
      path: "a.ts",
      content,
    });
    expect(preview.kind).toBe("code");
    if (preview.kind !== "code") return;
    expect(preview.lines).toHaveLength(TOOL_PREVIEW_WINDOW);
    expect(preview.hiddenLineCount).toBe(20 - TOOL_PREVIEW_WINDOW);
  });

  test("overwrite/edit visible rows 是 toolPreviewRows 的截断前缀", () => {
    const oldContent = Array.from({ length: 40 }, (_, i) => `old-${i}`).join(
      "\n"
    );
    const newContent = Array.from({ length: 40 }, (_, i) => `new-${i}`).join(
      "\n"
    );
    const input = { path: "a.ts", old_str: "x", new_str: "y" };
    const opts = { oldContent, newContent };
    const all = toolPreviewRows("edit_file", input, 80, opts);
    const preview = completedToolPreview("edit_file", input, opts);
    expect(preview.kind).toBe("diff");
    if (preview.kind !== "diff") return;
    expect(preview.rows).toEqual(all.slice(0, TOOL_PREVIEW_WINDOW));
    expect(preview.hiddenLineCount).toBe(all.length - TOOL_PREVIEW_WINDOW);
  });

  test("超长 overwrite diff → 截断到同一窗常数", () => {
    const oldContent = Array.from({ length: 40 }, (_, i) => `old-${i}`).join(
      "\n"
    );
    const newContent = Array.from({ length: 40 }, (_, i) => `new-${i}`).join(
      "\n"
    );
    const preview = completedToolPreview(
      "edit_file",
      { path: "a.ts", old_str: "x", new_str: "y" },
      { oldContent, newContent }
    );
    expect(preview.kind).toBe("diff");
    if (preview.kind !== "diff") return;
    expect(preview.rows.length).toBeLessThanOrEqual(TOOL_PREVIEW_WINDOW);
    expect(preview.hiddenLineCount).toBeGreaterThan(0);
    expect(preview.rows.length + preview.hiddenLineCount).toBeGreaterThan(
      TOOL_PREVIEW_WINDOW
    );
  });

  test("bash 等非 write/edit → 空", () => {
    expect(completedToolPreview("bash", { command: "ls" }).kind).toBe("empty");
    expect(completedToolPreview("read_file", { path: "a.ts" }).kind).toBe(
      "empty"
    );
  });
});

// M5 fixup：formatLiveToolEvent opts.cols 透传 —— detail override 缺省时
// 走 summarizeToolCall(name, input, cols) 视觉宽度收口（窄终端 CJK 不溢出）。
// #693 T1 D7 + #tui-render-overhaul T3：成功态文案 `name · detail`，去
// `[完成]` 前缀 + 尾缀 `· ok`。失败态保留 `[失败]`；运行中保留 `[运行中]`。
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
    expect(line.startsWith("bash ·")).toBe(true);
    expect(line.includes("[完成]")).toBe(false);
  });

  test("cols 缺省 → legacy 80 字符截断（与既有调用方字节兼容）", () => {
    const line = formatLiveToolEvent({
      toolName: "bash",
      input: { command: "x".repeat(200) },
      kind: "ok",
    });
    // 80 字符截断 + `bash · ` 前缀总长不超过 100（去掉 [完成] 5 字节后更短）。
    expect(line.length).toBeLessThanOrEqual(100);
    expect(line.startsWith("bash · x")).toBe(true);
    expect(line.includes("[完成]")).toBe(false);
  });
});

// ── #693 T4 D4:结果预览（resultToolPreview / stripAnsi / 注册表） ──────────

describe("stripAnsi: 剥 CSI / OSC 转义序列", () => {
  test("CSI SGR 颜色序列（git/npm 输出）全部吞掉", () => {
    expect(stripAnsi("\x1b[31mERROR\x1b[0m")).toBe("ERROR");
    expect(stripAnsi("\x1b[1;32mok\x1b[0m")).toBe("ok");
    expect(stripAnsi("\x1b[38;5;208mwarn\x1b[39m")).toBe("warn");
  });
  test("OSC 序列（含 BEL 终止）一并吞掉", () => {
    expect(stripAnsi("\x1b]0;title\x07body")).toBe("body");
    expect(stripAnsi("\x1b]8;;https://x\x07link\x1b]8;;\x07")).toBe("link");
  });
  test("无 ANSI 字符串原样", () => {
    expect(stripAnsi("plain text")).toBe("plain text");
    expect(stripAnsi("")).toBe("");
    expect(stripAnsi("测".repeat(5))).toBe("测".repeat(5));
  });
});

describe("resultPreviewOverflowLabel: `… +N 行` 文案", () => {
  test("N=0 → `… +0 行`（调用方负责仅在 hidden>0 时挂上）", () => {
    expect(resultPreviewOverflowLabel(0)).toBe("… +0 行");
  });
  test("N>0 → `… +N 行`", () => {
    expect(resultPreviewOverflowLabel(3)).toBe("… +3 行");
    expect(resultPreviewOverflowLabel(100)).toBe("… +100 行");
  });
});

describe("resultToolPreview: bash / skill / 兜底", () => {
  test("bash 单行 stdout → 1 行 result（无 overflow）", () => {
    const p = resultToolPreview(
      "bash",
      { command: "ls" },
      { resultText: JSON.stringify({ code: 0, stdout: "ok", stderr: "" }) }
    );
    expect(p.kind).toBe("result");
    if (p.kind !== "result") return;
    expect(p.lines).toEqual(["ok"]);
    expect(p.hiddenLineCount).toBe(0);
  });

  test("bash 多行 stdout → 取尾部 RESULT_PREVIEW_WINDOW 行 + 溢出 +N", () => {
    const stdout = Array.from({ length: 12 }, (_, i) => `line-${i}`).join("\n");
    const p = resultToolPreview(
      "bash",
      { command: "test" },
      {
        resultText: JSON.stringify({ code: 0, stdout, stderr: "" }),
      }
    );
    expect(p.kind).toBe("result");
    if (p.kind !== "result") return;
    expect(p.lines).toHaveLength(RESULT_PREVIEW_WINDOW);
    // 尾部 5 行：line-7..line-11
    expect(p.lines[0]).toBe("line-7");
    expect(p.lines[4]).toBe("line-11");
    expect(p.hiddenLineCount).toBe(7);
  });

  test("bash stderr 旁路（live 路径）→ 取尾部 + 溢出", () => {
    const stderr = "err-1\nerr-2\nerr-3\nerr-4\nerr-5\nerr-6\nerr-7";
    const p = resultToolPreview("bash", { command: "x" }, { stderr });
    expect(p.kind).toBe("result");
    if (p.kind !== "result") return;
    expect(p.lines).toEqual(["err-3", "err-4", "err-5", "err-6", "err-7"]);
    expect(p.hiddenLineCount).toBe(2);
  });

  test("bash stdout+stderr 合并（live 路径）→ 头尾拼接", () => {
    const p = resultToolPreview(
      "bash",
      { command: "x" },
      { stdout: "out-1\nout-2", stderr: "err-1" }
    );
    expect(p.kind).toBe("result");
    if (p.kind !== "result") return;
    expect(p.lines).toEqual(["out-1", "out-2", "err-1"]);
  });

  test("bash 全空白 stdout → empty（不渲染空块）", () => {
    const p = resultToolPreview(
      "bash",
      { command: "x" },
      {
        resultText: JSON.stringify({
          code: 0,
          stdout: "   \n\t\n  ",
          stderr: "",
        }),
      }
    );
    expect(p.kind).toBe("empty");
  });

  test("bash ANSI-only stdout（仅转义序列）→ empty", () => {
    const p = resultToolPreview(
      "bash",
      { command: "x" },
      {
        resultText: JSON.stringify({
          code: 0,
          stdout: "\x1b[31m\x1b[0m",
          stderr: "",
        }),
      }
    );
    expect(p.kind).toBe("empty");
  });

  test("bash 空 resultText / 缺字段 → empty", () => {
    expect(resultToolPreview("bash", { command: "x" }).kind).toBe("empty");
    expect(
      resultToolPreview("bash", { command: "x" }, { resultText: "" }).kind
    ).toBe("empty");
  });

  test("bash ANSI 透传：SGR 序列保留在行内容里（仅在「可见性判定」剥离）", () => {
    const stdout = "\x1b[31mERROR\x1b[0m line\n\x1b[32mOK\x1b[0m line";
    const p = resultToolPreview(
      "bash",
      { command: "x" },
      { resultText: JSON.stringify({ code: 0, stdout, stderr: "" }) }
    );
    expect(p.kind).toBe("result");
    if (p.kind !== "result") return;
    // 颜色码不重新染色 → 原样透传,行内仍含 ESC 序列。
    expect(p.lines[0]).toBe("\x1b[31mERROR\x1b[0m line");
    expect(p.lines[1]).toBe("\x1b[32mOK\x1b[0m line");
  });

  test("bash stdout 截断按 stripped 长度计数（ANSI 不计列）", () => {
    // 8 行：line-0..line-7 → 取尾部 5 → line-3..line-7
    const stdout = Array.from({ length: 8 }, (_, i) =>
      i % 2 === 0 ? `\x1b[31mline-${i}\x1b[0m` : `line-${i}`
    ).join("\n");
    const p = resultToolPreview(
      "bash",
      { command: "x" },
      { resultText: JSON.stringify({ code: 0, stdout, stderr: "" }) }
    );
    expect(p.kind).toBe("result");
    if (p.kind !== "result") return;
    expect(p.lines).toHaveLength(5);
    expect(p.lines[0]).toContain("line-3");
    expect(p.lines[4]).toContain("line-7");
    expect(p.hiddenLineCount).toBe(3);
  });

  test("bash ANSI 序列不被切断（行级截断不切字符，仅按行数）", () => {
    // 单行含多个 SGR：行内整体保留
    const stdout = "\x1b[31m\x1b[1m\x1b[4mUNDERLINE_RED_BOLD\x1b[0m";
    const p = resultToolPreview(
      "bash",
      { command: "x" },
      { resultText: JSON.stringify({ code: 0, stdout, stderr: "" }) }
    );
    expect(p.kind).toBe("result");
    if (p.kind !== "result") return;
    // 序列从 \x1b[31m 起，\x1b[0m 收尾 → 整段在 result 里
    expect(p.lines[0]?.startsWith("\x1b[31m")).toBe(true);
    expect(p.lines[0]?.endsWith("\x1b[0m")).toBe(true);
  });

  test("skill 无预览声明（D6 accent 点名着色）：多行正文不摊五行走", () => {
    // spec specs/tui-tool-settled-appearance.md D6：skill 是 accent 类 ——
    // 只点名着色（`skill <name>`），不把 skill 正文摊成五行走浅色预览；
    // 注册表不声明 preview，任何 resultText 一律 empty。
    const body = Array.from({ length: 10 }, (_, i) => `body-${i}`).join("\n");
    expect(
      resultToolPreview("skill", { name: "demo" }, { resultText: body }).kind
    ).toBe("empty");
    expect(
      resultToolPreview(
        "skill",
        { name: "demo" },
        { resultText: "Loaded skill body" }
      ).kind
    ).toBe("empty");
  });

  test("skill 缺 resultText → empty（live 路径无旁路）", () => {
    expect(resultToolPreview("skill", { name: "demo" }).kind).toBe("empty");
  });

  test("read_file 不显示内容预览（spec D4 边界）", () => {
    const p = resultToolPreview(
      "read_file",
      { path: "a.ts" },
      { resultText: "x".repeat(200) }
    );
    expect(p.kind).toBe("empty");
  });

  test("write_file / edit_file 维持原 6 行预览（结果预览为空，走 write/edit 通道）", () => {
    const wf = resultToolPreview(
      "write_file",
      { path: "a.ts", content: "x" },
      { resultText: "ok" }
    );
    expect(wf.kind).toBe("empty");
    const ef = resultToolPreview(
      "edit_file",
      { path: "a.ts", old_str: "a", new_str: "b" },
      { resultText: "ok" }
    );
    expect(ef.kind).toBe("empty");
  });

  test("未知工具 / 无 preview 声明 → empty（兜底）", () => {
    expect(resultToolPreview("mystery", {}).kind).toBe("empty");
    expect(resultToolPreview("grep", {}, { resultText: "x" }).kind).toBe(
      "empty"
    );
  });
});

describe("registeredToolDisplayNames: 注册表覆盖 EXPECTED_TOOLSET_30", () => {
  test("注册表至少覆盖 EXPECTED_TOOLSET_30 的所有工具名（声明密度单点）", () => {
    // spec D7：新增一种工具的显示只需在 TOOL_DISPLAYS 加一条声明。
    // 该测试保证 buildTuiDeps 装配的工具,每件都有显示声明（哪怕仅
    // summary、无 preview）。disclosure-index-align T2 删 skill_search 后
    // 总件数由 35 → 34。本闸与 deps-tools.test.ts 的 EXPECTED_TUI_TOOLSET
    // 正交但同源：装配闸校验"在不在"，本闸校验"是否声明了显示规则"，
    // 二者形成 spec D7「注册表完备性」双轨。
    const EXPECTED_TOOLSET_30 = [
      "bash",
      "read_file",
      "grep",
      "glob",
      "edit_file",
      "write_file",
      "web_fetch",
      "web_search",
      "memory_recall",
      "memory_save",
      "tool_search",
      "lsp_definition",
      "lsp_references",
      "lsp_hover",
      "lsp_document_symbol",
      "lsp_workspace_symbol",
      "lsp_go_to_implementation",
      "lsp_prepare_call_hierarchy",
      "lsp_incoming_calls",
      "lsp_outgoing_calls",
      "lsp_diagnostics",
      "skill",
      "spawn_subagent",
      "subagent_result",
      "todo_write",
      "list_mcp_resources",
      "read_mcp_resource",
      "bash_output",
      "bash_stop",
      // spec D2：建树四件 + list-task-worktrees 进入显示注册表。TUI 装配面
      // 仍按 host 缝条件化装配（deps-tools EXPECTED_TUI_TOOLSET 剥除不动），
      // 显示注册表完备性与装配条件化解耦 —— 覆盖闸从 30 件扩为 35 件，
      // 不变量（注册表每件都有显示声明）等于或强于原断言。
      "create-task-worktree",
      "enter-task-worktree",
      "exit-task-worktree",
      "remove-task-worktree",
      "list-task-worktrees",
    ];
    const names = new Set(registeredToolDisplayNames());
    for (const name of EXPECTED_TOOLSET_30) {
      expect(names.has(name)).toBe(true);
    }
  });
});

describe("settledClass: 落定态三分类（spec D2/D8）", () => {
  // spec D2：缺 settledClass 的声明非法。ToolDisplay 接口把字段钉成必填
  // （编译期闸），本测试在运行时再兜一层：注册表每件必须带合法 class 值。
  test("TOOL_DISPLAYS 每件都有合法 settledClass（缺声明即非法）", () => {
    const LEGAL: ReadonlyArray<string> = [
      "keep",
      "retract",
      "accent",
      "subagent",
    ];
    for (const name of registeredToolDisplayNames()) {
      const cls = settledClassOfDisplay(name);
      expect(LEGAL).toContain(cls);
      // 非 "subagent" 值必须来自 D8 三分类真值；"subagent" 只允许出现在
      // 核内 isSubagentSettledName 覆盖的两个名字上（跨核闸在 tool-settled.test）。
      if (cls === "subagent") {
        expect(["spawn_subagent", "subagent_result"]).toContain(name);
      }
    }
  });

  test("D8 分类表 sentinel：keep / retract / accent 各类代表名对号", () => {
    // keep：写路径与会话动作；retract：查询 / 读取 / 未注册兜底；
    // accent：skill 与建树四件。
    expect(settledClassOfDisplay("bash")).toBe("keep");
    expect(settledClassOfDisplay("write_file")).toBe("keep");
    expect(settledClassOfDisplay("todo_write")).toBe("keep");
    expect(settledClassOfDisplay("read_file")).toBe("retract");
    expect(settledClassOfDisplay("grep")).toBe("retract");
    expect(settledClassOfDisplay("list-task-worktrees")).toBe("retract");
    expect(settledClassOfDisplay("skill")).toBe("accent");
    for (const name of [
      "create-task-worktree",
      "enter-task-worktree",
      "exit-task-worktree",
      "remove-task-worktree",
    ]) {
      expect(settledClassOfDisplay(name)).toBe("accent");
    }
  });

  test('子代理两件显式声明 "subagent" class（D8 三类之外，无 ! 断言兜底）', () => {
    // spec D8：spawn_subagent / subagent_result 不进 keep/retract/accent 三类，
    // 核在 class 分派之前按 keep-title-only 特判。注册表声明必须诚实 ——
    // 若靠 undefined + 兜底「碰巧」解析成 retract，本测试拒绝。
    expect(settledClassOfDisplay("spawn_subagent")).toBe("subagent");
    expect(settledClassOfDisplay("subagent_result")).toBe("subagent");
  });

  test("建树四件 + list-task-worktrees 进显示注册表（spec D2 建树四件必须入表）", () => {
    const names = new Set(registeredToolDisplayNames());
    for (const name of [
      "create-task-worktree",
      "enter-task-worktree",
      "exit-task-worktree",
      "remove-task-worktree",
      "list-task-worktrees",
    ]) {
      expect(names.has(name)).toBe(true);
    }
  });
});
