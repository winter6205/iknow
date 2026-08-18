import assert from "node:assert/strict";
import React, { act, createElement, type ReactNode } from "react";
import Reconciler from "react-reconciler";
import { beforeEach, describe, it, vi } from "vitest";
import * as api from "../../web/src/api/client.ts";
import { useSessionChat } from "../../web/src/hooks/useSessionChat.ts";
import type { SessionChatApi } from "../../web/src/hooks/useSessionChat.ts";

vi.mock("../../web/src/api/client.ts", () => ({
  health: vi.fn(),
  createSession: vi.fn(),
  postMessage: vi.fn(),
  getSessionHistory: vi.fn(),
  resetSession: vi.fn(),
  compactSession: vi.fn(),
}));

type Container = { children: unknown[] };

const Renderer = Reconciler({
  supportsMutation: true,
  supportsPersistence: false,
  isPrimaryRenderer: false,
  noTimeout: -1,
  supportsHydration: false,
  supportsMicrotasks: true,
  scheduleMicrotask: queueMicrotask,
  trackSchedulerEvent: () => undefined,
  now: Date.now,
  getRootHostContext: () => null,
  getChildHostContext: (context: null) => context,
  getPublicInstance: (instance: unknown) => instance,
  prepareForCommit: () => null,
  resetAfterCommit: () => undefined,
  createInstance: () => ({}),
  appendInitialChild: () => undefined,
  finalizeInitialChildren: () => false,
  prepareUpdate: () => null,
  shouldSetTextContent: () => false,
  createTextInstance: (text: string) => text,
  appendChild: (parent: { children: unknown[] }, child: unknown) => {
    parent.children.push(child);
  },
  appendChildToContainer: (container: Container, child: unknown) => {
    container.children.push(child);
  },
  insertBefore: () => undefined,
  insertInContainerBefore: () => undefined,
  removeChild: () => undefined,
  removeChildFromContainer: () => undefined,
  commitUpdate: () => undefined,
  commitTextUpdate: () => undefined,
  resetTextContent: () => undefined,
  clearContainer: (container: Container) => {
    container.children = [];
  },
  getCurrentEventPriority: () => 32,
  getCurrentUpdatePriority: () => 1,
  setCurrentUpdatePriority: () => undefined,
  resolveUpdatePriority: () => 1,
  resolveEventType: () => 0,
  resolveEventTimeStamp: () => 0,
  shouldAttemptEagerTransition: () => false,
  requestPaint: () => undefined,
  scheduleTimeout: setTimeout,
  cancelTimeout: clearTimeout,
  maySuspendCommit: () => false,
  preloadInstance: () => true,
  startSuspendingCommit: () => undefined,
  suspendInstance: () => undefined,
  waitForCommitToBeReady: () => null,
  getInstanceFromNode: () => null,
  beforeActiveInstanceBlur: () => undefined,
  afterActiveInstanceBlur: () => undefined,
  prepareScopeUpdate: () => undefined,
  getInstanceFromScope: () => null,
  detachDeletedInstance: () => undefined,
});

function renderHook(): {
  getCurrent: () => SessionChatApi | null;
  root: ReturnType<typeof Renderer.createContainer>;
} {
  let current: SessionChatApi | null = null;
  function Hook(): ReactNode {
    current = useSessionChat();
    return null;
  }
  const container: Container = { children: [] };
  const root = Renderer.createContainer(
    container,
    0,
    null,
    false,
    null,
    "",
    () => undefined,
    () => undefined,
    () => undefined,
    () => undefined
  );
  act(() => {
    Renderer.updateContainer(createElement(Hook), root, null, () => undefined);
  });
  return { getCurrent: () => current, root };
}

describe("useSessionChat context usage wire", () => {
  it("retains contextWindow from health and lastUsage from postMessage", async () => {
    vi.mocked(api.health).mockResolvedValue({
      ok: true,
      service: "session-api",
      version: "test",
      contextWindow: 200000,
    });
    vi.mocked(api.createSession).mockResolvedValue({
      session: {
        conversation_id: "c1",
        json_mode: false,
        turn_count: 0,
        prior_count: 0,
      },
      turns: [],
    });
    const lastUsage = {
      inputTokens: 100,
      outputTokens: 20,
      cacheCreationInputTokens: null,
      cacheReadInputTokens: 80,
    };
    vi.mocked(api.postMessage).mockResolvedValue({
      session: {
        conversation_id: "c1",
        json_mode: false,
        turn_count: 1,
        prior_count: 0,
      },
      turn: {
        query: "hello",
        answer: {
          finalText: "world",
          stopReason: "completed",
          turnCount: 1,
          lastUsage,
        },
      },
    });

    const hook = renderHook();
    await act(async () => {
      await vi.waitFor(() => assert.equal(hook.getCurrent()?.phase, "ready"));
    });
    assert.equal(hook.getCurrent()?.contextWindow, 200000);

    await act(async () => {
      await hook.getCurrent()?.sendMessage("hello");
    });
    assert.deepEqual(hook.getCurrent()?.lastAnswer?.lastUsage, lastUsage);

    Renderer.updateContainer(null, hook.root, null, () => undefined);
  });
});

