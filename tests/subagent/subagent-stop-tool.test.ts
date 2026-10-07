/**
 * ADR-0101 — `subagent_stop` ACI tool unit tests.
 *
 * Coverage:
 *   - empty task_id / non-string task_id → ToolExecutionError (input validation);
 *   - unknown id → structured explanation (ok tool_result; no "task failed" illusion);
 *   - running in this conversation → existing abortTask (same path as Ctrl+X:
 *     settle in-flight waitFor first, then SIGTERM with 5s SIGKILL fallback);
 *     after process exit the state is queryable as failed;
 *   - terminal idempotence → second stop returns already_terminal structured
 *     explanation, no further signal;
 *   - cross-conversation → typed rejection (ToolExecutionError), abortTask not called.
 *
 * manager = real createSubAgentManager + fake child (same precedent as
 * manager.test.ts); the abortTask propagation chain (kill → exit → settleCrash)
 * runs the real implementation.
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, it, vi } from "vitest";
import type { ChildProcess } from "node:child_process";

import { createSubAgentManager } from "../../src/harness/subagent/manager.ts";
import type {
  SubAgentDefinition,
  SubagentInfo,
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

function makeFakeChild(
  opts: { readonly exitOnKill?: boolean } = {}
): FakeChild {
  const kill = vi.fn(() => {
    if (opts.exitOnKill !== false) {
      // A real worker exits after wrapping up on SIGTERM; the fake ends + emits exit
      // immediately (no stdout envelope → manager settleCrash → failed).
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

/** Real manager + fake spawn: records the child for each taskId. */
function makeManagerHarness() {
  const children = new Map<string, FakeChild>();
  const manager = createSubAgentManager({
    spawn: (
      _def: SubAgentDefinition,
      taskId: string,
      _payload: WorkerEnvelope
    ) => {
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
      () =>
        Promise.resolve(
          tool.handler({ task_id: "" }, { conversationId: "c1" })
        ),
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
    // idempotent: after terminal state, stop no longer signals the process.
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
    // abortTask propagation = child.kill("SIGTERM") (same entry as TUI Ctrl+X).
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
    // abortTask first rejects the in-flight waitFor with SubAgentAbortError (abort-before-signal ordering contract).
    await assert.rejects(
      () => waiting,
      (err: unknown) => (err as Error).name === "SubAgentAbortError"
    );
  });
});

describe("subagent_stop — 中止快照竞态（不伪造终态）", () => {
  it("abortTask 返回 false 且任务已出账 → not_found 结构化说明，无伪造 state", async () => {
    // fake manager with a precise race window: first lookup running (passes ownership +
    // terminal gate), abortTask returns false when the task is already invisible to the
    // manager, re-list is empty — in the real manager this is the shape of "TTL eviction
    // landing exactly between two enumerations".
    const running: SubagentInfo = {
      taskId: "t-gone",
      state: "running",
      taskPreview: "racing",
      startedAt: new Date().toISOString(),
      conversationId: "c1",
    };
    let listed: ReadonlyArray<SubagentInfo> = [running];
    const manager = {
      listSubagents: () => listed,
      abortTask: () => {
        listed = [];
        return false;
      },
    } as unknown as SubAgentManager;
    const tool = createSubAgentStopTool({ manager });
    const out = parse(
      await tool.handler({ task_id: "t-gone" }, { conversationId: "c1" })
    );
    assert.equal(out.status, "not_found");
    // Key pin: a vanished task must not fabricate any state via fallback (writing state:"failed" was a hallucination).
    assert.ok(
      !("state" in out),
      "vanished task must not carry a fabricated state"
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
    // ownership verdict precedes abortTask: an unauthorized call must not kill someone else's process.
    assert.equal(child.kill.mock.calls.length, 0);
    // A call surface without ctx.conversationId likewise must not touch owned tasks.
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
