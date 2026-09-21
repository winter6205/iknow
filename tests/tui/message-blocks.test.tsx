/** @jsxImportSource @opentui/react */
/**
 * tests/tui/message-blocks.test.tsx — MessageBlocks rendering acceptance.
 *
 * Coverage (bun:test):
 *  - user message → ❯ accent prefix, no Markdown rendering;
 *  - system message → separate branch: `[已打断]` ("interrupted") prefix +
 *    fixed text "Interrupted by user.", never parsed as Markdown;
 *  - assistant text → Markdown rendering (headings/code/lists excerpts);
 *  - thinking collapsed (default): no summary without seconds; with seconds →
 *    `Thought for Ns` (single line);
 *  - thinking expanded: full thinking text + redacted placeholder;
 *  - tool_use summary line + statusMap-driven ok/failed/running coloring
 *    (running uses the English process line, no `[运行中]` bracket);
 *  - content boundary: empty-text user message returns null, renders nothing;
 *  - spacing + background: message root marginTop={1} → blank separator lines
 *    between messages; background is render metadata (captureCharFrame carries
 *    no bg color), so assert structurally = bg box wrap renders without
 *    crashing + marginTop blank line present.
 *
 * Render form is the OpenTUI element tree (ink Box/Text primitives banned).
 * Assertions on captureCharFrame text.
 */
import { describe, expect, test } from "bun:test";
import type { AnthropicNativeMessage } from "../../src/harness/model-adapter/types.js";
import { testRender } from "@opentui/react/test-utils";
import { RGBA } from "@opentui/core";
import { MessageBlocks } from "../../src/tui/message-blocks.js";
import {
  IKNOW_GRAPH_MODE_OFF_NOTIFICATION,
  IKNOW_GRAPH_MODE_ON_NOTIFICATION,
  IKNOW_GRAPH_MODE_PRESENCE_NOTIFICATION,
} from "../../src/harness/graph/notification.js";
import { tuiPalette } from "../../src/tui/theme.js";

const COLS = 60;

function emptyStatusMap(): ReadonlyMap<string, boolean> {
  return new Map();
}

async function renderBlocks(
  message: AnthropicNativeMessage,
  opts?: {
    readonly statusMap?: ReadonlyMap<string, boolean>;
    readonly thinkingExpanded?: boolean;
  }
): Promise<Awaited<ReturnType<typeof testRender>>> {
  const setup = await testRender(
    <MessageBlocks
      message={message}
      cols={COLS}
      statusMap={opts?.statusMap ?? emptyStatusMap()}
      thinkingExpanded={opts?.thinkingExpanded ?? false}
    />,
    { width: COLS, height: 40, exitOnCtrlC: false }
  );
  await setup.waitForVisualIdle();
  return setup;
}

test("user 消息：渲染 ❯ 文本前缀（accent），原文不进 markdown 解析", async () => {
  const msg: AnthropicNativeMessage = {
    role: "user",
    content: [{ type: "text", text: "你好 iknow **不要加粗**" }],
  };
  const setup = await renderBlocks(msg);
  const frame = setup.captureCharFrame();
  expect(frame).toContain("❯ 你好 iknow");
  // user text skips markdown bold parsing → ** markers stay literal (archived verbatim).
  expect(frame).toContain("**不要加粗**");
  await setup.renderer.destroy();
});

test("user 消息：❯ 回显不走盘古之白（用户输入字面保留）", async () => {
  const msg: AnthropicNativeMessage = {
    role: "user",
    content: [{ type: "text", text: "美股4月行情如何" }],
  };
  const setup = await renderBlocks(msg);
  const frame = setup.captureCharFrame();
  expect(frame).toContain("❯ 美股4月行情如何");
  expect(frame.includes("美股 4 月")).toBe(false);
  await setup.renderer.destroy();
});

test("user 空文本 + 纯 tool_result：返回 null 不渲染任何节点", async () => {
  const msg: AnthropicNativeMessage = {
    role: "user",
    content: [
      {
        type: "tool_result",
        tool_use_id: "tu-1",
        content: "ok",
        is_error: false,
      },
    ],
  };
  const setup = await renderBlocks(msg);
  const frame = setup.captureCharFrame();
  // empty user content: frame stays blank — no ❯ marker, no tool_result field names.
  expect(frame.includes("❯")).toBe(false);
  expect(frame.includes("tool_result")).toBe(false);
  await setup.renderer.destroy();
});

test("host-drain 子代理结果：不渲染为 ❯ 用户气泡", async () => {
  const msg: AnthropicNativeMessage = {
    role: "user",
    content: [
      {
        type: "text",
        text: '## Sub-agent fdc006c7 result: {"kind":"abort","reason":"问候"}\n\n{"kind":"abort","reason":"问候"}',
      },
    ],
  };
  const setup = await renderBlocks(msg);
  const frame = setup.captureCharFrame();
  expect(frame.includes("❯")).toBe(false);
  expect(frame.includes("kind")).toBe(false);
  await setup.renderer.destroy();
});

test("verify 失败信封：不渲染为 ❯ 用户气泡", async () => {
  const msg: AnthropicNativeMessage = {
    role: "user",
    content: [
      {
        type: "text",
        text: "[VALIDATION FAILED] attempt=1/12 verdict=true-failure source=classifier\ntask: hi",
      },
    ],
  };
  const setup = await renderBlocks(msg);
  const frame = setup.captureCharFrame();
  expect(frame.includes("❯")).toBe(false);
  expect(frame.includes("VALIDATION FAILED")).toBe(false);
  await setup.renderer.destroy();
});

test("verify 补跑信封：不渲染为 ❯ 用户气泡", async () => {
  const msg: AnthropicNativeMessage = {
    role: "user",
    content: [
      {
        type: "text",
        text: "[VERIFY: rerun needed] attempt=1/12\nRun this command:\npytest -q",
      },
    ],
  };
  const setup = await renderBlocks(msg);
  const frame = setup.captureCharFrame();
  expect(frame.includes("❯")).toBe(false);
  expect(frame.includes("VERIFY: rerun needed")).toBe(false);
  await setup.renderer.destroy();
});

test("agent_status 栏注入：不渲染为 ❯ 用户气泡", async () => {
  const msg: AnthropicNativeMessage = {
    role: "user",
    content: [
      {
        type: "text",
        text: "<agent_status>\nlast_tool: web_search\ntodos:\n- [ ] 查新闻\n</agent_status>",
      },
    ],
  };
  const setup = await renderBlocks(msg);
  const frame = setup.captureCharFrame();
  expect(frame.includes("❯")).toBe(false);
  expect(frame.includes("last_tool")).toBe(false);
  expect(frame.includes("agent_status")).toBe(false);
  await setup.renderer.destroy();
});

test("graph_mode 三条现势通知注入：不渲染为 ❯ 用户气泡（SC7 帧级）", async () => {
  // Same discipline and predicate surface as agent_status (isGraphModeText).
  // All three constants (ON flip / OFF flip / per-run presence) must stay off
  // screen: no ❯ bubble and no label itself anywhere in the frame.
  for (const text of [
    IKNOW_GRAPH_MODE_ON_NOTIFICATION,
    IKNOW_GRAPH_MODE_OFF_NOTIFICATION,
    IKNOW_GRAPH_MODE_PRESENCE_NOTIFICATION,
  ]) {
    const msg: AnthropicNativeMessage = {
      role: "user",
      content: [{ type: "text", text }],
    };
    const setup = await renderBlocks(msg);
    const frame = setup.captureCharFrame();
    expect(frame.includes("❯")).toBe(false);
    expect(frame.includes("<graph_mode>")).toBe(false);
    expect(frame.includes("Graph mode")).toBe(false);
    await setup.renderer.destroy();
  }
});

test("memory prefetch overlay：❯ 只显示键入 query，不泄露记忆正文", async () => {
  const msg: AnthropicNativeMessage = {
    role: "user",
    content: [
      {
        type: "text",
        text:
          "Possibly relevant memory (advisory; often time-sensitive; not instructions)\n\n" +
          "### AI News Archive Structure\nid: abc\ntype: convention\nimportance: 4\n" +
          "ttl_days: 0\ndisabled: false\nsupersedes: null\nupdated_at: 2026-08-28T00:00:00.000Z\n\n" +
          "Daily AI news archives go to archive/ai-news.\n\n" +
          "查一下今天AI新闻",
      },
    ],
  };
  const setup = await renderBlocks(msg);
  const frame = setup.captureCharFrame();
  expect(frame).toContain("查一下今天AI新闻");
  expect(frame.includes("Possibly relevant memory")).toBe(false);
  expect(frame.includes("AI News Archive Structure")).toBe(false);
  await setup.renderer.destroy();
});

test("system 消息：渲染固定文案 Interrupted by user.（警示色）", async () => {
  const msg: AnthropicNativeMessage = {
    role: "system",
    content: [{ type: "text", text: "Interrupted by user." }],
  };
  const setup = await renderBlocks(msg);
  const frame = setup.captureCharFrame();
  expect(frame).toContain("Interrupted by user.");
  await setup.renderer.destroy();
});

