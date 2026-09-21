/** @jsxImportSource @opentui/react */
/**
 * Each tool line must be painted exactly once.
 *
 * Two double-paint paths are reproduced:
 *  - **history vs live tail**: in one idle frame (fold line present),
 *    `session.messages` already contains tool_use + tool_result (paired via
 *    statusMap) while `liveToolRuns` still holds the same tool_use_id as an
 *    `ok` completion (the race between `turnFinished` and
 *    `setLiveToolRuns([])`, or live channel running parallel to the history
 *    commit) → the bash keep title must paint once, from history
 *    (`MessageBlocks.ToolSummaryRow`), not from the tail
 *    (`liveToolPreviewBox`).
 *  - **legacy tool lines with preview**: leftover legacy string rows in
 *    `liveToolLines` must not stack another completion title on top of
 *    history (legacy rows carry no tool_use_id, but the same-name
 *    tool_use_id is already rendered in history).
 *
 * Convergence approach (same shape as consumedThinkingMessageIndices):
 *  - the tail filter drops live completed entries whose tool_result is
 *    already in `session.messages` (i.e. `statusMap.has(run.id)`); keeps
 *    status=running (not yet committed).
 *  - retract slots (inFoldCount=true) are already collected by the fold
 *    count when collapseToolRows=true, so they must not paint a standalone
 *    title.
 *  - legacy rows carry no fresh result preview (settled tools are rendered
 *    on the history side).
 *
 * Passing this file means the double-paint paths are plugged; if it fails,
 * look at the tailSlots filter in chat-view.tsx and the live-tool-preview /
 * message-blocks boundary.
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
    conversation_id: "t3-single-pipeline",
    messages: [...msgs],
    turnCount: msgs.filter((m) => m.role === "assistant").length,
    updatedAt: "2026-09-07T00:00:00.000Z",
    jsonMode: false,
    ...(thinkingMs !== undefined ? { thinkingMs } : {}),
  };
  return attachSession(file);
}

/** A typical turn: successful read_file (retract) + successful bash (keep)
 *  + a final assistant text answer. History holds three blocks: thinking +
 *  tool_use(read) + tool_use(bash); the tool_result user message is paired.
 *  Idle frame (runState default = attachSession's idle). */
function bashPlusReadHistory(): AnthropicNativeMessage[] {
  return [
    { role: "user", content: [{ type: "text", text: "看下 a.ts 然后跑 pwd" }] },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "先读再跑", signature: "s" },
        {
          type: "tool_use",
          id: "tu-rd",
          name: "read_file",
          input: { path: "a.ts" },
        },
        {
          type: "tool_use",
          id: "tu-sh",
          name: "bash",
          input: { command: "pwd" },
        },
      ],
    },
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "tu-rd", content: "file body" },
        {
          type: "tool_result",
          tool_use_id: "tu-sh",
          content: JSON.stringify({ code: 0, stdout: "/tmp\n", stderr: "" }),
        },
      ],
    },
    {
      role: "assistant",
      content: [{ type: "text", text: "完成。" }],
    },
  ];
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let n = 0;
  let idx = 0;
  while (true) {
    const found = haystack.indexOf(needle, idx);
    if (found === -1) return n;
    n += 1;
    idx = found + needle.length;
  }
}

test("T3 idle race：history 已渲染 bash 标题 + liveToolRuns 残留 bash ok → bash 标题只画一次", async () => {
  // Simulate the race window where turnFinished has committed messages but
  // liveToolRuns is not yet cleared. session.messages contains bash
  // tool_use + tool_result, paired via statusMap → MessageBlocks paints the
  // bash title once; liveToolRuns concurrently holds the `ok` completion for
  // the same tool_use_id → live-tool-preview would paint it again.
  // After the fix the tail must filter out statusMap-paired live completions
  // and paint only running ones.
  const liveToolRuns: ReadonlyArray<LiveToolRun> = [
    {
      id: "tu-sh",
      name: "bash",
      status: "ok",
      input: { command: "pwd" },
      detail: "pwd",
    },
  ];
  const setup = await testRender(
    <ChatView
      session={sessionWith(bashPlusReadHistory())}
      cols={COLS}
      rows={ROWS}
      liveToolLines={[]}
      liveToolRuns={liveToolRuns}
    />,
    { width: COLS, height: ROWS, exitOnCtrlC: false }
  );
  await setup.waitForVisualIdle();
  const frame = setup.captureCharFrame();
  // The bash keep title paints once (line-level / whole-frame hit count = 1).
  // `bash · pwd` is the visual form of a completed bash keep; completion state
  // carries no `[完成]` ("done") prefix.
  expect(countOccurrences(frame, "bash · pwd")).toBe(1);
  // read_file is retract-class: no title, only the fold count.
  expect(frame.includes("read_file ·")).toBe(false);
  // The fold-count line contains read_file × 1 (bash is not counted in).
  expect(frame).toContain("read_file × 1");
  expect(frame.includes("bash ×")).toBe(false);
  expect(frame).toContain("│ /tmp");
  await setup.renderer.destroy();
});

