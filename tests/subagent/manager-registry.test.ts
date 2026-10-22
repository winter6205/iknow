import { describe, expect, it, vi } from "vitest";

import {
  createSubagentManagerRegistry,
  SubagentManagerDrainError,
  type SubagentManagerReadView,
} from "../../src/harness/subagent/manager-registry.ts";
import type { ClaimedDelivery } from "../../src/harness/subagent/delivery-ledger.ts";
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

interface ClaimingManagerFake extends SubagentManagerReadView {
  readonly deliveredTaskIds: () => ReadonlyArray<string>;
  readonly addTask: (taskId: string) => void;
}

/**
 * Structural manager with the optional claim seam: one terminal generation per
 * task, claimable once and settled through the registry's ack/release routing.
 * The bookkeeping is local to this file so these cases pin registry
 * aggregation, not the product ledger's semantics.
 */
function claimingManager(
  initialTaskIds: ReadonlyArray<string>
): ClaimingManagerFake {
  const taskIds = [...initialTaskIds];
  const claimed = new Set<string>();
  const delivered = new Set<string>();
  const owners = new Map<symbol, string>();
  const mailbox = createSubAgentMailbox();

  const visible = (): ReadonlyArray<Completed> =>
    taskIds
      .filter((taskId) => !claimed.has(taskId) && !delivered.has(taskId))
      .map(completed);

  const settle = (
    claims: ReadonlyArray<ClaimedDelivery<unknown>>,
    outcome: "delivered" | "released"
  ): void => {
    for (const claim of claims) {
      const taskId = owners.get(claim.token);
      if (taskId === undefined) continue;
      owners.delete(claim.token);
      claimed.delete(taskId);
      if (outcome === "delivered") delivered.add(taskId);
    }
  };

  return {
    drainCompleted: () => visible(),
    claimCompleted: () =>
      visible().map(({ taskId, envelope }) => {
        const token = Symbol(taskId);
        owners.set(token, taskId);
        claimed.add(taskId);
        return {
          key: taskId,
          token,
          conversationId: "",
          taskId,
          terminalSeq: 1,
          envelope,
        };
      }),
    acknowledgeDeliveries: (claims) => settle(claims, "delivered"),
    releaseDeliveries: (claims) => settle(claims, "released"),
    listSubagents: () => [],
    subscribe: mailbox.subscribe,
    deliveredTaskIds: () => [...delivered],
    addTask: (taskId) => {
      taskIds.push(taskId);
    },
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

  it("claims every manager's undelivered result and delivers them on acknowledge", () => {
    const registry = createSubagentManagerRegistry();
    const first = claimingManager(["first-task"]);
    const second = claimingManager(["second-task"]);
    registry.register(first);
    registry.register(second);

    const claims = registry.claimCompleted();
    expect(claims.map(({ taskId }) => taskId)).toEqual([
      "first-task",
      "second-task",
    ]);
    // A claimed generation is invisible to both the read and a second claim.
    expect(registry.drainCompleted()).toEqual([]);
    expect(registry.claimCompleted()).toEqual([]);

    registry.acknowledgeDeliveries(claims);
    expect(first.deliveredTaskIds()).toEqual(["first-task"]);
    expect(second.deliveredTaskIds()).toEqual(["second-task"]);
    expect(registry.drainCompleted()).toEqual([]);
    expect(registry.claimCompleted()).toEqual([]);
  });

  it("reports a typed claim error and keeps the other manager's claims", () => {
    const failure = new Error("claim unavailable");
    const onError = vi.fn();
    const registry = createSubagentManagerRegistry({ onError });
    const healthy = claimingManager(["healthy"]);
    const broken: ClaimingManagerFake = {
      ...claimingManager(["broken"]),
      claimCompleted: () => {
        throw failure;
      },
    };
    registry.register(broken);
    registry.register(healthy);

    expect(registry.claimCompleted().map(({ taskId }) => taskId)).toEqual([
      "healthy",
    ]);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(expect.any(SubagentManagerDrainError));
    expect(onError.mock.calls[0]?.[0]).toMatchObject({
      reason: "drainFailed",
      cause: failure,
    });
  });

  it("routes same-task-id claims back to their own manager", () => {
    const registry = createSubagentManagerRegistry();
    const first = claimingManager(["shared-task"]);
    const second = claimingManager(["shared-task"]);
    registry.register(first);
    registry.register(second);

    const claims = registry.claimCompleted();
    expect(claims.map(({ taskId }) => taskId)).toEqual([
      "shared-task",
      "shared-task",
    ]);

    registry.acknowledgeDeliveries(claims);
    // Routing is by claim token, not by the parent-visible task id: each
    // manager settles its own generation.
    expect(first.deliveredTaskIds()).toEqual(["shared-task"]);
    expect(second.deliveredTaskIds()).toEqual(["shared-task"]);
    expect(registry.claimCompleted()).toEqual([]);
  });

  it("a delivered entry from one manager does not hide another manager's entry", () => {
    const registry = createSubagentManagerRegistry();
    const first = claimingManager(["first-task"]);
    const second = claimingManager([]);
    registry.register(first);
    registry.register(second);

    registry.acknowledgeDeliveries(registry.claimCompleted());
    expect(first.deliveredTaskIds()).toEqual(["first-task"]);

    // A later terminal result on another manager still claims.
    second.addTask("second-task");
    expect(registry.claimCompleted().map(({ taskId }) => taskId)).toEqual([
      "second-task",
    ]);
  });

  it("drains read-only when a view has no claim seam", () => {
    const registry = createSubagentManagerRegistry();
    registry.register(readManager(() => [completed("read-only")]));

    expect(registry.claimCompleted()).toEqual([]);
    expect(registry.drainCompleted()).toEqual([completed("read-only")]);
    expect(() => registry.acknowledgeDeliveries([])).not.toThrow();
    expect(() => registry.releaseDeliveries([])).not.toThrow();
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

  it("fans one hard kill to the owning manager and reports it (Slice D / SC14)", () => {
    const firstAbort = vi.fn(() => false);
    const secondAbort = vi.fn((taskId: string) => taskId === "second-live");
    const first = readManager(() => []);
    const second = readManager(() => []);
    const registry = createSubagentManagerRegistry();
    registry.register({ ...first, abortTask: firstAbort });
    registry.register({ ...second, abortTask: secondAbort });

    expect(registry.abortTask("second-live")).toBe(true);
    // taskId belongs to exactly one manager: keep asking the next after the first reports false.
    expect(firstAbort).toHaveBeenCalledWith("second-live");
    expect(secondAbort).toHaveBeenCalledWith("second-live");
  });

  it("returns false when no manager claims the task (unknown id / no abort seam)", () => {
    const withSeam = readManager(() => []);
    const registry = createSubagentManagerRegistry();
    registry.register({ ...withSeam, abortTask: () => false });

    expect(registry.abortTask("ghost")).toBe(false);
    // no manager (ask surface) → no-op, no throw.
    const empty = createSubagentManagerRegistry();
    expect(empty.abortTask("ghost")).toBe(false);
    // structurally compatible wake/read-only view (no abort seam) → skipped, no fake kill.
    const seamLess = createSubagentManagerRegistry();
    seamLess.register(readManager(() => []));
    expect(seamLess.abortTask("ghost")).toBe(false);
  });
});
