/** @jsxImportSource @opentui/react */
/**
 * tests/tui/message-blocks.test.tsx — #343 T6-B MessageBlocks 渲染验收。
 *
 * 覆盖范围（bun:test）：
 *  - user 消息 → ❯ accent 前缀，无 Markdown 渲染；
 *  - system 消息 → 独立分支：[已打断] 前缀 + 固定文案 Interrupted by user.，
 *    不进 Markdown 解析（#392 T3）；
 *  - assistant 文本 → Markdown 渲染（headings/code/lists 节选）；
 *  - thinking 折叠（默认）：无秒数不画摘要；有秒 → `Thought for Ns`（1 行）；
 *  - thinking 展开：thinking 文本全文 + redacted 占位；
 *  - tool_use 摘要行 + statusMap 驱动 ok/failed/running 染色（running 走英文
 *    过程行，无 `[运行中]` 括号）；
 *  - content 边界：空文本 user 消息返回 null，不渲染任何节点。
 *  - T7 间距 + 底色：消息块根 marginTop={1} → 字符帧消息间出现空白分隔行；
 *    底色为渲染元数据（captureCharFrame 字符帧不含背景色），结构层断言 =
 *    底色 box 包裹后渲染不崩 + marginTop 空行存在。
 *
 * 渲染形态 OpenTUI 元素树（禁 ink Box/Text 原语）。captureCharFrame 文本断言。
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

test("graph_mode 三条现势通知注入：不渲染为 ❯ 用户气泡（SC7 帧级）", async () => {
  // spec D8 / SC7：与 agent_status 同纪律同谓词面（isGraphModeText）。
  // 三条常量（翻转 ON / 翻转 OFF / 每拍 presence）都不得上屏 —— 帧里既无
  // ❯ 气泡，也不出现标签本身。
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
  // #tui-render-overhaul T3:成功态去掉 [完成] 前缀,状态由颜色表达。
  expect(frame).toContain("bash · npm test");
  expect(frame.includes("[完成]")).toBe(false);
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
  // 同消息 2 个 bash block：摘要行只显 `bash · detail`，去 [完成] 前缀。
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
  // #tui-render-overhaul T3:成功态无 [完成] 前缀。
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
  // 新格式（spec D2 / CONTEXT `unit fold`）：折叠行 = `Thought for 3s`
  // （英文，替换 [思考] 标记）。
  expect(frame).toContain("Thought for 3s");
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
  // 不变式（spec D2 / CONTEXT `unit fold`）：折叠时长行只到
  // `Thought for 3s`，原 `ran N command(s)` 第二行语义整体废弃 ——
  // 计数只出现在 turn 级 `name × N` 折叠行，不在 message 级摘要里。
  expect(frame).toContain("Thought for 3s");
  expect(frame.includes("ran 1 command")).toBe(false);
  expect(frame.includes("思考了")).toBe(false);
  expect(frame.includes("[思考]")).toBe(false);
  await setup.renderer.destroy();
});

test("tool_use 状态染色：statusMap 缺位 = 过程行（无 [运行中]），failed = [失败]，成功 = 无状态前缀", async () => {
  // #tui-render-overhaul T3:成功态去掉 [完成] 前缀，状态由颜色/glyph 表达。
  // spec D1（本轮）:running 也去掉 `[运行中]` —— 过程行改为英文
  // `name · detail`，状态只由颜色表达。失败仍保留 `[失败]` 明示前缀。
  const okStatus = new Map<string, boolean>([["tu-ok", false]]);
  const failedStatus = new Map<string, boolean>([["tu-fail", true]]);
  const cases: ReadonlyArray<{
    readonly name: string;
    readonly id: string;
    readonly map: ReadonlyMap<string, boolean>;
    readonly mark: string;
    /** 成功态的额外字节校验:成功态无 [完成]。 */
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
      // #tui-render-overhaul T3:成功态无 [完成] 前缀(由颜色表达)。
      expect(frame.includes("[完成]")).toBe(false);
    }
    // spec D1：三条分支（成功 / 失败 / 未配对）都不出现 `[运行中]`。
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
  // spec D1：running 过程行 = `write_file · <detail>`（英文，无状态括号），
  // 且 cols=20 下仍收口在单行内（wrapMode none → 视觉裁剪，不折行）。
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
  // #tui-render-overhaul T3:成功态无 [完成] 前缀 → 改用 write_file 行内
  // 内容断言「write_file」标题与「line-00」预览共存。
  expect(frame).toContain("write_file");
  expect(frame).toContain("line-00");
  expect(frame).not.toContain("line-19");
  // spec D3 / CONTEXT `write create preview`：溢出文案英文 `+N more lines`
  // （20 行正文 − 10 行窗 = 10 行溢出）。
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
  // #tui-render-overhaul T3:成功态无 [完成] 前缀 → 改用内容断言。
  expect(frame).toContain("edit_file");
  expect(frame).toContain("-old");
  expect(frame).toContain("+new");
  expect(frame.includes("[完成]")).toBe(false);
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
  // D1：过程行是英文 live tool line，无 `[运行中]` 括号；行数只在 content
  // 已成形时出现（此处 input 是权威完整 input → 2 行）。
  expect(frame).toContain("write_file · Wrote a.ts (2 lines)");
  expect(frame.includes("[运行中]")).toBe(false);
  expect(frame).not.toContain(bodyLine);
  expect(frame).not.toContain("second-body-line");
  await setup.renderer.destroy();
});

