/** @jsxImportSource @opentui/react */
/**
 * tests/tui/t4-thinking-only-live-then-fold.test.tsx
 *
 * Thinking-at-bottom revision（plans/tui-thinking-at-bottom.md 锁句 1–3 +
 * specs/tui-activity-block.md Thinking-at-bottom 锁句）：思考在流期间是
 * transcript 最底（unanchored thinking 壳）；同一 burst 内 live 安静簇
 * （已冒出来的动作）画在思考上面；下一段思考作为新的最底进入 unanchored
 * —— 已经可见的工具卡 / tail 槽卡 都不被「钉在思考下面」（旧 Live-signal
 * 锁句 1 行为）。
 *
 * `shouldShowLiveThinkingPanel` 仅作纯函数语义文档（顶层 panel 已退役，
 * 思考活在 unanchored 思考壳）。
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
  test("running + 仅思考流（无工具）→ `Thinking…` 是 transcript 最底", async () => {
    // Thinking-at-bottom revision 锁句 1：仅思考流时 `Thinking…` 必须是
    // transcript 最底元素（unanchored thinking 壳 + askLine 之后、Spinner 之
    // 前）；屏上 `Thinking…` 仅出现一次；折叠态 preview 由 thinkingPeekLines
    // 露出末 3 行。
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
    const lines = frame.split("\n").map((l) => l.trim());
    // 唯一一份 `Thinking…`（unanchored thinking 壳）。
    expect(frame.split("Thinking…").length - 1).toBe(1);
    expect(frame).toContain(formatThinkingLive());
    // 正文末 3 行通过 `thinkingPeekLines` 可见。
    expect(frame).toContain("末行戊-应出现");
    // 锁句 1：`Thinking…` 出现在 Spinner / 「Running …」之前，且是本帧
    // 最底（屏上行序 = running state + crunched + 未锚定非思考 + tailSlots +
    // askLine + 思考 + Spinner）。
    const thinkingIdx = lines.findIndex((l) => l.startsWith("Thinking"));
    const spinnerIdx = lines.findIndex((l) => l.includes("运行中"));
    expect(thinkingIdx).toBeGreaterThanOrEqual(0);
    expect(spinnerIdx).toBeGreaterThanOrEqual(0);
    expect(thinkingIdx).toBeLessThan(spinnerIdx);
    await setup.renderer.destroy();
  });

  test("running + 流思考 + 非 history noise run → noise 标题在 `Thinking…` 之上", async () => {
    // Thinking-at-bottom revision 锁句 1：同一 burst 内 live 安静簇（已
    // 冒出来的动作）画在前，思考块画在最后 —— 还在流的思考是本批最底；
    // 它驱动的那批动作若已出现则在它上面。noise 标题必须在 `Thinking…`
    // 之上（屏序）。
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
    // 屏序：noise 标题在 `Thinking…` 之上（noise 命中早于思考）。
    const noiseIdx = frame.indexOf("calling grep × 1");
    const thinkingIdx = frame.indexOf("Thinking…");
    expect(noiseIdx).toBeGreaterThanOrEqual(0);
    expect(thinkingIdx).toBeGreaterThanOrEqual(0);
    expect(noiseIdx).toBeLessThan(thinkingIdx);
    await setup.renderer.destroy();
  });

  test("running + 流思考 + 已可见 tail 工具卡（live signal）→ `Thinking…` 在 tail 卡之下", async () => {
    // Thinking-at-bottom revision 锁句 3：下一段思考（工具结果回来后的下一
    // 条 assistant）出现在新的最底，低于已经可见的工具（live signal 实卡）。
    // 本用例 live signal 工具 = web_search tail 卡（不被块消费 → 走 tail
    // `LiveTailSlot`），第二段思考流必须挂到该卡之下 —— 屏上 `Thinking…`
    // 的索引晚于「Search <query>」卡行。
    const messages: AnthropicNativeMessage[] = [
      { role: "user", content: [{ type: "text", text: "搜一下" }] },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "先想", signature: "s1" },
          {
            type: "tool_use",
            id: "tu-w-tail",
            name: "web_search",
            input: { query: "今天的AI" },
          },
        ],
      },
    ];
    const liveRuns: ReadonlyArray<LiveToolRun> = [
      {
        id: "tu-w-tail",
        name: "web_search",
        status: "running",
        input: { query: "今天的AI" },
        detail: "Search 今天的AI",
      },
    ];
    const setup = await testRender(
      <ChatView
        session={sessionWith(messages, {
          thinkingMs: [null, 5000],
          runState: "running-fg",
        })}
        cols={COLS}
        rows={ROWS}
        liveToolLines={[]}
        liveToolRuns={liveRuns}
        thinkingExpanded={false}
        thinkingDraftMasked={"第二段思考-应出现"}
      />,
      { width: COLS, height: ROWS, exitOnCtrlC: false }
    );
    await setup.waitForVisualIdle();
    const frame = setup.captureCharFrame();
    // tail 卡可见（live signal 实卡）。
    expect(frame).toContain("Search 今天的AI");
    // `Thinking…` 在 tail 卡行之下。
    const cardIdx = frame.indexOf("Search 今天的AI");
    const thinkingIdx = frame.indexOf("Thinking…");
    expect(cardIdx).toBeGreaterThanOrEqual(0);
    expect(thinkingIdx).toBeGreaterThanOrEqual(0);
    expect(thinkingIdx).toBeGreaterThan(cardIdx);
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
