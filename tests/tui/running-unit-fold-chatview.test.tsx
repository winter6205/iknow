/** @jsxImportSource @opentui/react */
/**
 * tests/tui/running-unit-fold-chatview.test.tsx
 *
 * 不变式:ChatView 在 running 态仍要按「已完成单元」出折叠行 —— plan T1。
 *
 * running 面的 live 件归 **live activity group**（D9）所有,idle 面归
 * unit fold（D3）所有 —— 两者互斥,同一件不得双计（R4）。
 *
 * 5 类边界:empty / negative / overflow / concurrent / exception。SSOT:
 * src/tui/chat-view.tsx 消费 src/tui/turn-activity.ts 的两个 per-segment
 * 闸门 `shouldShowThinkingFold` / `shouldShowRetractFold`（turn 级
 * `shouldCollapseTurnToolRows` 已由 plans/tui-live-activity-fold.md T3 删除）。
 *
 * 子断言:
 *  (1) running + live thinking 已结束 + final thinkingMs > 0 → 帧内
 *      出现 `Thought for`(不靠 per-message ThinkingSummary 兜底);
 *  (2) running + 历史 turn 含 retract → 历史 retract 折叠行
 *      (e.g. `read_file × 1`) 仍渲染,不被 running 闸门吞掉;
 *  (3) running + 当前 turn live 已完成 retract → 由 live activity group
 *      接住(D9),tail 不再保留 retract 已完成态;
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

test("running + 当前 turn live 已完成 retract:由 live activity group 接住,tail 不留完成卡", async () => {
  // 不变式:当前 turn 在 running,liveToolRuns 含一条 `post_tool_use` 已完成
  // 的 read_file —— 它不在 history tool_use id 集合里(本 turn 的 assistant
  // 还没 commit),故只能由 **live activity group** 接住(D9;D3/R4 互斥:
  // running 面归组、idle 面归 unit fold)。tail 不留完成卡 = 不 double-render。
  const messages: AnthropicNativeMessage[] = [
    { role: "user", content: [{ type: "text", text: "q" }] },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "先读", signature: "s" },
        { type: "text", text: "anchor 文本" },
      ],
    },
  ];
  const thinkingMs: ReadonlyArray<number | null> = [null, 5000];
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
  // 落点 = 过程组摘要（收类件不逐条刷标题）。
  expect(frame).toContain("Reading × 1");
  // 完成卡不出现在 tail（已由组计数接住）。
  expect(frame.includes("read_file ·")).toBe(false);
  await setup.renderer.destroy();
});

test("T5:live 刚完成 read_file + 历史仅 user 查询 → 落点必须在帧上(组或折叠计数)", async () => {
  // 不变式(plans/tui-live-activity-fold.md T5):成功收类不得既从 live
  // 数组抹掉、又因 history tool_use id 被 tail 丢弃而无处可去。历史的
  // 这一轮只有 user 查询(assistant 还没 commit),live 侧刚跑完一条
  // read_file → 帧上必须可见过程组摘要(Reading × 1)或 `read_file × 1`,
  // 不得两边都空。
  const messages: AnthropicNativeMessage[] = [
    { role: "user", content: [{ type: "text", text: "读一下 a.ts" }] },
  ];
  const liveToolRuns: ReadonlyArray<LiveToolRun> = [
    {
      id: "tu-live-done",
      name: "read_file",
      status: "ok",
      input: { path: "a.ts" },
      detail: "读取 a.ts",
    },
  ];
  const setup = await testRender(
    <ChatView
      session={sessionWith(messages, [null], "running-fg")}
      cols={COLS}
      rows={ROWS}
      liveToolLines={[]}
      liveToolRuns={liveToolRuns}
      thinkingExpanded={false}
    />,
    { width: COLS, height: ROWS, exitOnCtrlC: false }
  );
  await setup.waitForVisualIdle();
  const frame = setup.captureCharFrame();
  // 落点二选一（T5 acceptance）：live activity group 摘要，或已画 unit
  // fold 计数。本 fixture 里 unit fold 臂不可达 —— 历史没有任何 assistant
  // 活动段可当锚（`buildFoldLinesBySegmentIndex` 的 fallback 也要一条 text
  // 段），所以实际接住它的是过程组；断言仍按 acceptance 写成析取，避免
  // 锁死未来合法的落点迁移。
  const landed =
    frame.includes("Reading × 1") || frame.includes("read_file × 1");
  expect(landed).toBe(true);
  // 完成件不算过程行 —— 逐条面不画读标题（收类落定只剩计数）。
  expect(frame.includes("read_file ·")).toBe(false);
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

/** 唯一 bash 卡标记 —— 帧上 `bash · <命令>` 出现次数（run 间以 idle
 *  小写 bash 标题行分隔，前缀不会误命中 running 行的 `Running 1 shell…`）。 */
