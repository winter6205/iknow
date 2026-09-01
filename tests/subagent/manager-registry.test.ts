import { describe, expect, it, vi } from "vitest";

import {
  createSubagentManagerRegistry,
  SubagentManagerDrainError,
  type SubagentManagerReadView,
} from "../../src/harness/subagent/manager-registry.ts";
import { createSubAgentMailbox } from "../../src/harness/subagent/mailbox.ts";

type Completed = ReturnType<SubagentManagerReadView["drainCompleted"]>[number];

function completed(taskId: string): Completed {
  return {
    taskId,
    envelope: {
      status: "ok",
      summary: `${taskId} summary`,
      result: `${taskId} result`,
    },
  };
}

function readManager(
  drainCompleted: SubagentManagerReadView["drainCompleted"],
  listSubagents: SubagentManagerReadView["listSubagents"] = () => []
): SubagentManagerReadView & {
  publish: ReturnType<typeof createSubAgentMailbox>["publish"];
} {
  const mailbox = createSubAgentMailbox();
  return {
    drainCompleted,
    listSubagents,
    subscribe: mailbox.subscribe,
    publish: mailbox.publish,
  };
}

describe("createSubagentManagerRegistry", () => {
  it("aggregates completed and list projections across managers", () => {
    const first = readManager(
      () => [completed("before-rebind")],
      () => [
        {
          taskId: "before-rebind",
          state: "completed",
          taskPreview: "first",
          startedAt: "2026-08-31T00:00:00.000Z",
        },
      ]
    );
    const second = readManager(
      () => [completed("after-rebind")],
      () => [
        {
          taskId: "after-rebind",
          state: "running",
          taskPreview: "second",
          startedAt: "2026-08-31T00:00:00.000Z",
        },
      ]
    );
    const registry = createSubagentManagerRegistry();

    registry.register(first);
    registry.register(second);

    expect(registry.drainCompleted()).toEqual([
      completed("before-rebind"),
      completed("after-rebind"),
    ]);
    expect(registry.listSubagents().map(({ taskId }) => taskId)).toEqual([
      "before-rebind",
      "after-rebind",
    ]);
  });

  it("does not expose spawn or shutdown on the aggregate read surface", () => {
    const registry = createSubagentManagerRegistry();

    expect("spawn" in registry).toBe(false);
    expect("shutdown" in registry).toBe(false);
  });

  it("registers the same manager by identity only once", () => {
    const drainCompleted = vi.fn(() => [completed("once")]);
    const manager = readManager(drainCompleted);
    const registry = createSubagentManagerRegistry();

    registry.register(manager);
    registry.register(manager);

    expect(registry.drainCompleted()).toEqual([completed("once")]);
    expect(drainCompleted).toHaveBeenCalledTimes(1);
  });

  it("reports a typed drain error and keeps results from other managers", () => {
    const failure = new Error("old manager unavailable");
    const onError = vi.fn();
    const registry = createSubagentManagerRegistry({ onError });
    const broken = readManager(() => {
      throw failure;
    });
    const healthy = readManager(() => [completed("healthy")]);

    registry.register(broken);
    registry.register(healthy);

    expect(registry.drainCompleted()).toEqual([completed("healthy")]);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(expect.any(SubagentManagerDrainError));
    expect(onError.mock.calls[0]?.[0]).toMatchObject({
      reason: "drainFailed",
      cause: failure,
    });
  });

  it("fans terminal notices in from managers registered before and after subscribe", () => {
    const first = readManager(() => []);
    const second = readManager(() => []);
    const registry = createSubagentManagerRegistry();
    const notices: string[] = [];

    registry.register(first);
    const unsubscribe = registry.subscribe((notice) => {
      notices.push(notice.taskId);
    });
    first.publish({
      taskId: "first-live",
      status: "ok",
      summary: "done",
      result: "result",
    });

    registry.register(second);
    second.publish({
      taskId: "second-live",
      status: "ok",
      summary: "done",
      result: "result",
    });

    expect(notices).toEqual(["first-live", "second-live"]);
    unsubscribe();
  });

  it("filters list projections by parent conversation across every root manager", () => {
    const first = readManager(
      (conversationId) =>
        conversationId === "session-a"
          ? [completed("first-a")]
          : [completed("first-a"), completed("first-b")],
      (conversationId) =>
        conversationId === "session-a"
          ? [
              {
                taskId: "first-a",
                state: "completed",
                taskPreview: "A",
                startedAt: "2026-08-31T00:00:00.000Z",
              },
            ]
          : [
              {
                taskId: "first-a",
                state: "completed",
                taskPreview: "A",
                startedAt: "2026-08-31T00:00:00.000Z",
              },
              {
                taskId: "first-b",
                state: "completed",
                taskPreview: "B",
                startedAt: "2026-08-31T00:00:00.000Z",
              },
            ]
    );
    const second = readManager(
      (conversationId) =>
        conversationId === "session-a"
          ? [completed("second-a")]
          : [completed("second-a"), completed("second-b")],
      (conversationId) =>
        conversationId === "session-a"
          ? [
              {
                taskId: "second-a",
                state: "running",
                taskPreview: "A",
                startedAt: "2026-08-31T00:00:00.000Z",
              },
            ]
          : [
              {
                taskId: "second-a",
                state: "running",
                taskPreview: "A",
                startedAt: "2026-08-31T00:00:00.000Z",
              },
              {
                taskId: "second-b",
                state: "failed",
                taskPreview: "B",
                startedAt: "2026-08-31T00:00:00.000Z",
              },
            ]
    );
    const registry = createSubagentManagerRegistry();
    registry.register(first);
    registry.register(second);

    expect(
      registry.drainCompleted("session-a").map(({ taskId }) => taskId)
    ).toEqual(["first-a", "second-a"]);
    expect(
      registry.listSubagents("session-a").map(({ taskId }) => taskId)
    ).toEqual(["first-a", "second-a"]);
    expect(registry.listSubagents().map(({ taskId }) => taskId)).toEqual([
      "first-a",
      "first-b",
      "second-a",
      "second-b",
    ]);
  });

  it("filters terminal subscriptions by parent conversation across every root manager", () => {
    const first = readManager(() => []);
    const second = readManager(() => []);
    const registry = createSubagentManagerRegistry();
    registry.register(first);
    registry.register(second);
    const notices: string[] = [];
    const unsubscribe = registry.subscribe((notice) => {
      notices.push(notice.taskId);
    }, "session-a");

    first.publish({
      taskId: "first-a",
      conversationId: "session-a",
      status: "ok",
      summary: "done",
      result: "result",
    });
    first.publish({
      taskId: "first-b",
      conversationId: "session-b",
      status: "ok",
      summary: "done",
      result: "result",
    });
    second.publish({
      taskId: "second-a",
      conversationId: "session-a",
      status: "ok",
      summary: "done",
      result: "result",
    });

    expect(notices).toEqual(["first-a", "second-a"]);
    unsubscribe();
  });
});
