// @vitest-environment happy-dom
/**
 * T5 (#691): /continue slash handler — busy_stop_first, usage, continue_http_no_fallback.
 */
import assert from "node:assert/strict";
import { describe, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useSlashCommands } from "../../web/src/hooks/use-slash-commands.ts";
import type { SessionChatApi } from "../../web/src/hooks/useSessionChat.ts";
import { SessionApiError } from "../../web/src/api/types.ts";
import { DEFAULT_THINKING_SETTINGS } from "../../web/src/lib/thinking-settings.ts";
import type { SlashCommandName } from "../../web/src/lib/slash.ts";

function stubChat(overrides: Partial<SessionChatApi> = {}): SessionChatApi {
  return {
    phase: "ready",
    error: null,
    session: {
      conversation_id: "c1",
      json_mode: false,
      turn_count: 0,
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
  };
}

function renderSlash(opts: { chat: SessionChatApi; compacting?: boolean }) {
  return renderHook(() =>
    useSlashCommands({
      chat: opts.chat,
      perm: { mode: null, cycle: async () => "default" },
      thinkingSettings: DEFAULT_THINKING_SETTINGS,
      skills: [],
      setCollapsed: () => undefined,
      bumpSidebar: () => undefined,
      setWorkspaceOpen: () => undefined,
      setMcpServers: () => undefined,
      setMcpTools: () => undefined,
      setMcpOpen: () => undefined,
      setRewindTargets: () => undefined,
      setRewindIndex: () => undefined,
      handleThinkingChange: () => undefined,
      handleCompact: async () => undefined,
      handleNewSession: async () => undefined,
      compacting: opts.compacting ?? false,
    })
  );
}

const CONTINUE: SlashCommandName = "continue";

describe("useSlashCommands /continue", () => {
  it("idle → calls continue(), never sendMessage", async () => {
    const chat = stubChat();
    const { result } = renderSlash({ chat });
    act(() => {
      result.current.handleCommand(CONTINUE);
    });
    await act(async () => {
      await Promise.resolve();
    });
    assert.equal(vi.mocked(chat.continue).mock.calls.length, 1);
    assert.equal(vi.mocked(chat.sendMessage).mock.calls.length, 0);
  });

  it("sending → busy_stop_first notice, no HTTP continue", () => {
    const chat = stubChat({ phase: "sending" });
    const { result } = renderSlash({ chat });
    act(() => {
      result.current.handleCommand(CONTINUE);
    });
    assert.equal(vi.mocked(chat.continue).mock.calls.length, 0);
    assert.equal(vi.mocked(chat.sendMessage).mock.calls.length, 0);
    assert.equal(vi.mocked(chat.pushNotice).mock.calls.length, 1);
    assert.match(
      String(vi.mocked(chat.pushNotice).mock.calls[0]?.[0]),
      /busy_stop_first/
    );
  });

  it("compacting → busy_stop_first notice, no HTTP continue", () => {
    const chat = stubChat();
    const { result } = renderSlash({ chat, compacting: true });
    act(() => {
      result.current.handleCommand(CONTINUE);
    });
    assert.equal(vi.mocked(chat.continue).mock.calls.length, 0);
    assert.match(
      String(vi.mocked(chat.pushNotice).mock.calls[0]?.[0]),
      /busy_stop_first/
    );
  });

  it("continue-in-flight → second /continue is busy_stop_first, one HTTP", async () => {
    const chat = stubChat();
    let release!: () => void;
    vi.mocked(chat.continue).mockReturnValue(
      new Promise<void>((resolve) => {
        release = resolve;
      })
    );
    const { result } = renderSlash({ chat });
    act(() => {
      result.current.handleCommand(CONTINUE);
      result.current.handleCommand(CONTINUE);
    });
    assert.equal(vi.mocked(chat.continue).mock.calls.length, 1);
    assert.match(
      String(vi.mocked(chat.pushNotice).mock.calls[0]?.[0]),
      /busy_stop_first/
    );
    release();
    await act(async () => {
      await Promise.resolve();
    });
  });

  it("args → usage EXIT, no HTTP", () => {
    const chat = stubChat();
    const { result } = renderSlash({ chat });
    act(() => {
      result.current.handleCommand(CONTINUE, "extra");
    });
    assert.equal(vi.mocked(chat.continue).mock.calls.length, 0);
    assert.equal(vi.mocked(chat.sendMessage).mock.calls.length, 0);
    assert.equal(
      vi.mocked(chat.pushNotice).mock.calls[0]?.[0],
      "用法：/continue"
    );
  });

  it("ValidationError → pushNotice EXIT only, never postMessage fallback", async () => {
    const chat = stubChat();
    vi.mocked(chat.continue).mockRejectedValue(
      new SessionApiError(
        "nothing_pending: cannot continue this session",
        400,
        "validation",
        {
          error: {
            kind: "validation",
            message: "nothing_pending: cannot continue this session",
            field: "continue",
          },
        }
      )
    );
    const { result } = renderSlash({ chat });
    act(() => {
      result.current.handleCommand(CONTINUE);
    });
    await act(async () => {
      await Promise.resolve();
    });
    assert.equal(vi.mocked(chat.sendMessage).mock.calls.length, 0);
    assert.match(
      String(vi.mocked(chat.pushNotice).mock.calls[0]?.[0]),
      /nothing_pending/
    );
  });
});