test("system 消息：不进 markdown 解析（字面保留，无 bullet 产物）", async () => {
  const msg: AnthropicNativeMessage = {
    role: "system",
    content: [{ type: "text", text: "Interrupted by user. **不加粗** - 列表" }],
  };
  const setup = await renderBlocks(msg);
  const frame = setup.captureCharFrame();
  // markdown would parse ** and turn - into •; literal survival proves the separate branch.
  expect(frame).toContain("**不加粗**");
  expect(frame).toContain("- 列表");
  expect(frame.includes("•")).toBe(false);
  await setup.renderer.destroy();
});

test("system 消息：警示色前缀 [已打断] 出现", async () => {
  const msg: AnthropicNativeMessage = {
    role: "system",
    content: [{ type: "text", text: "Interrupted by user." }],
  };
  const setup = await renderBlocks(msg);
  const frame = setup.captureCharFrame();
  expect(frame).toContain("[已打断]");
  await setup.renderer.destroy();
});

test("system 空 content：fallback 固定文案 Interrupted by user.", async () => {
  const msg: AnthropicNativeMessage = {
    role: "system",
    content: [],
  };
  const setup = await renderBlocks(msg);
  const frame = setup.captureCharFrame();
  expect(frame).toContain("Interrupted by user.");
  await setup.renderer.destroy();
});

test("assistant 文本：Markdown 渲染（heading / code / list 节选）", async () => {
  const md = [
    "# 标题一",
    "",
    "段落文本含 `codespan` 与 **加粗**。",
    "",
    "- 列表 A",
    "- 列表 B",
  ].join("\n");
  const msg: AnthropicNativeMessage = {
    role: "assistant",
    content: [{ type: "text", text: md }],
  };
  const setup = await renderBlocks(msg);
  const frame = setup.captureCharFrame();
  expect(frame).toContain("标题一");
  expect(frame).toContain("codespan");
  expect(frame).toContain("加粗");
  expect(frame).toContain("列表 A");
  expect(frame).toContain("•");
  await setup.renderer.destroy();
});

test("thinking 折叠态：无秒数不画 [思考]，正文仍在，thinking 明文隐藏", async () => {
  const msg: AnthropicNativeMessage = {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "链上推理明细…", signature: "sig-1" },
      { type: "text", text: "正式回答" },
    ],
  };
  const setup = await renderBlocks(msg);
  const frame = setup.captureCharFrame();
  expect(frame.includes("[思考]")).toBe(false);
  expect(frame.includes("思考了")).toBe(false);
  expect(frame.includes("链上推理明细")).toBe(false);
  expect(frame).toContain("正式回答");
  await setup.renderer.destroy();
});

test("thinking 展开态：渲染 thinking 全文 + redacted 占位", async () => {
  const msg: AnthropicNativeMessage = {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "展开的思维链", signature: "sig-1" },
      { type: "redacted_thinking", data: "encrypted-blob" },
      { type: "text", text: "正文短句" },
    ],
  };
  const setup = await renderBlocks(msg, { thinkingExpanded: true });
  const frame = setup.captureCharFrame();
  // Without seconds no `[思考]` summary; expand renders body + redacted placeholder only.
  expect(frame.includes("[思考]")).toBe(false);
  expect(frame).toContain("展开的思维链");
  // redacted placeholder (REDACTED_PLACEHOLDER = "[已加密思考]").
  expect(frame).toContain("[已加密思考]");
  expect(frame).toContain("正文短句");
  await setup.renderer.destroy();
});

test("tool_use 完成态折叠摘要：bash 完成 → bash · npm test（无 [完成] 前缀，无 ran 后缀）", async () => {
  const msg: AnthropicNativeMessage = {
    role: "assistant",
    content: [
      {
        type: "tool_use",
        id: "tu-bash-1",
        name: "bash",
        input: { command: "npm test" },
      },
    ],
  };
  const setup = await renderBlocks(msg, {
    statusMap: new Map([["tu-bash-1", false]]),
  });
  const frame = setup.captureCharFrame();
  // Success state drops the `[完成]` prefix; state is carried by color.
  expect(frame).toContain("bash · npm test");
  expect(frame.includes("[完成]")).toBe(false);
  // Tool lines no longer append a ran-N suffix (counts aggregate in ThinkingSummary).
  expect(frame.includes("ran")).toBe(false);
  await setup.renderer.destroy();
});

test("tool_use 完成态折叠摘要：同消息多 bash → 各摘要行均无 ran 后缀", async () => {
  const msg: AnthropicNativeMessage = {
    role: "assistant",
    content: [
      {
        type: "tool_use",
        id: "tu-b1",
        name: "bash",
        input: { command: "npm test" },
      },
      { type: "text", text: "先看第一步" },
      {
        type: "tool_use",
        id: "tu-b2",
        name: "bash",
        input: { command: "git status" },
      },
    ],
  };
  const setup = await renderBlocks(msg, {
    statusMap: new Map([
      ["tu-b1", false],
      ["tu-b2", false],
    ]),
  });
  const frame = setup.captureCharFrame();
  // Two bash blocks in one message: each summary line is `bash · detail` only, no `[完成]` prefix.
  expect(frame).toContain("bash · npm test");
  expect(frame).toContain("bash · git status");
  expect(frame.includes("ran")).toBe(false);
  expect(frame.includes("[完成]")).toBe(false);
  await setup.renderer.destroy();
});

test("tool_use 非 bash 工具（write_file）：无 ran 计数，无 [完成] 前缀", async () => {
  const msg: AnthropicNativeMessage = {
    role: "assistant",
    content: [
      {
        type: "tool_use",
        id: "tu-wf",
        name: "write_file",
        input: { path: "a.ts", content: "x" },
      },
    ],
  };
  const setup = await renderBlocks(msg, {
    statusMap: new Map([["tu-wf", false]]),
  });
  const frame = setup.captureCharFrame();
  expect(frame).toContain("write_file · Wrote a.ts (1 lines)");
  expect(frame.includes("ran")).toBe(false);
  // success state has no `[完成]` prefix.
  expect(frame.includes("[完成]")).toBe(false);
  await setup.renderer.destroy();
});

test("thinking 折叠态 + thinkingSeconds：渲染 `Thought for Ns` 替换 [思考]", async () => {
  const msg: AnthropicNativeMessage = {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "链上推理明细…", signature: "sig-1" },
      { type: "text", text: "正式回答" },
    ],
  };
  const setup = await testRender(
    <MessageBlocks
      message={msg}
      cols={COLS}
      statusMap={emptyStatusMap()}
      thinkingExpanded={false}
      thinkingSeconds={3}
    />,
    { width: COLS, height: 40, exitOnCtrlC: false }
  );
  await setup.waitForVisualIdle();
  const frame = setup.captureCharFrame();
  // CONTEXT `unit fold`: collapsed line = `Thought for 3s`
  // (English, replaces the `[思考]` marker).
  expect(frame).toContain("Thought for 3s");
  expect(frame.includes("[思考]")).toBe(false);
  // the text block still renders.
  expect(frame).toContain("正式回答");
  await setup.renderer.destroy();
});

test("thinking 折叠态 + thinkingSeconds=0：不画摘要（不换 [思考]、不造 0 秒）", async () => {
  const msg: AnthropicNativeMessage = {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "链上推理明细…", signature: "sig-1" },
      { type: "text", text: "正式回答" },
    ],
  };
  const setup = await testRender(
    <MessageBlocks
      message={msg}
      cols={COLS}
      statusMap={emptyStatusMap()}
      thinkingExpanded={false}
      thinkingSeconds={0}
    />,
    { width: COLS, height: 40, exitOnCtrlC: false }
  );
  await setup.waitForVisualIdle();
  const frame = setup.captureCharFrame();
  expect(frame.includes("[思考]")).toBe(false);
  expect(frame.includes("思考了")).toBe(false);
  expect(frame).toContain("正式回答");
  await setup.renderer.destroy();
});

test("thinking 折叠态 + bash tool_use：无 thinkingSeconds → 无思考摘要（无 ran 后缀）", async () => {
  const msg: AnthropicNativeMessage = {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "链上推理…", signature: "sig-1" },
      {
        type: "tool_use",
        id: "tu-bash-1",
        name: "bash",
        input: { command: "ls", description: "list" },
      },
      { type: "text", text: "跑完了" },
    ],
  };
  const setup = await testRender(
    <MessageBlocks
      message={msg}
      cols={COLS}
      statusMap={emptyStatusMap()}
      thinkingExpanded={false}
    />,
    { width: COLS, height: 40, exitOnCtrlC: false }
  );
  await setup.waitForVisualIdle();
  const frame = setup.captureCharFrame();
  expect(frame.includes("[思考]")).toBe(false);
  expect(frame.includes("ran")).toBe(false);
  await setup.renderer.destroy();
});

