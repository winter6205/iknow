/**
 * tests/web/message-list-notice.test.tsx
 *
 * MessageList 的 notice 消息渲染：居中灰色小卡片、多行文本保留、
 * 与 user/agent 消息共存。/help 输出（多行）经 whitespace-pre-line 呈现。
 * renderToStaticMarkup 模式沿用 tests/web 既有约定（useEffect 不执行，
 * scrollIntoView 不触发）。
 */
import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MessageList } from "../../web/src/components/MessageList.tsx";
import type { ChatUiMessage } from "../../web/src/hooks/useSessionChat.ts";

describe("MessageList — notice 渲染", () => {
  it("notice 渲染为居中卡片（text-center + text-ink-3）", () => {
    const messages: ChatUiMessage[] = [
      { id: "n-1", role: "notice", text: "已压缩上下文" },
    ];
    const html = renderToStaticMarkup(<MessageList messages={messages} />);
    assert.ok(html.includes("已压缩上下文"));
    assert.ok(html.includes("text-center"));
    assert.ok(html.includes("text-ink-3"));
    assert.ok(html.includes('role="status"'));
  });

  it("多行 notice（/help 输出）保留换行（whitespace-pre-line）", () => {
    const text = "/compact — 压缩上下文\n/new — 新建会话";
    const messages: ChatUiMessage[] = [
      { id: "n-1", role: "notice", text },
    ];
    const html = renderToStaticMarkup(<MessageList messages={messages} />);
    assert.ok(html.includes("whitespace-pre-line"));
    assert.ok(html.includes("/compact — 压缩上下文"));
    assert.ok(html.includes("/new — 新建会话"));
  });

  it("notice 与 user/agent 消息共存于同一时间线", () => {
    const messages: ChatUiMessage[] = [
      { id: "u-1", role: "user", text: "你好" },
      {
        id: "a-1",
        role: "agent",
        text: "在的",
        answer: { finalText: "在的", stopReason: "completed", turnCount: 1 },
      },
      { id: "n-1", role: "notice", text: "上下文未达压缩阈值" },
    ];
    const html = renderToStaticMarkup(<MessageList messages={messages} />);
    assert.ok(html.includes("你好"));
    assert.ok(html.includes("在的"));
    assert.ok(html.includes("上下文未达压缩阈值"));
  });
});
