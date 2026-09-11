/** @jsxImportSource @opentui/react */
/**
 * tests/tui/thinking-fold-placement.test.tsx
 *
 * 不变式(CONTEXT.md unit fold,2026-09-08 操作员纠正):思考**按段原位折叠**
 * —— 一段思考完成 → 在该段原位折一行 `Thought for <duration>` → 随后正文或工具;
 * 同一用户任务里下一段思考再折一行。秒数来自对应 assistant 消息自己的
 * thinkingMs(per-message 并行数组),不跨段归并:
 *  (a) 有秒数的段各画各的 `Thought for <duration>`,无秒数段不画该行、不回落
 *      `[思考]`(只画工具计数行,若 retract 在场);
 *  (b) 不得把 final assistant 的秒数贴到前段 / 末位工具簇(旧
 *      thinking-fold-placement fallback 是误读,已删除);
 *  (c) 同一 assistant 消息内的多个 tools 簇(tool → text → tool)共享
 *      同一 thinkingMs → 同消息内不重复画(去重单位 = 同一消息内的重复
 *      展示,不是「整回合至多一次」);
 *  (d) per-message ThinkingSummary 与 fold 行不重复画同一秒数;
 *  (e) turn 仍在 running 时,前段已落定的工具折叠行在后段思考开始后仍在。
 *
 * 数据真相:loop-engine 每个 assistant commit 点各传一次
 * `turnResult.thinkingMs`(src/harness/loop-engine.ts:2021-2025),
 * thinkingMs 并行数组与 messages 一一对应 —— 每条 assistant 消息独立持有
 * 自己的思考时长;历史会话经 session-api/store/jsonl 重建同一并行数组。
 */
import { expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { ChatView } from "../../src/tui/chat-view.js";
import {
  attachSession,
  type TuiSessionState,
} from "../../src/tui/session-state.js";
import type { AnthropicNativeMessage } from "../../src/harness/model-adapter/types.js";
import type { SessionFileV1 } from "../../src/session-api/store/schema.js";
import type { LiveToolRun } from "../../src/tui/live-tool-state.js";

const COLS = 80;
const ROWS = 36;

function sessionWith(
  msgs: ReadonlyArray<AnthropicNativeMessage>,
  thinkingMs: ReadonlyArray<number | null>,
  runState: "idle" | "running-fg" = "idle"
): TuiSessionState {
  const file: SessionFileV1 = {
    schemaVersion: 1,
    conversation_id: "thinking-fold-placement",
    messages: [...msgs],
    turnCount: msgs.filter((m) => m.role === "assistant").length,
    updatedAt: "2026-09-08T00:00:00.000Z",
    jsonMode: false,
    title: "thinking-fold-placement",
    cwd: "/tmp",
    sanitized_at: "2026-09-08T00:00:00.000Z",
    thinkingMs,
  };
  return runState === "idle"
    ? attachSession(file)
    : { ...attachSession(file), runState };
}

test("两轮思考→工具:有秒数的段各画各的 `Thought for`,无秒数段只画工具计数行", async () => {
  // 不变式 (a)(b) + D2(unit fold 一行):asst-1 无落盘 thinkingMs → 其
  // 计数不借用 final 的 30s;asst-final(bash keep + text)有 30s → 时长段
  // 挂它自己的簇。跨度工具簇 anchor 移到最新 assistant,therefore 时长与
  // read_file 计数焊在**同一行**(`Thought for 30s · read_file × 1`)。
  const messages: AnthropicNativeMessage[] = [
    { role: "user", content: [{ type: "text", text: "多步任务" }] },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "中段思考-1", signature: "s1" },
        {
          type: "tool_use",
          id: "tu-1",
          name: "read_file",
          input: { path: "a.ts" },
        },
      ],
    },
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "tu-1", content: "ok" }],
    },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "最终思考", signature: "s2" },
        {
          type: "tool_use",
          id: "tu-2",
          name: "bash",
          input: { command: "pwd" },
        },
        { type: "text", text: "完成总结" },
      ],
    },
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "tu-2", content: "ok" }],
    },
  ];
  // messages: user(0) asst-1(1) tool_result(2) asst-final(3) tool_result(4)
  const thinkingMs: ReadonlyArray<number | null> = [
    null,
    null,
    null,
    30000,
    null,
  ];
  const setup = await testRender(
    <ChatView
      session={sessionWith(messages, thinkingMs)}
      cols={COLS}
      rows={ROWS}
      liveToolLines={[]}
      thinkingExpanded={false}
    />,
    { width: COLS, height: ROWS, exitOnCtrlC: false }
  );
  await setup.waitForVisualIdle();
  const frame = setup.captureCharFrame();
  const lines = frame.split("\n");
  // (1) `Thought for 30s` 恰好出现一次 —— 新合同下 asst-final 自己的
  //     秒数原位落到其折叠行(没有跨段归并到 asst-1,也没有被吞)。
  const thinkLineIndices = lines
    .map((line, idx) => (line.includes("Thought for 30s") ? idx : -1))
    .filter((idx) => idx >= 0);
  expect(thinkLineIndices).toHaveLength(1);
  const thinkLineIdx = thinkLineIndices[0] ?? -1;
  // (2) asst-1 的 read_file retract 不得蒸发:orderedTurnActivitySegments
  //     把跨消息 tool_use 合并到末段簇(anchor = final assistant),因此
  //     read_file × 1 与 Thought for 30s **同一行**(D2 收类焊进结束态
  //     第一行,不是第二行)。
  const readCountIdx = lines.findIndex((line) =>
    line.includes("read_file × 1")
  );
  expect(readCountIdx).toBeGreaterThanOrEqual(0);
  expect(lines[readCountIdx]).toContain("Thought for 30s");
  // (3) bash keep 不进折叠 → 不得出现 `bash × 1` 计数行。
  expect(lines.findIndex((line) => line.includes("bash × "))).toBe(-1);
  // (4) 「完成总结」出现在秒数行附近(text block 在 fold 后渲染;
  //     若秒数行与 read_file 计数行同 fold row,顺序 = think → count →
  //     text;若两者分属不同 row,顺序仍 think 在前)。
  const summaryIdx = lines.findIndex((line) => line.includes("完成总结"));
  expect(summaryIdx).toBeGreaterThan(thinkLineIdx);
  // (5) 不重复:同一时长不得既在 fold 行又在 per-message ThinkingSummary。
  const allThinkSeconds = lines.filter((line) => /Thought for \d+s/.test(line));
  expect(allThinkSeconds).toHaveLength(1);
  await setup.renderer.destroy();
});

