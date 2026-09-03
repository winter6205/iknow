/** @jsxImportSource @opentui/react */
/**
 * D3 (tui-display-consistency) 折叠简化：
 *  - `inLastTurn` 门已删除 —— 折叠作用于每一轮历史;
 *  - `thinkingSeconds > 0 || turnToolTotal > 1` 闸已删除 —— 任何已完成工具
 *    轮次都折叠;running 态保持逐条可见(行为不变);
 *  - 折叠输入改用 D2 落盘的 `thinkingMs`(纯函数 sumThinkingMsInRange),
 *    由 `attachSession(file)` → `TuiSessionState.thinkingMs` 携带。
 *
 * 旧合同:有完成工具后只留一行 turn 摘要;不再铺 `[思考]` / `[完成] bash`
 * 交错 —— 仍成立。新增合同:两轮会话各自出现折叠行且旧轮 `[完成]` 行不回摊;
 * 单工具无思考秒数轮次也折叠(落盘 thinkingMs 缺席 → 折叠行只显示工具计数);
 * running 态逐条工具可见。
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
  thinkingMs?: ReadonlyArray<number | null>
): TuiSessionState {
  const file: SessionFileV1 = {
    schemaVersion: 1,
    conversation_id: "think-tool-fold",
    messages: [...msgs],
    turnCount: msgs.filter((m) => m.role === "assistant").length,
    updatedAt: "2026-08-28T00:00:00.000Z",
    jsonMode: false,
    ...(thinkingMs !== undefined ? { thinkingMs } : {}),
  };
  return attachSession(file);
}

function bashTurn(
  id: string,
  thinking: string,
  command: string
): ReadonlyArray<AnthropicNativeMessage> {
  return [
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking, signature: `sig-${id}` },
        {
          type: "tool_use",
          id,
          name: "bash",
          input: { command },
        },
      ],
    },
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: id, content: "ok" }],
    },
  ];
}

function toolResultMessage(id: string): AnthropicNativeMessage {
  return {
    role: "user",
    content: [{ type: "tool_result", tool_use_id: id, content: "ok" }],
  };
}

/** 用户截图同构：一轮提问 + 多轮「思考 → bash」+ 末条思考后回答。 */
function interleavedThinkingToolMessages(): AnthropicNativeMessage[] {
  return [
    {
      role: "user",
      content: [
        {
          type: "text",
          text: "发子代理，让他在归内文件夹写一个神圣礼堂的HTML",
        },
      ],
    },
    ...bashTurn("tu-1", "先看项目根", "ls -la /home/winner/projects/iknow/"),
    ...bashTurn("tu-2", "再看 src", "ls /home/winner/projects/iknow/src/"),
    ...bashTurn("tu-3", "再看 web", "ls /home/winner/projects/iknow/web/"),
    {
      role: "assistant",
      content: [
        {
          type: "thinking",
          thinking: "没找到归内目录，准备回答",
          signature: "sig-final",
        },
        {
          type: "text",
          text: "「归内」我没找到对应的目录",
        },
      ],
    },
  ];
}

type Marker = "think" | "tool";

function markerSequence(frame: string): Marker[] {
  const out: Marker[] = [];
  for (const raw of frame.split("\n")) {
    const line = raw.trim();
    if (line.length === 0) continue;
    if (
      line.includes("[思考]") ||
      line.startsWith("思考了 ") ||
      line.startsWith("思考中")
    ) {
      out.push("think");
      continue;
    }
    if (line.includes("[完成]") && line.includes("bash")) {
      out.push("tool");
    }
  }
  return out;
}

function thinkingAfterFirstTool(seq: ReadonlyArray<Marker>): boolean {
  const firstTool = seq.indexOf("tool");
  if (firstTool < 0) return false;
  return seq.slice(firstTool + 1).includes("think");
}

/** thinkingMs 与 messages 一一对应。null = 该位置无 thinkingMs;
 *  number(ms) = 该 assistant 回合的思考时长。三个 bashTurn 的 thinkingMs 落在
 *  index 1, 3, 5(final assistant 的思考在 index 7)。 */
function thinkingMsForInterleaved(
  values: ReadonlyArray<number | null>
): ReadonlyArray<number | null> {
  // messages: [user(0), asst-1(1), user-result(2), asst-2(3), user-result(4),
  //            asst-3(5), user-result(6), asst-final(7)]
  // values 顺序与 assistant messageIndex 对齐:values[0] → index 1,values[1]
  // → index 3,values[2] → index 5,values[3] → index 7。
  const anchors = [1, 3, 5, 7] as const;
  const out: Array<number | null> = [
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
  ];
  for (const [idx, v] of values.entries()) {
    if (v === undefined) continue;
    const anchor = anchors[idx];
    if (anchor === undefined) continue;
    out[anchor] = v;
  }
  return out;
}

