// @vitest-environment happy-dom
/**
 * useChatCompact notice-copy branches.
 *
 * Invariant asserted: the manual-compaction path must never surface "auto token
 * gate not reached" semantics (copy like `上下文未达压缩阈值` ("context below
 * compaction threshold") is forbidden). When compacted=false the reason collapses
 * to `没有可压缩的上下文` ("nothing to compact"): on the manual path the only
 * remaining no-op is messages_too_few (empty-session idempotence or whole
 * compaction failure).
 */
import assert from "node:assert/strict";
import { describe, expect, it, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useChatCompact } from "../../web/src/hooks/use-chat-compact.ts";
import type { SessionChatApi } from "../../web/src/hooks/useSessionChat.ts";

function stubChat(overrides: Partial<SessionChatApi> = {}): SessionChatApi {
  return {
    phase: "ready",
    error: null,
    session: {
      conversation_id: "c1",
      json_mode: false,
      turn_count: 3,
      prior_count: 0,
    },
    messages: [],
    lastAnswer: null,
    healthLabel: null,
    contextWindow: null,
    model: null,
    sendMessage: vi.fn(async () => undefined),
    continue: vi.fn(async () => undefined),
    reset: vi.fn(async () => undefined),
    compact: vi.fn(async () => false),
    rewind: vi.fn(async () => undefined),
    newSession: vi.fn(async () => undefined),
    setConversation: vi.fn(async () => undefined),
    retryBootstrap: vi.fn(),
    clearError: vi.fn(),
    pushNotice: vi.fn(),
    ...overrides,
  } as SessionChatApi;
}

describe("useChatCompact notice copy", () => {
  it("compacted=true → 「已压缩上下文」", async () => {
    const chat = stubChat({ compact: vi.fn(async () => true) });
    const { result } = renderHook(() => useChatCompact(chat));
    await act(async () => {
      await result.current.handleCompact();
    });
    expect(vi.mocked(chat.pushNotice).mock.calls.length).to.equal(1);
    assert.equal(vi.mocked(chat.pushNotice).mock.calls[0]?.[0], "已压缩上下文");
  });

  it("compacted=false + 有会话 → 「没有可压缩的上下文」，不出现 auto 阈值文案", async () => {
    const chat = stubChat({ compact: vi.fn(async () => false) });
    const { result } = renderHook(() => useChatCompact(chat));
    await act(async () => {
      await result.current.handleCompact();
    });
    const notice = String(vi.mocked(chat.pushNotice).mock.calls[0]?.[0]);
    assert.equal(notice, "没有可压缩的上下文，会话保持原样。");
    assert.ok(!notice.includes("未达压缩阈值"));
    assert.ok(!notice.includes("token"));
  });

  it("compacted=false + 无会话 → 「当前无会话可压缩」", async () => {
    const chat = stubChat({
      session: null,
      compact: vi.fn(async () => false),
    });
    const { result } = renderHook(() => useChatCompact(chat));
    await act(async () => {
      await result.current.handleCompact();
    });
    assert.equal(
      vi.mocked(chat.pushNotice).mock.calls[0]?.[0],
      "当前无会话可压缩"
    );
  });

  it("compact 抛错 → 「压缩失败：」前缀", async () => {
    const chat = stubChat({
      compact: vi.fn(async () => {
        throw new Error("boom");
      }),
    });
    const { result } = renderHook(() => useChatCompact(chat));
    await act(async () => {
      await result.current.handleCompact();
    });
    assert.equal(
      vi.mocked(chat.pushNotice).mock.calls[0]?.[0],
      "压缩失败：boom"
    );
  });
});