test("多段各自持有 thinkingMs:时长按各自 anchor 严格归属,不串位不重复", async () => {
  // 不变式 (a)(d):thinkingMs 是落盘 per-message 并行数组,每条 assistant
  // 消息独立持有 ms。跨消息工具簇投影(anchor 移到最新 assistant)下,
  // 簇折叠行取 anchor 自身时长(25s);前段(asst-1)的 12s 由其
  // per-message ThinkingSummary 原位承担 —— 12s 不得贴到 final 簇,
  // 25s 不得漂到 asst-1 位置,二者各出现一次、顺序与消息顺序一致。
  const messages: AnthropicNativeMessage[] = [
    { role: "user", content: [{ type: "text", text: "q" }] },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "思考1", signature: "s1" },
        {
          type: "tool_use",
          id: "tu-a",
          name: "read_file",
          input: { path: "a" },
        },
      ],
    },
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "tu-a", content: "ok" }],
    },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "思考2", signature: "s2" },
        {
          type: "tool_use",
          id: "tu-b",
          name: "bash",
          input: { command: "ls" },
        },
      ],
    },
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "tu-b", content: "ok" }],
    },
  ];
  const thinkingMs: ReadonlyArray<number | null> = [
    null,
    12000, // asst-1:12s
    null,
    25000, // asst-2:25s
    null,
  ];
  const setup = await testRender(
    <ChatView
      session={sessionWith(messages, thinkingMs)}
      cols={COLS}
      rows={ROWS}
      liveToolLines={[]}
      thinkingExpanded={false}
    />,
    { width: COLS, height: ROWS, exitOnCtrlC: false }
  );
  await setup.waitForVisualIdle();
  const frame = setup.captureCharFrame();
  const lines = frame.split("\n");
  // (1) `Thought for 12s` 与 `Thought for 25s` 各出现一次、按消息顺序。
  const think12Idx = lines.findIndex((line) =>
    line.includes("Thought for 12s")
  );
  const think25Idx = lines.findIndex((line) =>
    line.includes("Thought for 25s")
  );
  expect(think12Idx).toBeGreaterThanOrEqual(0);
  expect(think25Idx).toBeGreaterThanOrEqual(0);
  expect(think12Idx).toBeLessThan(think25Idx);
  // (2) 恰好两行时长(各段一次,无重复;无中文残留)。
  expect(lines.filter((l) => /Thought for \d+s/.test(l))).toHaveLength(2);
  expect(frame.includes("思考了")).toBe(false);
  // (3) read_file retract 进折叠计数并焊在进行中簇时长同一行;bash keep 不进。
  const readIdx = lines.findIndex((line) => line.includes("read_file × 1"));
  expect(readIdx).toBeGreaterThanOrEqual(0);
  expect(lines[readIdx]).toContain("Thought for 25s");
  expect(lines.findIndex((line) => line.includes("bash × "))).toBe(-1);
  await setup.renderer.destroy();
});

test("final 仅有 text:其思考时长由 per-message ThinkingSummary 原位承担,不外挂到前段折叠行", async () => {
  // 不变式 (b):final 只含 text(无 tool_use) → 无 final 侧 tools 簇;
  // 前段 read_file 簇按自身 anchor(无 ms)只画计数行。final 的 30s 在
  // 它自己的消息块原位显示(per-message ThinkingSummary),不得贴到前段
  // read_file 折叠行(旧 fallback 残留行为),也不得丢失 —— 前段计数行
  // 因此**不带**时长段(两行互不焊接)。
  const messages: AnthropicNativeMessage[] = [
    { role: "user", content: [{ type: "text", text: "q" }] },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "思考", signature: "s" },
        {
          type: "tool_use",
          id: "tu-1",
          name: "read_file",
          input: { path: "a" },
        },
      ],
    },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "tu-1",
          content: JSON.stringify({ code: 0, stdout: "body", stderr: "" }),
        },
      ],
    },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "最终总结思考", signature: "s2" },
        { type: "text", text: "完成" },
      ],
    },
  ];
  const thinkingMs: ReadonlyArray<number | null> = [null, null, null, 30000];
  const setup = await testRender(
    <ChatView
      session={sessionWith(messages, thinkingMs)}
      cols={COLS}
      rows={ROWS}
      liveToolLines={[]}
      thinkingExpanded={false}
    />,
    { width: COLS, height: ROWS, exitOnCtrlC: false }
  );
  await setup.waitForVisualIdle();
  const frame = setup.captureCharFrame();
  const lines = frame.split("\n");
  // (1) `Thought for 30s` 恰好一次,值 = final 自身 thinkingMs。
  const thinkLines = lines.filter((l) => /Thought for \d+s/.test(l));
  expect(thinkLines).toHaveLength(1);
  expect(thinkLines[0]).toContain("Thought for 30s");
  // (2) 前段折叠行只有计数(不焊接 final 时长);时长行在它之后。
  const readCountIdx = lines.findIndex((line) =>
    line.includes("read_file × 1")
  );
  const thinkIdx = lines.findIndex((line) => line.includes("Thought for 30s"));
  expect(readCountIdx).toBeGreaterThanOrEqual(0);
  expect(thinkIdx).toBeGreaterThan(readCountIdx);
  expect(lines[readCountIdx]).not.toContain("Thought for");
  // (3) 无 [思考] 回落。
  expect(frame.includes("[思考]")).toBe(false);
  await setup.renderer.destroy();
});

