import { describe, expect, it, vi } from "vitest";

import {
  createSubAgentMailbox,
  type SubAgentTerminalNotice,
} from "../../src/harness/subagent/mailbox.ts";
import type { SubAgentEnvelope } from "../../src/harness/subagent/envelope.ts";
import { createSubAgentManager } from "../../src/harness/subagent/manager.ts";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

function terminalNotice(
  taskId: string,
  overrides: Partial<SubAgentEnvelope> = {}
): SubAgentTerminalNotice {
  return {
    taskId,
    status: "ok",
    summary: "done",
    result: "result",
    ...overrides,
  };
}

describe("SubAgentMailbox", () => {
  it("does not notify a subscriber when the mailbox is empty", () => {
    const mailbox = createSubAgentMailbox();
    const listener = vi.fn();

    mailbox.subscribe(listener);

    expect(listener).not.toHaveBeenCalled();
  });

  it("publishes failed terminal facts without exposing in-flight messages", () => {
    const mailbox = createSubAgentMailbox();
    const listener = vi.fn();
    mailbox.subscribe(listener);

    mailbox.publish(
      terminalNotice("failed-task", {
        status: "failed",
        reason: "crashed",
        summary: "worker crashed",
        result: "",
      })
    );

    expect(listener).toHaveBeenCalledWith({
      taskId: "failed-task",
      status: "failed",
      reason: "crashed",
      summary: "worker crashed",
      result: "",
    });
    expect(listener.mock.calls[0]![0]).not.toHaveProperty("messages");
  });

  it("retains every terminal fact when many workers finish", () => {
    const mailbox = createSubAgentMailbox();
    const received: string[] = [];
    mailbox.subscribe((notice) => received.push(notice.taskId));

    for (let i = 0; i < 128; i++) {
      mailbox.publish(terminalNotice(`task-${i}`));
    }

    expect(received).toHaveLength(128);
    expect(received[0]).toBe("task-0");
    expect(received.at(-1)).toBe("task-127");
  });

  it("replays terminal facts to a late subscriber and isolates subscriptions", () => {
    const mailbox = createSubAgentMailbox();
    const first = vi.fn();
    const second = vi.fn();
    mailbox.subscribe(first);
    mailbox.publish(terminalNotice("finished"));
    mailbox.subscribe(second);

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledWith(terminalNotice("finished"));
  });

  it("does not duplicate a listener when subscribe is repeated", () => {
    const mailbox = createSubAgentMailbox();
    const listener = vi.fn();

    mailbox.subscribe(listener);
    mailbox.subscribe(listener);
    mailbox.publish(terminalNotice("once"));

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("continues notifying other listeners when one listener throws", () => {
    const onSubscriberError = vi.fn();
    const mailbox = createSubAgentMailbox({ onSubscriberError });
    const failing = vi.fn(() => {
      throw new Error("listener failed");
    });
    const healthy = vi.fn();
    mailbox.subscribe(failing);
    mailbox.subscribe(healthy);

    mailbox.publish(terminalNotice("exception-safe"));

    expect(healthy).toHaveBeenCalledTimes(1);
    expect(onSubscriberError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "listener failed" })
    );
  });

  it("freezes the notice snapshot so subscribers cannot mutate terminal facts", () => {
    const mailbox = createSubAgentMailbox();
    let received: SubAgentTerminalNotice | undefined;
    mailbox.subscribe((notice) => {
      received = notice;
    });

    mailbox.publish(
      terminalNotice("immutable", {
        fileRefs: ["src/changed.ts"],
      })
    );

    expect(Object.isFrozen(received)).toBe(true);
    expect(Object.isFrozen(received?.fileRefs)).toBe(true);
  });
});

interface FakeChild {
  readonly stdin: PassThrough;
  readonly stdout: PassThrough;
  readonly stderr: PassThrough;
  emit: (event: string | symbol, ...args: unknown[]) => boolean;
}

function makeFakeChild(): FakeChild {
  return Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    kill: vi.fn(() => true),
  }) as unknown as FakeChild;
}

describe("SubAgentManager terminal subscription", () => {
  it("notifies without polling drain when a worker completes", () => {
    const child = makeFakeChild();
    const manager = createSubAgentManager({
      spawn: () => child as unknown as ChildProcess,
    });
    const received: SubAgentTerminalNotice[] = [];
    manager.subscribe?.((notice) => received.push(notice));
    const taskId = manager.spawn({ task: "finish" }).taskId;

    child.stdout.write(
      JSON.stringify({
        status: "ok",
        summary: "finished",
        result: "terminal result",
      }) + "\n"
    );

    expect(received).toEqual([
      {
        taskId,
        status: "ok",
        summary: "finished",
        result: "terminal result",
      },
    ]);
  });

  it("repeated subscription does not mutate the manager buffer envelope", () => {
    const child = makeFakeChild();
    const manager = createSubAgentManager({
      spawn: () => child as unknown as ChildProcess,
    });
    const listener = vi.fn();
    manager.subscribe?.(listener);
    manager.subscribe?.(listener);
    const taskId = manager.spawn({ task: "stable buffer" }).taskId;
    child.stdout.write(
      JSON.stringify({
        status: "ok",
        summary: "stable",
        result: "unchanged",
      }) + "\n"
    );

    expect(listener).toHaveBeenCalledTimes(1);
    expect(manager.queryBuffer(taskId)).toEqual({
      status: "ok",
      summary: "stable",
      result: "unchanged",
    });
  });
});