test("thinking 折叠态 + thinkingSeconds + bash：折叠摘要不另起 ran 第二行", async () => {
  const msg: AnthropicNativeMessage = {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "链上推理…", signature: "sig-1" },
      {
        type: "tool_use",
        id: "tu-bash-2",
        name: "bash",
        input: { command: "ls", description: "list" },
      },
      { type: "text", text: "跑完了" },
    ],
  };
  const setup = await testRender(
    <MessageBlocks
      message={msg}
      cols={COLS}
      statusMap={emptyStatusMap()}
      thinkingExpanded={false}
      thinkingSeconds={3}
    />,
    { width: COLS, height: 40, exitOnCtrlC: false }
  );
  await setup.waitForVisualIdle();
  const frame = setup.captureCharFrame();
  // Invariant (CONTEXT `unit fold`): the collapsed duration line is only
  // `Thought for 3s`; the old `ran N command(s)` second line is retired —
  // counts live solely in turn-level `name × N` folds, not message summaries.
  expect(frame).toContain("Thought for 3s");
  expect(frame.includes("ran 1 command")).toBe(false);
  expect(frame.includes("思考了")).toBe(false);
  expect(frame.includes("[思考]")).toBe(false);
  await setup.renderer.destroy();
});

test("tool_use 状态染色：statusMap 缺位 = 过程行（无 [运行中]），failed = [失败]，成功 = 无状态前缀", async () => {
  // Success drops the `[完成]` prefix (color/glyph carries state); running drops
  // `[运行中]` too — the process line is English `name · detail`, state shown by
  // color only. Failure keeps the explicit `[失败]` prefix.
  const okStatus = new Map<string, boolean>([["tu-ok", false]]);
  const failedStatus = new Map<string, boolean>([["tu-fail", true]]);
  const cases: ReadonlyArray<{
    readonly name: string;
    readonly id: string;
    readonly map: ReadonlyMap<string, boolean>;
    readonly mark: string;
    /** Extra byte check: success state carries no `[完成]`. */
    readonly expectNoCompleteMark?: boolean;
  }> = [
    {
      name: "写入 ok",
      id: "tu-ok",
      map: okStatus,
      mark: "write_file ·",
      expectNoCompleteMark: true,
    },
    { name: "失败染色", id: "tu-fail", map: failedStatus, mark: "[失败]" },
    {
      name: "未配对",
      id: "tu-runn",
      map: emptyStatusMap(),
      mark: "write_file · Wrote a.ts",
    },
  ];
  for (const c of cases) {
    const msg: AnthropicNativeMessage = {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: c.id,
          name: "write_file",
          input: { path: "a.ts", content: "x" },
        },
        { type: "text", text: c.name },
      ],
    };
    const setup = await renderBlocks(msg, { statusMap: c.map });
    const frame = setup.captureCharFrame();
    expect(frame).toContain(c.mark);
    if (c.expectNoCompleteMark === true) {
      // success state has no `[完成]` prefix (color expresses it).
      expect(frame.includes("[完成]")).toBe(false);
    }
    // none of the three branches (ok / failed / unpaired) shows `[运行中]`.
    expect(frame.includes("[运行中]")).toBe(false);
    await setup.renderer.destroy();
  }
});

test("tool_use 摘要行：cols 收口单行不折（narrow cols）", async () => {
  const setupNarrow = await testRender(
    <MessageBlocks
      message={{
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tu-1",
            name: "write_file",
            input: {
              path: "very-long-path/very-very-very-long-name.tsx",
              content: "hello",
            },
          },
        ],
      }}
      cols={20}
      statusMap={new Map()}
    />,
    { width: 20, height: 10, exitOnCtrlC: false }
  );
  await setupNarrow.waitForVisualIdle();
  const frame = setupNarrow.captureCharFrame();
  // running process line = `write_file · <detail>` (English, no state bracket),
  // still clamped to one line at cols=20 (wrapMode none → visual clip, no wrap).
  const lines = frame.split("\n").filter((l) => l.includes("write_file"));
  expect(lines.length).toBeGreaterThan(0);
  for (const l of lines) {
    expect(l.length).toBeLessThanOrEqual(20);
  }
  expect(frame.includes("[运行中]")).toBe(false);
  await setupNarrow.renderer.destroy();
});

test("tool_use preview 截断窗：新文件代码首窗可见，溢出标记，无全文", async () => {
  const content = Array.from(
    { length: 20 },
    (_, i) => `line-${String(i).padStart(2, "0")}`
  ).join("\n");
  const setup = await testRender(
    <MessageBlocks
      message={{
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tu-preview",
            name: "write_file",
            input: { path: "a.ts", content },
          },
        ],
      }}
      cols={40}
      statusMap={new Map([["tu-preview", false]])}
    />,
    { width: 40, height: 20, exitOnCtrlC: false }
  );
  await setup.waitForVisualIdle();
  const frame = setup.captureCharFrame();
  // success state has no `[完成]` prefix → assert coexistence of the
  // "write_file" title and the "line-00" preview inside the line instead.
  expect(frame).toContain("write_file");
  expect(frame).toContain("line-00");
  expect(frame).not.toContain("line-19");
  // CONTEXT `write create preview`: overflow text is English `+N more lines`
  // (20 body lines − 10-line window = 10 overflow).
  expect(frame).toContain("+10 more lines");
  expect(frame).not.toContain("还有");
  expect(frame).not.toContain("+line-00");
  expect(frame.includes("[完成]")).toBe(false);
  await setup.renderer.destroy();
});

test("tool_use preview 截断窗：edit_file 显示截断 diff", async () => {
  const setup = await testRender(
    <MessageBlocks
      message={{
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tu-edit",
            name: "edit_file",
            input: { path: "a.ts", old_str: "old", new_str: "new" },
          },
        ],
      }}
      cols={80}
      statusMap={new Map([["tu-edit", false]])}
    />,
    { width: 80, height: 20, exitOnCtrlC: false }
  );
  await setup.waitForVisualIdle();
  const frame = setup.captureCharFrame();
  // success state has no `[完成]` prefix → assert on content instead.
  expect(frame).toContain("edit_file");
  expect(frame).toContain("-old");
  expect(frame).toContain("+new");
  expect(frame.includes("[完成]")).toBe(false);
  await setup.renderer.destroy();
});

// -- message spacing + background ----------------------------------------
// Background is render metadata (captureCharFrame carries no bg color), so the
// assertion is structural: bg box wrap renders without crashing + text visible.
//
// Spacing ownership: the 1-line rhythm between messages comes from the
// MessageBlocks root `marginTop` prop (ChatView passes
// `visibleIndex===0?0:1`). It used to live on a ChatView wrapper `<box
// marginTop>`, but messages rendering null after collapse still left the
// wrapper margin behind, chaining into phantom gaps — margin now lives and
// dies with the MessageBlocks root. Default is no margin: a single-message
// render starts at the first line (SSOT boundary unchanged).

test("T7 多消息交替：marginTop prop={i===0?0:1} 提供 1 行节奏（首条无 margin）", async () => {
  const messages: AnthropicNativeMessage[] = [
    { role: "user", content: [{ type: "text", text: "第一条提问" }] },
    {
      role: "assistant",
      content: [{ type: "text", text: "第一个回答" }],
    },
    { role: "user", content: [{ type: "text", text: "第二条提问" }] },
  ];
  // mirror ChatView wiring: each message gets marginTop={i===0?0:1}.
  const setup = await testRender(
    <>
      {messages.map((message, i) => (
        <MessageBlocks
          key={i}
          message={message}
          cols={COLS}
          statusMap={emptyStatusMap()}
          marginTop={i === 0 ? 0 : 1}
        />
      ))}
    </>,
    { width: COLS, height: 40, exitOnCtrlC: false }
  );
  await setup.waitForVisualIdle();
  const frame = setup.captureCharFrame();
  const lines = frame.split("\n");
  // first user text must land on line 0 (no top margin).
  const firstTextLine = lines.findIndex((l) => l.includes("第一条提问"));
  expect(firstTextLine).toBe(0);
  // exactly 1 blank line between the first and second message.
  const secondTextLine = lines.findIndex((l) => l.includes("第一个回答"));
  expect(secondTextLine).toBeGreaterThan(firstTextLine + 1);
  // same 1 blank line between second and third.
  const thirdTextLine = lines.findIndex((l) => l.includes("第二条提问"));
  expect(thirdTextLine).toBeGreaterThan(secondTextLine + 1);
  await setup.renderer.destroy();
});

test("T7 user 消息：底色 box 包裹后渲染不崩，❯ 前缀保留（结构层断言）", async () => {
  const msg: AnthropicNativeMessage = {
    role: "user",
    content: [{ type: "text", text: "带底色的提问" }],
  };
  const setup = await renderBlocks(msg);
  const frame = setup.captureCharFrame();
  expect(frame).toContain("❯ 带底色的提问");
  // single MessageBlocks render: default marginTop → text starts at frame[0];
  // the bg box hugs content (paddingY=0); inter-message spacing comes from
  // ChatView's marginTop.
  const lines = frame.split("\n");
  const textLine = lines.findIndex((l) => l.includes("带底色的提问"));
  expect(textLine).toBe(0);
  await setup.renderer.destroy();
});