test("纯 retract 工具落定消息：全部收起 → 渲染为 null（无幻影空壳）", async () => {
  // D3/D7（spec specs/tui-tool-settled-appearance.md）：纯 read_file 消息
  // 落定后标题与预览同假（retract）→ MessageBlocks 返回 null，不留空壳
  // box（空壳会让消息间距残留幻影空白）。
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
  // 帧内不得出现任何工具痕迹（null 契约在帧上的投影 = 空白帧；
  // captureCharFrame 恒返回铺满空白的画布，故以「无内容字符」判定）。
  expect(frame.includes("read_file")).toBe(false);
  expect(frame.includes("[完成]")).toBe(false);
  expect(frame.includes("[失败]")).toBe(false);
  expect(frame.trim().length).toBe(0);
  // 结构层：spans 无非空 span —— 空白帧 + 零内容 span 共同钉住 null 契约。
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

// -- 子代理工具专属显示（plans/tui-chrome-interaction.md T7） ---------------
// 不变式：子代理工具不再以 `▣ 子代理` 形态作为 live/history 工具卡（dual
// render 移除）——状态由 identity strip（prompt 上方）+ SubagentPanel 表达，
// 工具卡仅显示 detail。

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
  // spec D1 / CONTEXT `live tool line`：running 的 bash 过程行带
  // `Running 1 shell command…` 前缀且命令可见，无状态括号。
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
  // #tui-render-overhaul T3:成功态无 [完成] 前缀。
  expect(doneFrame).toContain("bash · npm test");
  expect(doneFrame.includes("[完成]")).toBe(false);
  await setupDone.renderer.destroy();
});

test("D7 slot：bash 完成 → 标题留、结果预览不留（CONTEXT keep class）", async () => {
  // docs/CONTEXT.md keep class：bash 成功只留带命令的标题，不带结果预览
  // —— result preview 只属于 live running，成功落定后不画（slot.showTitle
  // 真、showPreview 假）。
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
  // #tui-render-overhaul T3:成功态无 [完成] 前缀。
  expect(frame).toContain("bash · ls");
  expect(frame.includes("[完成]")).toBe(false);
  await setup.renderer.destroy();
});

function rgbaEq(a: RGBA, b: RGBA): boolean {
  return a.r === b.r && a.g === b.g && a.b === b.b;
}

/** 抓含 needle 文本的 span 的 fg（无匹配 → undefined）。 */
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

// -- SC4（spec D5）：失败横切 —— 红标题 + 一行短错误，不 dim 堆长文 -------

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
  // 标题行保留（[失败] 形态）。
  expect(frame).toContain("[失败]");
  // 一行短错误：错误内容以单行截断形态出现（首行文本在场）。
  expect(frame).toContain("[worktree_isolation]");
  // 整个失败块只占 1 行标题 + 1 行错误（不摊开长回执多行）。
  const failLines = frame
    .split("\n")
    .filter(
      (l) =>
        l.includes("worktree_isolation") || l.includes("workspace mutation")
    );
  expect(failLines.length).toBe(1);
  await setup.renderer.destroy();
});

test("SC4 失败件：无 dim 五行走 ⎿ 块堆长文", async () => {
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
  // 失败件不画 dim ⎿ 结果预览（D5：不堆长文；长 stderr 只进一行短错误）。
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
  // 失败不落 dim（dim 只属成功 bash 尾巴）。
  const dimFg = RGBA.fromHex(tuiPalette.dim);
  expect(rgbaEq(fg!, dimFg)).toBe(false);
  await setup.renderer.destroy();
});

