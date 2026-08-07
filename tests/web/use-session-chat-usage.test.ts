import assert from "node:assert/strict";
import React, { act, createElement, type ReactNode } from "react";
import Reconciler from "react-reconciler";
import { describe, it, vi } from "vitest";
import * as api from "../../web/src/api/client.ts";
import { useSessionChat } from "../../web/src/hooks/useSessionChat.ts";
import type { SessionChatApi } from "../../web/src/hooks/useSessionChat.ts";

vi.mock("../../web/src/api/client.ts", () => ({
  health: vi.fn(),
  createSession: vi.fn(),
  postMessage: vi.fn(),
  getSessionHistory: vi.fn(),
  resetSession: vi.fn(),
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
