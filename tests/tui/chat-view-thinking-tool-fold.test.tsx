/** @jsxImportSource @opentui/react */
/**
 * 复现：流式思考折叠（旧：逐条 `[思考]`）与 turn 级工具折叠
 * （新：`思考了 N 秒 · bash × N`）冲突。
 *
 * 合同：有完成工具后只留一行 turn 摘要；不再铺 `[思考]` / `[完成] bash` 交错。
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
  msgs: ReadonlyArray<AnthropicNativeMessage>
): TuiSessionState {
  const file: SessionFileV1 = {
    schemaVersion: 1,
    conversation_id: "think-tool-fold",
    messages: [...msgs],
    turnCount: msgs.filter((m) => m.role === "assistant").length,
    updatedAt: "2026-08-28T00:00:00.000Z",
    jsonMode: false,
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

test("idle：思考秒数 + 多轮 bash → 思考了 N 秒 下一行 bash × N，不铺 [完成]", async () => {
  const setup = await testRender(
    <ChatView
      session={sessionWith(interleavedThinkingToolMessages())}
      cols={COLS}
      rows={ROWS}
      liveToolLines={[]}
      thinkingExpanded={false}
      lastThinkingSeconds={29}
    />,
    { width: COLS, height: ROWS, exitOnCtrlC: false }
  );
  await setup.waitForVisualIdle();
  const frame = setup.captureCharFrame();
  expect(frame).toContain("思考了 29 秒");
  expect(frame).toContain("bash × 3");
  expect(frame).not.toContain("思考了 29 秒 · bash × 3");
  const frameLines = frame.split("\n");
  const thinkIdx = frameLines.findIndex((l) => l.includes("思考了 29 秒"));
  const toolIdx = frameLines.findIndex((l) => l.includes("bash × 3"));
  expect(thinkIdx).toBeGreaterThanOrEqual(0);
  expect(toolIdx).toBe(thinkIdx + 1);
  expect(frame.includes("[完成]")).toBe(false);
  expect(frame.includes("[思考]")).toBe(false);
  expect(thinkingAfterFirstTool(markerSequence(frame))).toBe(false);
  await setup.renderer.destroy();
});

test("idle：文本→工具时，工具折叠出现在前置文本之后", async () => {
  const setup = await testRender(
    <ChatView
      session={sessionWith([
        {
          role: "user",
          content: [{ type: "text", text: "q" }],
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "先说明" }],
        },
        ...bashTurn("tu-after-text", "思考工具", "pwd"),
      ])}
      cols={COLS}
      rows={ROWS}
      liveToolLines={[]}
      thinkingExpanded={false}
      lastThinkingSeconds={29}
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
  const setup = await testRender(
    <ChatView
      session={sessionWith([
        {
          role: "user",
          content: [{ type: "text", text: "q" }],
        },
        ...bashTurn("tu-before-text", "先调用工具", "pwd"),
        {
          role: "assistant",
          content: [{ type: "text", text: "后续总结" }],
        },
      ])}
      cols={COLS}
      rows={ROWS}
      liveToolLines={[]}
      thinkingExpanded={false}
      lastThinkingSeconds={29}
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
    text: string
  ) => {
    const setup = await testRender(
      <ChatView
        session={sessionWith([
          {
            role: "user",
            content: [{ type: "text", text: "q" }],
          },
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
        ])}
        cols={COLS}
        rows={ROWS}
        liveToolLines={[]}
        thinkingExpanded={false}
        lastThinkingSeconds={29}
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

  const toolThenText = await renderCase(
    [
      { type: "tool_use", id: "tu-same-1", name: "bash", input: {} },
      { type: "text", text: "tool-text 总结" },
    ],
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
      lastThinkingSeconds={29}
    />,
    { width: COLS, height: ROWS, exitOnCtrlC: false }
  );
  await setup.waitForVisualIdle();
  const frame = setup.captureCharFrame();
  expect(frame).not.toContain("bash · pwd · ok");
  await setup.renderer.destroy();
});

test("running-fg：不提前收成 turn 摘要，历史 [完成] 仍可见", async () => {
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
      thinkingFrozenSeconds={6}
    />,
    { width: COLS, height: ROWS, exitOnCtrlC: false }
  );
  await setup.waitForVisualIdle();
  const frame = setup.captureCharFrame();
  expect(frame).toContain("思考了 6 秒");
  expect(frame.includes("bash ×")).toBe(false);
  expect(frame.includes("[完成]")).toBe(true);
  await setup.renderer.destroy();
});