test("T7 assistant 消息：底色 box 包裹后渲染不崩，markdown 产物保留（结构层断言）", async () => {
  const md = ["# T7 标题", "", "正文段落", "", "- 列表项"].join("\n");
  const msg: AnthropicNativeMessage = {
    role: "assistant",
    content: [{ type: "text", text: md }],
  };
  const setup = await renderBlocks(msg);
  const frame = setup.captureCharFrame();
  expect(frame).toContain("T7 标题");
  expect(frame).toContain("正文段落");
  expect(frame).toContain("列表项");
  await setup.renderer.destroy();
});

test("history write_file 未配对（空 statusMap）：仅过程行摘要，不含 content 正文", async () => {
  const bodyLine = "UNIQUE_WRITE_BODY_LINE_alpha";
  const msg: AnthropicNativeMessage = {
    role: "assistant",
    content: [
      {
        type: "tool_use",
        id: "tu-unpaired-write",
        name: "write_file",
        input: { path: "a.ts", content: `${bodyLine}\nsecond-body-line` },
      },
    ],
  };
  const setup = await renderBlocks(msg, { statusMap: emptyStatusMap() });
  const frame = setup.captureCharFrame();
  // the process line is the English live tool line, no `[运行中]` bracket; the
  // line count appears only once content is complete (input here is the
  // authoritative full input → 2 lines).
  expect(frame).toContain("write_file · Wrote a.ts (2 lines)");
  expect(frame.includes("[运行中]")).toBe(false);
  expect(frame).not.toContain(bodyLine);
  expect(frame).not.toContain("second-body-line");
  await setup.renderer.destroy();
});

test("纯 retract 工具落定消息：全部收起 → 渲染为 null（无幻影空壳）", async () => {
  // a pure read_file message settles with title and preview both false
  // (retract) → MessageBlocks returns null, leaving no empty shell box
  // (shells would strand phantom spacing).
  const msg: AnthropicNativeMessage = {
    role: "assistant",
    content: [
      {
        type: "tool_use",
        id: "tu-rd-null",
        name: "read_file",
        input: { path: "a.ts" },
      },
    ],
  };
  const setup = await renderBlocks(msg, {
    statusMap: new Map([["tu-rd-null", false]]),
  });
  const frame = setup.captureCharFrame();
  // no tool trace may appear in the frame (the null contract projects to a
  // blank frame; captureCharFrame always returns a full blank canvas, so the
  // test is "no content characters").
  expect(frame.includes("read_file")).toBe(false);
  expect(frame.includes("[完成]")).toBe(false);
  expect(frame.includes("[失败]")).toBe(false);
  expect(frame.trim().length).toBe(0);
  // structural layer: no non-empty spans — blank frame + zero content spans pin the null contract together.
  const { lines } = setup.captureSpans();
  const contentSpans = lines.flatMap((line) =>
    line.spans.filter((span) => span.text.trim().length > 0)
  );
  expect(contentSpans).toHaveLength(0);
  await setup.renderer.destroy();
});

test("T7 纯 tool_use 消息：底色 box 包裹后渲染不崩，摘要行可见", async () => {
  const msg: AnthropicNativeMessage = {
    role: "assistant",
    content: [
      {
        type: "tool_use",
        id: "tu-t7",
        name: "write_file",
        input: { path: "a.ts", content: "x" },
      },
    ],
  };
  const setup = await renderBlocks(msg);
  const frame = setup.captureCharFrame();
  expect(frame).toContain("write_file · Wrote a.ts (1 lines)");
  expect(frame.includes("[运行中]")).toBe(false);
  await setup.renderer.destroy();
});

// -- sub-agent tool display ------------------------------------------------
// Invariant: sub-agent tools no longer render a `▣ 子代理` live/history tool
// card (dual render removed) — status comes from the spawn card's two-line
// projection + SubagentPanel; the tool card shows detail only.

test("spawn_subagent 运行中 → 仅 detail（无 `▣` glyph，无 `[运行中] spawn_subagent` 残留）", async () => {
  const msg: AnthropicNativeMessage = {
    role: "assistant",
    content: [
      {
        type: "tool_use",
        id: "tu-spawn",
        name: "spawn_subagent",
        input: { task: "调查渲染层" },
      },
    ],
  };
  const setup = await renderBlocks(msg);
  const frame = setup.captureCharFrame();
  expect(frame).toContain("general-purpose");
  expect(frame).not.toContain("调查渲染层");
  expect(frame.includes("▣")).toBe(false);
  expect(frame).not.toContain("[运行中] spawn_subagent");
  await setup.renderer.destroy();
});

test("spawn_subagent 完成 ok → 仅 detail（无 `✓` glyph、无 `[完成]` 前缀）", async () => {
  const msg: AnthropicNativeMessage = {
    role: "assistant",
    content: [
      {
        type: "tool_use",
        id: "tu-spawn",
        name: "spawn_subagent",
        input: { task: "调查渲染层" },
      },
    ],
  };
  const setup = await renderBlocks(msg, {
    statusMap: new Map([["tu-spawn", false]]),
  });
  const frame = setup.captureCharFrame();
  expect(frame).toContain("general-purpose");
  expect(frame).not.toContain("调查渲染层");
  expect(frame.includes("✓")).toBe(false);
  expect(frame).not.toContain("[完成]");
  await setup.renderer.destroy();
});

test("spawn_subagent 完成 failed → 仅 detail（无 `✗` glyph、无 `[失败]` 前缀）", async () => {
  const msg: AnthropicNativeMessage = {
    role: "assistant",
    content: [
      {
        type: "tool_use",
        id: "tu-spawn",
        name: "spawn_subagent",
        input: { task: "调查渲染层" },
      },
    ],
  };
  const setup = await renderBlocks(msg, {
    statusMap: new Map([["tu-spawn", true]]),
  });
  const frame = setup.captureCharFrame();
  expect(frame).toContain("general-purpose");
  expect(frame).not.toContain("调查渲染层");
  expect(frame.includes("✗")).toBe(false);
  expect(frame).not.toContain("[失败]");
  await setup.renderer.destroy();
});

test("subagent_result 完成 ok → 仅 detail（无 `✓` glyph）", async () => {
  const msg: AnthropicNativeMessage = {
    role: "assistant",
    content: [
      {
        type: "tool_use",
        id: "tu-poll",
        name: "subagent_result",
        input: { task_id: "t-1" },
      },
    ],
  };
  const setup = await renderBlocks(msg, {
    statusMap: new Map([["tu-poll", false]]),
  });
  const frame = setup.captureCharFrame();
  expect(frame).toContain("Poll t-1");
  expect(frame.includes("✓")).toBe(false);
  await setup.renderer.destroy();
});

test("bash 回归：过程行 `Running 1 shell command…` + 命令可见，完成态字节不变", async () => {
  const running: AnthropicNativeMessage = {
    role: "assistant",
    content: [
      {
        type: "tool_use",
        id: "tu-bash-2",
        name: "bash",
        input: { command: "ls" },
      },
    ],
  };
  const setup = await renderBlocks(running);
  const frame = setup.captureCharFrame();
  // CONTEXT `live tool line`: running bash process line carries the
  // `Running 1 shell command…` prefix with the command visible, no state bracket.
  expect(frame).toContain("Running 1 shell command… · ls");
  expect(frame.includes("[运行中]")).toBe(false);
  await setup.renderer.destroy();

  const done: AnthropicNativeMessage = {
    role: "assistant",
    content: [
      {
        type: "tool_use",
        id: "tu-bash-3",
        name: "bash",
        input: { command: "npm test" },
      },
    ],
  };
  const setupDone = await renderBlocks(done, {
    statusMap: new Map([["tu-bash-3", false]]),
  });
  const doneFrame = setupDone.captureCharFrame();
  // success state has no `[完成]` prefix.
  expect(doneFrame).toContain("bash · npm test");
  expect(doneFrame.includes("[完成]")).toBe(false);
  await setupDone.renderer.destroy();
});

test("D7 slot：bash 完成 → 标题留、折叠结果预览可见", async () => {
  const msg: AnthropicNativeMessage = {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "先搜一下", signature: "s" },
      {
        type: "tool_use",
        id: "tu-b",
        name: "bash",
        input: { command: "ls" },
      },
    ],
  };
  const setup = await testRender(
    <MessageBlocks
      message={msg}
      cols={COLS}
      statusMap={new Map([["tu-b", false]])}
      resultTextMap={
        new Map([
          [
            "tu-b",
            JSON.stringify({ code: 0, stdout: "a.ts\nb.ts", stderr: "" }),
          ],
        ])
      }
      hideThinking={true}
      marginTop={1}
    />,
    { width: COLS, height: 12, exitOnCtrlC: false }
  );
  await setup.waitForVisualIdle();
  const frame = setup.captureCharFrame();
  expect(frame).toContain("bash · ls");
  expect(frame).toContain("a.ts");
  expect(frame).toContain("b.ts");
  expect(frame.includes("[完成]")).toBe(false);
  await setup.renderer.destroy();
});

function rgbaEq(a: RGBA, b: RGBA): boolean {
  return a.r === b.r && a.g === b.g && a.b === b.b;
}

