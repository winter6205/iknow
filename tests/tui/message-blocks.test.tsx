/** @jsxImportSource @opentui/react */
/**
 * tests/tui/message-blocks.test.tsx — #343 T6-B MessageBlocks 渲染验收。
 *
 * 覆盖范围（bun:test）：
 *  - user 消息 → ❯ accent 前缀，无 Markdown 渲染；
 *  - system 消息 → 独立分支：[已打断] 前缀 + 固定文案 Interrupted by user.，
 *    不进 Markdown 解析（#392 T3）；
 *  - assistant 文本 → Markdown 渲染（headings/code/lists 节选）；
 *  - thinking 折叠（默认）：单行 `[思考]` 文案；
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

test("thinking 折叠态：渲染 [思考] 单行（默认）", async () => {
  const msg: AnthropicNativeMessage = {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "链上推理明细…", signature: "sig-1" },
      { type: "text", text: "正式回答" },
    ],
  };
  const setup = await renderBlocks(msg);
  const frame = setup.captureCharFrame();
  expect(frame).toContain("[思考]");
  // 折叠态不渲染 thinking 明文。
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
  // 折叠摘要行 + 展开正文都出现。
  expect(frame).toContain("[思考]");
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

test("thinking 折叠态 + thinkingSeconds=0：渲染 `[思考]`（不显「思考了 0 秒」伪精度）", async () => {
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
  // 子秒 thinking（秒数 0）→ 历史折叠行回落 `[思考]`，不显伪精度。
  expect(frame).toContain("[思考]");
  expect(frame.includes("思考了")).toBe(false);
  expect(frame).toContain("正式回答");
  await setup.renderer.destroy();
});

test("thinking 折叠态 + bash tool_use：无 thinkingSeconds → `[思考]`（无 ran 后缀）", async () => {
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
  // 2026-08-14：无 thinkingSeconds → 折叠行只显 `[思考]`（纯折叠标记），
  // ran-N 后缀不再拼上 —— 避免 `[思考] · ran 1 command` 与工具行 ran-N
  // 双处重复计数造成混乱观感。
  expect(frame).toContain("[思考]");
  expect(frame.includes("ran")).toBe(false);
  await setup.renderer.destroy();
});

test("thinking 折叠态 + thinkingSeconds + bash：`思考了 3 秒 · ran 1 command`（turn 级统一摘要）", async () => {
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
  // 折叠行 = `思考了 3 秒 · ran 1 command`（turn 级统一摘要 —— 对齐参考
  // 样式 `Thought for 3s, ran 1 shell command`：思考时长 + 工具计数合并）。
  expect(frame).toContain("思考了 3 秒 · ran 1 command");
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
// ChatView wrapper `<box marginTop>` 提供，但折叠（hideToolSummaries）后
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

test("hideToolSummaries + hideThinking：无预览的纯工具消息整体返回 null（不留空壳）", async () => {
  // turn 结束折叠后，只含 thinking + 无预览工具（bash / 搜索类）的
  // assistant 消息不再有任何可见内容 —— 必须返回 null，让 ChatView 的
  // 消息间距（marginTop prop）随之消失，否则每条空消息残留 1 行幻影空白。
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
      hideToolSummaries={true}
      marginTop={1}
    />,
    { width: COLS, height: 10, exitOnCtrlC: false }
  );
  await setup.waitForVisualIdle();
  const frame = setup.captureCharFrame();
  expect(frame.trim()).toBe("");
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

test("hideToolSummaries：不画 [完成] 行，write 预览仍在", async () => {
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
      statusMap={
        new Map([
          ["tu-w", false],
          ["tu-b", false],
        ])
      }
      hideThinking={true}
      hideToolSummaries={true}
    />,
    { width: COLS, height: 40, exitOnCtrlC: false }
  );
  await setup.waitForVisualIdle();
  const frame = setup.captureCharFrame();
  expect(frame.includes("[思考]")).toBe(false);
  expect(frame.includes("[完成]")).toBe(false);
  expect(frame.includes("bash · ls")).toBe(false);
  expect(frame).toContain("export const x = 1;");
  await setup.renderer.destroy();
});
