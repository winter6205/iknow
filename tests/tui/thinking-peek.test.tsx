/** @jsxImportSource @opentui/react */
/**
 * tests/tui/thinking-peek.test.tsx
 *
 * Contract while thinking is in progress: the collapsed (unexpanded) TUI
 * peeks the last <=3 lines of thinking body; when the turn ends the whole
 * streaming thinking panel disappears.
 *
 * Acceptance:
 *  - collapsed + thinking running: `思考中…` summary line is visible **and**
 *    the tail body lines are visible (<= THINKING_PEEK_MAX_LINES = 3, taken
 *    from the end); earlier body lines must not appear;
 *  - turn ended (runState not running-fg) -> the whole streaming thinking
 *    panel disappears;
 *  - Ctrl+O / `thinkingExpanded` full-open path unchanged (full Markdown);
 *  - collapsed panel height is independent of thinking length -- the peek is
 *    a <=3-line window, not the full text (row height must not treat the
 *    peek as full-text height).
 *
 * The former "thinking frozen (answer started) -> fold back to summary-only
 * `思考了 N 秒`" case was retired together with the `thinkingFrozenSeconds`
 * side channel -- there is no frozen branch while running; collapsed state
 * always shows `思考中…`; after the turn ends the last assistant message's
 * persisted thinkingMs takes over (see
 * `chat-view-thinking-tool-fold.test.tsx`). This file no longer holds that
 * case.
 *
 * Wording assertions use think-fold.ts output only; no template strings are
 * copied into the tests.
 */