/** fg of the first span whose text contains needle (undefined if no match). */
function fgOfSpanWith(
  setup: Awaited<ReturnType<typeof testRender>>,
  needle: string
): RGBA | undefined {
  const { lines } = setup.captureSpans();
  for (const line of lines) {
    for (const span of line.spans) {
      if (span.text.includes(needle)) return span.fg;
    }
  }
  return undefined;
}

// -- failure cross-cut: red title + one short error line, no dim long-text stack --

const LONG_FAILURE_RECEIPT = [
  "[worktree_isolation] workspace mutation blocked: bash in this session",
  "workspace mutation blocked: worktree isolation is ON and this session",
  "is not yet bound to a task worktree. Call the create-task-worktree ACI",
  "tool first, then retry inside the bound worktree.",
  "at gate.check (worktree-gate.ts:66)",
  "at runLoop (loop.ts:120)",
].join("\n");

test("SC4 失败 mutate：红标题 + 一行短错误（截断长回执）", async () => {
  const setup = await testRender(
    <MessageBlocks
      message={{
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tu-wt-fail",
            name: "bash",
            input: { command: "rm -rf /" },
          },
        ],
      }}
      cols={COLS}
      statusMap={new Map([["tu-wt-fail", true]])}
      resultTextMap={new Map([["tu-wt-fail", LONG_FAILURE_RECEIPT]])}
    />,
    { width: COLS, height: 40, exitOnCtrlC: false }
  );
  await setup.waitForVisualIdle();
  const frame = setup.captureCharFrame();
  // title line kept (`[失败]` form).
  expect(frame).toContain("[失败]");
  // one short error line: the error surfaces truncated to its first line.
  expect(frame).toContain("[worktree_isolation]");
  // the failure block occupies only title + error line (long receipts are not spread out).
  const failLines = frame
    .split("\n")
    .filter(
      (l) =>
        l.includes("worktree_isolation") || l.includes("workspace mutation")
    );
  expect(failLines.length).toBe(1);
  await setup.renderer.destroy();
});

test("SC4 失败件：无 dim 结果预览块堆长文", async () => {
  const setup = await testRender(
    <MessageBlocks
      message={{
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tu-bash-longfail",
            name: "bash",
            input: { command: "false" },
          },
        ],
      }}
      cols={COLS}
      statusMap={new Map([["tu-bash-longfail", true]])}
      resultTextMap={
        new Map([
          [
            "tu-bash-longfail",
            JSON.stringify({
              code: 1,
              stdout: "line-1\nline-2\nline-3",
              stderr: LONG_FAILURE_RECEIPT,
            }),
          ],
        ])
      }
    />,
    { width: COLS, height: 40, exitOnCtrlC: false }
  );
  await setup.waitForVisualIdle();
  const frame = setup.captureCharFrame();
  // failed tools skip the dim ⎿ result preview (no long-text stack; long stderr goes to the one short error line).
  expect(frame.includes("⎿")).toBe(false);
  expect(frame.includes("line-2")).toBe(false);
  await setup.renderer.destroy();
});

test("SC4 失败标题 error 色 token（ToolSummaryRow fg = palette.error）", async () => {
  const setup = await testRender(
    <MessageBlocks
      message={{
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tu-wt-fail2",
            name: "bash",
            input: { command: "false" },
          },
        ],
      }}
      cols={COLS}
      statusMap={new Map([["tu-wt-fail2", true]])}
      resultTextMap={new Map([["tu-wt-fail2", "boom"]])}
    />,
    { width: COLS, height: 40, exitOnCtrlC: false }
  );
  await setup.waitForVisualIdle();
  const expectedErr = RGBA.fromHex(tuiPalette.error);
  const fg = fgOfSpanWith(setup, "[失败]");
  expect(fg).toBeDefined();
  expect(rgbaEq(fg!, expectedErr)).toBe(true);
  // failure is not dimmed (dim belongs to successful bash tails only).
  const dimFg = RGBA.fromHex(tuiPalette.dim);
  expect(rgbaEq(fg!, dimFg)).toBe(false);
  await setup.renderer.destroy();
});

test("SC5 accent 成功：skill 落定行走 accent 色，无 skill 正文结果预览", async () => {
  const body = Array.from({ length: 10 }, (_, i) => `body-${i}`).join("\n");
  const setup = await testRender(
    <MessageBlocks
      message={{
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tu-skill",
            name: "skill",
            input: { name: "playwright-cli" },
          },
        ],
      }}
      cols={COLS}
      statusMap={new Map([["tu-skill", false]])}
      resultTextMap={new Map([["tu-skill", body]])}
    />,
    { width: COLS, height: 40, exitOnCtrlC: false }
  );
  await setup.waitForVisualIdle();
  const frame = setup.captureCharFrame();
  // human-readable form: `skill <name>`.
  expect(frame).toContain("skill playwright-cli");
  // skill body is not spread out (no ⎿ result preview).
  expect(frame.includes("⎿")).toBe(false);
  expect(frame.includes("body-5")).toBe(false);
  // the accent token lands on the title line (not dim).
  const expectedAccent = RGBA.fromHex(tuiPalette.accent);
  const fg = fgOfSpanWith(setup, "skill playwright-cli");
  expect(fg).toBeDefined();
  expect(rgbaEq(fg!, expectedAccent)).toBe(true);
  const dimFg = RGBA.fromHex(tuiPalette.dim);
  expect(rgbaEq(fg!, dimFg)).toBe(false);
  await setup.renderer.destroy();
});

test("SC5 accent 成功：建树工具人读表述（label / 路径叶子）走 accent", async () => {
  const setup = await testRender(
    <MessageBlocks
      message={{
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tu-ctw",
            name: "enter-worktree",
            input: { conversationId: "abc-leaf-123" },
          },
        ],
      }}
      cols={COLS}
      statusMap={new Map([["tu-ctw", false]])}
    />,
    { width: COLS, height: 40, exitOnCtrlC: false }
  );
  await setup.waitForVisualIdle();
  const frame = setup.captureCharFrame();
  // human-readable process lines follow the summary registry in English and
  // name the target with its registered name (semantics still task worktree).
  // The accent assertion is unchanged; stronger than before, this also checks
  // that no Chinese residue remains.
  expect(frame).toContain("Entered worktree abc-leaf-123");
  expect(frame.includes("进入任务工作树")).toBe(false);
  const expectedAccent = RGBA.fromHex(tuiPalette.accent);
  const fg = fgOfSpanWith(setup, "Entered worktree abc-leaf-123");
  expect(fg).toBeDefined();
  expect(rgbaEq(fg!, expectedAccent)).toBe(true);
  await setup.renderer.destroy();
});

test("SC4/D6 error 优先于 accent：accent 工具失败走 error 色（渲染层）", async () => {
  const setup = await testRender(
    <MessageBlocks
      message={{
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tu-skill-fail",
            name: "skill",
            input: { name: "nope" },
          },
        ],
      }}
      cols={COLS}
      statusMap={new Map([["tu-skill-fail", true]])}
      resultTextMap={new Map([["tu-skill-fail", "skill not found"]])}
    />,
    { width: COLS, height: 40, exitOnCtrlC: false }
  );
  await setup.waitForVisualIdle();
  const expectedErr = RGBA.fromHex(tuiPalette.error);
  const fg = fgOfSpanWith(setup, "[失败]");
  expect(fg).toBeDefined();
  expect(rgbaEq(fg!, expectedErr)).toBe(true);
  // a failed accent tool must not keep accent color.
  const expectedAccent = RGBA.fromHex(tuiPalette.accent);
  expect(rgbaEq(fg!, expectedAccent)).toBe(false);
  await setup.renderer.destroy();
});

test("marginTop prop：根节点产顶部间距（缺省无间距，首条消息用）", async () => {
  const msg: AnthropicNativeMessage = {
    role: "user",
    content: [{ type: "text", text: "带间距的提问" }],
  };
  const setup = await testRender(
    <MessageBlocks
      message={msg}
      cols={COLS}
      statusMap={emptyStatusMap()}
      marginTop={1}
    />,
    { width: COLS, height: 10, exitOnCtrlC: false }
  );
  await setup.waitForVisualIdle();
  const lines = setup.captureCharFrame().split("\n");
  const textLine = lines.findIndex((l) => l.includes("带间距的提问"));
  // marginTop={1} → exactly 1 blank line above the text.
  expect(textLine).toBe(1);
  await setup.renderer.destroy();
});

// -- keep / accent titles no longer dim; accent gains bold ------------------
//
// Invariants:
//  - keep titles (bash / write_file settled ok) use the text color token,
//    never dim — dim is decoration only (result-preview prefix/overflow,
//    fold lines, thinking summary);
//  - accent titles (skill / create-task-worktree etc.) keep accent color and
//    gain bold so "named rare capabilities" read distinctly in the terminal
//    (theme.ts accent is nearly the text color, so color alone is not enough);
//  - side effect: RUNNING_SLOT maps through the same default, so running
//    titles move dim → text, making the action the user waits on clearer.
//
// theme.ts color values untouched; only the render maps in message-blocks /
// live-tool-preview switch default → tuiPalette.text and wrap accent in <b>.

