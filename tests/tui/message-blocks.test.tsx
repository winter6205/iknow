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
