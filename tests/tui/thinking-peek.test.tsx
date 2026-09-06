/** @jsxImportSource @opentui/react */
/**
 * tests/tui/thinking-peek.test.tsx
 *
 * plans/model-idle-thinking-peek.md T2：TUI 未展开折叠态在思考**进行中**
 * 露出正文末 ≤3 行，turn 结束后流式 thinking 面板整体消失。
 *
 * 合同（计划 T2 Acceptance）：
 *  - 未展开 + 思考进行中：可见 `思考中…` 摘要行 **且** 可见正文末行
 *    （≤ THINKING_PEEK_MAX_LINES = 3，取末尾）；更早的正文行不出现；
 *  - turn 结束（runState 非 running-fg）→ 整个流式 thinking 面板消失；
 *  - Ctrl+O / `thinkingExpanded` 全开路径不变（Markdown 全文）；
 *  - 折叠态面板高度与思考全文长度无关 —— 预览是 ≤3 行的窗口，不是全文
 *    （行高不把预览当全文高度）。
 *
 * D3 (tui-display-consistency)：原「思考冻结（answer 已开始）→ 折回仅
 * 摘要行 `思考了 N 秒`」用例随 `thinkingFrozenSeconds` 副通道一同下线
 * —— running 期间不再有冻结分支，折叠态恒 `思考中…`；turn 结束后由
 * 末条 assistant 消息的落盘 thinkingMs 接手（见
 * `chat-view-thinking-tool-fold.test.tsx`）。本文件不再持有该用例。
 *
 * 文案断言只对 think-fold.ts 的输出，不在测试里另抄模板字符串。
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
import type { SessionFileV1 } from "../../src/session-api/store/schema.js";

const COLS = 60;
const ROWS = 16;

/** 五行思考正文：前两行是「更早的行」，末三行是预览应命中的窗口。 */
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

test("running：已返回正文草稿时，流式思考出现在该正文之下", async () => {
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
  const returnedAt = frame.indexOf(returned);
  const thinkAt = frame.indexOf(formatThinkingLive());
  expect(returnedAt).toBeGreaterThanOrEqual(0);
  expect(thinkAt).toBeGreaterThan(returnedAt);
  await setup.renderer.destroy();
});
