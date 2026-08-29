import { describe, expect, it, vi } from "vitest";

import {
  createSubagentWake,
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
    await vi.waitFor(() => expect(onError).toHaveBeenCalledWith(failure));

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