test("T2 keep 标题：write_file 成功 fg = palette.text（非 dim）", async () => {
  const msg: AnthropicNativeMessage = {
    role: "assistant",
    content: [
      {
        type: "tool_use",
        id: "tu-wf",
        name: "write_file",
        input: { path: "a.ts", content: "x" },
      },
    ],
  };
  const setup = await testRender(
    <MessageBlocks
      message={msg}
      cols={COLS}
      statusMap={new Map([["tu-wf", false]])}
      marginTop={1}
    />,
    { width: COLS, height: 10, exitOnCtrlC: false }
  );
  await setup.waitForVisualIdle();
  const expectedText = RGBA.fromHex(tuiPalette.text);
  const expectedDim = RGBA.fromHex(tuiPalette.dim);
  const fg = fgOfSpanWith(setup, "write_file · Wrote a.ts");
  expect(fg).toBeDefined();
  expect(rgbaEq(fg!, expectedText)).toBe(true);
  // pin the invariant: must not be dim.
  expect(rgbaEq(fg!, expectedDim)).toBe(false);
  await setup.renderer.destroy();
});

test("T2 running 态标题：write_file 未配对 fg = palette.text（默认色从 dim 升 text 的可接受副作用）", async () => {
  const msg: AnthropicNativeMessage = {
    role: "assistant",
    content: [
      {
        type: "tool_use",
        id: "tu-r",
        name: "write_file",
        input: { path: "a.ts", content: "x" },
      },
    ],
  };
  const setup = await testRender(
    <MessageBlocks
      message={msg}
      cols={COLS}
      statusMap={emptyStatusMap()}
      marginTop={1}
    />,
    { width: COLS, height: 10, exitOnCtrlC: false }
  );
  await setup.waitForVisualIdle();
  const expectedText = RGBA.fromHex(tuiPalette.text);
  const fg = fgOfSpanWith(setup, "write_file");
  expect(fg).toBeDefined();
  expect(rgbaEq(fg!, expectedText)).toBe(true);
  await setup.renderer.destroy();
});

test("T2 accent 标题：skill 成功 fg = palette.accent + span 含 BOLD attribute", async () => {
  const msg: AnthropicNativeMessage = {
    role: "assistant",
    content: [
      {
        type: "tool_use",
        id: "tu-sk",
        name: "skill",
        input: { name: "playwright-cli" },
      },
    ],
  };
  const setup = await testRender(
    <MessageBlocks
      message={msg}
      cols={COLS}
      statusMap={new Map([["tu-sk", false]])}
      marginTop={1}
    />,
    { width: COLS, height: 10, exitOnCtrlC: false }
  );
  await setup.waitForVisualIdle();
  const expectedAccent = RGBA.fromHex(tuiPalette.accent);
  // OpenTUI TextAttributes.BOLD = 1 << 0 = 1.
  const { lines } = setup.captureSpans();
  const skillSpans = lines
    .flatMap((l) => l.spans)
    .filter((s) => s.text.includes("skill playwright-cli"));
  expect(skillSpans.length).toBeGreaterThan(0);
  for (const span of skillSpans) {
    expect(rgbaEq(span.fg, expectedAccent)).toBe(true);
    // assert the BOLD bit only; other bits unconstrained.
    expect(span.attributes & 1).toBe(1);
  }
  await setup.renderer.destroy();
});

test("D7 slot：retract 落定 → 标题与预览同假（read_file 不再出 [完成] 行）；keep 预览仍在", async () => {
  // rendering consumes deriveSlot only: a successful retract (read_file) pulls
  // title and preview off screen (fold count only); keep (write_file) retains
  // title + its existing preview.
  const msg: AnthropicNativeMessage = {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "要写文件", signature: "s" },
      {
        type: "tool_use",
        id: "tu-w",
        name: "write_file",
        input: { path: "a.ts", content: "export const x = 1;\n" },
      },
      {
        type: "tool_use",
        id: "tu-r",
        name: "read_file",
        input: { path: "b.ts" },
      },
    ],
  };
  const setup = await testRender(
    <MessageBlocks
      message={msg}
      cols={COLS}
      statusMap={
        new Map([
          ["tu-w", false],
          ["tu-r", false],
        ])
      }
      hideThinking={true}
    />,
    { width: COLS, height: 40, exitOnCtrlC: false }
  );
  await setup.waitForVisualIdle();
  const frame = setup.captureCharFrame();
  expect(frame.includes("[思考]")).toBe(false);
  // retract items: no title line, no preview.
  expect(frame.includes("read_file")).toBe(false);
  // keep items: title + preview content both present.
  expect(frame).toContain("write_file");
  expect(frame).toContain("export const x = 1;");
  await setup.renderer.destroy();
});

// -- history bash / skill result previews (result preview block) ------------

/** Minimal messages: one bash tool_use + its paired tool_result. */
function bashCallMessages(
  toolUseId: string,
  resultText: string
): AnthropicNativeMessage[] {
  return [
    {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: toolUseId,
          name: "bash",
          input: { command: "ls" },
        },
      ],
    },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: toolUseId,
          content: resultText,
          is_error: false,
        },
      ],
    },
  ];
}

test("D4 bash 历史：成功落定画折叠后的 result preview 尾窗", async () => {
  const stdout = Array.from({ length: 10 }, (_, i) => `out-${i}`).join("\n");
  const [assistant, user] = bashCallMessages(
    "tu-bash-r",
    JSON.stringify({ code: 0, stdout, stderr: "" })
  );
  const setup = await testRender(
    <MessageBlocks
      message={assistant}
      cols={COLS}
      statusMap={new Map([["tu-bash-r", false]])}
      resultTextMap={
        new Map([
          ["tu-bash-r", JSON.stringify({ code: 0, stdout, stderr: "" })],
        ])
      }
    />,
    { width: COLS, height: 40, exitOnCtrlC: false }
  );
  await setup.waitForVisualIdle();
  const frame = setup.captureCharFrame();
  expect(frame).toContain("bash · ls");
  // tail 3 of 10 lines per docs/CONTEXT.md **result preview** → out-7..out-9, 7 overflow.
  expect(frame).toContain("… +7 行");
  expect(frame).not.toContain("out-0");
  expect(frame).not.toContain("out-6");
  expect(frame).toContain("out-7");
  expect(frame).toContain("out-9");
  // user message not rendered (not part of the assistant block; testRender got no user block either)
  void user;
  await setup.renderer.destroy();
});

test("T3 相邻 keep 卡之间空一行：同消息两条成功 bash 标题不贴行", async () => {
  // Adjacent keep-class title cards are separated by one blank line (card
  // rhythm = intra-message block spacing, withBlockSpacing). In the settled
  // frame of two consecutive successful bash calls, exactly 1 blank line must
  // sit between the first card's body and the second card's title.
  const stdout = (n: number): string =>
    Array.from({ length: n }, (_, i) => `row-${i}`).join("\n");
  const setup = await testRender(
    <MessageBlocks
      message={{
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tu-gap-a",
            name: "bash",
            input: { command: "cmd-one" },
          },
          {
            type: "tool_use",
            id: "tu-gap-b",
            name: "bash",
            input: { command: "cmd-two" },
          },
        ],
      }}
      cols={COLS}
      statusMap={
        new Map([
          ["tu-gap-a", false],
          ["tu-gap-b", false],
        ])
      }
      resultTextMap={
        new Map([
          [
            "tu-gap-a",
            JSON.stringify({ code: 0, stdout: stdout(2), stderr: "" }),
          ],
          [
            "tu-gap-b",
            JSON.stringify({ code: 0, stdout: stdout(2), stderr: "" }),
          ],
        ])
      }
    />,
    { width: COLS, height: 20, exitOnCtrlC: false }
  );
  await setup.waitForVisualIdle();
  const lines = setup.captureCharFrame().split("\n");
  const first = lines.findIndex((l) => l.includes("bash · cmd-one"));
  const second = lines.findIndex((l) => l.includes("bash · cmd-two"));
  expect(first).toBeGreaterThanOrEqual(0);
  expect(second).toBeGreaterThan(first);
  const between = lines.slice(first + 1, second);
  expect(between.filter((l) => l.trim().length === 0)).toHaveLength(1);
  await setup.renderer.destroy();
});

test("D7 失败横切：失败 bash 标题行保留、不画 dim ⎿ 结果预览（slot.showPreview 假）", async () => {
  // the failure cross-cut is the core's last step → showTitle true (the full
  // one-line short error is a later bullet), showPreview false — no dim ⎿
  // stacking of long receipts.
  const setup = await testRender(
    <MessageBlocks
      message={{
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tu-bash-fail",
            name: "bash",
            input: { command: "false" },
          },
        ],
      }}
      cols={COLS}
      statusMap={new Map([["tu-bash-fail", true]])}
      resultTextMap={
        new Map([
          [
            "tu-bash-fail",
            JSON.stringify({ code: 1, stdout: "boom", stderr: "err-out" }),
          ],
        ])
      }
    />,
    { width: COLS, height: 40, exitOnCtrlC: false }
  );
  await setup.waitForVisualIdle();
  const frame = setup.captureCharFrame();
  // title line kept (ToolSummaryRow owns the failure error-color token).
  expect(frame).toContain("[失败]");
  // no dim ⎿ result preview (no long-text stacking).
  expect(frame.includes("⎿")).toBe(false);
  await setup.renderer.destroy();
});

