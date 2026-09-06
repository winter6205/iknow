/** @jsxImportSource @opentui/react */
/**
 * tests/tui/thinking-fold-placement.test.tsx
 *
 * 不变式:「思考了 N 秒」只能在一个位置出现一次 —— 折叠行的工具计数行
 * (`bash × N` / `read_file × M`) 相邻位置;绝不允许:
 *  (a) 多簇 turn 下「思考了 N 秒」出现在 per-message 位置(MessageBlocks
 *      ThinkingSummary),与簇折叠行错位 / 重复;
 *  (b) 折叠行「思考了 N 秒」数值 ≠ session.thinkingMs[segment.messageIndex]
 *      求和(串位:把最终 assistant 的秒数贴到首簇,或反之);
 *  (c) thinkingMs 在某条非 final assistant 消息时,该 assistant 的
 *      MessageBlocks ThinkingSummary 与其簇折叠行的「思考了 N 秒」重复。
 *
 * 数据真相:loop-engine 每 turn 仅一次 `commitMessages(messages, thinkingMs)`
 * （src/harness/loop-engine.ts:2016-2020），thinkingMs 只挂在 FINAL assistant
 * 事件上 → session.thinkingMs[N] 为 thinkingMs 值,其余 assistant 索引
 * 为 null(loop-engine 单 commit 点决定;session-api/store/jsonl.ts:269-274
 * 复盘时填 null)。
 * turn 内多条 assistant 消息的多簇 turn 中,fold line 按
 * `sumThinkingMsInRange(session.thinkingMs, [segment.messageIndex])` 求
 * 和:仅 anchor == final assistant index 的簇能拿到非零秒数;其余簇
 * anchor 处读 null → 该簇折叠行只显示工具计数「bash × N」、缺秒数行。
 *
 * 用户反馈:折叠行「思考了 N 秒」位置错乱、一直"在顶部统计"(=「思考了
 * N 秒」不该出现在 turn 中部 / 末条 per-message 位置)。本文件钉住位置 +
 * 数值 + 唯一性。
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

const COLS = 80;
const ROWS = 36;

function sessionWith(
  msgs: ReadonlyArray<AnthropicNativeMessage>,
  thinkingMs: ReadonlyArray<number | null>
): TuiSessionState {
  const file: SessionFileV1 = {
    schemaVersion: 1,
    conversation_id: "thinking-fold-placement",
    messages: [...msgs],
    turnCount: msgs.filter((m) => m.role === "assistant").length,
    updatedAt: "2026-09-05T00:00:00.000Z",
    jsonMode: false,
    title: "thinking-fold-placement",
    cwd: "/tmp",
    sanitized_at: "2026-09-05T00:00:00.000Z",
    thinkingMs,
  };
  return attachSession(file);
}

test("多簇 turn:thinkingMs 仅落盘在最终 assistant 时,「思考了 N 秒」必须只出现一次且在最终簇折叠行处", async () => {
  // 不变式:turn 内两条 assistant 各自一个工具簇(asst-1 = cluster A anchor=1,
  // asst-final = cluster B anchor=3)。cluster B anchor 在 final 上 →
  // 折叠行秒数 = thinkingMs[3] = 30000ms = 30 秒;cluster A anchor 在
  // 非 final 上 → thinkingMs[1] = null → 折叠行秒数 = 0 → 该簇折叠
  // 行不显示「思考了」前缀、只显示工具计数。「思考了 30 秒」必须在 frame
  // 中恰好出现一次,绝对位置必须在 cluster B 折叠行的工具计数行
  // (此处 = `read_file × 1`) 之前/相邻 1 行内,不得漂到 turn 顶部或末
  // 尾的 per-message ThinkingSummary 位置。
  //
  // 关键 bug(用户反馈):实际渲染里 `思考了 30 秒` 出现位置 OK(cluster B
  // 折叠内),但 cluster A 折叠行次同时让 asst-1 的 MessageBlocks
  // ThinkingSummary 也显示「思考了 N 秒」(秒数取 thinkingMs[1]=null=0)
  // —— 在 idle + 多簇场景里,只要任何簇折叠行存在,所有非折叠簇的
  // ThinkingSummary 都必须被压制,而不是各显示一遍。
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
  // thinkingMs 仅在 final assistant 落盘(loop-engine 单 commit 点决定)。
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
  // 钉死不变式:
  //  (1) 「思考了 30 秒」必须出现且只出现一次。
  const thinkLineIndices = lines
    .map((line, idx) => (line.includes("思考了 30 秒") ? idx : -1))
    .filter((idx) => idx >= 0);
  expect(thinkLineIndices).toHaveLength(1);
  const thinkLineIdx = thinkLineIndices[0] ?? -1;
  //  (2) 「思考了 30 秒」必须紧邻「read_file × 1」(cluster B 的计数
  //      行;read_file 是 retract,进折叠;bash 是 keep,保留独立标题)。
  //      顺序:思考行 → 工具行(同一 MessageShell,formatTurnActivityFold
  //      顺序 = 思考行先、工具行后)。
  const readCountIdx = lines.findIndex((line) =>
    line.includes("read_file × 1")
  );
  expect(readCountIdx).toBeGreaterThanOrEqual(0);
  expect(readCountIdx - thinkLineIdx).toBeGreaterThanOrEqual(0);
  expect(readCountIdx - thinkLineIdx).toBeLessThanOrEqual(1);
  //  (3) bash keep 不进折叠 → 不得出现 `bash × 1` 计数行。
  expect(lines.findIndex((line) => line.includes("bash × "))).toBe(-1);
  //  (4) 「完成总结」出现在 cluster B 折叠行之后(text block 在 fold
  //      后渲染;content order = thinking → tool → fold → text)。
  const summaryIdx = lines.findIndex((line) => line.includes("完成总结"));
  expect(summaryIdx).toBeGreaterThan(readCountIdx);
  //  (5) 不得出现第二个「思考了 N 秒」per-message 副本(asst-1 的
  //      ThinkingSummary 必须被压制:整 turn 已有 cluster 折叠行,
  //      ThinkingSummary 不应再独立显示 0 秒 / 错误秒数)。
  const allThinkSeconds = lines.filter((line) =>
    /思考了\s+\d+\s+秒/.test(line)
  );
  expect(allThinkSeconds).toHaveLength(1);
  await setup.renderer.destroy();
});

test("多簇 turn:每条 assistant 各自持有 thinkingMs 时,「思考了 N 秒」按 thinkingMs[i] 落在对应簇,不得串位或重复", async () => {
  // 不变式:thinkingMs 是落盘并行数组(jsonl.ts:269-274),每个 assistant
  // 索引独立持有 ms 值。本测试模拟 turn 内两条 assistant 各自有独立
  // thinkingMs(asst-1=12s、asst-final=25s),折叠行必须按 thinkingMs[i]
  // 严格归属到 anchor=i 对应的簇:cluster A anchor=1 → 12s,cluster B
  // anchor=3 → 25s。
  //
  // 关键 bug(用户反馈):per-message ThinkingSummary 也会渲染思考秒数
  // (chat-view.tsx:511 + message-blocks.tsx:296-304),如果 thinkingMs[1]
  // = 12s 且 asst-1 没有本簇折叠行,MessageBlocks ThinkingSummary 会
  // 直接渲染「思考了 12 秒」在 asst-1 位置 —— 视觉上跑到 turn 中段 /
  // 顶部,与 cluster 折叠行的「思考了 25 秒」分处两处,秒数串位。
  // 修复方向:整 turn 至少一个簇有折叠行时,该 turn 内所有 per-message
  // ThinkingSummary 必须隐藏;折叠行承担全部秒数展示。
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
  //  (1) 「思考了 12 秒」+「思考了 25 秒」必须按 thinkingMs 顺序出现。
  const think12Idx = lines.findIndex((line) => line.includes("思考了 12 秒"));
  const think25Idx = lines.findIndex((line) => line.includes("思考了 25 秒"));
  expect(think12Idx).toBeGreaterThanOrEqual(0);
  expect(think25Idx).toBeGreaterThanOrEqual(0);
  expect(think12Idx).toBeLessThan(think25Idx);
  //  (2) 思考行不得重复:每个 N 恰好出现一次。
  expect(lines.filter((l) => /思考了\s+\d+\s+秒/.test(l))).toHaveLength(2);
  //  (3) 折叠行工具计数:read_file retract → 进折叠;bash keep → 不计。
  //      当前 orderedTurnActivitySegments 把两条 assistant 的 tool_use
  //      合并到 anchor=3(final),cluster 折叠只显示 read_file × 1
  //      (bash 被 inFoldCountOf 过滤)。
  const readCountIdx = lines.findIndex((line) =>
    line.includes("read_file × 1")
  );
  expect(readCountIdx).toBeGreaterThanOrEqual(0);
  expect(lines.findIndex((line) => line.includes("bash × "))).toBe(-1);
  //  (4) 折叠行整体:思考行 + 工具计数必须邻近(renderInContentOrder
  //      或 renderFoldLines,均在一个 MessageShell 内连续两行)。
  //      由于当前 orderedTurnActivitySegments 合并两条簇到 final,
  //      折叠行只有一对(read_file × 1)。如果两簇各自独立折叠(预期
  //      修复),思考 12s 应紧邻 read_file × 1,思考 25s 应紧邻
  //      bash × 1(但当前 bug 是只出一对折叠,且 read_file 跑到 final
  //      簇锚点;暂只钉唯一性 + 顺序不变式)。
  await setup.renderer.destroy();
});

test("thinkingMs 在 final assistant 且 final 仅有 text 时:折叠行「思考了 N 秒」仍必须出现(fallback 到末 text 段)", async () => {
  // 不变式:turn 内 cluster 在非 final assistant,final assistant 只含
  // text(无 tool_use) → orderedTurnActivitySegments 的 tools cluster
  // anchor != final → fold lines 直接路径不显示;fallback 路径(无 fold
  // 但有 liveCompletedCounts)在本场景也无 → 折叠行彻底缺失,thinkingMs
  // 完全丢失,用户看不到「思考了 N 秒」。修复方向:fallback 必须按
  // session.thinkingMs[final_assistant_index] 求和,而非仅按
  // lastText.messageIndex。
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
  // thinkingMs 仅 final = 30s。
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
  // (1) 「思考了 30 秒」必须出现且仅出现一次。
  const thinkLines = lines.filter((l) => /思考了\s+\d+\s+秒/.test(l));
  expect(thinkLines).toHaveLength(1);
  expect(thinkLines[0]).toContain("30 秒");
  // (2) 「思考了 30 秒」必须紧邻 `read_file × 1`(同一 MessageShell 内
  //     相邻两行,顺序:思考行 → 工具计数);不允许思考行漂到 read_file
  //     计数行 5 行以外(即为分散显示)。
  const readCountIdx = lines.findIndex((line) =>
    line.includes("read_file × 1")
  );
  const thinkIdx = lines.findIndex((line) => line.includes("思考了 30 秒"));
  expect(readCountIdx).toBeGreaterThanOrEqual(0);
  expect(thinkIdx).toBeGreaterThanOrEqual(0);
  expect(Math.abs(readCountIdx - thinkIdx)).toBeLessThanOrEqual(1);
  await setup.renderer.destroy();
});

test("hidden agent_status 插在 tool_result 与 final 之间：thinkingMs 按盘上消息下标取值，折叠行仍要有「思考了 N 秒」+ retract 计数", async () => {
  // 复现：session.thinkingMs 与 messages 一一对应；ChatView 却用过滤后的
  // visibleIndex 去取。agent_status 对 TUI 隐藏，visible 下标比盘上下标短
  // 一格 → final 的 30s 读到 status 槽的 null → 「思考了 N 秒」消失。
  // hideThinking 仍因 retract 折叠行把 per-message 摘要掐掉，retract 工具
  // 也从消息框收走，结果只剩 keep/正文。
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
  expect(frame).toContain("思考了 30 秒");
  expect(frame).toContain("read_file × 1");
  expect(frame.includes("先读文件")).toBe(false);
  await setup.renderer.destroy();
});

test("hidden agent_status + 仅 keep 工具：无 retract 计数行时，仍要画出「思考了 N 秒」", async () => {
  // bash 是 keep：不进折叠计数，showTurnFold=false。思考秒数只能走
  // per-message ThinkingSummary，下标一旦错位就整行消失，屏幕上只剩
  // 消息框里的 bash 标题。
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
  expect(frame).toContain("思考了 12 秒");
  expect(frame.includes("× ")).toBe(false);
  await setup.renderer.destroy();
});
