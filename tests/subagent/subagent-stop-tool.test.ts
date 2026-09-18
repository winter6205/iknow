/**
 * ADR-0101 / plan subagent-stop-and-continue T2 — `subagent_stop` ACI 工具单测。
 *
 * 覆盖票面（ACR input-contract-tests）：
 *   - 空 task_id / 非 string task_id → ToolExecutionError（输入校验）；
 *   - 未知 id → 结构化说明（ok tool_result，不抛「任务失败幻觉」）；
 *   - 本会话 running → 走既有 abortTask（与 Ctrl+X 同路径：先 settle 在飞
 *     waitFor，再 SIGTERM + 5s SIGKILL 兜底）；进程结束后状态可查 failed；
 *   - 终态幂等 → 二次 stop 返回 already_terminal 结构化说明，不再发信号；
 *   - 跨会话 → typed 拒收（ToolExecutionError），不发 abortTask。
 *
 * manager 用真实 createSubAgentManager + fake child（沿用 manager.test.ts
 * 先例），abortTask 的传播链（kill → exit → settleCrash）走真实实现。
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, it, vi } from "vitest";
import type { ChildProcess } from "node:child_process";

import { createSubAgentManager } from "../../src/harness/subagent/manager.ts";
import type {
  SubAgentDefinition,
  SubAgentManager,
} from "../../src/harness/subagent/manager.ts";
import { createSubAgentStopTool } from "../../src/harness/subagent/subagent-stop-tool.ts";
import type {
  SubAgentEnvelope,
  WorkerEnvelope,
} from "../../src/harness/subagent/envelope.ts";
import { ToolExecutionError } from "../../src/harness/errors.ts";
import { TIMEOUT_TIER_MS } from "../../src/harness/aci/types.ts";

interface FakeChild {
  readonly stdout: PassThrough;
  readonly stderr: PassThrough;
  readonly kill: ReturnType<typeof vi.fn>;
  emit: (event: string | symbol, ...args: unknown[]) => boolean;
  once: (event: string | symbol, ...args: unknown[]) => unknown;
}

function makeFakeChild(opts: { readonly exitOnKill?: boolean } = {}): FakeChild {
  const kill = vi.fn(() => {
    if (opts.exitOnKill !== false) {
      // 真 worker 对 SIGTERM 收尾后退出；fake 立即 end + exit（无 stdout
      // 信封 → manager settleCrash → failed）。
      setImmediate(() => {
        child.stderr.end();
        child.emit("exit", null, "SIGTERM");
      });
    }
    return true;
  });
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    pid: 4242,
    kill,
  }) as unknown as FakeChild;
  return child;
}

/** 真实 manager + fake spawn：记录每个 taskId 对应的 child。 */
function makeManagerHarness() {
  const children = new Map<string, FakeChild>();
  const manager = createSubAgentManager({
    spawn: (def: SubAgentDefinition, taskId: string, _payload: WorkerEnvelope) => {
      const child = makeFakeChild();
      children.set(taskId, child);
      return child as unknown as ChildProcess;
    },
  });
  return { manager, children };
}

function emitOkEnvelope(child: FakeChild, result = "done"): void {
  const env: SubAgentEnvelope = { status: "ok", summary: result, result };
  child.stdout.write(JSON.stringify(env) + "\n");
  child.emit("exit", 0, null);
}

async function waitForTerminal(
  manager: SubAgentManager,
  taskId: string
): Promise<void> {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const q = manager.queryBuffer(taskId);
    if (q.status !== "running") return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`task ${taskId} never reached terminal state`);
}

function parse(out: unknown): Record<string, unknown> {
  assert.equal(typeof out, "string");
  return JSON.parse(out as string) as Record<string, unknown>;
}

describe("subagent_stop — 输入校验", () => {
  it("空 task_id → ToolExecutionError", async () => {
    const { manager } = makeManagerHarness();
    const tool = createSubAgentStopTool({ manager });
    await assert.rejects(
      () => Promise.resolve(tool.handler({ task_id: "" }, { conversationId: "c1" })),
      ToolExecutionError
    );
  });

  it("task_id 非 string（直调 handler 的 schema 外兜底）→ ToolExecutionError", async () => {
    const { manager } = makeManagerHarness();
    const tool = createSubAgentStopTool({ manager });
    await assert.rejects(
      () =>
        Promise.resolve(
          tool.handler({ task_id: 123 }, { conversationId: "c1" })
        ),
      ToolExecutionError
    );
    await assert.rejects(
      () => Promise.resolve(tool.handler(null)),
      ToolExecutionError
    );
  });
});

