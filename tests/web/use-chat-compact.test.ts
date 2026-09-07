// @vitest-environment happy-dom
/**
 * manual-compact-trigger T2 — useChatCompact 文案分支。
 *
 * 认证的不变式:手动压缩路径的呈现不得引用「auto token 门未过」语义
 * (「上下文未达压缩阈值」类文案禁止出现)。compacted=false 时按 reason
 * 语义归并为「没有可压缩的上下文」(T1 后手动路径 no-op 只剩
 * messages_too_few 一支:空会话幂等或压缩整体失败)。
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