function countBashCards(frame: string): number {
  let n = 0;
  let idx = 0;
  while (true) {
    const found = frame.indexOf("bash ·", idx);
    if (found === -1) return n;
    n += 1;
    idx = found + "bash ·".length;
  }
}

test("R1 frame：running-fg + 3 条已完成 bash → `Running 3 shell commands` + 恰一张 bash 卡", async () => {
  // 不变式(D9 spec specs/tui-tool-settled-appearance.md:27 / CONTEXT
  // `live activity group`):>=2 条非失败 bash 收进过程组摘要,逐条面只留
  // 最后一条作细节槽 —— 不是 3 张 `bash · <cmd>` 卡。
  const liveToolRuns: ReadonlyArray<LiveToolRun> = [
    {
      id: "b1",
      name: "bash",
      status: "ok",
      input: { command: "ls a" },
      detail: "ls a",
    },
    {
      id: "b2",
      name: "bash",
      status: "ok",
      input: { command: "ls b" },
      detail: "ls b",
    },
    {
      id: "b3",
      name: "bash",
      status: "ok",
      input: { command: "ls c" },
      detail: "ls c",
    },
  ];
  const setup = await testRender(
    <ChatView
      session={sessionWith(
        [{ role: "user", content: [{ type: "text", text: "跑三条" }] }],
        [null],
        "running-fg"
      )}
      cols={COLS}
      rows={ROWS}
      liveToolLines={[]}
      liveToolRuns={liveToolRuns}
      thinkingExpanded={false}
    />,
    { width: COLS, height: ROWS, exitOnCtrlC: false }
  );
  await setup.waitForVisualIdle();
  const frame = setup.captureCharFrame();
  expect(frame).toContain("Running 3 shell commands");
  expect(countBashCards(frame)).toBe(1);
  // 细节槽 = 最后一条 bash 的命令（D9「或最后一条 keep bash 的短预览」）。
  expect(frame).toContain("bash · ls c");
  expect(frame.includes("ls a")).toBe(false);
  expect(frame.includes("ls b")).toBe(false);
  await setup.renderer.destroy();
});

test("R1 frame：running-fg + 2 完成 bash + 1 条 running bash → `Running 3 shell commands` + running 命令可见 + 恰一张卡", async () => {
  // 不变式:running 件优先占细节槽（D9「当前 running 件」），且它与已完成
  // bash 同算进聚合计数（进行中不换过去时）。
  const liveToolRuns: ReadonlyArray<LiveToolRun> = [
    {
      id: "b1",
      name: "bash",
      status: "ok",
      input: { command: "ls a" },
      detail: "ls a",
    },
    {
      id: "b2",
      name: "bash",
      status: "ok",
      input: { command: "ls b" },
      detail: "ls b",
    },
    {
      id: "b3",
      name: "bash",
      status: "running",
      input: { command: "npm test" },
      partialInput: '{"command":"npm test"}',
    },
  ];
  const setup = await testRender(
    <ChatView
      session={sessionWith(
        [{ role: "user", content: [{ type: "text", text: "跑三条" }] }],
        [null],
        "running-fg"
      )}
      cols={COLS}
      rows={ROWS}
      liveToolLines={[]}
      liveToolRuns={liveToolRuns}
      thinkingExpanded={false}
    />,
    { width: COLS, height: ROWS, exitOnCtrlC: false }
  );
  await setup.waitForVisualIdle();
  const frame = setup.captureCharFrame();
  expect(frame).toContain("Running 3 shell commands");
  // running 件的贴底过程行 `Running 1 shell command… · <cmd>` —— 细节槽唯一一条。
  expect(frame).toContain("Running 1 shell command… · npm test");
  // 已完成 bash 只剩计数，不逐条刷卡（`bash ·` 前缀 0 次）。
  expect(countBashCards(frame)).toBe(0);
  await setup.renderer.destroy();
});

test("R1 frame：running-fg + 1 条已完成 bash → 无 `Running N shell commands` 段，单卡可见", async () => {
  // 不变式(CONTEXT `live tool line`):单条 keep bash 的命令走普通卡片 /
  // 细节槽,不构成聚合段（阈值 >=2）。
  const liveToolRuns: ReadonlyArray<LiveToolRun> = [
    {
      id: "b1",
      name: "bash",
      status: "ok",
      input: { command: "ls solo" },
      detail: "ls solo",
    },
  ];
  const setup = await testRender(
    <ChatView
      session={sessionWith(
        [{ role: "user", content: [{ type: "text", text: "跑一条" }] }],
        [null],
        "running-fg"
      )}
      cols={COLS}
      rows={ROWS}
      liveToolLines={[]}
      liveToolRuns={liveToolRuns}
      thinkingExpanded={false}
    />,
    { width: COLS, height: ROWS, exitOnCtrlC: false }
  );
  await setup.waitForVisualIdle();
  const frame = setup.captureCharFrame();
  expect(frame.includes("Running ")).toBe(false);
  expect(frame).toContain("bash · ls solo");
  await setup.renderer.destroy();
});

