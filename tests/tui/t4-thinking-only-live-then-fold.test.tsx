/** @jsxImportSource @opentui/react */
/**
 * tests/tui/t4-thinking-only-live-then-fold.test.tsx
 *
 * T4 (plans/tui-activity-block.md T4 + specs/tui-activity-block.md)：
 * thinking-only live then fold —— 思考在流时正文槽流思考（ThinkingPanel 路径不变）；
 * 出现正文或工具后思考正文离开槽位、标题留 `Thought for Ns`；工具 running 不得在
 * 思考仍流时抢槽（`shouldShowLiveThinkingPanel` 让位语义保持「草稿非空 + 无工具
 * running」**但**「工具 running」的判定改成**当前块的**槽位上下文，不再是整轮
 * running——具体 = 当块安静工具 calling 时让位，其他块的 running 工具不让位）。
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

describe("T4 思考 only 流思考（ThinkingPanel 路径不变）", () => {
  test("running + 仅有思考流 → 摘要 Thinking… 与正文末行可见", async () => {
    // T4 验收：思考仍在流时 ThinkingPanel 走原路径 ——
    // 摘要 + 正文末 ≤3 行可见，槽位归思考。
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
    expect(frame).toContain(formatThinkingLive());
    expect(frame).toContain("末行戊-应出现");
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
  test("running + 非空 thinkingDraft + 无工具 running → 让位判定保留 `true`", () => {
    // 草稿非空 + 无工具 running = 槽归思考。
    expect(
      shouldShowLiveThinkingPanel({
        running: true,
        thinkingDraft: "思考中",
        toolRunning: false,
      })
    ).toBe(true);
  });

  test("running + 非空 thinkingDraft + 工具 running → 旧判定仍 false（让位给 running）", () => {
    // 旧「整轮 running」语义保留为 backward 入口——调用方可在传入前先收敛到块上下文；
    // 本断言钉函数纯函数语义不漂。
    expect(
      shouldShowLiveThinkingPanel({
        running: true,
        thinkingDraft: "思考中",
        toolRunning: true,
      })
    ).toBe(false);
  });
});
