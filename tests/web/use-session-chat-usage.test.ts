import assert from "node:assert/strict";
import React, { act, createElement, type ReactNode } from "react";
import Reconciler from "react-reconciler";
import { afterEach, beforeEach, describe, it, vi } from "vitest";
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

/**
 * serve-workspace T9b: 进站总是 fresh-on-mount, 不读 / 不写 localStorage。
 * serve T9a auto-bind 后 `createSession` 在 default workspace 下永远成功,
 * 因此 bootstrap 路径简化为 health → createAndAdopt, 不再有 stored 恢复 +
 * 404 fallback 路径。
 *
 * localStorage mock 模式参考 tests/web/workspace-groups-storage.test.ts。
 */
describe("useSessionChat bootstrap — T9b fresh-on-mount", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /**
   * 安装一个计数版 localStorage: getItem/setItem/removeItem 都可被断言。
   * 初始带一条历史 key "iknow:conversation_id" → "stale-id", 验证
   * bootstrap 不会读取它 (旧行为的回归测试)。
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

    // T9b 关键契约: 进站一次 getItem 都不发, 不读 stored conversation id。
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

    // 旧 key 应被废弃: bootstrap / newSession / setConversation 一概不写。
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

    // 路径: health → createSession → applySession。
    assert.equal(vi.mocked(api.health).mock.calls.length, 1);
    assert.equal(vi.mocked(api.createSession).mock.calls.length, 1);
    // T9b 已删: 旧 stored-restore 路径不再调 getSessionHistory (除非
    // setConversation 显式切旧会话)。
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

    // T9b: 进站失败路径不再尝试从 localStorage 恢复旧会话 — 错误直接
    // 暴露给用户重试, 不静默 fallback。
    assert.equal(calls.getItem.length, 0);
    assert.ok(
      hook.getCurrent()?.error?.includes("default workspace unavailable"),
      `expected create error message, got: ${hook.getCurrent()?.error}`
    );

    Renderer.updateContainer(null, hook.root, null, () => undefined);
  });
});
