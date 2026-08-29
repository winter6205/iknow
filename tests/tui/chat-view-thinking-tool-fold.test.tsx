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