describe("subagent_stop — 结构化说明与幂等（不抛任务失败幻觉）", () => {
  it("未知 id → ok 结果 {status:'not_found'}，不 throw", async () => {
    const { manager } = makeManagerHarness();
    const tool = createSubAgentStopTool({ manager });
    const out = parse(
      await tool.handler({ task_id: "no-such-task" }, { conversationId: "c1" })
    );
    assert.equal(out.status, "not_found");
    assert.equal(out.task_id, "no-such-task");
  });

  it("已终态（completed）→ 结构化 already_terminal，二次调用仍幂等", async () => {
    const { manager, children } = makeManagerHarness();
    const tool = createSubAgentStopTool({ manager });
    const { taskId } = manager.spawn({
      task: "finish-me",
      conversationId: "c1",
    } as SubAgentDefinition);
    const child = children.get(taskId)!;
    emitOkEnvelope(child);
    await waitForTerminal(manager, taskId);

    const first = parse(
      await tool.handler({ task_id: taskId }, { conversationId: "c1" })
    );
    assert.equal(first.status, "already_terminal");
    assert.equal(first.state, "completed");
    const second = parse(
      await tool.handler({ task_id: taskId }, { conversationId: "c1" })
    );
    assert.equal(second.status, "already_terminal");
    // 幂等：终态后 stop 不再向进程发信号。
    assert.equal(child.kill.mock.calls.length, 0);
  });
});

describe("subagent_stop — running 走既有 abortTask（与 Ctrl+X 同路径）", () => {
  it("本会话 running → SIGTERM 传播，进程结束后状态可查 failed", async () => {
    const { manager, children } = makeManagerHarness();
    const tool = createSubAgentStopTool({ manager });
    const { taskId } = manager.spawn({
      task: "long-running",
      conversationId: "c1",
    } as SubAgentDefinition);
    const child = children.get(taskId)!;

    const out = parse(
      await tool.handler({ task_id: taskId }, { conversationId: "c1" })
    );
    assert.equal(out.status, "stopped");
    assert.equal(out.task_id, taskId);
    // abortTask 的传播 = child.kill("SIGTERM")（与 TUI Ctrl+X 同一入口）。
    assert.ok(
      child.kill.mock.calls.some((call) => call[0] === "SIGTERM"),
      "stop must go through abortTask's SIGTERM path"
    );

    await waitForTerminal(manager, taskId);
    const q = manager.queryBuffer(taskId);
    assert.equal(q.status, "failed");
    assert.equal((q as { reason?: string }).reason, "crashed");
  });

  it("abortTask 同步 settle 在飞 waitFor（前景交差归因 cancelled，不是 timeout）", async () => {
    const { manager, children } = makeManagerHarness();
    const tool = createSubAgentStopTool({ manager });
    const { taskId } = manager.spawn({
      task: "foreground",
      conversationId: "c1",
    } as SubAgentDefinition);
    const child = children.get(taskId)!;
    void child;
    const waiting = manager.waitFor(taskId, 5000);
    await tool.handler({ task_id: taskId }, { conversationId: "c1" });
    // abortTask 先以 SubAgentAbortError 拒绝在飞 waitFor（SC14 顺序契约）。
    await assert.rejects(
      () => waiting,
      (err: unknown) => (err as Error).name === "SubAgentAbortError"
    );
  });
});

describe("subagent_stop — 跨会话拒", () => {
  it("task 属于另一会话 → ToolExecutionError，不发信号", async () => {
    const { manager, children } = makeManagerHarness();
    const tool = createSubAgentStopTool({ manager });
    const { taskId } = manager.spawn({
      task: "other-session",
      conversationId: "conv-owner",
    } as SubAgentDefinition);
    const child = children.get(taskId)!;

    await assert.rejects(
      () =>
        Promise.resolve(
          tool.handler({ task_id: taskId }, { conversationId: "conv-thief" })
        ),
      ToolExecutionError
    );
    // 所有权判定先于 abortTask：越权调用不能杀别人的进程。
    assert.equal(child.kill.mock.calls.length, 0);
    // 无 ctx.conversationId 的调用面同样不能碰带归属的任务。
    await assert.rejects(
      () => Promise.resolve(tool.handler({ task_id: taskId })),
      ToolExecutionError
    );
    assert.equal(child.kill.mock.calls.length, 0);
  });
});

describe("subagent_stop — AciToolDef 元数据", () => {
  it("name/description/schema/aci 形态（对齐 bash_stop 的 write/默认档）", () => {
    const { manager } = makeManagerHarness();
    const tool = createSubAgentStopTool({ manager });
    assert.equal(tool.name, "subagent_stop");
    assert.ok(tool.description.length > 0);
    assert.ok(Object.isFrozen(tool));
    const schema = tool.inputSchema as {
      required: string[];
      additionalProperties: boolean;
      properties: Record<string, { type: string }>;
    };
    assert.deepEqual(schema.required, ["task_id"]);
    assert.equal(schema.additionalProperties, false);
    assert.equal(schema.properties.task_id.type, "string");
    assert.equal(tool.aci.category, "write");
    assert.equal(tool.aci.isConcurrencySafe, false);
    assert.equal(tool.aci.interruptBehavior, "block");
    assert.equal(tool.aci.timeoutTier, "default");
    assert.ok(TIMEOUT_TIER_MS.default > 0);
  });
});
