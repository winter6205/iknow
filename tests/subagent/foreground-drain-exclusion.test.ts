/**
 * Locked sentence 1 — foreground handoff channel mutual exclusion.
 *
 * Invariant: a `wait:true` foreground worker's envelope is delivered **only**
 * in the tool_result of that one tool call; the same envelope must not enter
 * parent messages again via host drain or mailbox silent wake (that would
 * redraw the handoff as a user message / duplicate it).
 *
 *   - fg (`wait:true`)  → def.excludeFromHostDrain = true → drainCompleted returns empty
 *                         + no terminal notice in the mailbox
 *   - bg (`wait:false`) → still mailbox-published + still collected by drainCompleted
 *   - `listSubagents()` projects the same equivalence into `foreground` (parent-side
 *     in-band wait = judge / graph-node / wait:true, same population); downstream
 *     Ctrl+C fan-out selects targets by it.
 *
 * Rig: real handler + real manager + fake child (writes one valid envelope line
 * to stdout), same style as tests/subagent/foreground-contract.test.ts /
 * mailbox.test.ts; the fg arm must really return tool_result via
 * `manager.waitFor`, so "the same envelope travels exactly one hop" is proven
 * rather than being two disconnected assertions.
 */
import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";

import { createSubAgentManager } from "../../src/harness/subagent/manager.ts";
import type { SubAgentManager } from "../../src/harness/subagent/manager.ts";
import type { SubAgentTerminalNotice } from "../../src/harness/subagent/mailbox.ts";
import { createSpawnSubAgentTool } from "../../src/harness/subagent/spawn-subagent-tool.ts";
import {
  drainPendingSubagents,
  formatDrainedResults,
  SUBAGENT_DRAIN_PREFIX,
} from "../../src/harness/subagent/host-drain.ts";

/**
 * Fake child paired with the writable end of its stdout. `ChildProcess.stdout`
 * is typed `Readable | null`, so the envelope writer is fed through the
 * `PassThrough` directly instead of reaching through the process handle.
 */
interface FakeChild {
  readonly child: ChildProcess;
  readonly stdout: PassThrough;
}

/** Minimal fake child: stdout can write one envelope line; stdin/stderr present (same as mailbox.test.ts). */
function makeFakeChild(): FakeChild {
  const stdout = new PassThrough();
  return {
    stdout,
    child: Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout,
      stderr: new PassThrough(),
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null,
      kill: vi.fn(() => true),
    }) as unknown as ChildProcess,
  };
}

interface Rig {
  readonly manager: SubAgentManager;
  readonly tool: ReturnType<typeof createSpawnSubAgentTool>;
  readonly children: FakeChild[];
  /**
   * The subscriber registers **afterwards** (`subscribeNow()`) — mailbox
   * replays already-published notices to new subscribers (late-subscriber
   * semantics in mailbox.ts), so only "subscribe after terminal" proves
   * nothing was published at the terminal moment. This is a channel independent
   * from the always-empty drain assertion: the former watches the drain read
   * side, this one watches the publish write side.
   */
  readonly subscribeNow: () => void;
  readonly notices: SubAgentTerminalNotice[];
}

/** Real manager + real handler; the spawn factory yields fake children in call order. */
function makeRig(): Rig {
  const children: FakeChild[] = [];
  const manager = createSubAgentManager({
    spawn: () => {
      const fake = makeFakeChild();
      children.push(fake);
      return fake.child;
    },
  });
  const notices: SubAgentTerminalNotice[] = [];
  return {
    manager,
    tool: createSpawnSubAgentTool({ manager }),
    children,
    notices,
    subscribeNow: () => {
      manager.subscribe((notice) => notices.push(notice));
    },
  };
}

/** Write back one legal terminal envelope (manager stdout newline-JSON protocol). */
function emitEnvelope(stdout: PassThrough, summary: string): void {
  stdout.write(
    `${JSON.stringify({ status: "ok", summary, result: `${summary} result` })}\n`
  );
}

const CONVERSATION = "conv-fg-drain";

