/** @jsxImportSource @opentui/react */
/**
 * tests/tui/streaming-thinking-close-on-tool-call.test.tsx
 *
 * 不变式：流式 thinking 面板在 turn 内思考阶段结束（模型从 thinking 进入
 * tool_call_start 或 text_delta）时必须收起，不再继续累积 / 渲染——
 * 不应等整轮 turn 结束才消失。后续 thinking_delta 重新累积为新一段。
 *
 * 本测试通过 stub streamDraft 事件序列（thinking_delta 若干 →
 * tool_call_start → 断言 `thinkingMasked()` 返回空串 + 已通知
 * listener）锁住不变式；不依赖真实模型。
 */
import { expect, test } from "bun:test";
import { createStreamDraft } from "../../src/cli/stream-draft.js";

test("tool_call_start 后 thinkingMasked() 返回空串：thinking 阶段结束", () => {
  const draft = createStreamDraft();
  draft.append({ type: "thinking_delta", text: "思考甲" });
  draft.append({ type: "thinking_delta", text: "思考乙" });
  // 累积后未清空 → 思考正文在场
  expect(draft.thinkingMasked()).toContain("思考");
  // 工具调用起点 → 思考阶段结束 → thinkingBuffer 必须清空
  draft.append({
    type: "tool_call_start",
    name: "bash",
    id: "tu-tool-1",
  });
  expect(draft.thinkingMasked()).toBe("");
  // thinkingRaw 也清空(若实现走 raw 而不是 masked,这里一并钉)。
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
  // tool_call_start 后必须立即 flush(不等 50ms 节流),让 ChatView 同步
  // 重渲染并隐藏 thinking 面板——节流延迟会让面板在工具调用后仍持续
  // 可见 50ms,与「思考阶段结束就收起」的合同冲突。
  draft.append({
    type: "tool_call_start",
    name: "bash",
    id: "tu-tool-1",
  });
  expect(notifyCount).toBeGreaterThan(notifyBeforeToolStart);
  unsubscribe();
});

test("tool_call_start 后续 text_delta 不重新启用流式 thinking 面板", () => {
  // 场景：思考 → 工具 → 工具结果 → 后续 text_delta(正式回答)→ 此时不应
  // 误把 text_delta 重新触发 thinking 面板的累积或重新渲染。
  const draft = createStreamDraft();
  draft.append({ type: "thinking_delta", text: "思考正文" });
  draft.append({
    type: "tool_call_start",
    name: "bash",
    id: "tu-tool-1",
  });
  // thinking 已清空,正文仍为空
  expect(draft.thinkingMasked()).toBe("");
  draft.append({ type: "text_delta", text: "正式回答" });
  // thinking 仍为空(text_delta 不写 thinkingBuffer;若实现错把 text_delta
  // 写进 thinking 就会在这里把 thinkingMasked 重新非空,锁住不变式)。
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
