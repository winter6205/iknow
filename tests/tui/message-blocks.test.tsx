/** @jsxImportSource @opentui/react */
/**
 * tests/tui/message-blocks.test.tsx — #343 T6-B MessageBlocks 渲染验收。
 *
 * 覆盖范围（bun:test）：
 *  - user 消息 → ❯ accent 前缀，无 Markdown 渲染；
 *  - system 消息 → 独立分支：[已打断] 前缀 + 固定文案 Interrupted by user.，
 *    不进 Markdown 解析（#392 T3）；
 *  - assistant 文本 → Markdown 渲染（headings/code/lists 节选）；
 *  - thinking 折叠（默认）：无秒数不画摘要；有秒 → `思考了 N 秒`；
 *  - thinking 展开：thinking 文本全文 + redacted 占位；
 *  - tool_use 摘要行 + statusMap 驱动 ok/failed/运行中 标记染色；
 *  - content 边界：空文本 user 消息返回 null，不渲染任何节点。
 *  - T7 间距 + 底色：消息块根 marginTop={1} → 字符帧消息间出现空白分隔行；
 *    底色为渲染元数据（captureCharFrame 字符帧不含背景色），结构层断言 =
 *    底色 box 包裹后渲染不崩 + marginTop 空行存在。
 *
 * 渲染形态 OpenTUI 元素树（禁 ink Box/Text 原语）。captureCharFrame 文本断言。
 */
import { expect, test } from "bun:test";
import type { AnthropicNativeMessage } from "../../src/harness/model-adapter/types.js";
import { testRender } from "@opentui/react/test-utils";
import { MessageBlocks } from "../../src/tui/message-blocks.js";

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
  // user 消息不进 markdown bold 解析 → **`** 应保持原样（存档字面）。
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
  // 空 user content：frame 应为空或纯占位（不出现 ❯ 标记、不出现 tool_result 字段名）。
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
  // 若走 markdown：** 被解析、- 变 •；字面保留则证明走独立分支。
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
  // 无秒数时不画 [思考] 摘要；展开只出正文 + redacted 占位。
  expect(frame.includes("[思考]")).toBe(false);
  expect(frame).toContain("展开的思维链");
  // redacted 占位（REDACTED_PLACEHOLDER = "[已加密思考]"）。
  expect(frame).toContain("[已加密思考]");
  expect(frame).toContain("正文短句");
  await setup.renderer.destroy();
});

test("tool_use 完成态折叠摘要：bash 完成 → [完成] bash · npm test（无 ran 后缀）", async () => {
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
  expect(frame).toContain("[完成]");
  expect(frame).toContain("bash · npm test");
  // 2026-08-14：工具行不再拼 ran-N 后缀（计数统一由 ThinkingSummary 汇总）。
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
  // 同消息 2 个 bash block：摘要行只显 `[完成] name · detail`，计数不再逐行追加。
  expect(frame).toContain("bash · npm test");
  expect(frame).toContain("bash · git status");
  expect(frame.includes("ran")).toBe(false);
  await setup.renderer.destroy();
});

test("tool_use 非 bash 工具（write_file）：无 ran 计数", async () => {
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
  expect(frame).toContain("[完成]");
  expect(frame).toContain("write_file · 写入 a.ts（1 行）");
  expect(frame.includes("ran")).toBe(false);
  await setup.renderer.destroy();
});