test("R4 frame：running 时 live 已完成件归过程组 —— 不并进 unit fold（互斥，不双计）", async () => {
  // 不变式(D9 / CONTEXT `open unit`):turn 仍在 running 时,live 已完成件由
  // **live activity group** 拥有;unit fold 只数 settled history。同一批件
  // 不得既进 `read_file × N` 折叠行又进 `Reading × N` 组行。
  const messages: AnthropicNativeMessage[] = [
    { role: "user", content: [{ type: "text", text: "读一批再搜" }] },
    {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "tu-rd-hist",
          name: "read_file",
          input: { path: "hist.ts" },
        },
        {
          type: "tool_use",
          id: "tu-grep-hist",
          name: "grep",
          input: { pattern: "needle" },
        },
      ],
    },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "tu-rd-hist",
          content: "hist body",
        },
        {
          type: "tool_result",
          tool_use_id: "tu-grep-hist",
          content: "1 match",
        },
      ],
    },
  ];
  const liveToolRuns: ReadonlyArray<LiveToolRun> = [
    {
      id: "live-r1",
      name: "read_file",
      status: "ok",
      input: { path: "a.ts" },
      detail: "读取 a.ts",
    },
    {
      id: "live-r2",
      name: "read_file",
      status: "ok",
      input: { path: "b.ts" },
      detail: "读取 b.ts",
    },
  ];
  const setup = await testRender(
    <ChatView
      session={sessionWith(messages, [null, 4000, null], "running-fg")}
      cols={COLS}
      rows={ROWS}
      liveToolLines={[]}
      liveToolRuns={liveToolRuns}
      thinkingExpanded={false}
    />,
    { width: COLS, height: ROWS, exitOnCtrlC: false }
  );
  await setup.waitForVisualIdle();
  const frame = setup.captureCharFrame();
  // settled history 的折叠行仍在（fold 归历史）。
  expect(frame).toContain("read_file × 1");
  // live 两件归组（D9）。
  expect(frame).toContain("Reading × 2");
  // 双计回归：live 两件不得并进 fold 计数（`read_file × 3` = 1 历史 + 2 live）。
  expect(frame.includes("read_file × 3")).toBe(false);
  await setup.renderer.destroy();
});

test("R5 frame：idle 不画过程组行（组是进行中 chrome，落定走 unit fold）", async () => {
  // 不变式(D9「turn 仍在 running 时」/「idle 落定仍走 unit fold」):组摘要
  // 只在 running 面出现;idle 帧不得残留 `Reading × N` 组段。
  const liveToolRuns: ReadonlyArray<LiveToolRun> = [
    {
      id: "tu-idle-rd",
      name: "read_file",
      status: "ok",
      input: { path: "a.ts" },
      detail: "读取 a.ts",
    },
  ];
  const setup = await testRender(
    <ChatView
      session={sessionWith(
        [{ role: "user", content: [{ type: "text", text: "读一下" }] }],
        [null],
        "idle"
      )}
      cols={COLS}
      rows={ROWS}
      liveToolLines={[]}
      liveToolRuns={liveToolRuns}
      thinkingExpanded={false}
    />,
    { width: COLS, height: ROWS, exitOnCtrlC: false }
  );
  await setup.waitForVisualIdle();
  const frame = setup.captureCharFrame();
  expect(frame.includes("Reading ×")).toBe(false);
  expect(frame.includes("Running ")).toBe(false);
  await setup.renderer.destroy();
});

test("R5 frame：idle + ≥2 条完成 bash → 聚合停摆，逐条 keep 卡各自可见", async () => {
  // 不变式(CONTEXT `live activity group`「idle 仍走 unit fold + keep 标题」):
  // idle 时摘要行不画（R5 上一条），聚合若仍吞卡 = keep 卡既不在组行也不在
  // 逐条面 = 静默丢件（unit fold 只接 retract）。
  const liveToolRuns: ReadonlyArray<LiveToolRun> = [
    {
      id: "tu-idle-b1",
      name: "bash",
      status: "ok",
      input: { command: "cmd-alpha" },
      detail: "cmd-alpha",
    },
    {
      id: "tu-idle-b2",
      name: "bash",
      status: "ok",
      input: { command: "cmd-beta" },
      detail: "cmd-beta",
    },
  ];
  const setup = await testRender(
    <ChatView
      session={sessionWith(
        [{ role: "user", content: [{ type: "text", text: "跑两条" }] }],
        [null],
        "idle"
      )}
      cols={COLS}
      rows={ROWS}
      liveToolLines={[]}
      liveToolRuns={liveToolRuns}
      thinkingExpanded={false}
    />,
    { width: COLS, height: ROWS, exitOnCtrlC: false }
  );
  await setup.waitForVisualIdle();
  const frame = setup.captureCharFrame();
  expect(frame.includes("shell command")).toBe(false);
  expect(frame).toContain("bash · cmd-alpha");
  expect(frame).toContain("bash · cmd-beta");
  await setup.renderer.destroy();
});

