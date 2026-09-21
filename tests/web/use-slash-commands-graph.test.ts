// @vitest-environment happy-dom
/**
 * Web equivalent of the CLI/TUI `/graph` command.
 *
 * Semantics are not duplicated in the frontend: args are POSTed verbatim to
 * `/api/v1/graph-mode`, and the notice text comes from the server's
 * `GraphModeResponse.message` (the live contract, not the draft chain's `text`).
 */
import assert from "node:assert/strict";
import { beforeEach, describe, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import * as api from "../../web/src/api/client.ts";
import { useSlashCommands } from "../../web/src/hooks/use-slash-commands.ts";
import type { SessionChatApi } from "../../web/src/hooks/useSessionChat.ts";
import { SessionApiError } from "../../web/src/api/types.ts";
import { DEFAULT_THINKING_SETTINGS } from "../../web/src/lib/thinking-settings.ts";
import {
  matchSlash,
  SLASH_COMMANDS,
  slashSubmitDecision,
} from "../../web/src/lib/slash.ts";

vi.mock("../../web/src/api/client.ts", () => ({
  applyGraphMode: vi.fn(),
  listMcp: vi.fn(),
  listMcpTools: vi.fn(),
  listRewindTargets: vi.fn(),
  getSkillBody: vi.fn(),
}));

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

function renderSlash(chat: SessionChatApi) {
  return renderHook(() =>
    useSlashCommands({
      chat,
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
      compacting: false,
    })
  );
}

beforeEach(() => {
  vi.mocked(api.applyGraphMode).mockReset();
  vi.mocked(api.applyGraphMode).mockResolvedValue({
    enabled: true,
    message: "图模式已切换: on（下一次 run() 装配生效）",
  });
});

describe("web 词表含 /graph（对齐 CLI / TUI）", () => {
  it("SLASH_COMMANDS 含 graph 且带参可匹配", () => {
    assert.ok(SLASH_COMMANDS.some((c) => c.name === "graph"));
    assert.deepEqual(matchSlash("/graph on"), { name: "graph", arg: "on" });
    assert.deepEqual(matchSlash("/graph"), { name: "graph", arg: "" });
    assert.equal(slashSubmitDecision("/graph on").kind, "execute");
  });
});

describe("useSlashCommands /graph", () => {
  it("empty: 无 arg → POST 空 args，渲染服务端 message", async () => {
    const chat = stubChat();
    const { result } = renderSlash(chat);
    act(() => {
      result.current.handleCommand("graph");
    });
    await act(async () => {
      await Promise.resolve();
    });
    assert.deepEqual(vi.mocked(api.applyGraphMode).mock.calls[0]?.[0], []);
    assert.equal(
      vi.mocked(chat.pushNotice).mock.calls[0]?.[0],
      "图模式已切换: on（下一次 run() 装配生效）"
    );
    assert.equal(vi.mocked(chat.sendMessage).mock.calls.length, 0);
  });

  it("args 原样切词后上送（不在客户端解释语义）", async () => {
    const chat = stubChat();
    const { result } = renderSlash(chat);
    act(() => {
      result.current.handleCommand("graph", "  on  extra ");
    });
    await act(async () => {
      await Promise.resolve();
    });
    assert.deepEqual(vi.mocked(api.applyGraphMode).mock.calls[0]?.[0], [
      "on",
      "extra",
    ]);
  });

  it("negative: 服务端 400 → 只渲染 EXIT 文案，绝不 fallback 成 postMessage", async () => {
    const chat = stubChat();
    vi.mocked(api.applyGraphMode).mockRejectedValue(
      new SessionApiError("Usage: /graph [on|off|status]", 400, "validation", {
        error: {
          kind: "validation",
          message: "Usage: /graph [on|off|status]",
          field: "args",
        },
      })
    );
    const { result } = renderSlash(chat);
    act(() => {
      result.current.handleCommand("graph", "maybe");
    });
    await act(async () => {
      await Promise.resolve();
    });
    assert.equal(vi.mocked(chat.sendMessage).mock.calls.length, 0);
    assert.match(
      String(vi.mocked(chat.pushNotice).mock.calls[0]?.[0]),
      /Usage: \/graph/
    );
  });

  it("exception: 端点 404（未装配 holder）→ 渲染错误，不 crash", async () => {
    const chat = stubChat();
    vi.mocked(api.applyGraphMode).mockRejectedValue(
      new SessionApiError(
        "no route POST /api/v1/graph-mode",
        404,
        "not_found",
        null
      )
    );
    const { result } = renderSlash(chat);
    act(() => {
      result.current.handleCommand("graph", "on");
    });
    await act(async () => {
      await Promise.resolve();
    });
    assert.equal(vi.mocked(chat.pushNotice).mock.calls.length, 1);
    assert.equal(vi.mocked(chat.sendMessage).mock.calls.length, 0);
  });
});