test("D7 成功 retract：read_file 落定后标题与预览同假（内容不残留）", async () => {
  const setup = await testRender(
    <MessageBlocks
      message={{
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tu-rf",
            name: "read_file",
            input: { path: "a.ts" },
          },
        ],
      }}
      cols={COLS}
      statusMap={new Map([["tu-rf", false]])}
      resultTextMap={new Map([["tu-rf", "x".repeat(200)]])}
    />,
    { width: COLS, height: 40, exitOnCtrlC: false }
  );
  await setup.waitForVisualIdle();
  const frame = setup.captureCharFrame();
  // retract settled: title and preview both false (core-guaranteed, rendering must not resurrect) — the block emits no node.
  expect(frame.includes("read_file")).toBe(false);
  expect(frame.includes("⎿")).toBe(false);
  // must not leak model-facing tool_result text either
  expect(frame.includes("x".repeat(50))).toBe(false);
  await setup.renderer.destroy();
});

// live-signal revision: web_search / web_fetch settle into real cards —
// MessageBlocks lifts the title line `Search <query>` / `Fetch <url>`. Other
// registered retract names (read_file) still fold title and preview to false.

test("live-signal revision: web_search 落定 → 标题 'Search <query>' 可见", async () => {
  const setup = await testRender(
    <MessageBlocks
      message={{
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tu-ws",
            name: "web_search",
            input: { query: "今天的AI新闻" },
          },
        ],
      }}
      cols={COLS}
      statusMap={new Map([["tu-ws", false]])}
      resultTextMap={new Map([["tu-ws", "结果一 / 结果二"]])}
    />,
    { width: COLS, height: 40, exitOnCtrlC: false }
  );
  await setup.waitForVisualIdle();
  const frame = setup.captureCharFrame();
  // real card: title `Search <query>` visible (formatToolStatusLine single source).
  expect(frame).toContain("Search");
  expect(frame).toContain("今天的AI新闻");
  // after settling the preview slot is empty (no long-text spread).
  expect(frame.includes("⎿")).toBe(false);
  await setup.renderer.destroy();
});

test("live-signal revision: web_fetch 落定 → 标题 'Fetch <url>' 可见", async () => {
  const setup = await testRender(
    <MessageBlocks
      message={{
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tu-wf",
            name: "web_fetch",
            input: { url: "https://example.com" },
          },
        ],
      }}
      cols={COLS}
      statusMap={new Map([["tu-wf", false]])}
      resultTextMap={new Map([["tu-wf", "page body"]])}
    />,
    { width: COLS, height: 40, exitOnCtrlC: false }
  );
  await setup.waitForVisualIdle();
  const frame = setup.captureCharFrame();
  expect(frame).toContain("Fetch");
  expect(frame).toContain("https://example.com");
  expect(frame.includes("⎿")).toBe(false);
  await setup.renderer.destroy();
});

test("live-signal revision: 已注册 retract (read_file) 仍被抽掉，不出标题", async () => {
  // Guards the retract contract: names other than web_search / web_fetch still
  // take the "title and preview both false" path (unchanged by live-signal).
  const setup = await testRender(
    <MessageBlocks
      message={{
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tu-rf2",
            name: "read_file",
            input: { path: "a.ts" },
          },
        ],
      }}
      cols={COLS}
      statusMap={new Map([["tu-rf2", false]])}
    />,
    { width: COLS, height: 40, exitOnCtrlC: false }
  );
  await setup.waitForVisualIdle();
  const frame = setup.captureCharFrame();
  expect(frame.includes("read_file")).toBe(false);
  await setup.renderer.destroy();
});

test("D4 bash 空输出 / 全空白 → 不渲染预览块", async () => {
  const cases: ReadonlyArray<{
    readonly label: string;
    readonly resultText: string;
  }> = [
    {
      label: "空 stdout",
      resultText: JSON.stringify({ code: 0, stdout: "", stderr: "" }),
    },
    {
      label: "全空白",
      resultText: JSON.stringify({ code: 0, stdout: "   \n\t\n", stderr: "" }),
    },
    {
      label: "ANSI-only",
      resultText: JSON.stringify({
        code: 0,
        stdout: "\x1b[31m\x1b[0m",
        stderr: "",
      }),
    },
  ];
  for (const c of cases) {
    const setup = await testRender(
      <MessageBlocks
        message={{
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "tu-bash-empty",
              name: "bash",
              input: { command: "x" },
            },
          ],
        }}
        cols={COLS}
        statusMap={new Map([["tu-bash-empty", false]])}
        resultTextMap={new Map([["tu-bash-empty", c.resultText]])}
      />,
      { width: COLS, height: 40, exitOnCtrlC: false }
    );
    await setup.waitForVisualIdle();
    const frame = setup.captureCharFrame();
    // success state has no `[完成]` prefix → assert on the bash title content instead.
    expect(frame, `case=${c.label}`).toContain("bash");
    expect(frame, `case=${c.label}`).not.toContain("⎿");
    expect(frame, `case=${c.label}`).not.toContain("[完成]");
    await setup.renderer.destroy();
  }
});

test("D4 bash ANSI 透传：成功落定预览保留可见正文", async () => {
  const stdout = "\x1b[31mERROR\x1b[0m line\n\x1b[32mOK\x1b[0m line";
  const setup = await testRender(
    <MessageBlocks
      message={{
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tu-bash-ansi",
            name: "bash",
            input: { command: "x" },
          },
        ],
      }}
      cols={COLS}
      statusMap={new Map([["tu-bash-ansi", false]])}
      resultTextMap={
        new Map([
          ["tu-bash-ansi", JSON.stringify({ code: 0, stdout, stderr: "" })],
        ])
      }
    />,
    { width: COLS, height: 40, exitOnCtrlC: false }
  );
  await setup.waitForVisualIdle();
  const frame = setup.captureCharFrame();
  expect(frame).toContain("bash · x");
  expect(frame.includes("ERROR")).toBe(true);
  expect(frame.includes("OK")).toBe(true);
  await setup.renderer.destroy();
});

test("D4 bash 单行输出：成功落定画出结果预览", async () => {
  const setup = await testRender(
    <MessageBlocks
      message={{
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tu-bash-1line",
            name: "bash",
            input: { command: "echo hi" },
          },
        ],
      }}
      cols={COLS}
      statusMap={new Map([["tu-bash-1line", false]])}
      resultTextMap={
        new Map([
          [
            "tu-bash-1line",
            JSON.stringify({ code: 0, stdout: "hi", stderr: "" }),
          ],
        ])
      }
    />,
    { width: COLS, height: 40, exitOnCtrlC: false }
  );
  await setup.waitForVisualIdle();
  const frame = setup.captureCharFrame();
  expect(frame).toContain("bash · echo hi");
  expect(frame).toContain("│ hi");
  await setup.renderer.destroy();
});

test("D4 未配对 tool_use（statusMap 缺位）→ 不画结果预览", async () => {
  const setup = await testRender(
    <MessageBlocks
      message={{
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tu-bash-runn",
            name: "bash",
            input: { command: "ls" },
          },
        ],
      }}
      cols={COLS}
      statusMap={new Map()}
      resultTextMap={
        new Map([
          [
            "tu-bash-runn",
            JSON.stringify({ code: 0, stdout: "x", stderr: "" }),
          ],
        ])
      }
    />,
    { width: COLS, height: 40, exitOnCtrlC: false }
  );
  await setup.waitForVisualIdle();
  const frame = setup.captureCharFrame();
  // missing statusMap entry → treated as running: no result preview (unpaired never renders).
  // The process line is the English live tool line (running bash carries the
  // `Running 1 shell command…` prefix + visible command), no `[运行中]` bracket.
  expect(frame).toContain("Running 1 shell command… · ls");
  expect(frame.includes("[运行中]")).toBe(false);
  expect(frame).not.toContain("⎿");
  await setup.renderer.destroy();
});

test("D4 keep 足迹：bash 落定标题 + 折叠结果预览", async () => {
  const setup = await testRender(
    <MessageBlocks
      message={{
        role: "assistant",
        content: [
          { type: "thinking", thinking: "先跑 ls", signature: "s" },
          {
            type: "tool_use",
            id: "tu-bash-fold",
            name: "bash",
            input: { command: "ls" },
          },
        ],
      }}
      cols={COLS}
      statusMap={new Map([["tu-bash-fold", false]])}
      resultTextMap={
        new Map([
          [
            "tu-bash-fold",
            JSON.stringify({ code: 0, stdout: "a.ts\nb.ts", stderr: "" }),
          ],
        ])
      }
      hideThinking={true}
    />,
    { width: COLS, height: 40, exitOnCtrlC: false }
  );
  await setup.waitForVisualIdle();
  const frame = setup.captureCharFrame();
  expect(frame).toContain("bash · ls");
  expect(frame).toContain("a.ts");
  expect(frame).toContain("b.ts");
  expect(frame.includes("[完成]")).toBe(false);
  await setup.renderer.destroy();
});

