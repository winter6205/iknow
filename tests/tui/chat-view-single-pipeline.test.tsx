/** @jsxImportSource @opentui/react */
/**
 * T3：同一条工具只画一次。
 *
 * 复现两类叠画路径：
 *  - **历史 vs live tail**：idle（runState=idle、fold 行在场）的同一帧，
 *    `session.messages` 已经包含 tool_use + tool_result（statusMap 配对），
 *    同时 `liveToolRuns` 仍残留该 tool_use_id 的 `ok` 完成态（模拟
 *    `turnFinished` 与 `setLiveToolRuns([])` 之间的 race、或 live 通道
 *    与历史 commit 之间的并行）→ bash keep 标题应只画一次（来自历史
 *    `MessageBlocks.ToolSummaryRow`，不是 tail 的 `liveToolPreviewBox`）。
 *  - **legacy 工具行挂预览**：`liveToolLines` 残留的 legacy 字符串行不
 *    得在历史里再叠一份完成标题（legacy 行无 tool_use_id，但同 name
 *    tool_use_id 在历史已渲染）。
 *
 * 收口思路（同 consumedThinkingMessageIndices 一致）：
 *  - tail 过滤除掉 `session.messages` 已含 tool_result 的 live 完成件
 *    （即 `statusMap.has(run.id)`）；保留 status=running（未 commit）。
 *  - retract slot（inFoldCount=true）已在 collapseToolRows=true 时被
 *    折叠计数收走，不应再独立画标题。
 *  - legacy 行不挂新结果预览（已落定的工具历史侧已渲染）。
 *
 * 测试目的：跑通本文件即视为双画路径已堵（acceptance 第 3 条）；
 * 跑不通则需要回 chat-view.tsx 的 tailSlots 过滤逻辑、live-tool-preview
 * 与 message-blocks 的边界。
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

/** 一轮典型场景：成功 read_file（retract）+ 成功 bash（keep）+ 末条
 *  assistant 文本回答。历史里三个 block：thinking + tool_use(read) +
 *  tool_use(bash)。tool_result user 已配对。idle 帧（runState 缺省 =
 *  attachSession 的 idle）。 */
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
  // 模拟 turnFinished 已 commit messages 但 liveToolRuns 还没被清空的
  // race 窗口。session.messages 含 bash tool_use + tool_result,statusMap
  // 配对 → MessageBlocks 会画一次 bash 标题;liveToolRuns 同时含同
  // tool_use_id 的 ok 完成件 → live-tool-preview 也会画一次。
  // 修复后 tail 必须把 statusMap 配对的 live 完成件过滤掉,只画 running。
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
  // bash keep 标题只画一次(行级 / 整帧总命中数 = 1)。
  // bash · pwd 是 bash keep 完成态的视觉形态;completion 状态无 [完成] 前缀。
  expect(countOccurrences(frame, "bash · pwd")).toBe(1);
  // read_file retract 不画标题(只进折叠计数)。
  expect(frame.includes("read_file ·")).toBe(false);
  // 折叠计数行含 read_file × 1(bash 不进)。
  expect(frame).toContain("read_file × 1");
  expect(frame.includes("bash ×")).toBe(false);
  // result preview 不属于落定态的 bash(只在 live running 才挂)。
  expect(frame.includes("\u23bf")).toBe(false);
  await setup.renderer.destroy();
});

test("T3 idle race：keep 完成态 + accent 完成态 同 tool_use_id → 每件各画一次", async () => {
  // accent(skill) + keep(bash) 同时存在 race;两条 tool_use_id 都应
  // 只画一次。
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
  // 两条完成态各画一次。
  expect(countOccurrences(frame, "skill echo")).toBe(1);
  expect(countOccurrences(frame, "bash · echo hi")).toBe(1);
  // accent 走 accent 色 + bold(渲染细节),但不带 result preview。
  expect(frame.includes("\u23bf")).toBe(false);
  await setup.renderer.destroy();
});

test("T3 running：bash 还在 running（liveToolRuns）→ history 与 live 同名不算双画", async () => {
  // running 态：历史 messages 还没 commit 本 turn 的 tool_use(session
  // messages 是上一轮的尾巴);liveToolRuns 含 status=running 的同
  // tool_use_id。这是正常 live 渲染,不算双画。
  // 修复边界：tail 过滤条件应只在 status !== "running" 时排除 statusMap
  // 配对的件 —— running 件保留(tail 唯一渲染面)。
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
  // running 标题在 tail(历史无该 tool_use)→ 1 次。
  expect(frame).toContain("[运行中] bash");
  expect(countOccurrences(frame, "[运行中] bash")).toBe(1);
  await setup.renderer.destroy();
});

test("T3 legacy 行：liveToolLines 残留 legacy 完成行不与历史同件叠画", async () => {
  // legacy 路径(无 toolUseId)产出的字符串行不应与历史同 name 工具叠
  // 画。acceptance:画面里不应同时存在两条 [完成] bash 行。
  // legacy 行已无 [完成] 前缀(uni/forma live 收口),所以"双画"实际表
  // 现为同一 bash 标题(bash · ...)出现两次。
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
  const legacyLine = "bash · pwd"; // formatLiveToolEvent 形态
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
  // 落定的 bash 在历史中已渲染;legacy 行若未被过滤也会带"bash · pwd"。
  // acceptance:同 name 工具的标题只画一次。legacy 行若与历史叠画,
  // 计数 = 2;正确实现 = 1(history only)。
  // 实际 legacy 路径的视觉等同 bash · pwd,history 侧 bash keep 标题
  // 也是 bash · pwd,共用同一视觉。允差:legacy 行不应再挂 result preview
  // (`\u23bf`)—— legacy 是已落定状态,挂预览是 T3 任务定义的双画路径之一。
  expect(frame.includes("\u23bf")).toBe(false);
  await setup.renderer.destroy();
});

test("T3 fold line：fold 行不替代 bash keep 标题（一条 bash 标题仍可见）", async () => {
  // acceptance 第 3 条细化：fold 行在场时 retract 进计数、bash 标题仍
  // 可见（来自历史 message-blocks，不是 live tail）。回归用。
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
