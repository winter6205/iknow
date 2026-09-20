import assert from "node:assert/strict";
import React, { act, createElement, type ReactNode } from "react";
import Reconciler from "react-reconciler";
import { afterEach, beforeEach, describe, it, vi } from "vitest";
import * as api from "../../web/src/api/client.ts";
import { SessionApiError } from "../../web/src/api/types.ts";
import { useSessionChat } from "../../web/src/hooks/useSessionChat.ts";
import type { SessionChatApi } from "../../web/src/hooks/useSessionChat.ts";

vi.mock("../../web/src/api/client.ts", () => ({
  health: vi.fn(),
  createSession: vi.fn(),
  postMessage: vi.fn(),
  getSessionHistory: vi.fn(),
  resetSession: vi.fn(),
  compactSession: vi.fn(),
  continueSession: vi.fn(),
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

  /** Boot a ready session (health + createSession) and return the hook. */
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
    assert.equal(hook.getCurrent()?.phase, "ready"); // does not flip to loading

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
    // compact is a lightweight op: failure must not set the global error
    // StateBlock (App surfaces a local notice); session phase/messages stay intact.
    assert.equal(hook.getCurrent()?.phase, "ready");
    assert.equal(hook.getCurrent()?.error, null);

    Renderer.updateContainer(null, hook.root, null, () => undefined);
  });
});

