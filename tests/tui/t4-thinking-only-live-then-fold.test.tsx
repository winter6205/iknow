/** @jsxImportSource @opentui/react */
/**
 * tests/tui/t4-thinking-only-live-then-fold.test.tsx
 *
 * Thinking-at-bottom revision (lock clauses 1–3; also the Thinking-at-bottom
 * lock clauses in specs/tui-activity-block.md): during streaming, thinking sits
 * at the bottom of the transcript (unanchored thinking shell); the live quiet
 * cluster within the same burst (actions already surfaced) draws above the
 * thinking; the next thinking segment enters unanchored as a new bottom —
 * already-visible tool cards / tail-slot cards are never "pinned below
 * thinking" (the old Live-signal lock clause 1 behavior).
 *
 * `shouldShowLiveThinkingPanel` serves only as pure-function semantic
 * documentation (the top-level panel is retired; thinking lives in the
 * unanchored thinking shell).
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
    // Thinking-at-bottom revision lock clause 1: with a thinking-only stream,
    // `Thinking…` must be the bottommost transcript element (unanchored
    // thinking shell + after askLine, before Spinner); `Thinking…` appears
    // exactly once on screen; the collapsed preview is exposed by
    // thinkingPeekLines as the last 3 lines.
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
    // Single copy of `Thinking…` (unanchored thinking shell).
    expect(frame.split("Thinking…").length - 1).toBe(1);
    expect(frame).toContain(formatThinkingLive());
    // Last 3 body lines visible via `thinkingPeekLines`.
    expect(frame).toContain("末行戊-应出现");
    // Lock clause 1: `Thinking…` appears before the Spinner / 「Running …」 and
    // is the frame bottom (on-screen order = running state + crunched +
    // unanchored non-thinking + tailSlots + askLine + thinking + Spinner).
    const thinkingIdx = lines.findIndex((l) => l.startsWith("Thinking"));
    const spinnerIdx = lines.findIndex((l) => l.includes("运行中"));
    expect(thinkingIdx).toBeGreaterThanOrEqual(0);
    expect(spinnerIdx).toBeGreaterThanOrEqual(0);
    expect(thinkingIdx).toBeLessThan(spinnerIdx);
    await setup.renderer.destroy();
  });

  test("running + 流思考 + 非 history noise run → noise 标题在 `Thinking…` 之上", async () => {
    // Thinking-at-bottom revision lock clause 1: within one burst the live
    // quiet cluster (already-surfaced actions) draws first, the thinking block
    // last — thinking still streaming is the burst bottom; actions it drives,
    // once visible, sit above it. The noise title must be above `Thinking…`
    // (screen order).
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
    // Screen order: noise title above `Thinking…` (noise landed before thinking).
    const noiseIdx = frame.indexOf("calling grep × 1");
    const thinkingIdx = frame.indexOf("Thinking…");
    expect(noiseIdx).toBeGreaterThanOrEqual(0);
    expect(thinkingIdx).toBeGreaterThanOrEqual(0);
    expect(noiseIdx).toBeLessThan(thinkingIdx);
    await setup.renderer.destroy();
  });

  test("running + 流思考 + 已可见 tail 工具卡（live signal）→ `Thinking…` 在 tail 卡之下", async () => {
    // Thinking-at-bottom revision lock clause 3: the next thinking (the next
    // assistant after tool results return) appears at a new bottom, below
    // already-visible tools (live-signal real cards). Here the live-signal tool
    // = web_search tail card (not consumed by the block → tail `LiveTailSlot`);
    // the second thinking stream must hang under that card — on screen the
    // `Thinking…` index comes after the「Search <query>」card line.
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
    // Tail card visible (live-signal real card).
    expect(frame).toContain("Search 今天的AI");
    // `Thinking…` below the tail card line.
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
    // Live-signal revision: lock clause 7 deleted the "any tool running
    // closes thinking" gate. This predicate is pure-function semantic
    // documentation only (kept for historical fixtures); the production path
    // now uses the `liveThinking` field (`draftMasked.length > 0`) and no longer
    // consumes this function.
    expect(
      shouldShowLiveThinkingPanel({
        running: true,
        thinkingDraft: "思考中",
      })
    ).toBe(true);
  });
});