import { createRef } from "react";
import { expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { ChatView, type ChatViewHandle } from "../../src/tui/chat-view.js";
import {
  attachSession,
  type TuiSessionState,
} from "../../src/tui/session-state.js";
import {
  THINKING_PEEK_MAX_LINES,
  formatThinkingLive,
} from "../../src/tui/think-fold.js";
import type { AnthropicNativeMessage } from "../../src/harness/model-adapter/types.js";
import type { LiveToolRun } from "../../src/tui/live-tool-state.js";
import type { SessionFileV1 } from "../../src/session-api/store/schema.js";

const COLS = 60;
const ROWS = 16;

/** Five thinking body lines: the first two are "earlier lines" that must stay hidden; the last three are the peek window. */
const THINKING_FIVE_LINES = [
  "早行甲-不应出现",
  "早行乙-不应出现",
  "末行丙-应出现",
  "末行丁-应出现",
  "末行戊-应出现",
].join("\n");

function sessionWith(
  msgs: ReadonlyArray<AnthropicNativeMessage>
): TuiSessionState {
  const file: SessionFileV1 = {
    schemaVersion: 1,
    conversation_id: "thinking-peek",
    messages: [...msgs],
    turnCount: msgs.filter((m) => m.role === "assistant").length,
    updatedAt: "2026-08-27T00:00:00.000Z",
    jsonMode: false,
  };
  return attachSession(file);
}

function runningSession(): TuiSessionState {
  const base = sessionWith([
    { role: "user", content: [{ type: "text", text: "复杂问题" }] },
  ]);
  return { ...base, runState: "running-fg" };
}

test("思考进行中 + 未展开：摘要行 `思考中…` + 正文末 3 行，更早的行不出现", async () => {
  const setup = await testRender(
    <ChatView
      session={runningSession()}
      cols={COLS}
      rows={ROWS}
      liveToolLines={[]}
      thinkingExpanded={false}
      thinkingDraftMasked={THINKING_FIVE_LINES}
    />,
    { width: COLS, height: ROWS, exitOnCtrlC: false }
  );
  await setup.waitForVisualIdle();
  const frame = setup.captureCharFrame();
  expect(frame).toContain(formatThinkingLive());
  expect(frame).toContain("末行丙-应出现");
  expect(frame).toContain("末行丁-应出现");
  expect(frame).toContain("末行戊-应出现");
  expect(frame.includes("早行甲-不应出现")).toBe(false);
  expect(frame.includes("早行乙-不应出现")).toBe(false);
  await setup.renderer.destroy();
});

test("turn 结束（非 running-fg）：流式 thinking 面板整体消失，正文不残留", async () => {
  const idle = sessionWith([
    { role: "user", content: [{ type: "text", text: "复杂问题" }] },
    { role: "assistant", content: [{ type: "text", text: "正式回答" }] },
  ]);
  const setup = await testRender(
    <ChatView
      session={idle}
      cols={COLS}
      rows={ROWS}
      liveToolLines={[]}
      thinkingExpanded={false}
      thinkingDraftMasked={THINKING_FIVE_LINES}
    />,
    { width: COLS, height: ROWS, exitOnCtrlC: false }
  );
  await setup.waitForVisualIdle();
  const frame = setup.captureCharFrame();
  expect(frame).toContain("正式回答");
  expect(frame.includes("末行戊-应出现")).toBe(false);
  expect(frame.includes(formatThinkingLive())).toBe(false);
  await setup.renderer.destroy();
});

test("Ctrl+O 全开路径不变：thinkingExpanded 时早行与末行都可见", async () => {
  const setup = await testRender(
    <ChatView
      session={runningSession()}
      cols={COLS}
      rows={ROWS}
      liveToolLines={[]}
      thinkingExpanded={true}
      thinkingDraftMasked={THINKING_FIVE_LINES}
    />,
    { width: COLS, height: ROWS, exitOnCtrlC: false }
  );
  await setup.waitForVisualIdle();
  const frame = setup.captureCharFrame();
  expect(frame).toContain("早行甲-不应出现");
  expect(frame).toContain("末行戊-应出现");
  await setup.renderer.destroy();
});

test("折叠态面板高度与思考全文长度无关：预览 ≤3 行，不按全文算高度", async () => {
  const measure = async (draft: string): Promise<number> => {
    const ref = createRef<ChatViewHandle>();
    const setup = await testRender(
      <ChatView
        ref={ref}
        session={runningSession()}
        cols={COLS}
        rows={ROWS}
        liveToolLines={[]}
        thinkingExpanded={false}
        thinkingDraftMasked={draft}
      />,
      { width: COLS, height: ROWS, exitOnCtrlC: false }
    );
    await setup.waitForVisualIdle();
    const scrollHeight = ref.current?.scrollbox?.scrollHeight ?? -1;
    await setup.renderer.destroy();
    return scrollHeight;
  };

  const threeShortLines = await measure("甲\n乙\n丙");
  const manyLines = await measure(
    Array.from({ length: 120 }, (_, i) => `思考行-${i}`).join("\n")
  );
  const longWrappingLines = await measure(
    Array.from({ length: 4 }, (_, i) => `${i}${"长".repeat(COLS * 3)}`).join(
      "\n"
    )
  );

  expect(threeShortLines).toBeGreaterThan(0);
  expect(manyLines).toBe(threeShortLines);
  expect(longWrappingLines).toBe(threeShortLines);

  const noThinking = await measure("");
  expect(threeShortLines - noThinking).toBeLessThanOrEqual(
    THINKING_PEEK_MAX_LINES + 1
  );
});

test("running：已返回正文草稿时，流式思考不抢正文槽位（活动块 spec 下 unanchored 块与 draft 段栈序）", async () => {
  // After the old `live activity group` was retired, live thinking is shown
  // via two channels: the unanchored block plus the thinking panel. The
  // unanchored block anchors after messages.length, directly above tailSlots
  // -- draftSegments as TailSlotDraft still order within tailSlots by
  // draftEpoch. Stack order details live in transcript-tail.tsx and
  // activity-block.ts (liveThinking block). This test only checks the basic
  // no-loss contract: draft in frame, Thinking… in frame, neither suppresses
  // the other.
  const returned = "RETURNED-SEGMENT-UNIQUE";
  const setup = await testRender(
    <ChatView
      session={runningSession()}
      cols={COLS}
      rows={24}
      liveToolLines={[]}
      thinkingExpanded={false}
      draftSegments={[returned]}
      thinkingDraftMasked="NEXT-THINK-UNIQUE"
    />,
    { width: COLS, height: 24, exitOnCtrlC: false }
  );
  await setup.waitForVisualIdle();
  const frame = setup.captureCharFrame();
  expect(frame).toContain(returned);
  expect(frame).toContain(formatThinkingLive());
  await setup.renderer.destroy();
});