test("idle：思考秒数 + 多轮 bash → 思考了 N 秒 下一行 bash × N，不铺 [完成]", async () => {
  // thinkingMs 落盘:每个 bashTurn 思考 9s,末条 final 思考 2s。`s = 30 → 30 秒 / 9 秒 × 3 = 27 秒`
  // 该用例只对末段折叠感兴趣 —— 末段 anchor = final assistant (index 7) → 2000ms → 2 秒。
  const setup = await testRender(
    <ChatView
      session={sessionWith(
        interleavedThinkingToolMessages(),
        thinkingMsForInterleaved([9000, 9000, 9000, 2000])
      )}
      cols={COLS}
      rows={ROWS}
      liveToolLines={[]}
      thinkingExpanded={false}
    />,
    { width: COLS, height: ROWS, exitOnCtrlC: false }
  );
  await setup.waitForVisualIdle();
  const frame = setup.captureCharFrame();
  // 三个 bash 折叠行（每段一个 thinkingMs = 9000ms → 9 秒）+ 末段折叠 = final
  // assistant 2000ms → 2 秒,bash × 3。
  expect(frame).toContain("思考了 9 秒");
  expect(frame).toContain("思考了 2 秒");
  expect(frame).toContain("bash × 3");
  expect(frame).not.toContain("思考了 2 秒 · bash × 3");
  expect(frame.includes("[完成]")).toBe(false);
  expect(frame.includes("[思考]")).toBe(false);
  expect(thinkingAfterFirstTool(markerSequence(frame))).toBe(false);
  await setup.renderer.destroy();
});

test("idle：两轮会话各自折叠（spec D3 全轮生效）", async () => {
  // 两轮:每轮一条 user query + assistant(thinking + bash)+ tool_result user。
  // thinkingMs = [null, 4000, null, 6000, null] (assistant 思考 4s / 6s)。
  // 旧轮 `[完成] bash` 不回摊 —— 两轮各自出现折叠行。
  const messages: AnthropicNativeMessage[] = [
    {
      role: "user",
      content: [{ type: "text", text: "第一轮提问" }],
    },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "第一轮思考", signature: "s1" },
        { type: "tool_use", id: "tu-1", name: "bash", input: {} },
      ],
    },
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "tu-1", content: "ok" }],
    },
    { role: "user", content: [{ type: "text", text: "第二轮提问" }] },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "第二轮思考", signature: "s2" },
        { type: "tool_use", id: "tu-2", name: "bash", input: {} },
      ],
    },
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "tu-2", content: "ok" }],
    },
  ];
  // messages 长度 6:asst-1 在 index 1、asst-2 在 index 4。
  const thinkingMs: ReadonlyArray<number | null> = [
    null,
    4000,
    null,
    null,
    6000,
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
  // 两轮各自出现折叠行:各带独立 thinkingMs。
  expect(frame).toContain("思考了 4 秒");
  expect(frame).toContain("思考了 6 秒");
  // 旧轮 `[完成] bash` 不回摊(全文不应出现 `[完成]`)。
  expect(frame.includes("[完成]")).toBe(false);
  // 折叠计数行两次各显示 `bash × 1`。
  expect(frame.split("bash × 1").length - 1).toBe(2);
  await setup.renderer.destroy();
});

test("idle：单工具无 thinkingMs（落盘缺席） → 也折叠（只显示 bash × 1）", async () => {
  // spec D3:旧 `thinkingSeconds > 0 || turnToolTotal > 1` 闸已删除 —— 单工具、
  // 无秒数轮次也折叠。折叠行只显示工具计数,不显示秒数行。
  const messages: AnthropicNativeMessage[] = [
    { role: "user", content: [{ type: "text", text: "q" }] },
    {
      role: "assistant",
      content: [{ type: "tool_use", id: "tu-solo", name: "bash", input: {} }],
    },
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "tu-solo", content: "ok" }],
    },
  ];
  // 全 null thinkingMs(模拟 legacy 文件 / 无落盘 thinkingMs)。
  const setup = await testRender(
    <ChatView
      session={sessionWith(messages, [null, null, null])}
      cols={COLS}
      rows={ROWS}
      liveToolLines={[]}
      thinkingExpanded={false}
    />,
    { width: COLS, height: ROWS, exitOnCtrlC: false }
  );
  await setup.waitForVisualIdle();
  const frame = setup.captureCharFrame();
  expect(frame).toContain("bash × 1");
  expect(frame.includes("[完成]")).toBe(false);
  // 无秒数 → 不显示 `思考了` 行。
  expect(frame.includes("思考了 ")).toBe(false);
  await setup.renderer.destroy();
});