test("hidden agent_status 插在 tool_result 与 final 之间：thinkingMs 按盘上消息下标取值,各段秒数不丢", async () => {
  // 不变式 (a):session.thinkingMs 与 messages 一一对应;ChatView 用过滤
  // 后的 visibleIndex 时必须映射回盘上下标,否则 final 的 30s 读到
  // status 槽的 null → `Thought for` 消失。前段折叠行(无 ms)只画
  // 计数行;final 的时长原位显示。
  const messages: AnthropicNativeMessage[] = [
    { role: "user", content: [{ type: "text", text: "q" }] },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "先读文件", signature: "s1" },
        {
          type: "tool_use",
          id: "tu-1",
          name: "read_file",
          input: { path: "a.ts" },
        },
      ],
    },
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "tu-1", content: "ok" }],
    },
    {
      role: "user",
      content: [
        {
          type: "text",
          text: "<agent_status>\nlast_tool: read_file\n</agent_status>",
        },
      ],
    },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "最终总结思考", signature: "s2" },
        { type: "text", text: "完成总结" },
      ],
    },
  ];
  const thinkingMs: ReadonlyArray<number | null> = [
    null,
    null,
    null,
    null,
    30000,
  ];
  const setup = await testRender(
    <ChatView
      session={sessionWith(messages, thinkingMs)}
      cols={COLS}
      rows={ROWS}
      liveToolLines={[]}
      thinkingExpanded={false}
    />,
    { width: COLS, height: ROWS, exitOnCtrlC: false }
  );
  await setup.waitForVisualIdle();
  const frame = setup.captureCharFrame();
  expect(frame).toContain("完成总结");
  expect(frame).toContain("Thought for 30s");
  expect(frame).toContain("read_file × 1");
  expect(frame.includes("先读文件")).toBe(false);
  await setup.renderer.destroy();
});

test("hidden agent_status + 仅 keep 工具：无 retract 计数行时,仍要画出 `Thought for`", async () => {
  // 不变式 (a):bash 是 keep → 不进折叠计数;final 的 12s 由 per-message
  // ThinkingSummary 原位承担(下标映射错误时整行消失)。
  const messages: AnthropicNativeMessage[] = [
    { role: "user", content: [{ type: "text", text: "q" }] },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "跑一下", signature: "s1" },
        {
          type: "tool_use",
          id: "tu-bash",
          name: "bash",
          input: { command: "pwd" },
        },
      ],
    },
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "tu-bash", content: "ok" }],
    },
    {
      role: "user",
      content: [
        {
          type: "text",
          text: "<agent_status>\nlast_tool: bash\n</agent_status>",
        },
      ],
    },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "收尾", signature: "s2" },
        { type: "text", text: "目录如下" },
      ],
    },
  ];
  const thinkingMs: ReadonlyArray<number | null> = [
    null,
    null,
    null,
    null,
    12000,
  ];
  const setup = await testRender(
    <ChatView
      session={sessionWith(messages, thinkingMs)}
      cols={COLS}
      rows={ROWS}
      liveToolLines={[]}
      thinkingExpanded={false}
    />,
    { width: COLS, height: ROWS, exitOnCtrlC: false }
  );
  await setup.waitForVisualIdle();
  const frame = setup.captureCharFrame();
  expect(frame).toContain("目录如下");
  expect(frame).toContain("bash");
  expect(frame).toContain("Thought for 12s");
  expect(frame.includes("× ")).toBe(false);
  await setup.renderer.destroy();
});

