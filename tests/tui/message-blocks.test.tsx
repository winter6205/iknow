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

test("tool_use 完成态折叠摘要：bash 单次 → ran 1 command 追加（T4）", async () => {
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
  expect(frame).toContain("bash · npm test，ran 1 command");
  await setup.renderer.destroy();
});

test("tool_use 完成态折叠摘要：同消息多 bash → ran 2 commands（聚合计数，T4）", async () => {
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
  // 同消息 2 个 bash block：两个摘要行都追加聚合 ran 2 commands。
  expect(frame).toContain("bash · npm test，ran 2 commands");
  expect(frame).toContain("bash · git status，ran 2 commands");
  await setup.renderer.destroy();
});

test("tool_use 非 bash 工具（write_file）：不追加 ran 计数（T4）", async () => {
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

test("thinking 折叠态 + bash tool_use：`[思考] · ran 1 command`（无时间）", async () => {
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
  // 折叠行 = `[思考] · ran 1 command`（无时间）。精确定位子串，避免
  // `[运行中] bash · ls` 摘要行里误带的 `·` 假阳性。
  expect(frame).toContain("[思考] · ran 1 command");
  await setup.renderer.destroy();
});

test("thinking 折叠态 + thinkingSeconds + bash：`思考了 3 秒 · ran 1 command`", async () => {
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
  // 折叠行 = `思考了 3 秒 · ran 1 command`（时间 + bash 计数合并）。
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

test("tool_use preview 固定高度：content 长时渲染稳定，摘要行可见", async () => {
  // 多行 content → toolPreviewRows 产多行 diff（write_file 纯 add）。
  // preview 收进固定高度 ScrollableOutputRegion，不撑开渲染帧；摘要行仍在。
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
      statusMap={new Map()}
    />,
    { width: 40, height: 12, exitOnCtrlC: false }
  );
  await setup.waitForVisualIdle();
  const frame = setup.captureCharFrame();
  // 摘要行（单行，不折）可见。
  const sumLines = frame.split("\n").filter((l) => l.includes("[运行中]"));
  expect(sumLines.length).toBeGreaterThan(0);
  // preview 为固定高度区：帧高 12 行，末 diff 行（line-19）可见（sticky 贴底），
  // 首 diff 行（line-00）被内部滚动折叠不可见——证明固定高度滚动，不撑开布局。
  expect(frame).toContain("line-19");
  expect(frame).not.toContain("line-00");
  await setup.renderer.destroy();
});

// -- T7：消息间距 + 底色 ------------------------------------------------
// 底色 = 渲染元数据，captureCharFrame 字符帧不含背景色 → 底色断言走结构层：
// 底色 box 包裹后渲染不崩 + 内层文本可见。
//
// 间距归属变更：消息间 1 行节奏由 ChatView wrapper `<box marginTop={i===0?0:1}>`
// 提供（chat-view.tsx:208 消息 map 循环处）。MessageBlocks 根 box 不再自带
// marginTop——单条 MessageBlocks 渲染时首行前无 padding 空白行（T9 抖动修复
// 后的 SSOT 边界）。本节 T7 测试用「wrapper 模拟 ChatView」模式恢复间距验证。

test("T7 多消息交替：wrapper marginTop={i===0?0:1} 提供 1 行节奏（首条无 margin）", async () => {
  const messages: AnthropicNativeMessage[] = [
    { role: "user", content: [{ type: "text", text: "第一条提问" }] },
    {
      role: "assistant",
      content: [{ type: "text", text: "第一个回答" }],
    },
    { role: "user", content: [{ type: "text", text: "第二条提问" }] },
  ];
  // 模拟 ChatView wrapper 模式：每条消息外层 <box marginTop={i===0?0:1}>。
  const setup = await testRender(
    <>
      {messages.map((message, i) => (
        <box key={i} width={COLS} marginTop={i === 0 ? 0 : 1}>
          <MessageBlocks
            message={message}
            cols={COLS}
            statusMap={emptyStatusMap()}
          />
        </box>
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
  // 单条 MessageBlocks 渲染：根 box 无 marginTop → 文本首行 = frame[0]，
  // 底色块紧贴内容（paddingY=0）；间距由 ChatView wrapper 提供。
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
