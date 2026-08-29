/** @jsxImportSource @opentui/react */
/**
 * scripts/probe-tui-fold-live.tsx
 *
 * MCP/pty 实测：用真实 OpenTUI testRender 打出 ChatView 帧，校验
 * 1) running 时草稿在 write 预览前
 * 2) idle 且 ≥2 次 tool_use 时折叠成 bash × N、不铺 [完成] bash
 *
 * bun run scripts/probe-tui-fold-live.tsx
 */
import { testRender } from "@opentui/react/test-utils";
import { ChatView } from "../src/tui/chat-view.js";
import { attachSession } from "../src/tui/session-state.js";
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
    updatedAt: "2026-08-21T00:00:00.000Z",
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

const runningSession = {
  ...sessionWith([
    { role: "user", content: [{ type: "text", text: "写个页面" }] },
  ]),
  runState: "running-fg" as const,
};
const liveToolRuns: ReadonlyArray<LiveToolRun> = [
  {
    id: "tu-w",
    name: "write_file",
    status: "ok",
    // 本 probe 模拟「先流式文本、后 write 预览」（#590）：生产里 app 层会给
    // 草稿后开始的工具打 draftEpoch ≥ 1 → 渲染在草稿之下。
    draftEpoch: 1,
    input: {
      path: "/tmp/iknow-fold-probe.html",
      content: '<!doctype html>\n<html lang="en">',
    },
  },
];
const draft = "我新写一份不同审美的腕表页";

const idleMsgs: AnthropicNativeMessage[] = [
  { role: "user", content: [{ type: "text", text: "写个页面" }] },
  {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "先扫", signature: "s1" },
      {
        type: "tool_use",
        id: "tu-b1",
        name: "bash",
        input: { command: "echo fold-a" },
      },
    ],
  },
  {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "再扫", signature: "s2" },
      {
        type: "tool_use",
        id: "tu-b2",
        name: "bash",
        input: { command: "echo fold-b" },
      },
    ],
  },
  {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "收尾", signature: "s3" },
      { type: "text", text: "完成。" },
    ],
  },
];

const runningSetup = await testRender(
  <ChatView
    session={runningSession}
    cols={COLS}
    rows={ROWS}
    liveToolLines={[]}
    liveToolRuns={liveToolRuns}
    draftsMasked={draft}
  />,
  { width: COLS, height: ROWS, exitOnCtrlC: false }
);
await runningSetup.waitForVisualIdle();
const runningFrame = runningSetup.captureCharFrame();
console.log("===== FRAME_RUNNING =====");
console.log(runningFrame);
const iDraft = runningFrame.indexOf("我新写一份");
const iCode = runningFrame.indexOf("<!doctype html>");
if (iDraft < 0 || iCode < 0) {
  fail("running 帧缺少草稿或 write 预览", runningFrame);
}
if (iDraft >= iCode) {
  fail(`草稿插在 write 预览后面 iDraft=${iDraft} iCode=${iCode}`, runningFrame);
}
console.log("PROBE_PASS_ORDER iDraft=", iDraft, "iCode=", iCode);
await runningSetup.renderer.destroy();

const idleSetup = await testRender(
  <ChatView
    session={sessionWith(idleMsgs)}
    cols={COLS}
    rows={ROWS}
    liveToolLines={[]}
    lastThinkingSeconds={29}
  />,
  { width: COLS, height: ROWS, exitOnCtrlC: false }
);
await idleSetup.waitForVisualIdle();
const idleFrame = idleSetup.captureCharFrame();
console.log("===== FRAME_IDLE =====");
console.log(idleFrame);
if (
  !idleFrame.includes("思考了 29 秒") ||
  !idleFrame.includes("bash × 2") ||
  idleFrame.includes("思考了 29 秒 · bash × 2")
) {
  fail("idle 缺少分行的思考/工具折叠", idleFrame);
}
if (!idleFrame.includes("完成。")) {
  fail("idle 缺少最终回复", idleFrame);
}
if (idleFrame.includes("[完成] bash")) {
  fail("idle 仍铺着 [完成] bash", idleFrame);
}
console.log("PROBE_PASS_FOLD");
await idleSetup.renderer.destroy();
console.log("PROBE_ALL_GREEN");
process.exit(0);
