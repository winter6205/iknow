/** @jsxImportSource @opentui/react */
/**
 * scripts/probe-tui-live-order-gap.tsx
 *
 * 复现两个连带问题（PR #590 只修了「草稿被 write 预览顶到后面」一半）：
 * A) running 时「先工具后文本」场景：工具显示应在上、流式草稿在下
 *    （按真实事件顺序插入）；当前实现草稿恒在工具之上 → 顺序颠倒。
 * B) turn 结束折叠后：原先 live 工具区域是否留下大空位（折叠行与最终
 *    文本之间隔一大段空白）。
 *
 * bun run scripts/probe-tui-live-order-gap.tsx
 */
import { act, useEffect, useRef, useState } from "react";
import { testRender } from "@opentui/react/test-utils";
import { ChatView, type ChatViewHandle } from "../src/tui/chat-view.js";
import {
  attachSession,
  type TuiSessionState,
} from "../src/tui/session-state.js";
import type { AnthropicNativeMessage } from "../src/harness/model-adapter/types.js";
import type { LiveToolRun } from "../src/tui/live-tool-state.js";
import type { SessionFileV1 } from "../src/session-api/store/schema.js";

const COLS = 80;
const ROWS = 28;

function sessionWith(msgs: ReadonlyArray<AnthropicNativeMessage>) {
  const file: SessionFileV1 = {
    schemaVersion: 1,
    conversation_id: "probe",
    messages: [...msgs],
    turnCount: msgs.filter((m) => m.role === "assistant").length,
    updatedAt: "2026-08-22T00:00:00.000Z",
    jsonMode: false,
  };
  return attachSession(file);
}

function fail(msg: string, frame: string): never {
  console.error("PROBE_FAIL", msg);
  console.error("----- FRAME -----");
  console.error(frame);
  process.exit(1);
}

/* ---------- 场景 A：running，先搜索工具、后流式回答 ---------- */

const sessionA: TuiSessionState = {
  ...sessionWith([
    { role: "user", content: [{ type: "text", text: "搜索今天的AI新闻" }] },
  ]),
  runState: "running-fg",
};
const runsA: ReadonlyArray<LiveToolRun> = [
  {
    id: "tu-s",
    name: "web_search",
    status: "ok",
    input: { query: "今天的AI新闻" },
    detail: "搜索 今天的AI新闻",
  },
];
const draftA = "以下是今天的AI新闻摘要";

const setupA = await testRender(
  <ChatView
    session={sessionA}
    cols={COLS}
    rows={ROWS}
    liveToolLines={[]}
    liveToolRuns={runsA}
    draftsMasked={draftA}
  />,
  { width: COLS, height: ROWS, exitOnCtrlC: false }
);
await setupA.waitForVisualIdle();
const frameA = setupA.captureCharFrame();
console.log("===== FRAME_A_RUNNING_TOOL_THEN_TEXT =====");
console.log(frameA);
const iTool = frameA.indexOf("web_search");
const iDraft = frameA.indexOf("以下是今天的AI新闻");
if (iTool < 0 || iDraft < 0) {
  fail("A: 帧缺工具行或草稿", frameA);
}
if (iDraft < iTool) {
  fail(
    `A: 草稿插在工具显示之前 iDraft=${iDraft} iTool=${iTool}（应按事件顺序：工具在上、草稿在下）`,
    frameA
  );
}
console.log("A_OK: 工具在上草稿在下");
await setupA.renderer.destroy();

/* ---------- 场景 B：running → idle 折叠后检查空位 ---------- */

interface HarnessApi {
  finishTurn(): void;
}

