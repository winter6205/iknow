/** @jsxImportSource @opentui/react */
/**
 * tests/tui/t4-thinking-only-live-then-fold.test.tsx
 *
 * T4 (plans/tui-activity-block-live-signal.md 锁句 1/2/7 + specs/tui-activity-block.md
 * live-signal revision)：thinking-only live then fold —— 思考在流时正文槽
 * 流思考（落在 unanchored 块壳的正文槽里）；出现正文或工具后思考正文离开
 * 槽位、标题留 `Thought for Ns`（历史路径不变）；任意 tool running 不再关
 * 思考槽（live-signal 锁句 7）；`shouldShowLiveThinkingPanel` 移除 `toolRunning`
 * 维度，仅 `running + draft 非空` 即开思考（顶层 panel 已退役，仅供纯函数
 * 语义文档与历史夹具）。
 *
 * 这是 plans T4 验收。
 */
import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { ChatView } from "../../src/tui/chat-view.js";
import {
  attachSession,
  type TuiSessionState,
} from "../../src/tui/session-state.js";
import { shouldShowLiveThinkingPanel } from "../../src/tui/turn-fold-lines.js";
import type { AnthropicNativeMessage } from "../../src/harness/model-adapter/types.js";
import type { SessionFileV1 } from "../../src/session-api/store/schema.js";
import type { LiveToolRun } from "../../src/tui/live-tool-state.js";
import { formatThinkingLive } from "../../src/tui/think-fold.js";

const COLS = 80;
const ROWS = 36;

function sessionWith(
  msgs: ReadonlyArray<AnthropicNativeMessage>,
  opts: {
    readonly thinkingMs?: ReadonlyArray<number | null>;
    readonly runState?: "idle" | "running-fg";
  } = {}
): TuiSessionState {
  const file: SessionFileV1 = {
    schemaVersion: 1,
    conversation_id: "t4-thinking-fold",
    messages: [...msgs],
    turnCount: msgs.filter((m) => m.role === "assistant").length,
    updatedAt: "2026-09-15T00:00:00.000Z",
    jsonMode: false,
    title: "t4-thinking-fold",
    cwd: "/tmp",
    sanitized_at: "2026-09-15T00:00:00.000Z",
    ...(opts.thinkingMs !== undefined ? { thinkingMs: opts.thinkingMs } : {}),
  };
  const base = attachSession(file);
  return opts.runState !== undefined
    ? { ...base, runState: opts.runState }
    : base;
}

describe("T4 思考 only 流思考（unanchored 块槽路径）", () => {
  test("running + 仅有思考流 → 摘要 Thinking… 与正文末行可见（活在 unanchored 块壳）", async () => {
    // T4 live-signal revision：思考活在 unanchored 活动块的正文槽里 —
    // — ThinkingPanel 已退役，但视觉合同不变：`Thinking…` 标题 + 正文末
    // ≤3 行 dim 预览，全部装在 unanchored 块的 MessageShell 中。
    const setup = await testRender(
      <ChatView
        session={sessionWith(
          [{ role: "user", content: [{ type: "text", text: "q" }] }],
          { runState: "running-fg" }
        )}
        cols={COLS}
        rows={ROWS}
        liveToolLines={[]}
        liveToolRuns={[]}
        thinkingExpanded={false}
        thinkingDraftMasked={"末行丙-应出现\n末行丁-应出现\n末行戊-应出现"}
      />,
      { width: COLS, height: ROWS, exitOnCtrlC: false }
    );
    await setup.waitForVisualIdle();
    const frame = setup.captureCharFrame();
    // 唯一一份 `Thinking…`（unanchored 块壳内的思考块标题）。
    expect(frame.split("Thinking…").length - 1).toBe(1);
    expect(frame).toContain(formatThinkingLive());
    // 正文末 3 行通过 `thinkingPeekLines` 在 unanchored 块壳内可见。
    expect(frame).toContain("末行戊-应出现");
    await setup.renderer.destroy();
  });

  test("running + 流思考 + 噪音 live run（id 不在 history）→ 文档顺序思考在噪音之上", async () => {
    // T4 锁句 1：思考永远画在它驱动的那批动作之上（文档顺序）。
    // 真实 burst-only 场景：live run id 不在 messages 里 → `appendLiveBlocks`
    // 同时落 thinking 块 + noise 块，顺序 = thinking 先、noise 后。两者
    // 都在 unanchored 块壳里（同 MessageShell 渲染），所以思考应在噪音
    // 之上。带「同一 burst 内后续工具不再让位思考」语义（锁句 7）的
    // 真信号验证。
    const liveRuns: ReadonlyArray<LiveToolRun> = [
      {
        id: "tu-g-burst",
        name: "grep",
        status: "running",
        input: { pattern: "foo" },
      },
    ];
    const setup = await testRender(
      <ChatView
        session={sessionWith(
          [{ role: "user", content: [{ type: "text", text: "搜一下" }] }],
          { runState: "running-fg" }
        )}
        cols={COLS}
        rows={ROWS}
        liveToolLines={[]}
        liveToolRuns={liveRuns}
        thinkingExpanded={false}
        thinkingDraftMasked={"思考在噪音之上"}
      />,
      { width: COLS, height: ROWS, exitOnCtrlC: false }
    );
    await setup.waitForVisualIdle();
    const frame = setup.captureCharFrame();
    // 文档顺序：思考标题在 noise 标题之上。
    const thinkingIdx = frame.indexOf("Thinking…");
    const noiseIdx = frame.indexOf("calling grep × 1");
    expect(thinkingIdx).toBeGreaterThanOrEqual(0);
    expect(noiseIdx).toBeGreaterThanOrEqual(0);
    expect(thinkingIdx).toBeLessThan(noiseIdx);
    await setup.renderer.destroy();
  });
});

describe("T4 思考结束：正文离开槽、时长留标题", () => {
  test("已落定 thinkingMs + 思考流空 + 无工具 → 标题 `Thought for Ns` 在,正文不残留", async () => {
    const messages: AnthropicNativeMessage[] = [
      { role: "user", content: [{ type: "text", text: "q" }] },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "想一下", signature: "s" },
          { type: "text", text: "完成回答" },
        ],
      },
    ];
    const setup = await testRender(
      <ChatView
        session={sessionWith(messages, { thinkingMs: [null, 5000] })}
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
    expect(frame).toContain("Thought for 5s");
    expect(frame).toContain("完成回答");
    expect(frame.includes(formatThinkingLive())).toBe(false);
    await setup.renderer.destroy();
  });
});

describe("T4 shouldShowLiveThinkingPanel 让位语义改跟块槽位上下文", () => {
  test("running + 非空 thinkingDraft → 纯函数判定 `true`（toolRunning 闸已被锁句 7 退役）", () => {
    // T4 live-signal revision：锁句 7 删「任意 tool running 关思考」闸。
    // 该判定只承担纯函数语义文档（保留给历史夹具）；生产路径已改走
    // `liveThinking` 字段（`draftMasked.length > 0`），不再消费此函数。
    expect(
      shouldShowLiveThinkingPanel({
        running: true,
        thinkingDraft: "思考中",
      })
    ).toBe(true);
  });
});