// -- 1 blank line between assistant inner blocks -----------------------------
// When an assistant message renders several nodes in order (thinking fold /
// thinking body / text / tool line / error line), a blank line is inserted
// between adjacent nodes; the first block gets no top margin. Row-difference
// checks run across the full frame from captureCharFrame.

test("T4 assistant 内部块：thinking 折叠 + 工具行 + 文本，节点间 1 行空白", async () => {
  // three node types in order: thinking fold (with seconds) → bash tool line →
  // text. Each occupies 1 line; 1 blank line sits between nodes.
  const msg: AnthropicNativeMessage = {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "先想", signature: "s" },
      {
        type: "tool_use",
        id: "tu-t4-1",
        name: "bash",
        input: { command: "ls" },
      },
      { type: "text", text: "跑完了，结果在下面。" },
    ],
  };
  const setup = await testRender(
    <MessageBlocks
      message={msg}
      cols={COLS}
      statusMap={new Map([["tu-t4-1", false]])}
      thinkingExpanded={false}
      thinkingSeconds={3}
    />,
    { width: COLS, height: 40, exitOnCtrlC: false }
  );
  await setup.waitForVisualIdle();
  const frame = setup.captureCharFrame();
  const lines = frame.split("\n");
  // anchor line indices.
  const thinkIdx = lines.findIndex((l) => l.includes("Thought for 3s"));
  const bashIdx = lines.findIndex((l) => l.includes("bash ·"));
  const textIdx = lines.findIndex((l) => l.includes("跑完了"));
  expect(thinkIdx).toBeGreaterThanOrEqual(0);
  expect(bashIdx).toBeGreaterThanOrEqual(0);
  expect(textIdx).toBeGreaterThanOrEqual(0);
  // 1 blank line between nodes (≥ 2-row gap = 1 spacer line).
  expect(bashIdx - thinkIdx).toBeGreaterThanOrEqual(2);
  expect(textIdx - bashIdx).toBeGreaterThanOrEqual(2);
  // the first block (thinking fold line) sits on row 0, no top margin.
  expect(thinkIdx).toBe(0);
  await setup.renderer.destroy();
});

test("T4 assistant 单块无内部空白：仅 1 个文本块时,文本独占首行", async () => {
  // a lone node must produce no blank lines (no top margin, nothing to space against).
  const msg: AnthropicNativeMessage = {
    role: "assistant",
    content: [{ type: "text", text: "唯一文本块" }],
  };
  const setup = await renderBlocks(msg);
  const frame = setup.captureCharFrame();
  const lines = frame.split("\n");
  const textIdx = lines.findIndex((l) => l.includes("唯一文本块"));
  expect(textIdx).toBe(0);
  await setup.renderer.destroy();
});

test("T4 assistant 思考折叠块只占 1 行：无 ran 第二行，与工具行保持块间间距", async () => {
  // message-level thinking fold is the single `Thought for <duration>` line;
  // the old `ran M commands` second line is retired (counts belong to
  // turn-level `name × N` folds only), so this block is always 1 line and the
  // spacing check reduces to "fold line → tool line".
  const msg: AnthropicNativeMessage = {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "链上推理…", signature: "sig-1" },
      {
        type: "tool_use",
        id: "tu-t4-2",
        name: "bash",
        input: { command: "ls" },
      },
    ],
  };
  const setup = await testRender(
    <MessageBlocks
      message={msg}
      cols={COLS}
      statusMap={new Map([["tu-t4-2", false]])}
      thinkingExpanded={false}
      thinkingSeconds={3}
    />,
    { width: COLS, height: 40, exitOnCtrlC: false }
  );
  await setup.waitForVisualIdle();
  const frame = setup.captureCharFrame();
  const lines = frame.split("\n");
  const thinkIdx = lines.findIndex((l) => l.includes("Thought for 3s"));
  const bashIdx = lines.findIndex((l) => l.includes("bash ·"));
  expect(thinkIdx).toBeGreaterThanOrEqual(0);
  expect(bashIdx).toBeGreaterThanOrEqual(0);
  // the fold block is 1 line only (no `ran N command(s)` second line).
  expect(frame.includes("ran 1 command")).toBe(false);
  // 1 blank line is inserted between the fold line and the next bash block (≥ 2-row gap).
  expect(bashIdx - thinkIdx).toBeGreaterThanOrEqual(2);
  await setup.renderer.destroy();
});

/**
 * skill-load projection renders in the user branch.
 *  - matched form → chip-only (empty remainder) / chip + remainder (non-empty);
 *    the SKILL body never enters a ❯ bubble;
 *  - rejected form (prefix hit but name unclosed / not starting with
 *    [skill-load) → falls through to the plain user-text path (treated as
 *    ordinary user input);
 *  - legacy Chinese displayText `[加载技能 echo]` (not a closed skill-load
 *    form) → still shown as ordinary user text, never mis-projected as a chip.
 */
describe("user: skill-load chip projection（plans T5）", () => {
  test("chip-only：remainder 空 → 只画 `loading skill <name>`，正文不渲染", async () => {
    const msg: AnthropicNativeMessage = {
      role: "user",
      content: [
        {
          type: "text",
          text: '[skill-load name="echo"]\n# 回声技能\n\nBase directory: /tmp\n\n<skill_files>\n/skill.md\n</skill_files>',
        },
      ],
    };
    const setup = await renderBlocks(msg);
    const frame = setup.captureCharFrame();
    expect(frame).toContain("loading skill echo");
    // SKILL body must not enter the ❯ bubble (nor any text node):
    expect(frame.includes("# 回声技能")).toBe(false);
    expect(frame.includes("Base directory")).toBe(false);
    expect(frame.includes("<skill_files>")).toBe(false);
    expect(frame.includes("❯")).toBe(false);
    await setup.renderer.destroy();
  });

  test("chip + remainder：remainder 非空 → chip + `❯ <remainder>`", async () => {
    const msg: AnthropicNativeMessage = {
      role: "user",
      content: [
        {
          type: "text",
          text: '[skill-load name="echo"]\n# 回声技能\n\nBase directory: /tmp\n\n<skill_files>\n/skill.md\n</skill_files>\n\n帮我做 X',
        },
      ],
    };
    const setup = await renderBlocks(msg);
    const frame = setup.captureCharFrame();
    expect(frame).toContain("loading skill echo");
    expect(frame).toContain("❯ 帮我做 X");
    // body enters no text node:
    expect(frame.includes("# 回声技能")).toBe(false);
    expect(frame.includes("Base directory")).toBe(false);
    expect(frame.includes("<skill_files>")).toBe(false);
    await setup.renderer.destroy();
  });

  test("chip + remainder：body 巨大（10KB）→ 仍只画 chip + remainder，正文不渲染", async () => {
    const huge = "x".repeat(10_000);
    const msg: AnthropicNativeMessage = {
      role: "user",
      content: [
        {
          type: "text",
          text: `[skill-load name="echo"]\n${huge}\n\n帮我做 X`,
        },
      ],
    };
    const setup = await renderBlocks(msg);
    const frame = setup.captureCharFrame();
    expect(frame).toContain("loading skill echo");
    expect(frame).toContain("❯ 帮我做 X");
    // the huge body must not leak (nor trigger a full wrapped render).
    expect(frame.includes("xxxxxx")).toBe(false);
    await setup.renderer.destroy();
  });

  test("malformed `[skill-load name=...]`（短前缀命中但 name 没闭合）→ 走普通 user 文本", async () => {
    const msg: AnthropicNativeMessage = {
      role: "user",
      content: [
        {
          type: "text",
          // malformed: missing `\n` after name=echo] → projection rejects.
          text: "[skill-load name=echo]\nbody\n\n帮我做 X",
        },
      ],
    };
    const setup = await renderBlocks(msg);
    const frame = setup.captureCharFrame();
    // not projected to a chip; the whole text goes into the ❯ bubble verbatim:
    expect(frame.includes("loading skill")).toBe(false);
    expect(frame).toContain("❯");
    expect(frame).toContain("[skill-load name=echo]");
    await setup.renderer.destroy();
  });

  test("malformed `[skill-load` 单独短前缀 → 走普通 user 文本", async () => {
    const msg: AnthropicNativeMessage = {
      role: "user",
      content: [{ type: "text", text: "[skill-load 没闭合 name 内容]" }],
    };
    const setup = await renderBlocks(msg);
    const frame = setup.captureCharFrame();
    expect(frame.includes("loading skill")).toBe(false);
    expect(frame).toContain("❯");
    expect(frame).toContain("[skill-load 没闭合 name 内容]");
    await setup.renderer.destroy();
  });

  test("非 skill-load user 文本 → 行为不变（regression）", async () => {
    const msg: AnthropicNativeMessage = {
      role: "user",
      content: [{ type: "text", text: "你好 iknow" }],
    };
    const setup = await renderBlocks(msg);
    const frame = setup.captureCharFrame();
    expect(frame).toContain("❯ 你好 iknow");
    expect(frame.includes("loading skill")).toBe(false);
    await setup.renderer.destroy();
  });
});