test("thinking 折叠态 + thinkingSeconds：渲染 `思考了 N 秒` 替换 [思考]", async () => {
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
  // 新格式：折叠行 = `思考了 N 秒`（替换 [思考] 标记）。
  expect(frame).toContain("思考了 3 秒");
  expect(frame.includes("[思考]")).toBe(false);
  // text block 仍渲染（正式回答保留）。
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

test("thinking 折叠态 + thinkingSeconds + bash：思考一行、ran 下一行", async () => {
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
  expect(frame).toContain("思考了 3 秒");
  expect(frame).toContain("ran 1 command");
  expect(frame).not.toContain("思考了 3 秒 · ran 1 command");
  const frameLines = frame.split("\n");
  const thinkIdx = frameLines.findIndex((l) => l.includes("思考了 3 秒"));
  const ranIdx = frameLines.findIndex((l) => l.includes("ran 1 command"));
  expect(thinkIdx).toBeGreaterThanOrEqual(0);
  expect(ranIdx).toBe(thinkIdx + 1);
  expect(frame.includes("[思考]")).toBe(false);
  await setup.renderer.destroy();
});

test("tool_use 状态染色：statusMap 缺位 = [运行中]，failed = [失败]，成功 = [完成]", async () => {
  const okStatus = new Map<string, boolean>([["tu-ok", false]]);
  const failedStatus = new Map<string, boolean>([["tu-fail", true]]);
  const cases: ReadonlyArray<{
    readonly name: string;
    readonly id: string;
    readonly map: ReadonlyMap<string, boolean>;
    readonly mark: string;
  }> = [
    { name: "写入 ok", id: "tu-ok", map: okStatus, mark: "[完成]" },
    { name: "失败染色", id: "tu-fail", map: failedStatus, mark: "[失败]" },
    { name: "未配对", id: "tu-runn", map: emptyStatusMap(), mark: "[运行中]" },
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
  const lines = setupNarrow
    .captureCharFrame()
    .split("\n")
    .filter((l) => l.includes("[运行中]"));
  expect(lines.length).toBeGreaterThan(0);
  for (const l of lines) {
    expect(l.length).toBeLessThanOrEqual(20);
  }
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
  const sumLines = frame.split("\n").filter((l) => l.includes("[完成]"));
  expect(sumLines.length).toBeGreaterThan(0);
  expect(frame).toContain("line-00");
  expect(frame).not.toContain("line-19");
  expect(frame).toContain("还有");
  expect(frame).not.toContain("+line-00");
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
  expect(frame).toContain("[完成]");
  expect(frame).toContain("-old");
  expect(frame).toContain("+new");
  await setup.renderer.destroy();
});

// -- T7：消息间距 + 底色 ------------------------------------------------
// 底色 = 渲染元数据，captureCharFrame 字符帧不含背景色 → 底色断言走结构层：
// 底色 box 包裹后渲染不崩 + 内层文本可见。
//
// 间距归属（2026-08-22 变更）：消息间 1 行节奏由 MessageBlocks 根节点的
// `marginTop` prop 提供（ChatView 传 `visibleIndex===0?0:1`）。此前由
// ChatView wrapper `<box marginTop>` 提供，但折叠（工具标题行收掉）后
// 渲染为 null 的消息仍残留 wrapper margin，连成幻影空位 —— margin 改随
// MessageBlocks 根节点存亡。缺省无 margin：单条渲染首行前无空白行（T9
// 抖动修复后的 SSOT 边界不变）。

test("T7 多消息交替：marginTop prop={i===0?0:1} 提供 1 行节奏（首条无 margin）", async () => {
  const messages: AnthropicNativeMessage[] = [
    { role: "user", content: [{ type: "text", text: "第一条提问" }] },
    {
      role: "assistant",
      content: [{ type: "text", text: "第一个回答" }],
    },
    { role: "user", content: [{ type: "text", text: "第二条提问" }] },
  ];
  // 模拟 ChatView 接线：每条消息传 marginTop={i===0?0:1}。
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
  // 首条 user 文本首行应在第 0 行（无顶部 margin）。
  const firstTextLine = lines.findIndex((l) => l.includes("第一条提问"));
  expect(firstTextLine).toBe(0);
  // 第二条（assistant）与第一条间应有 1 行空白间隔。
  const secondTextLine = lines.findIndex((l) => l.includes("第一个回答"));
  expect(secondTextLine).toBeGreaterThan(firstTextLine + 1);
  // 第三条（user）与第二条间同样有 1 行空白。
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
  // 单条 MessageBlocks 渲染：marginTop prop 缺省 → 文本首行 = frame[0]，
  // 底色块紧贴内容（paddingY=0）；消息间距由 ChatView 传 marginTop 提供。
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

test("history write_file 未配对（空 statusMap）：仅 [运行中] 摘要，不含 content 正文", async () => {
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
  expect(frame).toContain("[运行中]");
  expect(frame).not.toContain(bodyLine);
  expect(frame).not.toContain("second-body-line");
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
  expect(frame).toContain("[运行中]");
  expect(frame).toContain("write_file");
  await setup.renderer.destroy();
});

// -- 子代理工具专属显示（spec #146） --------------------------------------

test("spawn_subagent 运行中（statusMap 无该 id）→ `▣ 子代理 · 派发子代理：…`，不含 `[运行中] spawn_subagent`", async () => {
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
  expect(frame).toContain("▣ 子代理 · 派发子代理：调查渲染层");
  // 不残留普通工具形态 `[运行中] spawn_subagent`。
  expect(frame).not.toContain("[运行中] spawn_subagent");
  await setup.renderer.destroy();
});

test("spawn_subagent 完成 ok → `✓ 子代理 · …`", async () => {
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
  expect(frame).toContain("✓ 子代理 · 派发子代理：调查渲染层");
  expect(frame).not.toContain("[完成]");
  await setup.renderer.destroy();
});

test("spawn_subagent 完成 failed → `✗ 子代理 · …`", async () => {
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
  expect(frame).toContain("✗ 子代理 · 派发子代理：调查渲染层");
  expect(frame).not.toContain("[失败]");
  await setup.renderer.destroy();
});

test("subagent_result 完成 ok → `✓ 子代理 · 轮询 t-1`", async () => {
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
  expect(frame).toContain("✓ 子代理 · 轮询 t-1");
  await setup.renderer.destroy();
});

test("bash 回归：`[运行中] bash` / 完成态字节不变", async () => {
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
  expect(frame).toContain("[运行中] bash · ls");
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
  expect(doneFrame).toContain("[完成] bash · npm test");
  await setupDone.renderer.destroy();
});

test("D7 slot：成功 retract（bash 无此态）—— bash 完成 → 标题 + 结果预览均保留", async () => {
  // D4：bash 是 keep 类 —— 落定后标题行与 5 行尾窗预览都留在屏幕上
  // （slot.showTitle / showPreview 均真），预览是否存在取决于 resultTextMap
  // 是否有配对文本。空 resultTextMap → 无预览内容 → 只有标题行。
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
      hideThinking={true}
      marginTop={1}
    />,
    { width: COLS, height: 10, exitOnCtrlC: false }
  );
  await setup.waitForVisualIdle();
  const frame = setup.captureCharFrame();
  expect(frame).toContain("[完成] bash · ls");
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
  // marginTop={1} → 文本上方恰 1 行空白。
  expect(textLine).toBe(1);
  await setup.renderer.destroy();
});

test("D7 slot：retract 落定 → 标题与预览同假（read_file 不再出 [完成] 行）；keep 预览仍在", async () => {
  // D3/D7：渲染只消费 deriveSlot。成功 retract（read_file）标题与预览都
  // 从屏幕拿掉（只进折叠计数）；keep（write_file）标题 + 既有 6 行预览保留。
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
  // retract 件：无标题行、无预览。
  expect(frame.includes("read_file")).toBe(false);
  // keep 件：标题 + 预览内容都在。
  expect(frame).toContain("write_file");
  expect(frame).toContain("export const x = 1;");
  await setup.renderer.destroy();
});

// -- #693 T4 D4:历史 bash / skill 结果预览（结果预览块） -----------------

/** 构造一个 bash 工具 + 配对 tool_result 的最小 messages 集。 */
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

test("D4 bash 历史：尾部 5 行 dim 预览 + … +N 行 溢出标记", async () => {
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
  // ⎿ 风格 dim 前缀出现
  expect(frame).toContain("⎿ out-5");
  expect(frame).toContain("⎿ out-9");
  // 早于尾窗 5 行的不应出现
  expect(frame).not.toContain("⎿ out-0");
  expect(frame).not.toContain("⎿ out-4");
  // 溢出 +N 行 标记
  expect(frame).toContain("… +5 行");
  // user 消息不画（user 不在 assistant message 块里,但 testRender 也没传 user 块）
  void user;
  await setup.renderer.destroy();
});

test("D7 失败横切：失败 bash 标题行保留、不画 dim ⎿ 结果预览（slot.showPreview 假）", async () => {
  // D5/D7：失败横切在核内最后一步 → showTitle 真（一行短错误的完整实现是
  // 后续 bullet）、showPreview 假 —— 不用 dim ⎿ 堆长回执。
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
  // 标题行保留（失败染色的 error 色 token 由 ToolSummaryRow 承担）。
  expect(frame).toContain("[失败]");
  // 不画 dim ⎿ 结果预览（D5：不堆长文）。
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
  // retract 落定：标题与预览同假（核保证，渲染不复活）—— 整块不出节点。
  expect(frame.includes("read_file")).toBe(false);
  expect(frame.includes("⎿")).toBe(false);
  // 也不应泄露模型面 tool_result 文本
  expect(frame.includes("x".repeat(50))).toBe(false);
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
    expect(frame, `case=${c.label}`).toContain("[完成] bash");
    expect(frame, `case=${c.label}`).not.toContain("⎿");
    await setup.renderer.destroy();
  }
});

test("D4 bash ANSI 透传：转义序列在 ⎿ 预览行内保留", async () => {
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
  // ANSI 序列在 ⎿ 预览行内原样保留
  expect(frame).toContain("⎿");
  expect(frame).toContain("ERROR");
  expect(frame).toContain("OK");
  await setup.renderer.destroy();
});

test("D4 bash 单行输出：直接显示 1 行（不强制 5 行格式）", async () => {
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
  expect(frame).toContain("⎿ hi");
  // 不出现溢出标记
  expect(frame).not.toContain("… +");
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
  // statusMap 缺位 → 等同 running 态：不画结果预览（spec D4 未配对不渲染）。
  expect(frame).toContain("[运行中] bash");
  expect(frame).not.toContain("⎿");
  await setup.renderer.destroy();
});

test("D4 keep 足迹：bash 落定后标题 + ⎿ 结果预览都留（不随折叠消失）", async () => {
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
  // keep 标题行留
  expect(frame).toContain("[完成] bash · ls");
  // bash 结果预览块（⎿）留
  expect(frame).toContain("⎿ a.ts");
  expect(frame).toContain("⎿ b.ts");
  await setup.renderer.destroy();
});
