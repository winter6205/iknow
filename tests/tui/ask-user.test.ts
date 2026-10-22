/**
 * TUI ask bridge additions the remote seat depends on (spec remote-sync §4.2):
 *  - pendingAll() lists every queued ask FIFO and carries the call input;
 *  - onSettled fires once per settlement, naming who answered
 *    (local / remote) or that the system ended it (timeout / abort);
 *  - first answer wins leaves exactly one settlement, and a broken settlement
 *    listener never breaks the ask.
 */
import { describe, expect, jest, test } from "bun:test";
import {
  createTuiAskUserBridge,
  type TuiAskUserBridge,
  type TuiPendingAsk,
} from "../../src/tui/ask-user.js";
import type { AskUserOutcome } from "../../src/harness/permission/types.js";

const flushMicrotasks = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

function askCtx(
  toolUseId: string,
  tool = "Bash",
  input: unknown = { command: "ls" }
): {
  readonly tool: string;
  readonly input: unknown;
  readonly summaryHint: string;
  readonly toolUseId: string;
} {
  return { tool, input, summaryHint: "run a command", toolUseId };
}

interface Settlement {
  readonly id: string;
  readonly outcome: AskUserOutcome;
  readonly by: "local" | "remote" | "system";
  readonly answer: "once" | "always" | "reject" | undefined;
}

function recordSettlements(bridge: TuiAskUserBridge): {
  readonly seen: Settlement[];
  readonly stop: () => void;
} {
  const seen: Settlement[] = [];
  const stop = bridge.onSettled((ask, outcome, by, answer) => {
    seen.push({ id: ask.id, outcome, by, answer });
  });
  return { seen, stop };
}

describe("pendingAll", () => {
  test("lists every queued ask FIFO, each carrying its call input", async () => {
    const bridge = createTuiAskUserBridge();
    const first = bridge.ask(askCtx("toolu_1", "Bash", { command: "ls -la" }));
    const second = bridge.ask(askCtx("toolu_2", "Edit", { path: "a.ts" }));

    const pending: readonly TuiPendingAsk[] = bridge.pendingAll();
    expect(pending.map((ask) => ask.id)).toEqual(["ask-1", "ask-2"]);
    expect(pending.map((ask) => ask.toolUseId)).toEqual(["toolu_1", "toolu_2"]);
    expect(pending[0]?.input).toEqual({ command: "ls -la" });
    expect(pending[1]?.input).toEqual({ path: "a.ts" });
    // The existing head accessor is unchanged.
    expect(bridge.pending()?.id).toBe("ask-1");
    expect(bridge.pendingCount()).toBe(2);

    expect(bridge.resolveAsk("ask-1", false)).toBe(true);
    await expect(first).resolves.toEqual({ kind: "declined" });
    expect(bridge.pendingAll().map((ask) => ask.id)).toEqual(["ask-2"]);

    expect(bridge.resolveAsk("ask-2", true)).toBe(true);
    await expect(second).resolves.toEqual({ kind: "approved" });
    expect(bridge.pendingAll()).toEqual([]);
  });
});

describe("onSettled", () => {
  test("fires once per ask with the answer and its origin", async () => {
    const bridge = createTuiAskUserBridge();
    const { seen, stop } = recordSettlements(bridge);
    const remote = bridge.ask(askCtx("toolu_1"));
    const local = bridge.ask(askCtx("toolu_2"));

    expect(bridge.resolveAsk("ask-1", true, "remote", "always")).toBe(true);
    await expect(remote).resolves.toEqual({ kind: "approved" });
    expect(seen).toEqual([
      {
        id: "ask-1",
        outcome: { kind: "approved" },
        by: "remote",
        answer: "always",
      },
    ]);

    // First answer wins: the late local answer settles nothing and reports
    // no second settlement.
    expect(bridge.resolveAsk("ask-1", false)).toBe(false);
    await flushMicrotasks();
    expect(seen).toHaveLength(1);

    expect(bridge.resolveAsk("ask-2", false, "local", "reject")).toBe(true);
    await expect(local).resolves.toEqual({ kind: "declined" });
    expect(seen[1]).toEqual({
      id: "ask-2",
      outcome: { kind: "declined" },
      by: "local",
      answer: "reject",
    });

    stop();
    const afterStop = bridge.ask(askCtx("toolu_3"));
    expect(bridge.resolveAsk("ask-3", true, "local", "once")).toBe(true);
    await expect(afterStop).resolves.toEqual({ kind: "approved" });
    expect(seen).toHaveLength(2);
  });

  test("a configured timeout settles as a system ending (fake timers)", async () => {
    jest.useFakeTimers();
    try {
      jest.clearAllTimers();
      const bridge = createTuiAskUserBridge({ timeoutMs: 5_000 });
      const { seen } = recordSettlements(bridge);
      const promise = bridge.ask(askCtx("toolu_1"));

      jest.advanceTimersByTime(5_000);
      await flushMicrotasks();

      await expect(promise).resolves.toEqual({
        kind: "timeout",
        afterMs: 5_000,
      });
      expect(seen).toEqual([
        {
          id: "ask-1",
          outcome: { kind: "timeout", afterMs: 5_000 },
          by: "system",
          answer: undefined,
        },
      ]);
      expect(bridge.pendingAll()).toEqual([]);
    } finally {
      jest.useRealTimers();
    }
  });

  test("an abort settles as a system cancellation", async () => {
    const bridge = createTuiAskUserBridge();
    const { seen } = recordSettlements(bridge);
    const controller = new AbortController();
    const promise = bridge.ask({
      ...askCtx("toolu_1"),
      signal: controller.signal,
    });
    expect(seen).toEqual([]);

    controller.abort();
    await flushMicrotasks();

    await expect(promise).resolves.toEqual({ kind: "cancelled" });
    expect(seen).toEqual([
      {
        id: "ask-1",
        outcome: { kind: "cancelled" },
        by: "system",
        answer: undefined,
      },
    ]);
  });

  test("a throwing settlement listener neither fails the ask nor hides the settlement", async () => {
    const bridge = createTuiAskUserBridge();
    bridge.onSettled(() => {
      throw new Error("broken projector");
    });
    const { seen } = recordSettlements(bridge);
    const promise = bridge.ask(askCtx("toolu_1"));

    expect(bridge.resolveAsk("ask-1", true, "remote", "always")).toBe(true);
    await expect(promise).resolves.toEqual({ kind: "approved" });
    expect(seen).toEqual([
      {
        id: "ask-1",
        outcome: { kind: "approved" },
        by: "remote",
        answer: "always",
      },
    ]);
    expect(bridge.pendingCount()).toBe(0);
  });
});