test("SC5 accent 成功：skill 落定行走 accent 色，无 skill 正文五行走预览", async () => {
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
  // 人读表述：`skill <name>`（D6）。
  expect(frame).toContain("skill playwright-cli");
  // 不摊 skill 正文（无 ⎿ 五行走预览）。
  expect(frame.includes("⎿")).toBe(false);
  expect(frame.includes("body-5")).toBe(false);
  // accent 色 token 落到标题行（非 dim）。
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
  // D1（specs/tui-human-display.md）人读过程行随摘要注册表改英文并点名目标
  // （specs/create-worktree-tools.md D5：人读行用新注册名，语义仍是 task
  // worktree）。accen 色断言不变 —— 强于旧断言的是此处再加「无中文残留」。
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
  // accent 失败不得落 accent 色。
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
  // marginTop={1} → 文本上方恰 1 行空白。
  expect(textLine).toBe(1);
  await setup.renderer.destroy();
});

// -- #tui-render-overhaul T2:keep / accent 标题不再 dim,accent 加 bold ---------
//
// 不变式：
//  - keep 标题（bash / write_file 等成功落定）走正文色 token,不再走 dim ——
//    dim 只属装饰（结果预览前缀/溢出、折叠行、思考摘要）；
//  - accent 标题（skill / create-task-worktree 等）保持 accent 色 + 加 bold,
//    让「点名的稀有能力」在终端里看得出来（theme.ts 的 accent 与正文几乎
//    同色,光改色值不够,故加 bold 区分）；
//  - 副作用：RUNNING_SLOT 也是 default → 改后 running 态标题从 dim 变 text,
//    让 running 态更醒目（用户诉求：running 是用户在等的动作,该清楚）。
//
// 不动 theme.ts 色值；只在 message-blocks / live-tool-preview 的渲染映射
// 处把 default 改 tuiPalette.text,并给 accent 加 <b>。

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
  // 钉死不变式:不得是 dim。
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
  // OpenTUI TextAttributes.BOLD = 1 << 0 = 1。
  const { lines } = setup.captureSpans();
  const skillSpans = lines
    .flatMap((l) => l.spans)
    .filter((s) => s.text.includes("skill playwright-cli"));
  expect(skillSpans.length).toBeGreaterThan(0);
  for (const span of skillSpans) {
    expect(rgbaEq(span.fg, expectedAccent)).toBe(true);
    // BOLD 位掩码 1;其它位不强制,只断言 BOLD 已设。
    expect(span.attributes & 1).toBe(1);
  }
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

test("D4 bash 历史：落定只留标题，stdout 不上屏（无 ⎿ / 无溢出标记）", async () => {
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
  // CONTEXT keep class：成功 bash 落定后只留标题，stdout/⎿ 尾巴整块不画
  //（result preview 只属于 live running）。长 stdout 一行都不上屏。
  expect(frame).toContain("bash · ls");
  expect(frame.includes("⎿")).toBe(false);
  expect(frame).not.toContain("out-0");
  expect(frame).not.toContain("out-5");
  expect(frame).not.toContain("out-9");
  // 溢出标记也不出现（无预览块即无溢出行）。
  expect(frame).not.toContain("… +5 行");
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
    // #tui-render-overhaul T3:成功态无 [完成] 前缀 → 改用 bash 标题内容断言。
    expect(frame, `case=${c.label}`).toContain("bash");
    expect(frame, `case=${c.label}`).not.toContain("⎿");
    expect(frame, `case=${c.label}`).not.toContain("[完成]");
    await setup.renderer.destroy();
  }
});

test("D4 bash ANSI 透传：落定 bash 无 ⎿ 预览行，stdout 不上屏", async () => {
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
  // CONTEXT keep class：成功 bash 落定只留标题；stdout（含 ANSI）整块不上
  // 屏 —— result preview 只属于 live running。
  expect(frame).toContain("bash · x");
  expect(frame.includes("⎿")).toBe(false);
  expect(frame.includes("ERROR")).toBe(false);
  expect(frame.includes("OK")).toBe(false);
  await setup.renderer.destroy();
});

test("D4 bash 单行输出：落定后 stdout 不上屏（仅标题）", async () => {
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
  // CONTEXT keep class：bash 成功只留标题，stdout（即使单行）不上屏 ——
  // 断言用 `⎿ hi`（标题 `bash · echo hi` 本身含 "hi"，不能拿裸 "hi" 判）。
  expect(frame).toContain("bash · echo hi");
  expect(frame.includes("⎿")).toBe(false);
  expect(frame.includes("⎿ hi")).toBe(false);
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
  // spec D1：过程行是英文 live tool line（running bash 带 `Running 1 shell
  // command…` 前缀 + 可见命令），无 `[运行中]` 括号。
  expect(frame).toContain("Running 1 shell command… · ls");
  expect(frame.includes("[运行中]")).toBe(false);
  expect(frame).not.toContain("⎿");
  await setup.renderer.destroy();
});

