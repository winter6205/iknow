/**
 * Locked sentence 1 (plans/session-fg-handoff-interrupt.md) — 前景交差通道互斥。
 *
 * 不变式：`wait:true` 的前景 worker，其信封只在**这一次工具调用的 tool_result**
 * 里交付；同一份信封不得再经 host drain 或 mailbox silent wake 二进父 messages
 * （那会把交差画成 user message / 重复一份）。
 *
 *   - fg (`wait:true`)  → def.excludeFromHostDrain = true → drainCompleted 空返
 *                         + mailbox 无 terminal notice
 *   - bg (`wait:false`) → 仍 mailbox 发布 + 仍被 drainCompleted 收走
 *   - `listSubagents()` 把同一等价关系投成 `foreground`（父侧 in-band 等待 =
 *     judge / graph-node / wait:true 同一population），下游 Ctrl+C 扇出按它选目标。
 *
 * rig：真 handler + 真 manager + fake child（stdout 写一行合法 envelope），
 * 与 tests/subagent/foreground-contract.test.ts / mailbox.test.ts 同款；
 * fg 臂必须真经 `manager.waitFor` 返回 tool_result，才能证明「同一份信封只走
 * 一跳」而不是各自为政的两条断言。
 */
import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";

import { createSubAgentManager } from "../../src/harness/subagent/manager.ts";
import type {
  SubAgentManager,
  SubAgentTerminalNotice,
} from "../../src/harness/subagent/manager.ts";
import { createSpawnSubAgentTool } from "../../src/harness/subagent/spawn-subagent-tool.ts";
import {
  drainPendingSubagents,
  formatDrainedResults,
  SUBAGENT_DRAIN_PREFIX,
} from "../../src/harness/subagent/host-drain.ts";

/** 最小 fake child：stdout 可写一行 envelope，stdin/stderr 齐备（同 mailbox.test.ts）。 */
function makeFakeChild(): ChildProcess {
  return Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    kill: vi.fn(() => true),
  }) as unknown as ChildProcess;
}

interface Rig {
  readonly manager: SubAgentManager;
  readonly tool: ReturnType<typeof createSpawnSubAgentTool>;
  readonly children: ChildProcess[];
  /**
   * 订阅者**后注册**（`subscribeNow()`）—— mailbox 会把注册前已发布的
   * notice 重放给新订阅者（mailbox.ts 的 late-subscriber 语义），所以只有
   * 「终态之后再订」才能证明终态那一刻**没有**发布。这也是 drain 恒为空
   * 断言之外的独立通道：前者盯 drain 读侧，后者盯 publish 写侧。
   */
  readonly subscribeNow: () => void;
  readonly notices: SubAgentTerminalNotice[];
}

/** 真 manager + 真 handler；spawn 工厂按调用序产出 fake child。 */
function makeRig(): Rig {
  const children: ChildProcess[] = [];
  const manager = createSubAgentManager({
    spawn: () => {
      const child = makeFakeChild();
      children.push(child);
      return child;
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

/** 写回一行合法终态信封（manager stdout newline-JSON 协议）。 */
function emitEnvelope(child: ChildProcess, summary: string): void {
  child.stdout!.write(
    `${JSON.stringify({ status: "ok", summary, result: `${summary} result` })}\n`
  );
}

const CONVERSATION = "conv-fg-drain";

describe("前景交差只走当跳 tool_result（Locked sentence 1）", () => {
  it("wait:true 终态后：tool_result 是唯一交付面 —— drainCompleted 空返且 mailbox 无 notice", async () => {
    const rig = makeRig();
    const pending = rig.tool.handler(
      { task: "fg", wait: true },
      { conversationId: CONVERSATION }
    );
    // handler 已 spawn 完并挂在 waitFor 上（fake child 无 exit，只有 stdout 信封）。
    await vi.waitFor(() => expect(rig.children).toHaveLength(1));
    emitEnvelope(rig.children[0]!, "fg done");

    const result = (await pending) as { status: string; summary: string };
    // 交付面 1：当跳 tool_result 拿到信封。
    expect({ status: result.status, summary: result.summary }).toEqual({
      status: "ok",
      summary: "fg done",
    });
    // 交付面 2（必须缺席）—— 读侧 + 写侧 + 浓缩文本三层，同一条断言：
    //   drained  = host drain 读不到；
    //   notices  = 终态之后再订阅（重放语义）仍然收不到；
    //   drainText = 真消费面（host-drain 的父可见浓缩格式）不产出。
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
      { task: "bg", wait: false },
      { conversationId: CONVERSATION }
    );
    // wait:false 臂的 tool_result 是 {task_id} JSON 串（异步臂不阻塞）。
    const { task_id: bgTaskId } = JSON.parse(raw as string) as {
      task_id: string;
    };
    emitEnvelope(rig.children[0]!, "bg done");

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
      // 后景臂的父可见文本仍是既有浓缩通道（前缀 SSOT + 任务身份 + 摘要）。
      // 不钉 envelope 投影的折叠细节 —— 那是 envelope.ts 自己的测试面。
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
      { task: "fg", wait: true },
      { conversationId: CONVERSATION }
    );
    await vi.waitFor(() => expect(rig.children).toHaveLength(1));
    emitEnvelope(rig.children[0]!, "fg done");
    await pending;
    await rig.tool.handler(
      { task: "bg", wait: false },
      { conversationId: CONVERSATION }
    );
    emitEnvelope(rig.children[1]!, "bg done");

    const infos = rig.manager.listSubagents(CONVERSATION);
    // def.task 是唯一投影锚（taskPreview 不截断短任务，见 truncateTaskPreview）。
    const fgInfo = infos.find((i) => i.taskPreview === "fg")!;
    const bgInfo = infos.find((i) => i.taskPreview === "bg")!;
    // foreground 的定义 = 父侧 in-band 等待（= judge / graph-node / wait:true
    // 同一 population）；下游 Ctrl+C 扇出按此字段选目标，语义必须钉死。
    expect({
      conversationId: fgInfo.conversationId,
      foreground: fgInfo.foreground,
    }).toEqual({ conversationId: CONVERSATION, foreground: true });
    expect(bgInfo.conversationId).toBe(CONVERSATION);
    expect("foreground" in bgInfo).toBe(false);
    await rig.manager.shutdown();
  });
});
