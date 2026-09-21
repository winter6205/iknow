/** @jsxImportSource @opentui/react */
/**
 * tests/tui/streaming-thinking-close-on-tool-call.test.tsx
 *
 * Invariant: the streaming thinking panel must collapse when the thinking
 * phase ends mid-turn (model moves from thinking to tool_call_start or
 * text_delta) — it must not linger until the whole turn finishes. Later
 * thinking_delta accumulates as a new segment.
 *
 * Locks the invariant via a stubbed streamDraft event sequence (thinking_delta
 * ×N → tool_call_start → assert `thinkingMasked()` returns "" + listener
 * notified); no real model involved.
 */
import { expect, test } from "bun:test";
import { createStreamDraft } from "../../src/cli/stream-draft.js";

test("tool_call_start 后 thinkingMasked() 返回空串：thinking 阶段结束", () => {
  const draft = createStreamDraft();
  draft.append({ type: "thinking_delta", text: "思考甲" });
  draft.append({ type: "thinking_delta", text: "思考乙" });
  // not yet cleared → thinking body still present
  expect(draft.thinkingMasked()).toContain("思考");
  // tool-call start ends the thinking phase → thinkingBuffer must be cleared
  draft.append({
    type: "tool_call_start",
    name: "bash",
    id: "tu-tool-1",
  });
  expect(draft.thinkingMasked()).toBe("");
  // pin thinkingRaw too (in case the implementation tracks raw instead of masked).
  expect(draft.thinkingRaw()).toBe("");
});

test("tool_call_start 触发 listener 通知,让 ChatView 重渲染", () => {
  const draft = createStreamDraft();
  let notifyCount = 0;
  const unsubscribe = draft.subscribe(() => {
    notifyCount++;
  });
  draft.append({ type: "thinking_delta", text: "思考正文" });
  const notifyBeforeToolStart = notifyCount;
  // Must flush immediately after tool_call_start (no 50ms throttle wait) so
  // ChatView re-renders synchronously and hides the thinking panel — a throttled
  // flush keeps the panel visible 50ms past the tool call, contradicting the
  // "collapse when the thinking phase ends" contract.
  draft.append({
    type: "tool_call_start",
    name: "bash",
    id: "tu-tool-1",
  });
  expect(notifyCount).toBeGreaterThan(notifyBeforeToolStart);
  unsubscribe();
});

test("tool_call_start 后续 text_delta 不重新启用流式 thinking 面板", () => {
  // Sequence: thinking → tool → tool result → later text_delta (final answer)
  // must not re-trigger thinking-panel accumulation or re-render.
  const draft = createStreamDraft();
  draft.append({ type: "thinking_delta", text: "思考正文" });
  draft.append({
    type: "tool_call_start",
    name: "bash",
    id: "tu-tool-1",
  });
  // thinking already cleared, text body still empty
  expect(draft.thinkingMasked()).toBe("");
  draft.append({ type: "text_delta", text: "正式回答" });
  // thinking stays empty (text_delta must not write thinkingBuffer; an
  // implementation leaking text_delta into thinking re-non-blanks thinkingMasked here).
  expect(draft.thinkingMasked()).toBe("");
});

test("text_delta 收起思考面板：思考阶段在正文起点结束", () => {
  const draft = createStreamDraft();
  draft.append({ type: "thinking_delta", text: "这一段想完了" });
  expect(draft.thinkingMasked()).toContain("想完了");
  draft.append({ type: "text_delta", text: "返回给用户的一段话" });
  expect(draft.thinkingMasked()).toBe("");
  expect(draft.masked()).toContain("返回给用户的一段话");
});

test("正文之后的新 thinking_delta 重新累积：下一段思考可以再出现", () => {
  const draft = createStreamDraft();
  draft.append({ type: "thinking_delta", text: "先想" });
  draft.append({ type: "text_delta", text: "先返回" });
  expect(draft.thinkingMasked()).toBe("");
  draft.append({ type: "thinking_delta", text: "再想下一段" });
  expect(draft.thinkingMasked()).toContain("再想下一段");
});
