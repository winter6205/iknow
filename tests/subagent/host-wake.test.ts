import { describe, expect, it, vi } from "vitest";

import {
  createSubagentWake,
  SubagentWakeError,
  type SubagentWake,
} from "../../src/harness/subagent/host-wake.ts";
import type { SubAgentManager } from "../../src/harness/subagent/manager.ts";
import type { SubAgentTerminalNotice } from "../../src/harness/subagent/mailbox.ts";

function fakeManager(): {
  manager: SubAgentManager;
  publish: (notice: SubAgentTerminalNotice) => void;
} {
  const subscribers = new Set<(notice: SubAgentTerminalNotice) => void>();
  const manager = {
    spawn: () => ({ taskId: "unused" }),
    queryBuffer: () => ({ status: "not_found" as const }),
    waitFor: async () => {
      throw new Error("unused");
    },
    shutdown: async () => {},
    drainCompleted: () => [],
    listActive: () => [],
    abortTask: () => false,
    listSubagents: () => [],
    subscribe: (subscriber: (notice: SubAgentTerminalNotice) => void) => {
      subscribers.add(subscriber);
      return () => subscribers.delete(subscriber);
    },
  } as SubAgentManager;
  return {
    manager,
    publish: (notice) => {
      for (const subscriber of [...subscribers]) subscriber(notice);
    },
  };
}

function notice(taskId: string): SubAgentTerminalNotice {
  return {
    taskId,
    status: "ok",
    summary: "done",
    result: "result",
  };
}

