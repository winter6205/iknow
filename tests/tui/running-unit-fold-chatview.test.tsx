/** @jsxImportSource @opentui/react */
/**
 * tests/tui/running-unit-fold-chatview.test.tsx
 *
 * 不变式:ChatView 在 running 态仍要按「已完成单元」出折叠行 —— plan T1。
 *
 * 5 类边界:empty / negative / overflow / concurrent / exception。SSOT:
 * src/tui/chat-view.tsx 消费 src/tui/turn-activity.ts 的三个新闸门
 * `shouldShowThinkingFold` / `shouldShowRetractFold` /
 * `shouldCollapseTurnToolRows`。
 *
 * 子断言:
 *  (1) running + live thinking 已结束 + final thinkingMs > 0 → 帧内
 *      出现 `Thought for`(不靠 per-message ThinkingSummary 兜底);
 *  (2) running + 历史 turn 含 retract → 历史 retract 折叠行
 *      (e.g. `read_file × 1`) 仍渲染,不被 running 闸门吞掉;
 *  (3) running + 当前 turn live 已完成 retract → 进折叠计数,tail
 *      不再保留 retract 已完成态;
 *  (4) hidden user 消息夹在 tool_result 与 final 之间 → final 的
 *      thinkingMs 仍按 sourceIndex 映射,不漂位(不可静默 double-kill)。
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
    conversation_id: "running-unit-fold",
    messages: [...msgs],
    turnCount: msgs.filter((m) => m.role === "assistant").length,
    updatedAt: "2026-09-07T00:00:00.000Z",
    jsonMode: false,
    title: "running-unit-fold",
    cwd: "/tmp",
    sanitized_at: "2026-09-07T00:00:00.000Z",
    thinkingMs,
  };
  return { ...attachSession(file), runState };
}

test("running + thinking 已结束:final thinkingMs 已落盘,`Thought for` 立刻出现(不等整 turn idle)", async () => {
  // 不变式:loop-engine 在 final assistant commit 时落盘 thinkingMs →
  // session.thinkingMs[finalIdx] > 0;此后 live thinking 流即清空
  // (deferredThinkingDrafts = ""),但本 turn 还在 running（final assistant
  // 之后还有 tool_call_start + tool_result 入站,流式未结束）。此时
  // `Thought for` 必须立刻可见 —— 不再被 showTurnFold 的 running 闸
  // 吞掉。
  const messages: AnthropicNativeMessage[] = [
    { role: "user", content: [{ type: "text", text: "q" }] },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "final", signature: "s" },
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
  const thinkingMs: ReadonlyArray<number | null> = [null, 12000, null];
  // running + final thinkingMs 已落盘 + 无 live 草稿(模拟 final commit 后
  // 进入下一个流式单元,旧 final thinking 已冻结;liveToolRuns 含一条
  // running 工具,代表当前 turn 仍在运行)。
  const liveToolRuns: ReadonlyArray<LiveToolRun> = [
    {
      id: "tu-live",
      name: "bash",
      status: "running",
      input: { command: "pwd" },
    },
  ];
  const setup = await testRender(
    <ChatView
      session={sessionWith(messages, thinkingMs, "running-fg")}
      cols={COLS}
      rows={ROWS}
      liveToolLines={[]}
      liveToolRuns={liveToolRuns}
      thinkingExpanded={false}
      thinkingDraftMasked=""
    />,
    { width: COLS, height: ROWS, exitOnCtrlC: false }
  );
  await setup.waitForVisualIdle();
  const frame = setup.captureCharFrame();
  expect(frame).toContain("Thought for 12s");
  await setup.renderer.destroy();
});

test("running + 历史 turn 含 retract:历史折叠行 `read_file × 1` 仍渲染", async () => {
  // 不变式:当前 turn idle(retract=0) 但更早的 turn 含 retract(read_file)。
  // 当新一轮进入 running,历史折叠行不能被 showTurnFold 的
  // running=false+turnToolTotal=0 闸吞掉。
  const messages: AnthropicNativeMessage[] = [
    { role: "user", content: [{ type: "text", text: "q1" }] },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "x", signature: "s1" },
        {
          type: "tool_use",
          id: "tu-rd-history",
          name: "read_file",
          input: { path: "a.ts" },
        },
      ],
    },
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "tu-rd-history", content: "ok" },
      ],
    },
    { role: "user", content: [{ type: "text", text: "q2" }] },
  ];
  const thinkingMs: ReadonlyArray<number | null> = [null, 5000, null, null];
  // 当前 turn 在 running;liveToolRuns 空,无折叠贡献;但历史 retract
  // 必须保留 `read_file × 1`。
  const setup = await testRender(
    <ChatView
      session={sessionWith(messages, thinkingMs, "running-fg")}
      cols={COLS}
      rows={ROWS}
      liveToolLines={[]}
      liveToolRuns={[]}
      thinkingExpanded={false}
      thinkingDraftMasked="继续思考中"
    />,
    { width: COLS, height: ROWS, exitOnCtrlC: false }
  );
  await setup.waitForVisualIdle();
  const frame = setup.captureCharFrame();
  expect(frame).toContain("read_file × 1");
  await setup.renderer.destroy();
});

test("running + 当前 turn live 已完成 retract:进入折叠,tail 不再保留完成行", async () => {
  // 不变式:当前 turn 在 running;session 里已有 assistant 文本段(text),
  // tool_result 已落盘,liveToolRuns 含一条对应 read_file 完成态(模拟
  // `post_tool_use` 完成事件);折叠行锚到 text 段尾的 fallback 路径要
  // 在 running 期间渲染 `read_file × 1`,tail 不再保留 read_file 完成行
  // (避免 double-render)。
  const messages: AnthropicNativeMessage[] = [
    { role: "user", content: [{ type: "text", text: "q" }] },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "先读", signature: "s" },
        {
          type: "tool_use",
          id: "tu-live-ok",
          name: "read_file",
          input: { path: "a.ts" },
        },
        { type: "text", text: "anchor 文本" },
      ],
    },
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "tu-live-ok", content: "ok" },
      ],
    },
  ];
  const thinkingMs: ReadonlyArray<number | null> = [null, 5000, null];
  const liveToolRuns: ReadonlyArray<LiveToolRun> = [
    {
      id: "tu-live-ok",
      name: "read_file",
      status: "ok",
      input: { path: "a.ts" },
      detail: "读取 a.ts",
    },
  ];
  const setup = await testRender(
    <ChatView
      session={sessionWith(messages, thinkingMs, "running-fg")}
      cols={COLS}
      rows={ROWS}
      liveToolLines={[]}
      liveToolRuns={liveToolRuns}
      thinkingExpanded={false}
      thinkingDraftMasked="收尾"
    />,
    { width: COLS, height: ROWS, exitOnCtrlC: false }
  );
  await setup.waitForVisualIdle();
  const frame = setup.captureCharFrame();
  expect(frame).toContain("read_file × 1");
  // read_file 完成行不出现在 tail(已被折叠计数行吸收)。
  expect(frame).not.toContain("读取 a.ts · ok");
  await setup.renderer.destroy();
});

test("exception:hidden agent_status 夹在 tool_result 与 final 之间 + running,final 的 thinkingMs 仍按 sourceIndex 映射", async () => {
  // 不变式:session.thinkingMs 与 messages 一一对应;ChatView 用过滤后的
  // visibleIndex 时,必须用 sourceIndexOfVisible 映射回盘上下标,否则
  // final 的 thinkingMs 读到 status 槽的 null → `Thought for` 消失;
  // 再叠加 hideThinking 的掐摘,thinking 秒数彻底丢失 —— plan T1
  // 例外类的「hidden user messages 仍要按 source index 映射」要求。
  const messages: AnthropicNativeMessage[] = [
    { role: "user", content: [{ type: "text", text: "q" }] },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "读一下", signature: "s1" },
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
        { type: "thinking", thinking: "最终", signature: "s2" },
        { type: "text", text: "完成总结" },
      ],
    },
  ];
  // final 在盘上下标 4,thinkingMs[4] = 30000 → 30 秒。
  const thinkingMs: ReadonlyArray<number | null> = [
    null,
    null,
    null,
    null,
    30000,
  ];
  const setup = await testRender(
    <ChatView
      session={sessionWith(messages, thinkingMs, "running-fg")}
      cols={COLS}
      rows={ROWS}
      liveToolLines={[]}
      liveToolRuns={[]}
      thinkingExpanded={false}
      thinkingDraftMasked=""
    />,
    { width: COLS, height: ROWS, exitOnCtrlC: false }
  );
  await setup.waitForVisualIdle();
  const frame = setup.captureCharFrame();
  expect(frame).toContain("完成总结");
  expect(frame).toContain("Thought for 30s");
  await setup.renderer.destroy();
});