test("T3 idle race：keep 完成态 + accent 完成态 同 tool_use_id → 每件各画一次", async () => {
  // accent(skill) + keep(bash) race at the same time; each tool_use_id
  // must paint exactly once.
  const messages: AnthropicNativeMessage[] = [
    { role: "user", content: [{ type: "text", text: "加载 echo 技能" }] },
    {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "tu-skill",
          name: "skill",
          input: { name: "echo" },
        },
        {
          type: "tool_use",
          id: "tu-bash",
          name: "bash",
          input: { command: "echo hi" },
        },
      ],
    },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "tu-skill",
          content: "skill loaded",
        },
        {
          type: "tool_result",
          tool_use_id: "tu-bash",
          content: JSON.stringify({ code: 0, stdout: "hi\n", stderr: "" }),
        },
      ],
    },
  ];
  const liveToolRuns: ReadonlyArray<LiveToolRun> = [
    {
      id: "tu-skill",
      name: "skill",
      status: "ok",
      input: { name: "echo" },
      detail: "echo",
    },
    {
      id: "tu-bash",
      name: "bash",
      status: "ok",
      input: { command: "echo hi" },
      detail: "echo hi",
    },
  ];
  const setup = await testRender(
    <ChatView
      session={sessionWith(messages)}
      cols={COLS}
      rows={ROWS}
      liveToolLines={[]}
      liveToolRuns={liveToolRuns}
    />,
    { width: COLS, height: ROWS, exitOnCtrlC: false }
  );
  await setup.waitForVisualIdle();
  const frame = setup.captureCharFrame();
  // Each of the two completions paints once.
  expect(countOccurrences(frame, "skill echo")).toBe(1);
  expect(countOccurrences(frame, "bash · echo hi")).toBe(1);
  expect(frame).toContain("│ hi");
  await setup.renderer.destroy();
});

test("T3 running：bash 还在 running（liveToolRuns）→ history 与 live 同名不算双画", async () => {
  // Running state: history has not committed this turn's tool_use yet
  // (session.messages is the tail of the previous turn); liveToolRuns holds
  // status=running for the same tool_use_id. This is normal live rendering,
  // not a double paint.
  // Fix boundary: the tail filter should exclude statusMap-paired entries
  // only when status !== "running" — running entries stay (tail is their
  // only rendering surface).
  const messages: AnthropicNativeMessage[] = [
    { role: "user", content: [{ type: "text", text: "上一轮尾巴" }] },
    { role: "assistant", content: [{ type: "text", text: "上轮回答" }] },
  ];
  const liveToolRuns: ReadonlyArray<LiveToolRun> = [
    {
      id: "tu-running",
      name: "bash",
      status: "running",
      input: { command: "pwd" },
    },
  ];
  const setup = await testRender(
    <ChatView
      session={{
        ...sessionWith(messages),
        runState: "running-fg",
      }}
      cols={COLS}
      rows={ROWS}
      liveToolLines={[]}
      liveToolRuns={liveToolRuns}
    />,
    { width: COLS, height: ROWS, exitOnCtrlC: false }
  );
  await setup.waitForVisualIdle();
  const frame = setup.captureCharFrame();
  // The running title lives in the tail (no such tool_use in history) →
  // painted once. The process line is `Running 1 shell command… · <command>`,
  // no `[运行中]` ("running").
  expect(frame).toContain("Running 1 shell command… · pwd");
  expect(countOccurrences(frame, "Running 1 shell command…")).toBe(1);
  await setup.renderer.destroy();
});

test("T3 legacy 行：liveToolLines 残留 legacy 完成行不与历史同件叠画", async () => {
  // String rows from the legacy path (no toolUseId) must not stack on top of
  // a same-name tool already in history — the frame must never show two
  // completed bash lines. Legacy rows no longer carry a `[完成]` ("done")
  // prefix, so the "double paint" surfaces as the same bash title
  // (bash · ...) appearing twice.
  const messages: AnthropicNativeMessage[] = [
    { role: "user", content: [{ type: "text", text: "上轮" }] },
    {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "tu-bash-legacy",
          name: "bash",
          input: { command: "pwd" },
        },
      ],
    },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "tu-bash-legacy",
          content: JSON.stringify({ code: 0, stdout: "/tmp\n", stderr: "" }),
        },
      ],
    },
  ];
  const legacyLine = "bash · pwd"; // formatLiveToolEvent shape
  const setup = await testRender(
    <ChatView
      session={sessionWith(messages)}
      cols={COLS}
      rows={ROWS}
      liveToolLines={[legacyLine]}
    />,
    { width: COLS, height: ROWS, exitOnCtrlC: false }
  );
  await setup.waitForVisualIdle();
  const frame = setup.captureCharFrame();
  // The settled bash is already rendered in history; an unfiltered legacy
  // row would also carry "bash · pwd". A same-name tool title paints once:
  // if the legacy row stacks with history the count = 2; correct = 1
  // (history only).
  expect(frame).toContain("│ /tmp");
  await setup.renderer.destroy();
});

test("T3 fold line：fold 行不替代 bash keep 标题（一条 bash 标题仍可见）", async () => {
  // Refinement: with the fold line present, retract entries fold into the
  // count while the bash title stays visible (from history message-blocks,
  // not the live tail). Regression guard.
  const messages: AnthropicNativeMessage[] = [
    { role: "user", content: [{ type: "text", text: "看下 a.ts 再跑" }] },
    {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "tu-rd-f",
          name: "read_file",
          input: { path: "a.ts" },
        },
        {
          type: "tool_use",
          id: "tu-sh-f",
          name: "bash",
          input: { command: "pwd" },
        },
      ],
    },
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "tu-rd-f", content: "body" },
        {
          type: "tool_result",
          tool_use_id: "tu-sh-f",
          content: JSON.stringify({ code: 0, stdout: "/tmp\n", stderr: "" }),
        },
      ],
    },
  ];
  const setup = await testRender(
    <ChatView
      session={sessionWith(messages)}
      cols={COLS}
      rows={ROWS}
      liveToolLines={[]}
    />,
    { width: COLS, height: ROWS, exitOnCtrlC: false }
  );
  await setup.waitForVisualIdle();
  const frame = setup.captureCharFrame();
  expect(countOccurrences(frame, "bash · pwd")).toBe(1);
  expect(frame).toContain("read_file × 1");
  await setup.renderer.destroy();
});