describe("createSubagentWake", () => {
  it("does not subscribe or wake when the manager is absent", async () => {
    const wake = vi.fn(async () => {});
    const controller = createSubagentWake({
      manager: undefined,
      isIdle: () => true,
      wake,
    });

    controller.request();
    await Promise.resolve();

    expect(wake).not.toHaveBeenCalled();
    controller.dispose();
  });

  it("wakes an idle host after a terminal notice", async () => {
    const { manager, publish } = fakeManager();
    const wake = vi.fn(async () => {});
    const controller = createSubagentWake({
      manager,
      isIdle: () => true,
      wake,
    });

    publish(notice("finished"));
    await vi.waitFor(() => expect(wake).toHaveBeenCalledTimes(1));

    controller.dispose();
  });

  it("does not wake session B for a terminal notice from session A", async () => {
    const { manager, publish } = fakeManager();
    const wake = vi.fn(async () => {});
    let activeSession = "session-b";
    const controller = createSubagentWake({
      manager,
      conversationId: () => activeSession,
      isIdle: () => true,
      wake,
    });

    publish({
      ...notice("session-a-task"),
      conversationId: "session-a",
    });
    await Promise.resolve();
    expect(wake).not.toHaveBeenCalled();

    publish({
      ...notice("session-b-task"),
      conversationId: "session-b",
    });
    await vi.waitFor(() => expect(wake).toHaveBeenCalledTimes(1));

    activeSession = "session-a";
    controller.flush();
    await vi.waitFor(() => expect(wake).toHaveBeenCalledTimes(2));
    controller.dispose();
  });

  it("queues terminal notices received during a parent turn", async () => {
    const { manager, publish } = fakeManager();
    let idle = false;
    let releaseWake!: () => void;
    const wakePromise = new Promise<void>((resolve) => {
      releaseWake = resolve;
    });
    const wake = vi.fn(() => wakePromise);
    const controller = createSubagentWake({
      manager,
      isIdle: () => idle,
      wake,
    });

    publish(notice("first"));
    expect(wake).not.toHaveBeenCalled();
    idle = true;
    controller.flush();
    expect(wake).toHaveBeenCalledTimes(1);

    publish(notice("second"));
    expect(wake).toHaveBeenCalledTimes(1);
    releaseWake();
    await vi.waitFor(() => expect(wake).toHaveBeenCalledTimes(2));

    controller.dispose();
  });

  it("coalesces an overflow of concurrent terminal notices into idle wakes", async () => {
    const { manager, publish } = fakeManager();
    const wake = vi.fn(async () => {});
    const controller = createSubagentWake({
      manager,
      isIdle: () => true,
      wake,
    });

    for (let i = 0; i < 128; i++) publish(notice(`task-${i}`));
    await vi.waitFor(() => expect(wake).toHaveBeenCalledTimes(1));

    controller.dispose();
  });

  it("reports a wake exception without rejecting the mailbox callback", async () => {
    const { manager, publish } = fakeManager();
    const onError = vi.fn();
    const failure = new Error("model unavailable");
    const controller = createSubagentWake({
      manager,
      isIdle: () => true,
      wake: async () => {
        throw failure;
      },
      onError,
    });

    expect(() => publish(notice("failed-wake"))).not.toThrow();
    await vi.waitFor(() =>
      expect(onError).toHaveBeenCalledWith(
        expect.objectContaining({
          status: "undelivered",
          reason: "wakeFailed",
          taskIds: ["failed-wake"],
          cause: failure,
        })
      )
    );

    controller.dispose();
  });

  it("diagnoses an observer failure without rejecting the mailbox callback", async () => {
    const { manager, publish } = fakeManager();
    const stderrWrite = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    const controller = createSubagentWake({
      manager,
      isIdle: () => true,
      wake: async () => {
        throw new Error("wake failed");
      },
      onError: () => {
        throw new Error("observer failed");
      },
    });

    try {
      expect(() => publish(notice("observer-failure"))).not.toThrow();
      await vi.waitFor(() =>
        expect(stderrWrite).toHaveBeenCalledWith(
          expect.stringContaining("onError observer failed")
        )
      );
    } finally {
      controller.dispose();
      stderrWrite.mockRestore();
    }
  });

  it("diagnoses an unsubscribe failure without throwing from dispose", () => {
    const stderrWrite = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    const controller = createSubagentWake({
      manager: undefined,
      subscribe: () => {
        return () => {
          throw new Error("unsubscribe failed");
        };
      },
      isIdle: () => true,
      wake: async () => {},
    });

    try {
      expect(() => controller.dispose()).not.toThrow();
      expect(stderrWrite).toHaveBeenCalledWith(
        expect.stringContaining("unsubscribe failed")
      );
    } finally {
      stderrWrite.mockRestore();
    }
  });

  it("reports a waitFor rejection as an undelivered, queryable failure", async () => {
    const { manager, publish } = fakeManager();
    const onError = vi.fn();
    const failure = new Error("waitFor rejected");
    const controller = createSubagentWake({
      manager,
      isIdle: () => true,
      wake: async () => {
        await manager.waitFor("wait-task");
        throw failure;
      },
      onError,
    });

    publish({ ...notice("wait-task"), taskId: "wait-task" });
    await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(1));

    const reported = onError.mock.calls[0]?.[0];
    expect(reported).toBeInstanceOf(SubagentWakeError);
    expect(reported).toMatchObject({
      status: "undelivered",
      reason: "wakeFailed",
      taskIds: ["wait-task"],
      queryable: true,
    });
    expect((reported as Error).message).toContain("subagent_result");

    controller.dispose();
  });

  it("reports a synchronous injection failure without forging completion text", async () => {
    const { manager, publish } = fakeManager();
    const onError = vi.fn();
    const controller = createSubagentWake({
      manager,
      isIdle: () => true,
      wake: () => {
        throw new Error("inject failed");
      },
      onError,
    });

    publish(notice("inject-task"));
    await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(1));

    const reported = onError.mock.calls[0]?.[0] as SubagentWakeError;
    expect(reported.status).toBe("undelivered");
    expect(reported.taskIds).toEqual(["inject-task"]);
    expect(reported.message).not.toContain("completed");
    expect(reported.message).toContain("inject failed");

    controller.dispose();
  });

  it("does not throw when the watcher is unavailable", async () => {
    const onError = vi.fn();
    const controller = createSubagentWake({
      manager: undefined,
      subscribe: () => {
        throw new Error("watcher unavailable");
      },
      isIdle: () => true,
      wake: vi.fn(async () => {}),
      onError,
    });

    expect(controller).toBeDefined();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[0]).toMatchObject({
      status: "undelivered",
      reason: "watcherUnavailable",
      taskIds: [],
      queryable: false,
    });
    controller.dispose();
  });

  it("reports an idle watcher failure without throwing from flush", async () => {
    const { manager, publish } = fakeManager();
    const onError = vi.fn();
    const controller = createSubagentWake({
      manager,
      isIdle: () => {
        throw new Error("idle check failed");
      },
      wake: vi.fn(async () => {}),
      onError,
    });

    expect(() => publish(notice("idle-task"))).not.toThrow();
    await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    expect(onError.mock.calls[0]?.[0]).toMatchObject({
      status: "undelivered",
      reason: "watcherUnavailable",
      taskIds: ["idle-task"],
      queryable: true,
    });

    controller.dispose();
  });

  it("does not report or invent a completion when no terminal envelope exists", async () => {
    const { manager } = fakeManager();
    const wake = vi.fn(async () => {
      throw new Error("no envelope");
    });
    const onError = vi.fn();
    const controller = createSubagentWake({
      manager,
      isIdle: () => true,
      wake,
      onError,
    });

    controller.request();
    await Promise.resolve();
    await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(1));

    expect(onError.mock.calls[0]?.[0]).toMatchObject({
      status: "undelivered",
      reason: "wakeFailed",
      taskIds: [],
      queryable: false,
    });
    expect((onError.mock.calls[0]?.[0] as Error).message).not.toContain(
      "result:"
    );
    controller.dispose();
  });

  it("exposes a stable controller shape for entry wiring", () => {
    const controller: SubagentWake = createSubagentWake({
      manager: undefined,
      isIdle: () => true,
      wake: async () => {},
    });

    expect(typeof controller.flush).toBe("function");
    expect(typeof controller.request).toBe("function");
    expect(typeof controller.dispose).toBe("function");
    controller.dispose();
  });
});