test("D4 keep 足迹：bash 落定只留标题（stdout 不上屏）", async () => {
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
  // keep 标题行留（#tui-render-overhaul T3:成功态无 [完成] 前缀）。
  expect(frame).toContain("bash · ls");
  // CONTEXT keep class：bash 成功只留标题（带命令），stdout/⎿ 尾巴整块
  // 不上屏 —— 与 write/edit 不同（write/edit 仍走 6 行预览窗）。
  expect(frame).toContain("bash · ls");
  expect(frame.includes("⎿")).toBe(false);
  expect(frame).not.toContain("a.ts");
  expect(frame).not.toContain("b.ts");
  expect(frame.includes("[完成]")).toBe(false);
  await setup.renderer.destroy();
});

// -- T4：assistant 内部块间 1 行间距（#tui-render-overhaul T4）--------------
// assistant 内多个节点（thinking 折叠 / thinking 明文 / 文本 / 工具行 /
// 错误行）顺序渲染时，相邻节点之间补 1 行空白；首块不补顶 margin。跨
// MessageShell 内容宽度内做行差判定（captureCharFrame 返回整帧字符串）。

test("T4 assistant 内部块：thinking 折叠 + 工具行 + 文本，节点间 1 行空白", async () => {
  // 三个不同类型的节点顺序：thinking 折叠（带秒数）→ bash 工具行 → 文本。
  // 折叠行 / 工具行 / 文本行各占 1 行；节点间应有 1 行空白。
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
  // 锚点行号。
  const thinkIdx = lines.findIndex((l) => l.includes("Thought for 3s"));
  const bashIdx = lines.findIndex((l) => l.includes("bash ·"));
  const textIdx = lines.findIndex((l) => l.includes("跑完了"));
  expect(thinkIdx).toBeGreaterThanOrEqual(0);
  expect(bashIdx).toBeGreaterThanOrEqual(0);
  expect(textIdx).toBeGreaterThanOrEqual(0);
  // #tui-render-overhaul T4:节点间 1 行空白（≥ 2 行差 = 1 行间距）。
  expect(bashIdx - thinkIdx).toBeGreaterThanOrEqual(2);
  expect(textIdx - bashIdx).toBeGreaterThanOrEqual(2);
  // 首块（思考折叠行）位于第 0 行,无顶部 margin。
  expect(thinkIdx).toBe(0);
  await setup.renderer.destroy();
});

test("T4 assistant 单块无内部空白：仅 1 个文本块时,文本独占首行", async () => {
  // 仅 1 个节点时不应有空白行（首块不补顶 margin,且无后续节点可比）。
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
  // spec D2：message 级思考折叠只有 `Thought for <duration>` 一行；原
  // `ran M commands` 第二行语义整体废弃（计数只属 turn 级 `name × N` 折叠），
  // 因此本块恒 1 行，块间间距判定回到「折叠行 → 工具行」。
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
  // 折叠块只有 1 行（无 `ran N command(s)` 第二行）。
  expect(frame.includes("ran 1 command")).toBe(false);
  // 折叠行与下一块 bash 之间补 1 行空白（≥ 2 行差）。
  expect(bashIdx - thinkIdx).toBeGreaterThanOrEqual(2);
  await setup.renderer.destroy();
});

/**
 * plans/tui-chrome-interaction.md Task 5：skill-load 投影在 user 分支渲染。
 *  - 命中形态 → chip-only（remainder 空）/ chip+remainder（remainder 非空），
 *    正文（SKILL body）绝不进 ❯ 气泡；
 *  - 拒绝形态（短前缀命中但 name 没闭合 / 不以 [skill-load 开头）→ 走
 *    现有 user 文本路径（视为普通 user 输入）；
 *  - 中文 `[加载技能 echo]` 历史 displayText（非 skill-load 闭合形态）→
 *    仍按普通 user 文本显示（不误投影为 chip）。
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
    // SKILL body 不进 ❯ 气泡（也不进任何文本节点）：
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
    // body 不进任何文本节点：
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
    // 巨大 body 不应泄漏（也不应触发 wrap 之后的整篇渲染）。
    expect(frame.includes("xxxxxx")).toBe(false);
    await setup.renderer.destroy();
  });

  test("malformed `[skill-load name=...]`（短前缀命中但 name 没闭合）→ 走普通 user 文本", async () => {
    const msg: AnthropicNativeMessage = {
      role: "user",
      content: [
        {
          type: "text",
          // 形态破坏：name=echo] 后缺 `\n` 引导 → projection 拒绝。
          text: "[skill-load name=echo]\nbody\n\n帮我做 X",
        },
      ],
    };
    const setup = await renderBlocks(msg);
    const frame = setup.captureCharFrame();
    // 不投影为 chip，整段原样进 ❯ 气泡：
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