describe("useSessionChat continue()", () => {
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

  const continueOk = {
    session: {
      conversation_id: "c1",
      json_mode: false,
      turn_count: 1,
      prior_count: 0,
    },
    turn: {
      query: "",
      answer: {
        finalText: "resumed tools",
        stopReason: "completed",
        turnCount: 1,
      },
    },
  };

  it("success → agent bubble only (no optimistic userMsg); POST continue not postMessage", async () => {
    const hook = bootReady();
    await act(async () => {
      await vi.waitFor(() => assert.equal(hook.getCurrent()?.phase, "ready"));
    });
    vi.mocked(api.continueSession).mockResolvedValue(continueOk);

    await act(async () => {
      await hook.getCurrent()?.continue();
    });

    const messages = hook.getCurrent()?.messages ?? [];
    assert.equal(
      messages.some((m) => m.role === "user"),
      false
    );
    assert.equal(messages.length, 1);
    assert.equal(messages[0]?.role, "agent");
    assert.equal(messages[0]?.text, "resumed tools");
    assert.equal(hook.getCurrent()?.lastAnswer?.finalText, "resumed tools");
    assert.equal(hook.getCurrent()?.session?.turn_count, 1);
    assert.equal(hook.getCurrent()?.phase, "ready");
    assert.equal(vi.mocked(api.continueSession).mock.calls.length, 1);
    assert.equal(vi.mocked(api.continueSession).mock.calls[0]?.[0], "c1");
    assert.equal(vi.mocked(api.postMessage).mock.calls.length, 0);

    Renderer.updateContainer(null, hook.root, null, () => undefined);
  });

  it("in-flight → phase=sending, still no user bubble", async () => {
    const hook = bootReady();
    await act(async () => {
      await vi.waitFor(() => assert.equal(hook.getCurrent()?.phase, "ready"));
    });
    let release!: (value: typeof continueOk) => void;
    vi.mocked(api.continueSession).mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      })
    );

    let pending: Promise<void> | undefined;
    act(() => {
      pending = hook.getCurrent()?.continue();
    });
    assert.equal(hook.getCurrent()?.phase, "sending");
    assert.equal(
      (hook.getCurrent()?.messages ?? []).some((m) => m.role === "user"),
      false
    );

    release(continueOk);
    await act(async () => {
      await pending;
    });
    assert.equal(hook.getCurrent()?.phase, "ready");

    Renderer.updateContainer(null, hook.root, null, () => undefined);
  });

  it("ValidationError → rethrow, phase stays ready, no postMessage fallback", async () => {
    const hook = bootReady();
    await act(async () => {
      await vi.waitFor(() => assert.equal(hook.getCurrent()?.phase, "ready"));
    });
    vi.mocked(api.continueSession).mockRejectedValue(
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

    await act(async () => {
      await assert.rejects(
        () => hook.getCurrent()?.continue(),
        /nothing_pending/
      );
    });
    assert.equal(hook.getCurrent()?.phase, "ready");
    assert.equal(hook.getCurrent()?.error, null);
    assert.equal(vi.mocked(api.postMessage).mock.calls.length, 0);
    assert.equal(
      (hook.getCurrent()?.messages ?? []).some((m) => m.role === "user"),
      false
    );

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
    // No wire API is called.
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

/**
 * Bootstrap is always fresh-on-mount: no localStorage reads or writes.
 * Once auto-bind landed, `createSession` under the default workspace always
 * succeeds, so the bootstrap path simplifies to health → createAndAdopt, with no
 * stored-restore + 404 fallback path anymore.
 *
 * localStorage mock pattern follows tests/web/workspace-groups-storage.test.ts.
 */
describe("useSessionChat bootstrap — T9b fresh-on-mount", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /**
   * Install a counting localStorage: getItem/setItem/removeItem are all assertable.
   * Guards the regression that bootstrap never reads the legacy key
   * "iknow:conversation_id" even if a stale id was stored by the old behavior.
   */
  function installCountingLocalStorage() {
    const calls = {
      getItem: [] as string[],
      setItem: [] as Array<{ key: string; value: string }>,
      removeItem: [] as string[],
    };
    const stub: Storage = {
      getItem: (k) => {
        calls.getItem.push(k);
        return null;
      },
      setItem: (k, v) => {
        calls.setItem.push({ key: k, value: v });
      },
      removeItem: (k) => {
        calls.removeItem.push(k);
      },
      clear: () => undefined,
      key: () => null,
      get length() {
        return 0;
      },
    };
    vi.stubGlobal("localStorage", stub);
    return calls;
  }

  function mockHealthAndCreate() {
    vi.mocked(api.health).mockResolvedValue({
      ok: true,
      service: "session-api",
      version: "test",
      contextWindow: 200000,
    });
    vi.mocked(api.createSession).mockResolvedValue({
      session: {
        conversation_id: "c-fresh",
        json_mode: false,
        turn_count: 0,
        prior_count: 0,
      },
      turns: [],
    });
  }

  it("bootstrap 不读 localStorage (T9b fresh-on-mount)", async () => {
    const calls = installCountingLocalStorage();
    mockHealthAndCreate();
    const hook = renderHook();

    await act(async () => {
      await vi.waitFor(() => assert.equal(hook.getCurrent()?.phase, "ready"));
    });

    // Key contract: bootstrap issues zero getItem calls, never reads a stored conversation id.
    assert.equal(
      calls.getItem.length,
      0,
      `expected 0 localStorage.getItem calls, got ${calls.getItem.length}: ${JSON.stringify(calls.getItem)}`
    );
    assert.equal(hook.getCurrent()?.session?.conversation_id, "c-fresh");

    Renderer.updateContainer(null, hook.root, null, () => undefined);
  });

  it("bootstrap 不写 localStorage (旧 conversation_id key 永不创建)", async () => {
    const calls = installCountingLocalStorage();
    mockHealthAndCreate();
    const hook = renderHook();

    await act(async () => {
      await vi.waitFor(() => assert.equal(hook.getCurrent()?.phase, "ready"));
    });

    // Legacy keys are retired: bootstrap / newSession / setConversation never write.
    assert.equal(
      calls.setItem.length,
      0,
      `expected 0 localStorage.setItem calls, got ${calls.setItem.length}: ${JSON.stringify(calls.setItem)}`
    );
    assert.equal(calls.removeItem.length, 0);

    Renderer.updateContainer(null, hook.root, null, () => undefined);
  });

  it("bootstrap 直接调 createSession 并 adopt (无 stored / 404 fallback)", async () => {
    installCountingLocalStorage();
    mockHealthAndCreate();
    const hook = renderHook();

    await act(async () => {
      await vi.waitFor(() => assert.equal(hook.getCurrent()?.phase, "ready"));
    });

    // Path: health → createSession → applySession.
    assert.equal(vi.mocked(api.health).mock.calls.length, 1);
    assert.equal(vi.mocked(api.createSession).mock.calls.length, 1);
    // The removed stored-restore path must not call getSessionHistory (unless
    // setConversation explicitly switches to an existing session).
    assert.equal(vi.mocked(api.getSessionHistory).mock.calls.length, 0);
    assert.equal(hook.getCurrent()?.session?.conversation_id, "c-fresh");
    assert.equal(hook.getCurrent()?.phase, "ready");

    Renderer.updateContainer(null, hook.root, null, () => undefined);
  });

  it("createSession 失败 → 置 phase=error, 不读 localStorage fallback", async () => {
    const calls = installCountingLocalStorage();
    vi.mocked(api.health).mockResolvedValue({
      ok: true,
      service: "session-api",
      version: "test",
      contextWindow: 200000,
    });
    vi.mocked(api.createSession).mockRejectedValue(
      new Error("default workspace unavailable")
    );
    const hook = renderHook();

    await act(async () => {
      await vi.waitFor(() => assert.equal(hook.getCurrent()?.phase, "error"));
    });

    // The bootstrap failure path no longer attempts a localStorage restore — the
    // error surfaces for user retry instead of a silent fallback.
    assert.equal(calls.getItem.length, 0);
    assert.ok(
      hook.getCurrent()?.error?.includes("default workspace unavailable"),
      `expected create error message, got: ${hook.getCurrent()?.error}`
    );

    Renderer.updateContainer(null, hook.root, null, () => undefined);
  });
});