test("running 中间态:前段已落定的工具折叠行,在后段思考开始后仍在", async () => {
  // 不变式 (e):同一用户任务内,前段(asst-1)的 read_file 簇已落定并折出
  // 计数行;下一段思考开始流式(live thinking draft 非空)时,前段折叠行
  // 不得被 running 闸或 live 面板吞掉 —— 已完成单元照折,各段各画各的。
  const messages: AnthropicNativeMessage[] = [
    { role: "user", content: [{ type: "text", text: "q" }] },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "先读文件", signature: "s1" },
        {
          type: "tool_use",
          id: "tu-rd",
          name: "read_file",
          input: { path: "a.ts" },
        },
      ],
    },
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "tu-rd", content: "ok" }],
    },
  ];
  const thinkingMs: ReadonlyArray<number | null> = [null, 8000, null];
  const setup = await testRender(
    <ChatView
      session={sessionWith(messages, thinkingMs, "running-fg")}
      cols={COLS}
      rows={ROWS}
      liveToolLines={[]}
      liveToolRuns={[]}
      thinkingExpanded={false}
      thinkingDraftMasked="第二段思考流式进行中"
    />,
    { width: COLS, height: ROWS, exitOnCtrlC: false }
  );
  await setup.waitForVisualIdle();
  const frame = setup.captureCharFrame();
  // 前段已落定的折叠行仍在(retract 计数)。
  expect(frame).toContain("read_file × 1");
  // 无 [思考] 回落;前段思考正文(折叠态)不摊开。
  expect(frame.includes("[思考]")).toBe(false);
  expect(frame.includes("先读文件")).toBe(false);
  await setup.renderer.destroy();
});

test("多段渲染 (content-order)：text 段无 fold 行但 message 的 thinkingMs 已被 tools 段 fold 行覆盖 → text 段不重复画 ThinkingSummary", async () => {
  // 不变式 (d) 的 content-order 强化：同一 assistant 拆出多段（text →
  // tools），tools 段 fold 行已显示 `Thought for Ns · read_file × 1`，
  // text 段（partIndex===0，挂 thinkingSeconds）**不得**再画一份独立的
  // `Thought for Ns`。message-row.tsx 在 #986 拆分时把 `messageThinkingMs`
  // 硬编码成 0 喂给 TurnFoldSegment，导致 content-order 分支的
  // `shownThinkingMsValues.has(...)` 子句失效 → text 段 ThinkingSummary
  // 不去重 → 屏幕上看到两条 `Thought for Ns`（一条 fold 行、一条摘要）。
  //
  // 数据构造：assistant 自身带 `thinking + text + tool_use(read_file)`,
  // tool_result 在其后。activitySegments = [text(0), tools(1)] →
  // renderInContentOrder 走 content-order 分支 → text 段是 partIndex 0
  // （挂 thinkingSeconds）,tools 段是 partIndex 1（不挂）。
  const messages: AnthropicNativeMessage[] = [
    { role: "user", content: [{ type: "text", text: "q" }] },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "想一下", signature: "s" },
        { type: "text", text: "先说结论" },
        {
          type: "tool_use",
          id: "tu-1",
          name: "read_file",
          input: { path: "a" },
        },
      ],
    },
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "tu-1", content: "ok" }],
    },
  ];
  const thinkingMs: ReadonlyArray<number | null> = [null, 12000, null];
  const setup = await testRender(
    <ChatView
      session={sessionWith(messages, thinkingMs)}
      cols={COLS}
      rows={ROWS}
      liveToolLines={[]}
      thinkingExpanded={false}
    />,
    { width: COLS, height: ROWS, exitOnCtrlC: false }
  );
  await setup.waitForVisualIdle();
  const frame = setup.captureCharFrame();
  const lines = frame.split("\n");
  // (1) `Thought for 12s` 只出现一次：tools 段 fold 行（`Thought for 12s
  //     · read_file × 1`）焊在同一行；text 段 ThinkingSummary 必须被 hide
  //     掉（message-row.tsx TurnFoldSegment 内 hideSegmentThinking 走
  //     `messageThinkingMs > 0 && shownThinkingMsValues.has(...)`）。
  const thinkLines = lines.filter((l) => /Thought for \d+s/.test(l));
  expect(thinkLines).toHaveLength(1);
  expect(thinkLines[0]).toContain("Thought for 12s");
  // (2) read_file 计数行必须在场（content-order 路径下 fold 行挂 tools 段）。
  expect(frame).toContain("read_file × 1");
  // (3) text 段正文仍在（hideThinking 只去 ThinkingSummary，不动 text block）。
  expect(frame).toContain("先说结论");
  await setup.renderer.destroy();
});
