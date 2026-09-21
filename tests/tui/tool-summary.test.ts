/**
 * tests/tui/tool-summary.test.ts
 *
 * Tool summary lines (pure formatting, bun:test rewrite of archived semantics):
 *  - summarizeToolCall argument summary (enhanced for create/edit tools) +
 *    cols visual-width cap;
 *  - projectToolLines exact tool_use_id pairing for status backfill;
 *  - formatLiveToolEvent runtime-event wording SSOT;
 *  - toolPreviewRows unified diff preview rows (side-channel exact diff / intent fallback).
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  SUBAGENT_TOOL_LABEL,
  settledClassOfDisplay,
  clipOneLine,
  clipOneLineVisual,
  formatLiveToolEvent,
  formatToolStatusLine,
  isSubagentTool,
  previewOverflowLabel,
  projectToolLines,
  registeredToolDisplayNames,
  resultPreviewOverflowLabel,
  resultToolPreview,
  writePreviewOverflowLabel,
  stripAnsi,
  subagentDisplayMark,
  summarizeToolCall,
  RESULT_PREVIEW_WINDOW,
  WRITE_CREATE_PREVIEW_WINDOW,
  completedToolPreview,
  toolPreviewRows,
  visualWidth,
} from "../../src/tui/tool-summary.js";
import { resultPreviewTextLines } from "../../src/tui/completed-tool-preview-view.js";
import type { AnthropicNativeMessage } from "../../src/harness/model-adapter/types.js";

describe("summarizeToolCall: 参数摘要（生成/编辑类增强）", () => {
  test("write_file → 路径 + 行数（生成了什么）", () => {
    const { detail } = summarizeToolCall("write_file", {
      path: "docs/a.md",
      content: "l1\nl2\nl3",
    });
    expect(detail).toBe("Wrote docs/a.md (3 lines)");
  });

  test("edit_file → 路径 + 行数（描述性；本次改动 diff 由预览承担）", () => {
    const { detail } = summarizeToolCall("edit_file", {
      path: "src/x.ts",
      old_str: "foo",
      new_str: "bar",
    });
    expect(detail).toBe("Edited src/x.ts (1 → 1 lines)");
    // The old inline old→new fragment is retired: the change is expressed by
    // the diff preview; the title line no longer carries a fragment.
    expect(detail).not.toContain("foo");
  });

  test("bash → 命令摘要；read_file/grep/glob → 各自动词（英文人读行）", () => {
    expect(summarizeToolCall("bash", { command: "npm test" }).detail).toBe(
      "npm test"
    );
    expect(summarizeToolCall("read_file", { path: "a.ts" }).detail).toBe(
      "Read a.ts"
    );
    expect(summarizeToolCall("grep", { pattern: "foo" }).detail).toBe(
      "Search foo"
    );
    expect(summarizeToolCall("glob", { pattern: "*.ts" }).detail).toBe(
      "Glob *.ts"
    );
  });

  test("未知工具 → 占位符摘要（避免 JSON 全文外露）", () => {
    const { detail } = summarizeToolCall("mystery", { a: "x".repeat(200) });
    expect(detail).toBe("(mystery)");
    // Unknown tools no longer stringify the whole input -- no full-JSON leakage.
    expect(detail.includes("x".repeat(200))).toBe(false);
  });

  test("web_search → `Search <query>`；web_fetch → `Fetch <url>`（首个关键字段）", () => {
    const search = summarizeToolCall("web_search", {
      query: "DeepSeek V4 评测",
      max_results: 6,
    }).detail;
    expect(search).toBe("Search DeepSeek V4 评测");
    expect(search.includes('"max_results"')).toBe(false);
    expect(
      summarizeToolCall("web_fetch", {
        url: "https://example.com/a",
        max_chars: 500,
      }).detail
    ).toBe("Fetch https://example.com/a");
  });

  test("memory_recall / memory_save / tool_search / skill 摘要（SC5 删 skill_search）", () => {
    expect(
      summarizeToolCall("memory_recall", { query: "TUI", limit: 5 }).detail
    ).toBe("Recall TUI");
    expect(
      summarizeToolCall("memory_save", { title: "TUI 折叠", body: "x" }).detail
    ).toBe("Remember TUI 折叠");
    expect(summarizeToolCall("tool_search", { query: "web" }).detail).toBe(
      "Tool search web"
    );
    expect(
      summarizeToolCall("tool_search", {
        names: ["web_search", "web_fetch"],
      }).detail
    ).toBe("Tool search web_search");
    expect(summarizeToolCall("tool_search", {}).detail).toBe("Tool search ?");
    expect(summarizeToolCall("skill", { name: "playwright-cli" }).detail).toBe(
      "skill playwright-cli"
    );
  });

  test("unknown name → 走默认 placeholder,不抛(SC5 删 skill_search 后默认 fallback)", () => {
    // Historical tool_result may still carry skill_search (messages were
    // written before its deletion). The summary function sends unregistered
    // names to the default placeholder: tool name wrapped in parentheses, no
    // throw, no bespoke display for unregistered names. This test locks that
    // the "unknown tool = default placeholder" path exists and is stable.
    const { detail } = summarizeToolCall("skill_search", { query: "tui" });
    expect(detail).toBe("(skill_search)");
  });

  test("spawn_subagent / subagent_result 摘要（role / task_id；task 不进 transcript）", () => {
    expect(
      summarizeToolCall("spawn_subagent", { task: "查 root cause" }).detail
    ).toBe("general-purpose");
    expect(
      summarizeToolCall(
        "spawn_subagent",
        { task: "查 root cause" },
        undefined,
        {
          running: true,
        }
      ).detail
    ).toBe("general-purpose running");
    expect(
      summarizeToolCall("spawn_subagent", {
        task: "查 root cause",
        subagent_type: "explore",
      }).detail
    ).toBe("explore");
    expect(
      summarizeToolCall("subagent_result", { task_id: "t-1" }).detail
    ).toBe("Poll t-1");
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

describe("countBashCalls / formatRanSuffix: 已退役的 ran N 语义", () => {
  // docs/CONTEXT.md `unit fold`: the `ran N command(s)` second-line semantics
  // is abolished wholesale; counting is carried only by the turn-level
  // `formatToolUseCounts` (`bash × N`); both helpers and their tests retired to
  // archive/tests/tui/ (the invariant is permanently gone, not assertion drift).
  test("生产面不再有任何 ran N 后缀调用方（退役闸）", () => {
    const src = readFileSync(
      new URL("../../src/tui/message-blocks.tsx", import.meta.url),
      "utf8"
    );
    // Code only: mentions of the old semantics inside comments are not callers (the `formatRanSuffix(` call form).
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(code.includes("formatRanSuffix")).toBe(false);
    expect(code.includes("countBashCalls")).toBe(false);
    expect(code.includes("ran ")).toBe(false);
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
  // Live completion-line wording converges to the historical form.
  // Human-readable contract: the completed state draws only `name · detail`,
  // no `[完成]` ("done"), no `[运行中]` ("running"); failure still shows an
  // explicit `[失败]` ("failed") prefix (the failure overlay is out of this
  // change's scope). Invariant: non-empty detail -> `name · detail`; empty
  // detail -> `name`.
  test("完成态 ok → `name · detail`（无 [完成] 前缀，与 ToolSummaryRow 同源）", () => {
    const line = formatLiveToolEvent({
      toolName: "read_file",
      input: { path: "a.ts" },
      kind: "ok",
    });
    expect(line).toBe("read_file · Read a.ts");
    // Invariant: success state carries no status prefix.
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
      detail: "Edited a.ts (2 → 3 lines)",
    });
    expect(line).toBe("edit_file · Edited a.ts (2 → 3 lines)");
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

describe("formatToolStatusLine: running 人读行（D1 无状态括号）", () => {
  test("bash running → `Running 1 shell command… · <command>`（命令可见）", () => {
    const line = formatToolStatusLine({
      toolName: "bash",
      input: { command: "npm test" },
      status: "running",
    });
    expect(line).toBe("Running 1 shell command… · npm test");
    expect(line.includes("[运行中]")).toBe(false);
  });

  test("read_file / grep / web_search running → 英文动词 + 路径 / 模式 / 查询", () => {
    expect(
      formatToolStatusLine({
        toolName: "read_file",
        input: { path: "a.ts" },
        status: "running",
      })
    ).toBe("read_file · Read a.ts");
    expect(
      formatToolStatusLine({
        toolName: "grep",
        input: { pattern: "foo" },
        status: "running",
      })
    ).toBe("grep · Search foo");
    expect(
      formatToolStatusLine({
        toolName: "web_search",
        input: { query: "clickhouse merge" },
        status: "running",
      })
    ).toBe("web_search · Search clickhouse merge");
    expect(
      formatToolStatusLine({
        toolName: "web_fetch",
        input: { url: "https://example.com/a" },
        status: "running",
      })
    ).toBe("web_fetch · Fetch https://example.com/a");
  });

  test("bash running 已过行数闸（runningBashSummary：任一非空片段都可见）", () => {
    expect(
      formatToolStatusLine({
        toolName: "bash",
        input: { command: "npm run test:real-llm", timeout_ms: 600000 },
        status: "running",
      })
    ).toBe("Running 1 shell command… · npm run test:real-llm");
  });

  test("running 行不得出现 `[运行中]`（旧状态括号文案整体作废）", () => {
    for (const name of ["bash", "read_file", "write_file", "mystery"]) {
      const line = formatToolStatusLine({
        toolName: name,
        input: {},
        status: "running",
      });
      expect(line.includes("[运行中]")).toBe(false);
    }
  });

  test("bash running 只透传命令，不再渲染行数（D5 挤档：Wrote N lines to path）", () => {
    const line = formatToolStatusLine({
      toolName: "bash",
      input: { command: "ls -la" },
      status: "running",
    });
    expect(line).toBe("Running 1 shell command… · ls -la");
  });

  test("写入 running → `write_file · Wrote N lines to <path>`（计数已知才带）", () => {
    expect(
      formatToolStatusLine({
        toolName: "write_file",
        input: undefined,
        status: "running",
        detail: "Wrote 5 lines to a.ts",
      })
    ).toBe("write_file · Wrote 5 lines to a.ts");
  });
});

describe("summarizeToolCall(cols): 窄终端宽度收口（行账不漂移）", () => {
  test("窄终端：running 人读形态 `Running 1 shell command… · <detail>` 单行放得下", () => {
    const cols = 60;
    // Running assembly = English prefix + ` · ` + detail (no status brackets
    // anymore); with a longer prefix, formatToolStatusLine caps the whole line
    // as a fallback.
    const line = formatToolStatusLine({
      toolName: "bash",
      input: { command: "x".repeat(300) },
      status: "running",
      cols,
    });
    expect(line.startsWith("Running 1 shell command… · ")).toBe(true);
    expect(visualWidth(line)).toBeLessThanOrEqual(cols);
  });

  test("窄终端：失败完成形态单行放得下（断言真实发射字节，非手拼串）", () => {
    const cols = 60;
    // The width invariant must attach to the form formatToolStatusLine
    // actually emits: a hand-built `name · detail · failed` does not exist in
    // the failure branch (the real one is `[失败] name · detail`), and a
    // hand-strung assertion would certify a line production never emits.
    const liveLine = formatToolStatusLine({
      toolName: "bash",
      input: { command: "x".repeat(300) },
      status: "failed",
      cols,
    });
    expect(liveLine.startsWith("[失败] bash")).toBe(true);
    expect(visualWidth(liveLine)).toBeLessThanOrEqual(cols);
  });

  test("CJK 内容按视觉宽度收口（字符数截断会低估列数 → 折行）", () => {
    const cols = 50;
    const line = formatToolStatusLine({
      toolName: "bash",
      input: { command: "测".repeat(200) },
      status: "running",
      cols,
    });
    expect(visualWidth(line)).toBeLessThanOrEqual(cols);
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

  test("write_file create 窗 = 10 行（旧 6 行闸作废），可见正文为首 10 行", () => {
    const content = Array.from({ length: 60 }, (_, i) => `line-${i}`).join(
      "\n"
    );
    const preview = completedToolPreview("write_file", {
      path: "a.ts",
      content,
    });
    expect(preview.kind).toBe("code");
    if (preview.kind !== "code") return;
    // Pin the window as the literal 10 (not derived from the constant -- a
    // derived assertion would stay green even if someone wrote 6).
    expect(WRITE_CREATE_PREVIEW_WINDOW).toBe(10);
    expect(preview.lines).toHaveLength(10);
    expect(preview.lines[0]).toBe("line-0");
    expect(preview.lines[9]).toBe("line-9");
    expect(preview.hiddenLineCount).toBe(50);
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

  test("formatLiveToolEvent spawn_subagent ok → 仅返 detail（plans T7 钉死不再以 `▣ 子代理 · …` 形态作为 live/history 工具卡）", () => {
    const line = formatLiveToolEvent({
      toolName: "spawn_subagent",
      input: { task: "调查渲染层" },
      kind: "ok",
    });
    // Subagent tools no longer render live / history tool cards in the
    // `▣ 子代理` form -- subagent state is expressed by the spawn card's
    // two-line projection + SubagentPanel alone, avoiding dual render.
    // formatToolStatusLine returns only detail for them.
    expect(line).toBe("general-purpose");
    // Pinned: no `▣` glyph, no `✓` status prefix; the task body never enters the transcript
    expect(line.includes("调查渲染层")).toBe(false);
    expect(line.includes("▣")).toBe(false);
    expect(line.includes("✓")).toBe(false);
  });

  test("formatLiveToolEvent spawn_subagent failed → 仅返 detail（无 glyph 前缀）", () => {
    const line = formatLiveToolEvent({
      toolName: "spawn_subagent",
      input: { task: "调查渲染层" },
      kind: "execution_failed",
    });
    expect(line).toBe("general-purpose");
    expect(line.includes("调查渲染层")).toBe(false);
    expect(line.includes("✗")).toBe(false);
  });

  test("formatLiveToolEvent subagent_result ok → 仅返 detail", () => {
    const line = formatLiveToolEvent({
      toolName: "subagent_result",
      input: { task_id: "t-1" },
      kind: "ok",
    });
    expect(line).toBe("Poll t-1");
  });

  test("formatLiveToolEvent 子代理 detail 空（显式 override）→ 空串（无 glyph / `· ` 残留）", () => {
    // Subagent with empty detail (explicit-override path) -> formatToolStatusLine
    // returns detail only, so empty detail -> empty string. The component layer
    // decides whether to hide empty lines.
    const line = formatLiveToolEvent({
      toolName: "subagent_result",
      input: { task_id: "t-1" },
      kind: "ok",
      detail: "",
    });
    expect(line).toBe("");
  });

  test("formatLiveToolEvent bash ok 回归 → `bash · <detail>`（#693 T1 D7 统一形态 + #tui-render-overhaul T3 去完成前缀）", () => {
    const line = formatLiveToolEvent({
      toolName: "bash",
      input: { command: "npm test" },
      kind: "ok",
    });
    expect(line).toBe("bash · npm test");
    // No trailing ` · ok` suffix anymore (an inconsistency this unification removes).
    expect(line.endsWith(" · ok")).toBe(false);
    // Success state carries no [完成] prefix.
    expect(line.includes("[完成]")).toBe(false);
  });

  test("formatLiveToolEvent tool_search detail 空（普通分支）→ `tool_search`（无 `· ` 残留）", () => {
    // tool_search / mystery tools still take the normal branch when detail is empty; the subagent branch is unaffected.
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
    // Literal 10: deriving from the constant would stay green even if someone
    // reverted it to 6 (the old 6-line-gate regression would go unnoticed).
    expect(preview.lines).toHaveLength(10);
    expect(preview.hiddenLineCount).toBe(10);
  });

  test("overwrite/edit diff 全量可见：rows === toolPreviewRows（无 10 行帽）", () => {
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
    // docs/CONTEXT.md `edit diff preview`: the human must see the diff of
    // **this change** -- no 10-line create cap; rows are the full diff, no hidden lines.
    expect(preview.rows).toEqual(all);
    expect(preview.hiddenLineCount).toBe(0);
    expect(preview.rows.length).toBeGreaterThan(10);
  });

  test("超长 overwrite diff 不被 10 行窗截断（与新建预览分道）", () => {
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
    // Negative control: a same-length write_file create walks the 10-line cap
    // and yields a hiddenLineCount; the edit diff has neither -- the two
    // preview paths' caps are independent.
    const create = completedToolPreview("write_file", {
      path: "a.ts",
      content: newContent,
    });
    expect(create.kind).toBe("code");
    if (create.kind !== "code") return;
    expect(create.lines).toHaveLength(10);
    expect(preview.rows.length).toBeGreaterThan(10);
    expect(preview.hiddenLineCount).toBe(0);
  });

  test("bash 等非 write/edit → 空", () => {
    expect(completedToolPreview("bash", { command: "ls" }).kind).toBe("empty");
    expect(completedToolPreview("read_file", { path: "a.ts" }).kind).toBe(
      "empty"
    );
  });
});

// formatLiveToolEvent opts.cols pass-through -- when the detail override is
// absent it goes through summarizeToolCall(name, input, cols) with visual-width
// capping (CJK does not overflow on narrow terminals). Human-readable contract:
// success is `name · detail` (no `[完成]` prefix, no ` · ok` suffix); running
// uses an English process line (no `[运行中]`); only failure keeps `[失败]`.
describe("formatLiveToolEvent(cols) 透传：detail 空时按视觉宽度收口", () => {
  test("窄 cols + CJK 长 command → 单行 ≤ cols（不在中间换行）", () => {
    // Empty detail goes through summarizeToolCall; when cols is given, detail is capped by visual width.
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
    // 80-char truncation + the `bash · ` prefix keeps total length under 100
    // (shorter now that the [完成] prefix is gone).
    expect(line.length).toBeLessThanOrEqual(100);
    expect(line.startsWith("bash · x")).toBe(true);
    expect(line.includes("[完成]")).toBe(false);
  });
});

// ── Result preview (resultToolPreview / stripAnsi / registry) ──────────

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

describe("previewOverflowLabel / writePreviewOverflowLabel: `+N more lines`", () => {
  test("围栏 32 行帽与新建 10 行帽共用同一英文文案（单一 SSOT）", () => {
    expect(previewOverflowLabel(1)).toBe("+1 more lines");
    expect(previewOverflowLabel(8)).toBe("+8 more lines");
    expect(previewOverflowLabel(10)).toBe("+10 more lines");
  });
  test("writePreviewOverflowLabel 是同一函数的语义别名（字节一致）", () => {
    expect(writePreviewOverflowLabel(10)).toBe(previewOverflowLabel(10));
    expect(writePreviewOverflowLabel(0)).toBe("+0 more lines");
  });
  test("中文旧文案 `还有 N 行` 不再出现（人读合同已换英文）", () => {
    expect(previewOverflowLabel(3).includes("还有")).toBe(false);
    for (const n of [0, 1, 7, 32]) {
      expect(previewOverflowLabel(n)).toMatch(/^\+\d+ more lines$/);
    }
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
    // Tail 3 lines: line-9..line-11 (SSOT = docs/CONTEXT.md **result preview**).
    expect(p.lines[0]).toBe("line-9");
    expect(p.lines[2]).toBe("line-11");
    expect(p.hiddenLineCount).toBe(9);
  });

  test("RESULT_PREVIEW_WINDOW 字面 = 3（docs/CONTEXT.md **result preview** SSOT）", () => {
    // Pinned as a literal: a constant-derived assertion would stay green if the
    // constant were changed back to 5, failing as a gate.
    expect(RESULT_PREVIEW_WINDOW).toBe(3);
  });

  test("bash 恰好 3 行 → 全量可见，无溢出标记", () => {
    const stdout = "a\nb\nc";
    const p = resultToolPreview(
      "bash",
      { command: "x" },
      { resultText: JSON.stringify({ code: 0, stdout, stderr: "" }) }
    );
    expect(p.kind).toBe("result");
    if (p.kind !== "result") return;
    expect(p.lines).toEqual(["a", "b", "c"]);
    expect(p.hiddenLineCount).toBe(0);
  });

  test("bash stderr 旁路（live 路径）→ 取尾部 + 溢出", () => {
    const stderr = "err-1\nerr-2\nerr-3\nerr-4\nerr-5\nerr-6\nerr-7";
    const p = resultToolPreview("bash", { command: "x" }, { stderr });
    expect(p.kind).toBe("result");
    if (p.kind !== "result") return;
    // 7 lines, tail window 3 -> err-5..err-7, hidden = 4.
    expect(p.lines).toEqual(["err-5", "err-6", "err-7"]);
    expect(p.hiddenLineCount).toBe(4);
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
    // Color codes are not re-tinted -> passed through verbatim; rows still contain the ESC sequences.
    expect(p.lines[0]).toBe("\x1b[31mERROR\x1b[0m line");
    expect(p.lines[1]).toBe("\x1b[32mOK\x1b[0m line");
  });

  test("bash stdout 截断按 stripped 长度计数（ANSI 不计列）", () => {
    // 8 lines: line-0..line-7 -> tail 3 -> line-5..line-7
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
    expect(p.lines).toHaveLength(3);
    expect(p.lines[0]).toContain("line-5");
    expect(p.lines[2]).toContain("line-7");
    expect(p.hiddenLineCount).toBe(5);
  });

  test("bash ANSI 序列不被切断（行级截断不切字符，仅按行数）", () => {
    // A single line with multiple SGRs: kept whole within the line
    const stdout = "\x1b[31m\x1b[1m\x1b[4mUNDERLINE_RED_BOLD\x1b[0m";
    const p = resultToolPreview(
      "bash",
      { command: "x" },
      { resultText: JSON.stringify({ code: 0, stdout, stderr: "" }) }
    );
    expect(p.kind).toBe("result");
    if (p.kind !== "result") return;
    // Sequence opens with \x1b[31m and closes with \x1b[0m -> the whole span is in the result
    expect(p.lines[0]?.startsWith("\x1b[31m")).toBe(true);
    expect(p.lines[0]?.endsWith("\x1b[0m")).toBe(true);
  });

  test("skill 无预览声明（D6 accent 点名着色）：多行正文不摊成 result preview", () => {
    // skill is the accent class: name-only coloring (`skill <name>`); the skill
    // body is never flattened into a dim result preview. The registry declares
    // no preview for it, so any resultText yields empty.
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

describe("SC5：bash 进度先折再 result preview 尾窗（旧合同「最后 5 条百分行」作废）", () => {
  test("Updating files 1%→100% + 两行实况 → 最后一跳与实况，无中间百分比", () => {
    const ticks = Array.from({ length: 20 }, (_, i) => {
      const pct = (i + 1) * 5;
      return `Updating files: ${pct}% (${pct * 10}/1000)`;
    });
    const stdout = [
      ...ticks,
      "Preparing worktree",
      "HEAD is now at abc1234",
    ].join("\n");
    const p = resultToolPreview(
      "bash",
      { command: "git checkout" },
      { resultText: JSON.stringify({ code: 0, stdout, stderr: "" }) }
    );
    expect(p.kind).toBe("result");
    if (p.kind !== "result") return;
    expect(p.lines).toEqual([
      "Updating files: 100% (1000/1000)",
      "Preparing worktree",
      "HEAD is now at abc1234",
    ]);
    expect(p.hiddenLineCount).toBe(0);
    expect(p.lines.some((l) => l.includes("5%"))).toBe(false);
    expect(p.lines.some((l) => l.includes("80%"))).toBe(false);
  });

  test("\\r 原地覆盖：同一物理行只留最后一跳", () => {
    const stdout =
      "Updating files: 69% (690/1000)\rUpdating files: 80%\rUpdating files: 100% (1000/1000)\nPreparing worktree\n";
    const p = resultToolPreview(
      "bash",
      { command: "git checkout" },
      { resultText: JSON.stringify({ code: 0, stdout, stderr: "" }) }
    );
    expect(p.kind).toBe("result");
    if (p.kind !== "result") return;
    expect(p.lines).toEqual([
      "Updating files: 100% (1000/1000)",
      "Preparing worktree",
    ]);
    expect(p.lines.some((l) => l.includes("69%"))).toBe(false);
  });

  test("negative: `failed at 50%` / `done at 50%` 不是 progress tick，不折", () => {
    const stdout = "failed at 50%\ndone at 50%\n";
    const p = resultToolPreview(
      "bash",
      { command: "build" },
      { resultText: JSON.stringify({ code: 0, stdout, stderr: "" }) }
    );
    expect(p.kind).toBe("result");
    if (p.kind !== "result") return;
    expect(p.lines).toEqual(["failed at 50%", "done at 50%"]);
    expect(p.hiddenLineCount).toBe(0);
  });

  test("overflow: 先折再 takeTailWindow — hidden 按折叠后行数计", () => {
    const ticks = Array.from(
      { length: 20 },
      (_, i) => `Updating files: ${(i + 1) * 5}%`
    );
    const extras = ["L0", "L1", "L2", "L3", "L4", "L5"];
    const stdout = [...ticks, ...extras].join("\n");
    const p = resultToolPreview(
      "bash",
      { command: "git checkout" },
      { resultText: JSON.stringify({ code: 0, stdout, stderr: "" }) }
    );
    expect(p.kind).toBe("result");
    if (p.kind !== "result") return;
    // After folding: 7 rows (last hop + L0..L5) -> tail window 3 = L3..L5, hidden = 4.
    // Under the old contract (tail window before folding) hidden would be 21
    // (20 percentage rows + L0 cut by the window).
    expect(p.lines).toEqual(["L3", "L4", "L5"]);
    expect(p.hiddenLineCount).toBe(4);
    expect(resultPreviewTextLines(p).some((l) => l.includes("5%"))).toBe(false);
  });

  test("空 stdout → empty preview", () => {
    expect(
      resultToolPreview(
        "bash",
        { command: "true" },
        { resultText: JSON.stringify({ code: 0, stdout: "", stderr: "" }) }
      ).kind
    ).toBe("empty");
  });
});

describe("registeredToolDisplayNames: 注册表覆盖 EXPECTED_TOOLSET_30", () => {
  test("注册表至少覆盖 EXPECTED_TOOLSET_30 的所有工具名（声明密度单点）", () => {
    // Adding a new tool kind needs only one new TOOL_DISPLAYS declaration.
    // This test guarantees every tool assembled by buildTuiDeps has a display
    // declaration (summary only, no preview, still counts). After
    // skill_search's deletion the total went 35 -> 34. This gate is orthogonal
    // yet same-source as deps-tools.test.ts's EXPECTED_TUI_TOOLSET: the
    // assembly gate checks "is it present", this gate checks "is a display
    // rule declared", together forming the registry-completeness twin tracks.
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
      // The four worktree-build tools + list-worktrees enter the display
      // registry. The TUI assembly side still assembles conditionally by host
      // seam (deps-tools EXPECTED_TUI_TOOLSET stripping is untouched); display
      // registry completeness is decoupled from conditional assembly -- the
      // coverage gate grows from 30 to 35 tools, and the invariant (every
      // registry entry has a display declaration) is equal or stronger than
      // the original assertion.
      "create-worktree",
      "enter-worktree",
      "exit-worktree",
      "remove-worktree",
      "list-worktrees",
    ];
    const names = new Set(registeredToolDisplayNames());
    for (const name of EXPECTED_TOOLSET_30) {
      expect(names.has(name)).toBe(true);
    }
  });
});

describe("settledClass: 落定态三分类（spec D2/D8）", () => {
  // A declaration without settledClass is illegal. ToolDisplay pins the field
  // required (compile-time gate); this test adds a runtime backstop: every
  // registry entry must carry a legal class value.
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
      // Values other than "subagent" must come from the three-way ground
      // truth; "subagent" is allowed only on the two names covered by the
      // core's isSubagentSettledName (the cross-core gate lives in tool-settled.test).
      if (cls === "subagent") {
        expect(["spawn_subagent", "subagent_result"]).toContain(name);
      }
    }
  });

  test("D8 分类表 sentinel：keep / retract / accent 各类代表名对号", () => {
    // keep: write paths and session actions; retract: query / read / unregistered
    // fallback; accent: skill and the four worktree-build tools.
    expect(settledClassOfDisplay("bash")).toBe("keep");
    expect(settledClassOfDisplay("write_file")).toBe("keep");
    expect(settledClassOfDisplay("todo_write")).toBe("keep");
    expect(settledClassOfDisplay("read_file")).toBe("retract");
    expect(settledClassOfDisplay("grep")).toBe("retract");
    expect(settledClassOfDisplay("list-worktrees")).toBe("retract");
    expect(settledClassOfDisplay("skill")).toBe("accent");
    for (const name of [
      "create-worktree",
      "enter-worktree",
      "exit-worktree",
      "remove-worktree",
    ]) {
      expect(settledClassOfDisplay(name)).toBe("accent");
    }
  });

  test('子代理两件显式声明 "subagent" class（D8 三类之外，无 ! 断言兜底）', () => {
    // spawn_subagent / subagent_result do not join the keep/retract/accent
    // three-way split; the core special-cases them as keep-title-only before
    // class dispatch. The registry declaration must be honest -- resolving to
    // retract "by accident" via undefined + fallback is rejected here.
    expect(settledClassOfDisplay("spawn_subagent")).toBe("subagent");
    expect(settledClassOfDisplay("subagent_result")).toBe("subagent");
  });

  test("建树四件 + list-worktrees 进显示注册表（spec D2 建树四件必须入表）", () => {
    const names = new Set(registeredToolDisplayNames());
    for (const name of [
      "create-worktree",
      "enter-worktree",
      "exit-worktree",
      "remove-worktree",
      "list-worktrees",
    ]) {
      expect(names.has(name)).toBe(true);
    }
  });
});