test("R5 frame：idle + 落定 retract → 标题不摊（D3 showTitle 同假）", async () => {
  // 不变式(D3 `specs/tui-tool-settled-appearance.md`:22「retract 必须
  // showTitle 与 showPreview 同假」):idle 面不得把落定 retract 放回逐条面。
  const liveToolRuns: ReadonlyArray<LiveToolRun> = [
    {
      id: "tu-idle-r1",
      name: "read_file",
      status: "ok",
      input: { path: "RETRACT_MARKER_A.ts" },
      detail: "RETRACT_MARKER_A.ts",
    },
    {
      id: "tu-idle-r2",
      name: "read_file",
      status: "ok",
      input: { path: "RETRACT_MARKER_B.ts" },
      detail: "RETRACT_MARKER_B.ts",
    },
  ];
  const setup = await testRender(
    <ChatView
      session={sessionWith(
        [{ role: "user", content: [{ type: "text", text: "读两个" }] }],
        [null],
        "idle"
      )}
      cols={COLS}
      rows={ROWS}
      liveToolLines={[]}
      liveToolRuns={liveToolRuns}
      thinkingExpanded={false}
    />,
    { width: COLS, height: ROWS, exitOnCtrlC: false }
  );
  await setup.waitForVisualIdle();
  const frame = setup.captureCharFrame();
  expect(frame.includes("RETRACT_MARKER_")).toBe(false);
  expect(frame.includes("read_file ·")).toBe(false);
  await setup.renderer.destroy();
});

test("R6-1 frame：仅计数折叠（无 thinkingMs）+ 非空 thinkingDraft → thinking panel 仍在", async () => {
  // 不变式(CONTEXT `open unit`):已画 unit fold **不是**关 thinking panel 的
  // 信号 —— 只计数（无秒数）的折叠行不得吞掉后续思考流。
  const messages: AnthropicNativeMessage[] = [
    { role: "user", content: [{ type: "text", text: "先读" }] },
    {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "tu-rd-1",
          name: "read_file",
          input: { path: "a.ts" },
        },
      ],
    },
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "tu-rd-1", content: "ok" }],
    },
  ];
  // thinkingMs 全 null → 折叠行只有计数,无 `Thought for`。
  const setup = await testRender(
    <ChatView
      session={sessionWith(messages, [null, null, null], "running-fg")}
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
  expect(frame).toContain("read_file × 1");
  expect(frame).toContain("Thinking…");
  await setup.renderer.destroy();
});

test("R6-2 frame：running keep bash 在场 → 历史 retract 折叠行仍可见", async () => {
  // 不变式(T5):keep bash 的 live 细节槽不得把 settled history 的 unit fold
  // 顶掉 —— `read_file × 1` 与 bash 过程行同帧共存。
  const messages: AnthropicNativeMessage[] = [
    { role: "user", content: [{ type: "text", text: "q1" }] },
    {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "tu-rd-hist",
          name: "read_file",
          input: { path: "a.ts" },
        },
      ],
    },
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "tu-rd-hist", content: "ok" },
      ],
    },
    { role: "user", content: [{ type: "text", text: "q2" }] },
  ];
  const liveToolRuns: ReadonlyArray<LiveToolRun> = [
    {
      id: "tu-bash-live",
      name: "bash",
      status: "running",
      input: { command: "npm test" },
      partialInput: '{"command":"npm test"}',
    },
  ];
  // thinkingMs 全 null → 折叠行只能由 retract 计数闸门画出（唯一路径），
  // 避免思考秒数把行带出来后本断言空转。
  const setup = await testRender(
    <ChatView
      session={sessionWith(messages, [null, null, null, null], "running-fg")}
      cols={COLS}
      rows={ROWS}
      liveToolLines={[]}
      liveToolRuns={liveToolRuns}
      thinkingExpanded={false}
    />,
    { width: COLS, height: ROWS, exitOnCtrlC: false }
  );
  await setup.waitForVisualIdle();
  const frame = setup.captureCharFrame();
  expect(frame).toContain("read_file × 1");
  expect(frame).toContain("Running 1 shell command… · npm test");
  await setup.renderer.destroy();
});