describe("useSessionChat compact()", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /** 建立 ready 会话（health + createSession），返回 hook。 */
  function bootReady() {
    vi.mocked(api.health).mockResolvedValue({
      ok: true,
      service: "session-api",
      version: "test",
      contextWindow: 200000,
    });
    vi.mocked(api.createSession).mockResolvedValue({
      session: {
        conversation_id: "c1",
        json_mode: false,
        turn_count: 0,
        prior_count: 0,
      },
      turns: [],
    });
    const hook = renderHook();
    return hook;
  }

  it("实际压缩 → 返回 true，session/turns 刷新为压缩后投影", async () => {
    const hook = bootReady();
    await act(async () => {
      await vi.waitFor(() => assert.equal(hook.getCurrent()?.phase, "ready"));
    });
    vi.mocked(api.compactSession).mockResolvedValue({
      session: {
        conversation_id: "c1",
        json_mode: false,
        turn_count: 1,
        prior_count: 0,
      },
      turns: [
        {
          query: "boundary",
          answer: {
            finalText: "",
            stopReason: "completed",
            turnCount: 1,
          },
        },
      ],
      compacted: true,
      beforeCount: 8,
      afterCount: 7,
    });

    let result = false;
    await act(async () => {
      result = (await hook.getCurrent()?.compact()) ?? false;
    });
    assert.equal(result, true);
    assert.equal(hook.getCurrent()?.session?.turn_count, 1);
    assert.equal(hook.getCurrent()?.messages.length, 1);
    assert.equal(hook.getCurrent()?.phase, "ready"); // 不置 loading

    Renderer.updateContainer(null, hook.root, null, () => undefined);
  });

  it("no-op → 返回 false；无活跃会话 → false（不调 API）", async () => {
    const hook = bootReady();
    await act(async () => {
      await vi.waitFor(() => assert.equal(hook.getCurrent()?.phase, "ready"));
    });
    vi.mocked(api.compactSession).mockResolvedValue({
      session: {
        conversation_id: "c1",
        json_mode: false,
        turn_count: 1,
        prior_count: 0,
      },
      turns: [
        {
          query: "hello",
          answer: { finalText: "world", stopReason: "completed", turnCount: 1 },
        },
      ],
      compacted: false,
      beforeCount: 2,
      afterCount: 2,
    });

    let result = true;
    await act(async () => {
      result = (await hook.getCurrent()?.compact()) ?? true;
    });
    assert.equal(result, false);
    assert.equal(vi.mocked(api.compactSession).mock.calls.length, 1);

    Renderer.updateContainer(null, hook.root, null, () => undefined);
  });

  it("压缩失败 → 抛错 + 会话状态不被破坏（phase 保持 ready）", async () => {
    const hook = bootReady();
    await act(async () => {
      await vi.waitFor(() => assert.equal(hook.getCurrent()?.phase, "ready"));
    });
    vi.mocked(api.compactSession).mockRejectedValue(new Error("compact boom"));

    await act(async () => {
      await assert.rejects(() => hook.getCurrent()?.compact(), /compact boom/);
    });
    // compact 是轻操作：失败不置全局 error StateBlock（由 App 局部提示），
    // 会话 phase/消息保持不变。
    assert.equal(hook.getCurrent()?.phase, "ready");
    assert.equal(hook.getCurrent()?.error, null);

    Renderer.updateContainer(null, hook.root, null, () => undefined);
  });
});

describe("useSessionChat pushNotice()", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function bootReady() {
    vi.mocked(api.health).mockResolvedValue({
      ok: true,
      service: "session-api",
      version: "test",
      contextWindow: 200000,
    });
    vi.mocked(api.createSession).mockResolvedValue({
      session: {
        conversation_id: "c1",
        json_mode: false,
        turn_count: 0,
        prior_count: 0,
      },
      turns: [],
    });
    return renderHook();
  }

  it("追加纯本地 notice 消息（不进 wire、id 唯一）", async () => {
    const hook = bootReady();
    await act(async () => {
      await vi.waitFor(() => assert.equal(hook.getCurrent()?.phase, "ready"));
    });

    act(() => {
      hook.getCurrent()?.pushNotice("已压缩上下文");
    });
    act(() => {
      hook.getCurrent()?.pushNotice("第二条");
    });
    const messages = hook.getCurrent()?.messages ?? [];
    assert.equal(messages.length, 2);
    assert.equal(messages[0]?.role, "notice");
    assert.equal(messages[0]?.text, "已压缩上下文");
    assert.notEqual(messages[0]?.id, messages[1]?.id);
    // 不调任何 wire API。
    assert.equal(vi.mocked(api.postMessage).mock.calls.length, 0);

    Renderer.updateContainer(null, hook.root, null, () => undefined);
  });

  it("会话切换（applySession）后 notice 不残留", async () => {
    const hook = bootReady();
    await act(async () => {
      await vi.waitFor(() => assert.equal(hook.getCurrent()?.phase, "ready"));
    });
    act(() => {
      hook.getCurrent()?.pushNotice("临时提示");
    });
    assert.equal(hook.getCurrent()?.messages.length, 1);

    await act(async () => {
      await hook.getCurrent()?.newSession();
    });
    assert.equal(hook.getCurrent()?.messages.length, 0);

    Renderer.updateContainer(null, hook.root, null, () => undefined);
  });
});