const finalMessages: AnthropicNativeMessage[] = [
  { role: "user", content: [{ type: "text", text: "搜索今天的AI新闻" }] },
  {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "先搜一下", signature: "s1" },
      {
        type: "tool_use",
        id: "tu-s1",
        name: "web_search",
        input: { query: "今天的AI新闻" },
      },
    ],
  },
  {
    role: "user",
    content: [
      {
        type: "tool_result",
        tool_use_id: "tu-s1",
        content: "搜索结果……",
        is_error: false,
      },
    ],
  },
  {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "再补充搜一次", signature: "s2" },
      {
        type: "tool_use",
        id: "tu-s2",
        name: "web_search",
        input: { query: "AI news today" },
      },
    ],
  },
  {
    role: "user",
    content: [
      {
        type: "tool_result",
        tool_use_id: "tu-s2",
        content: "更多结果……",
        is_error: false,
      },
    ],
  },
  {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "整理输出", signature: "s3" },
      { type: "text", text: "以下是今天的AI新闻摘要：第一条……" },
    ],
  },
];

function HarnessB(props: { register: (api: HarnessApi) => void }) {
  const [session, setSession] = useState<TuiSessionState>(() => ({
    ...sessionWith([
      { role: "user", content: [{ type: "text", text: "搜索今天的AI新闻" }] },
    ]),
    runState: "running-fg" as const,
  }));
  const [runs, setRuns] = useState<ReadonlyArray<LiveToolRun>>([
    {
      id: "tu-s1",
      name: "web_search",
      status: "ok",
      input: { query: "今天的AI新闻" },
      detail: "搜索 今天的AI新闻",
    },
    {
      id: "tu-s2",
      name: "web_search",
      status: "ok",
      input: { query: "AI news today" },
      detail: "搜索 AI news today",
    },
  ]);
  const [draft, setDraft] = useState("以下是今天的AI新闻摘要：第一条……");
  const chatRef = useRef<ChatViewHandle>(null);
  useEffect(() => {
    props.register({
      finishTurn: () => {
        act(() => {
          setSession((prev) => ({
            ...sessionWith(finalMessages),
            runState: "idle" as const,
          }));
          setRuns([]);
          setDraft("");
        });
      },
    });
  });
  return (
    <ChatView
      ref={chatRef}
      session={session}
      cols={COLS}
      rows={ROWS}
      liveToolLines={[]}
      liveToolRuns={runs}
      draftsMasked={draft}
      lastThinkingSeconds={12}
    />
  );
}

const holderB: { api: HarnessApi | null } = { api: null };
const setupB = await testRender(
  <HarnessB
    register={(api) => {
      holderB.api = api;
    }}
  />,
  { width: COLS, height: ROWS, exitOnCtrlC: false }
);
await setupB.waitForVisualIdle();
console.log("===== FRAME_B_RUNNING =====");
console.log(setupB.captureCharFrame());
if (holderB.api === null) fail("B: harness 未注册", "");
holderB.api.finishTurn();
await setupB.waitForVisualIdle();
const frameB = setupB.captureCharFrame();
console.log("===== FRAME_B_IDLE_FOLDED =====");
console.log(frameB);
if (!frameB.includes("web_search × 2")) {
  fail("B: idle 缺 turn 折叠行", frameB);
}
// 空位检测：折叠行与最终文本之间的连续空行数。
const lines = frameB.split("\n");
const iFold = lines.findIndex((l) => l.includes("web_search × 2"));
const iText = lines.findIndex((l) => l.includes("以下是今天的AI新闻摘要"));
if (iFold < 0 || iText < 0) fail("B: 帧缺折叠行或最终文本", frameB);
let blanks = 0;
for (let i = iFold + 1; i < iText; i++) {
  if ((lines[i] ?? "").trim() === "") blanks++;
}
console.log(`B_GAP_BLANK_LINES=${blanks} (fold@${iFold} text@${iText})`);
if (blanks >= 3) {
  fail(`B: 折叠行与最终文本间有 ${blanks} 行空位（幻影 margin）`, frameB);
}
console.log("B_OK: 无明显空位");
await setupB.renderer.destroy();
process.exit(0);