test("idle：旧会话无 thinkingMs（整链缺席） → 折叠行只显示工具计数", async () => {
  // 旧会话:文件不携带 thinkingMs(SessionFileV1.thinkingMs undefined)。
  // attachSession 透传 undefined → session.thinkingMs = undefined →
  // sumThinkingMsInRange 按 0 计入 → 折叠行只显示 bash × N,不显示秒数。
  const messages: AnthropicNativeMessage[] = [
    { role: "user", content: [{ type: "text", text: "q" }] },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "x", signature: "s" },
        { type: "tool_use", id: "tu-legacy", name: "bash", input: {} },
      ],
    },
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "tu-legacy", content: "ok" },
      ],
    },
  ];
  const setup = await testRender(
    <ChatView
      session={sessionWith(messages)}
      cols={COLS}
      rows={ROWS}
      liveToolLines={[]}
      thinkingExpanded={false}
    />,
    { width: COLS, height: ROWS, exitOnCtrlC: false }
  );
  await setup.waitForVisualIdle();
  const frame = setup.captureCharFrame();
  expect(frame).toContain("bash × 1");
  expect(frame.includes("思考了 ")).toBe(false);
  await setup.renderer.destroy();
});

test("idle：文本→工具时，工具折叠出现在前置文本之后", async () => {
  // anchor = asst-with-tool (index 2) → thinkingMs[2] = 29000ms → 29 秒。
  const messages: AnthropicNativeMessage[] = [
    { role: "user", content: [{ type: "text", text: "q" }] },
    { role: "assistant", content: [{ type: "text", text: "先说明" }] },
    ...bashTurn("tu-after-text", "思考工具", "pwd"),
  ];
  const setup = await testRender(
    <ChatView
      session={sessionWith(messages, [null, null, 29000, null])}
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
  const textIdx = lines.findIndex((line) => line.includes("先说明"));
  const foldIdx = lines.findIndex((line) => line.includes("bash × 1"));
  expect(textIdx).toBeGreaterThanOrEqual(0);
  expect(foldIdx).toBeGreaterThan(textIdx);
  expect(frame).not.toContain("[完成]");
  await setup.renderer.destroy();
});

test("idle：工具→文本时，工具折叠出现在后续文本之前", async () => {
  // anchor = asst-with-tool (index 2) → thinkingMs[2] = 29000ms → 29 秒。
  const messages: AnthropicNativeMessage[] = [
    { role: "user", content: [{ type: "text", text: "q" }] },
    ...bashTurn("tu-before-text", "先调用工具", "pwd"),
    {
      role: "assistant",
      content: [{ type: "text", text: "后续总结" }],
    },
  ];
  const setup = await testRender(
    <ChatView
      session={sessionWith(messages, [null, 29000, null, null])}
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
  const foldIdx = lines.findIndex((line) => line.includes("bash × 1"));
  const textIdx = lines.findIndex((line) => line.includes("后续总结"));
  expect(foldIdx).toBeGreaterThanOrEqual(0);
  expect(textIdx).toBeGreaterThanOrEqual(0);
  expect(foldIdx).toBeLessThan(textIdx);
  expect(frame).not.toContain("[完成]");
  await setup.renderer.destroy();
});

test("idle：同一 assistant 消息内按 tool/text 位置渲染折叠", async () => {
  const renderCase = async (
    content: AnthropicNativeMessage["content"],
    thinkingMsValue: number,
    text: string
  ) => {
    const messages: AnthropicNativeMessage[] = [
      { role: "user", content: [{ type: "text", text: "q" }] },
      { role: "assistant", content },
      ...content
        .filter(
          (
            block
          ): block is Extract<
            AnthropicNativeMessage["content"][number],
            { type: "tool_use" }
          > => block.type === "tool_use"
        )
        .map((block) => toolResultMessage(block.id)),
    ];
    // assistant 在 index 1 → thinkingMs[1] = value。
    const setup = await testRender(
      <ChatView
        session={sessionWith(messages, [null, thinkingMsValue, null, null])}
        cols={COLS}
        rows={ROWS}
        liveToolLines={[]}
        thinkingExpanded={false}
      />,
      { width: COLS, height: ROWS, exitOnCtrlC: false }
    );
    await setup.waitForVisualIdle();
    const lines = setup.captureCharFrame().split("\n");
    const textIdx = lines.findIndex((line) => line.includes(text));
    const foldIndices = lines.flatMap((line, index) =>
      line.includes("bash × 1") ? [index] : []
    );
    return { setup, textIdx, foldIndices };
  };

  // tool_then_text:同一 assistant 内先 tool 后 text → 折叠行在 text 前。
  // spec D3 + cross-tool 簇 anchor 在 first/last tool。orderedTurnActivitySegments
  // 对同消息内 tool/text/tool 的处理:每个 tool 簇 anchor 到第一个 tool;text 段
  // 不单独折叠。tool-text-tool → 2 个折叠行;tool-text → 1 个折叠行。
  const toolThenText = await renderCase(
    [
      { type: "tool_use", id: "tu-same-1", name: "bash", input: {} },
      { type: "text", text: "tool-text 总结" },
    ],
    29000,
    "tool-text 总结"
  );
  expect(toolThenText.foldIndices).toHaveLength(1);
  expect(toolThenText.foldIndices[0]).toBeLessThan(toolThenText.textIdx);
  await toolThenText.setup.renderer.destroy();

  const toolTextTool = await renderCase(
    [
      { type: "tool_use", id: "tu-same-2", name: "bash", input: {} },
      { type: "text", text: "tool-text-tool 总结" },
      { type: "tool_use", id: "tu-same-3", name: "bash", input: {} },
    ],
    29000,
    "tool-text-tool 总结"
  );
  expect(toolTextTool.foldIndices).toHaveLength(2);
  expect(toolTextTool.foldIndices[0]).toBeLessThan(toolTextTool.textIdx);
  expect(toolTextTool.foldIndices[1]).toBeGreaterThan(toolTextTool.textIdx);
  await toolTextTool.setup.renderer.destroy();
});

test("idle：无历史 activity 时已完成 live 工具仍被折叠出 tail", async () => {
  const setup = await testRender(
    <ChatView
      session={sessionWith([
        {
          role: "user",
          content: [{ type: "text", text: "q" }],
        },
      ])}
      cols={COLS}
      rows={ROWS}
      liveToolLines={[]}
      liveToolRuns={[
        {
          id: "tu-live-completed",
          name: "bash",
          status: "ok",
          input: { command: "pwd" },
          detail: "pwd",
        },
      ]}
    />,
    { width: COLS, height: ROWS, exitOnCtrlC: false }
  );
  await setup.waitForVisualIdle();
  const frame = setup.captureCharFrame();
  expect(frame).not.toContain("bash · pwd · ok");
  await setup.renderer.destroy();
});

test("running-fg：不提前收成 turn 摘要,历史 [完成] 仍可见", async () => {
  // D3:running 态仍逐条工具可见(行为不变);折叠行不出现。
  // spec D3 删除了 `thinkingFrozenSeconds` 副通道 —— running 期间不再有
  // 冻结「思考了 N 秒」分支,流式面板恒 `思考中…`(测试 `thinking-peek.test.tsx`)。
  const liveToolRuns: ReadonlyArray<LiveToolRun> = [
    {
      id: "tu-live",
      name: "bash",
      status: "ok",
      input: { command: "memory_recall" },
      detail: "记忆 召回",
    },
  ];
  const setup = await testRender(
    <ChatView
      session={{
        ...sessionWith(interleavedThinkingToolMessages()),
        runState: "running-fg",
      }}
      cols={COLS}
      rows={ROWS}
      liveToolLines={[]}
      liveToolRuns={liveToolRuns}
      thinkingExpanded={false}
      thinkingDraftMasked="继续在找归内目录"
    />,
    { width: COLS, height: ROWS, exitOnCtrlC: false }
  );
  await setup.waitForVisualIdle();
  const frame = setup.captureCharFrame();
  // running 态:折叠行不出现(running 闸)。
  expect(frame.includes("bash ×")).toBe(false);
  // 历史消息的 `[完成]` 行仍可见(running 态逐条)。
  expect(frame.includes("[完成]")).toBe(true);
  await setup.renderer.destroy();
});