describe("前景交差只走当跳 tool_result（Locked sentence 1）", () => {
  it("wait:true 终态后：tool_result 是唯一交付面 —— drainCompleted 空返且 mailbox 无 notice", async () => {
    const rig = makeRig();
    const pending = rig.tool.handler(
      { title: "sample title", task: "fg", wait: true },
      { conversationId: CONVERSATION }
    );
    // The handler has spawned and is parked on waitFor (fake child never exits; only the stdout envelope ends it).
    await vi.waitFor(() => expect(rig.children).toHaveLength(1));
    emitEnvelope(rig.children[0]!.stdout, "fg done");

    const result = (await pending) as { status: string; summary: string };
    // Delivery surface 1: this hop's tool_result receives the envelope.
    expect({ status: result.status, summary: result.summary }).toEqual({
      status: "ok",
      summary: "fg done",
    });
    // Delivery surface 2 (must be absent) — read side + write side + condensed
    // text, three layers in one assertion:
    //   drained   = host drain can't read it;
    //   notices   = subscribing after terminal (replay semantics) still receives nothing;
    //   drainText = the real consumption surface (host-drain's parent-visible condensed format) produces nothing.
    rig.subscribeNow();
    expect({
      drained: rig.manager.drainCompleted(CONVERSATION),
      notices: rig.notices,
      drainText: await drainPendingSubagents(rig.manager, {
        conversationId: CONVERSATION,
      }),
    }).toEqual({ drained: [], notices: [], drainText: "" });
    await rig.manager.shutdown();
  });

  it("regression wait:false：仍发布 mailbox notice 且仍被 drainCompleted 收走", async () => {
    const rig = makeRig();
    const raw = await rig.tool.handler(
      { title: "sample title", task: "bg", wait: false },
      { conversationId: CONVERSATION }
    );
    // The wait:false arm's tool_result is a {task_id} JSON string (async arm, non-blocking).
    const { task_id: bgTaskId } = JSON.parse(raw as string) as {
      task_id: string;
    };
    emitEnvelope(rig.children[0]!.stdout, "bg done");

    await vi.waitFor(() =>
      expect(rig.manager.drainCompleted(CONVERSATION)).toHaveLength(1)
    );
    rig.subscribeNow();
    const drainText = formatDrainedResults(
      rig.manager.drainCompleted(CONVERSATION)
    );
    expect({
      noticedTaskId: rig.notices[0]!.taskId,
      drained: rig.manager
        .drainCompleted(CONVERSATION)
        .map(({ taskId }) => taskId),
      // The background arm's parent-visible text stays the existing condensed
      // channel (prefix SSOT + task identity + summary). Don't pin the envelope
      // projection's folding details — that's envelope.ts's own test surface.
      drainChannel: drainText.startsWith(
        `${SUBAGENT_DRAIN_PREFIX}${bgTaskId} result: `
      ),
      drainCarriesSummary: drainText.includes("bg done"),
      drainEmpty: drainText.length === 0,
    }).toEqual({
      noticedTaskId: bgTaskId,
      drained: [bgTaskId],
      drainChannel: true,
      drainCarriesSummary: true,
      drainEmpty: false,
    });
    await rig.manager.shutdown();
  });

  it("listSubagents：fg 任务带 conversationId + foreground:true；bg 任务 foreground 缺席", async () => {
    const rig = makeRig();
    const pending = rig.tool.handler(
      { title: "sample title", task: "fg", wait: true },
      { conversationId: CONVERSATION }
    );
    await vi.waitFor(() => expect(rig.children).toHaveLength(1));
    emitEnvelope(rig.children[0]!.stdout, "fg done");
    await pending;
    await rig.tool.handler(
      { title: "sample title", task: "bg", wait: false },
      { conversationId: CONVERSATION }
    );
    emitEnvelope(rig.children[1]!.stdout, "bg done");

    const infos = rig.manager.listSubagents(CONVERSATION);
    // def.task is the only projection anchor (taskPreview doesn't truncate short tasks; see truncateTaskPreview).
    const fgInfo = infos.find((i) => i.taskPreview === "fg")!;
    const bgInfo = infos.find((i) => i.taskPreview === "bg")!;
    // foreground is defined as parent-side in-band wait (= judge / graph-node /
    // wait:true, same population); downstream Ctrl+C fan-out selects targets by
    // this field, so its semantics must be pinned.
    expect({
      conversationId: fgInfo.conversationId,
      foreground: fgInfo.foreground,
    }).toEqual({ conversationId: CONVERSATION, foreground: true });
    expect(bgInfo.conversationId).toBe(CONVERSATION);
    expect("foreground" in bgInfo).toBe(false);
    await rig.manager.shutdown();
  });
});
