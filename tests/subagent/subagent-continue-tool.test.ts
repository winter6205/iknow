/**
 * ADR-0102 — `subagent_continue` ACI tool unit tests.
 *
 * Coverage:
 *   - empty / non-string `task_id`, empty / non-string `message` → ToolExecutionError;
 *   - unknown id rejected; running rejected (never inject into an in-flight loop);
 *   - terminal but no worker transcript rejected;
 *   - a per-agent trace on disk does **not** count as a transcript (no backfill from trace);
 *   - cross-conversation rejected (ownership verdict precedes any re-launch);
 *   - concurrency ceiling shares spawn's source: full → SubAgentCapacityError →
 *     ToolExecutionError;
 *   - completed / failed + transcript + next message → new process, same `task_id`
 *     handle, payload.task = next message, transcriptPath identical to first run
 *     (the rewind head is consumed worker-side; tests pin that the ledger address
 *     delivered by manager stays unchanged);
 *   - identity and capability fields carry over from the original def (role /
 *     maxTurns / conversationId ownership); per-turn fields (parentTurnId / toolUseId /
 *     foreground exclusion) are recomputed for this hop;
 *   - wait contract identical to spawn: `wait:false` returns {task_id} immediately;
 *     foreground (wait omitted) returns the projected envelope for this hop.
 *
 * manager = real createSubAgentManager + fake child; transcript files are written
 * manually at `<subagents>/<taskId>/<taskId>.jsonl` — manager's gate is mere
 * existence (ledger content truth is certified worker-side, see
 * worker-transcript.test.ts).
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it, vi } from "vitest";
import type { ChildProcess } from "node:child_process";

import { createSubAgentManager } from "../../src/harness/subagent/manager.ts";
import { SubAgentResumeError } from "../../src/harness/subagent/manager.ts";
import type {
  SubAgentDefinition,
  SubAgentManager,
} from "../../src/harness/subagent/manager.ts";
import { createSubAgentContinueTool } from "../../src/harness/subagent/subagent-continue-tool.ts";
import type {
  SubAgentEnvelope,
  WorkerEnvelope,
} from "../../src/harness/subagent/envelope.ts";
import { ToolExecutionError } from "../../src/harness/errors.ts";
import type { ToolExecutionContext } from "../../src/harness/tools/types.ts";

interface FakeChild {
  readonly stdout: PassThrough;
  readonly stderr: PassThrough;
  readonly kill: ReturnType<typeof vi.fn>;
  emit: (event: string | symbol, ...args: unknown[]) => boolean;
  once: (event: string | symbol, ...args: unknown[]) => unknown;
}

interface SpawnCall {
  readonly def: SubAgentDefinition;
  readonly taskId: string;
  readonly payload: WorkerEnvelope;
  readonly child: FakeChild;
}

function makeFakeChild(): FakeChild {
  const kill = vi.fn(() => {
    setImmediate(() => {
      child.stderr.end();
      child.emit("exit", null, "SIGTERM");
    });
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

/** Real manager (subagentsDir present → all three ledger keys derived) + fake spawn recording every launch. */
function makeManagerHarness(
  opts: { readonly maxConcurrentWorkers?: number } = {}
) {
  const subagentsDir = mkdtempSync(join(tmpdir(), "iknow-continue-"));
  const invocations: SpawnCall[] = [];
  const manager = createSubAgentManager({
    subagentsDir,
    ...("maxConcurrentWorkers" in opts
      ? { maxConcurrentWorkers: opts.maxConcurrentWorkers }
      : {}),
    spawn: (
      def: SubAgentDefinition,
      taskId: string,
      payload: WorkerEnvelope
    ) => {
      const child = makeFakeChild();
      invocations.push({ def, taskId, payload, child });
      return child as unknown as ChildProcess;
    },
  });
  const transcriptPath = (taskId: string) =>
    join(subagentsDir, taskId, `${taskId}.jsonl`);
  const writeTranscript = (taskId: string) => {
    writeFileSync(transcriptPath(taskId), '{"type":"header"}\n', "utf8");
  };
  return {
    manager,
    invocations,
    subagentsDir,
    transcriptPath,
    writeTranscript,
  };
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

/** A worker run to completed terminal state; returns taskId. */
async function spawnCompleted(
  harness: ReturnType<typeof makeManagerHarness>,
  def: SubAgentDefinition
): Promise<string> {
  const { taskId } = harness.manager.spawn(def);
  emitOkEnvelope(harness.invocations[harness.invocations.length - 1]!.child);
  await waitForTerminal(harness.manager, taskId);
  return taskId;
}

describe("subagent_continue — 输入校验", () => {
  it("空 / 非 string task_id → ToolExecutionError", async () => {
    const { manager } = makeManagerHarness();
    const tool = createSubAgentContinueTool({ manager });
    await assert.rejects(
      () =>
        Promise.resolve(
          tool.handler(
            { task_id: "", message: "next" },
            { conversationId: "c1" }
          )
        ),
      ToolExecutionError
    );
    await assert.rejects(
      () =>
        Promise.resolve(
          tool.handler(
            { task_id: 123, message: "next" },
            { conversationId: "c1" }
          )
        ),
      ToolExecutionError
    );
    await assert.rejects(
      () => Promise.resolve(tool.handler(null)),
      ToolExecutionError
    );
  });

  it("空 / 非 string message → ToolExecutionError", async () => {
    const { manager } = makeManagerHarness();
    const tool = createSubAgentContinueTool({ manager });
    await assert.rejects(
      () =>
        Promise.resolve(
          tool.handler({ task_id: "t", message: "" }, { conversationId: "c1" })
        ),
      ToolExecutionError
    );
    await assert.rejects(
      () =>
        Promise.resolve(
          tool.handler({ task_id: "t", message: 42 }, { conversationId: "c1" })
        ),
      ToolExecutionError
    );
  });
});

describe("subagent_continue — 拒绝分支（锁句 4：闸 = 进程已死 + 有账）", () => {
  it("未知 task_id → typed 拒（无新进程）", async () => {
    const { manager, invocations } = makeManagerHarness();
    const tool = createSubAgentContinueTool({ manager });
    await assert.rejects(
      () =>
        Promise.resolve(
          tool.handler(
            { task_id: "no-such-task", message: "again" },
            { conversationId: "c1" }
          )
        ),
      ToolExecutionError
    );
    assert.equal(invocations.length, 0);
  });

  it("running 拒 —— 不往 in-flight loop 塞话，无新进程", async () => {
    const { manager, invocations } = makeManagerHarness();
    const tool = createSubAgentContinueTool({ manager });
    const { taskId } = manager.spawn({
      task: "long-running",
      conversationId: "c1",
    } as SubAgentDefinition);
    await assert.rejects(
      () =>
        Promise.resolve(
          tool.handler(
            { task_id: taskId, message: "pivot" },
            { conversationId: "c1" }
          )
        ),
      (err: unknown) => {
        assert.ok(err instanceof ToolExecutionError);
        assert.match(err.message, /running/);
        return true;
      }
    );
    assert.equal(invocations.length, 1);
  });

  it("终态但无工人 transcript → 拒（切片前的旧工人）", async () => {
    const harness = makeManagerHarness();
    const { manager, invocations } = harness;
    const tool = createSubAgentContinueTool({ manager });
    const taskId = await spawnCompleted(harness, {
      task: "legacy",
      conversationId: "c1",
    } as SubAgentDefinition);
    await assert.rejects(
      () =>
        Promise.resolve(
          tool.handler(
            { task_id: taskId, message: "follow-up" },
            { conversationId: "c1" }
          )
        ),
      (err: unknown) => {
        assert.ok(err instanceof ToolExecutionError);
        assert.match(err.message, /no_transcript/);
        return true;
      }
    );
    assert.equal(invocations.length, 1);
  });

  it("per-agent trace 在场不算账 —— 不从 trace 倒灌（锁句 6）", async () => {
    const harness = makeManagerHarness();
    const { manager, subagentsDir } = harness;
    const tool = createSubAgentContinueTool({ manager });
    const taskId = await spawnCompleted(harness, {
      task: "traced",
      conversationId: "c1",
    } as SubAgentDefinition);
    // Write only the trace form (agent-<taskId>.jsonl), not the transcript (<taskId>.jsonl).
    mkdirSync(join(subagentsDir, taskId), { recursive: true });
    writeFileSync(
      join(subagentsDir, taskId, `agent-${taskId}.jsonl`),
      "{}\n",
      "utf8"
    );
    await assert.rejects(
      () =>
        Promise.resolve(
          tool.handler(
            { task_id: taskId, message: "continue" },
            { conversationId: "c1" }
          )
        ),
      (err: unknown) => {
        assert.ok(err instanceof ToolExecutionError);
        assert.match(err.message, /no_transcript/);
        return true;
      }
    );
  });

  it("跨会话拒 —— 所有权判定先于任何再拉起", async () => {
    const harness = makeManagerHarness();
    const { manager, writeTranscript, invocations } = harness;
    const tool = createSubAgentContinueTool({ manager });
    const taskId = await spawnCompleted(harness, {
      task: "owned",
      conversationId: "conv-owner",
    } as SubAgentDefinition);
    writeTranscript(taskId);
    await assert.rejects(
      () =>
        Promise.resolve(
          tool.handler(
            { task_id: taskId, message: "hijack" },
            { conversationId: "conv-thief" }
          )
        ),
      (err: unknown) => {
        assert.ok(err instanceof ToolExecutionError);
        assert.match(err.message, /out_of_scope/);
        return true;
      }
    );
    // A call surface without ctx.conversationId likewise must not touch an owned ledger.
    await assert.rejects(
      () =>
        Promise.resolve(tool.handler({ task_id: taskId, message: "hijack" })),
      ToolExecutionError
    );
    assert.equal(invocations.length, 1);
  });

  it("manager 闸防御面：task 缺失 / 空串 → missing_task typed 抛，不起新进程", async () => {
    const harness = makeManagerHarness();
    const taskId = await spawnCompleted(harness, {
      task: "gate",
      conversationId: "c1",
    } as SubAgentDefinition);
    harness.writeTranscript(taskId);
    const resume = harness.manager.resumeTask!;
    for (const next of [{}, { task: "" }] as SubAgentDefinition[]) {
      assert.throws(
        () => resume(taskId, next),
        (err: unknown) => {
          assert.ok(err instanceof SubAgentResumeError);
          assert.equal(err.kind, "missing_task");
          assert.equal(err.taskId, taskId);
          return true;
        }
      );
    }
    // rejection paths consume no quota and launch no process.
    assert.equal(harness.invocations.length, 1);
  });

  it("并发顶与 spawn 同源：满 → capacity 拒，不起新进程（锁句 5）", async () => {
    const harness = makeManagerHarness({ maxConcurrentWorkers: 1 });
    const tool = createSubAgentContinueTool({ manager: harness.manager });
    const done = await spawnCompleted(harness, {
      task: "first",
      conversationId: "c1",
    } as SubAgentDefinition);
    harness.writeTranscript(done);
    // fill the only quota slot: a second worker is running.
    harness.manager.spawn({
      task: "occupier",
      conversationId: "c1",
    } as SubAgentDefinition);
    await assert.rejects(
      () =>
        Promise.resolve(
          tool.handler(
            { task_id: done, message: "more" },
            { conversationId: "c1" }
          )
        ),
      (err: unknown) => {
        assert.ok(err instanceof ToolExecutionError);
        assert.match(err.message, /capacity/i);
        return true;
      }
    );
    // two spawns, no third launch via resume.
    assert.equal(harness.invocations.length, 2);
  });
});

describe("subagent_continue — 死工人续跑（新进程、同句柄）", () => {
  it("uses the current parent's thinking snapshot for the resumed worker", async () => {
    const harness = makeManagerHarness();
    const originalThinking = { mode: "off", effort: "low" } as const;
    const currentThinking = { mode: "adaptive", effort: "high" } as const;
    const taskId = await spawnCompleted(harness, {
      task: "original",
      conversationId: "c1",
      parentThinking: originalThinking,
    } as SubAgentDefinition);
    harness.writeTranscript(taskId);
    const tool = createSubAgentContinueTool({ manager: harness.manager });
    const ctx = {
      conversationId: "c1",
      parentThinking: currentThinking,
    } as unknown as ToolExecutionContext;

    try {
      await tool.handler(
        {
          task_id: taskId,
          message: "continue with current reasoning",
          wait: false,
        },
        ctx
      );

      const resumed = harness.invocations[1]!;
      assert.equal(resumed.taskId, taskId);
      assert.deepEqual(
        (
          resumed.payload as WorkerEnvelope & {
            readonly parentThinking?: unknown;
          }
        ).parentThinking,
        currentThinking
      );
    } finally {
      const resumed = harness.invocations[1];
      if (resumed !== undefined) {
        emitOkEnvelope(resumed.child, "resumed");
        await waitForTerminal(harness.manager, taskId);
      }
      await harness.manager.shutdown();
      rmSync(harness.subagentsDir, { recursive: true, force: true });
    }
  });

  it("completed + transcript + 下一句（wait:false）→ 同 task_id 新进程，payload 指向同一本账", async () => {
    const harness = makeManagerHarness();
    const tool = createSubAgentContinueTool({ manager: harness.manager });
    const taskId = await spawnCompleted(harness, {
      task: "original",
      conversationId: "c1",
    } as SubAgentDefinition);
    harness.writeTranscript(taskId);
    const firstPayload = harness.invocations[0]!.payload;

    const out = JSON.parse(
      (await tool.handler(
        { task_id: taskId, message: "next sentence", wait: false },
        { conversationId: "c1", turnId: "turn-2", toolUseId: "toolu-2" }
      )) as string
    ) as Record<string, unknown>;
    assert.deepEqual(out, { task_id: taskId });

    assert.equal(harness.invocations.length, 2);
    const second = harness.invocations[1]!;
    assert.equal(second.taskId, taskId); // external handle unchanged (ADR-0102 Decision 4)
    assert.equal(second.payload.task, "next sentence");
    assert.equal(second.payload.transcriptPath, firstPayload.transcriptPath);
    assert.equal(second.payload.role, firstPayload.role);
    // the old terminal state is replaced by the new record: the handle now runs a fresh process.
    assert.equal(harness.manager.queryBuffer(taskId).status, "running");

    // The background arm's terminal state enters host drain as usual (no stale foreground
    // exclusion bit — resumeDefinition recomputes it).
    emitOkEnvelope(second.child, "resumed done");
    await waitForTerminal(harness.manager, taskId);
    const drained = harness.manager.drainCompleted("c1");
    assert.deepEqual(
      drained.map((d) => d.taskId),
      [taskId]
    );
  });

  it("failed 终态一视同仁：被停/崩掉的工人同样可续", async () => {
    const harness = makeManagerHarness();
    const tool = createSubAgentContinueTool({ manager: harness.manager });
    const { taskId } = harness.manager.spawn({
      task: "dies",
      conversationId: "c1",
    } as SubAgentDefinition);
    harness.invocations[0]!.child.kill("SIGTERM");
    await waitForTerminal(harness.manager, taskId);
    assert.equal(harness.manager.queryBuffer(taskId).status, "failed");
    harness.writeTranscript(taskId);

    await tool.handler(
      { task_id: taskId, message: "retry with sharper scope", wait: false },
      { conversationId: "c1" }
    );
    assert.equal(harness.invocations.length, 2);
    assert.equal(harness.invocations[1]!.taskId, taskId);
  });

  it("failed(modelTransient) + transcript 在场 → 闸放行续跑（ADR-0102 Decision 1：闸只认寿命与账，不看 reason）", async () => {
    // ADR-0111 Consequences: modelTransient landing in failed state uses the ADR-0102
    // channel, no new mechanism needed — this test pins the gate passing naturally
    // (the gate itself is unchanged).
    const harness = makeManagerHarness();
    const tool = createSubAgentContinueTool({ manager: harness.manager });
    const { taskId } = harness.manager.spawn({
      task: "transient victim",
      conversationId: "c1",
    } as SubAgentDefinition);
    const first = harness.invocations[0]!.child;
    first.stdout.write(
      JSON.stringify({
        status: "failed",
        reason: "modelTransient",
        summary: "",
        result: "",
      }) + "\n"
    );
    first.emit("exit", 0, null);
    await waitForTerminal(harness.manager, taskId);
    const q = harness.manager.queryBuffer(taskId);
    assert.equal(q.status, "failed");
    if (q.status === "failed") assert.equal(q.reason, "modelTransient");
    harness.writeTranscript(taskId);

    await tool.handler(
      { task_id: taskId, message: "carry on after the blip", wait: false },
      { conversationId: "c1" }
    );
    assert.equal(harness.invocations.length, 2);
    assert.equal(harness.invocations[1]!.taskId, taskId);
    assert.equal(
      harness.invocations[1]!.payload.task,
      "carry on after the blip"
    );
  });

  it("身份沿用原 def，回合字段按本跳重算", async () => {
    const harness = makeManagerHarness();
    const tool = createSubAgentContinueTool({ manager: harness.manager });
    const taskId = await spawnCompleted(harness, {
      task: "identity",
      conversationId: "c1",
      role: "explore",
      maxTurns: 7,
      parentTurnId: "turn-1",
      toolUseId: "toolu-1",
      excludeFromHostDrain: true,
    } as SubAgentDefinition);
    harness.writeTranscript(taskId);
    await tool.handler(
      { task_id: taskId, message: "deeper please", wait: false },
      { conversationId: "c1", turnId: "turn-9", toolUseId: "toolu-9" }
    );
    const nextDef = harness.invocations[1]!.def;
    // identity and capability fields = the original catalog role re-run()
    assert.equal(nextDef.role, "explore");
    assert.equal(nextDef.maxTurns, 7);
    assert.equal(nextDef.conversationId, "c1");
    assert.equal(nextDef.task, "deeper please");
    // turn fields take new values; the previous hop's foreground exclusion bit does not linger (background wait:false).
    assert.equal(nextDef.parentTurnId, "turn-9");
    assert.equal(nextDef.toolUseId, "toolu-9");
    assert.notEqual(nextDef.excludeFromHostDrain, true);
  });

  it("前景臂（省略 wait）当跳返回投影信封", async () => {
    const harness = makeManagerHarness();
    const tool = createSubAgentContinueTool({ manager: harness.manager });
    const taskId = await spawnCompleted(harness, {
      task: "fg",
      conversationId: "c1",
    } as SubAgentDefinition);
    harness.writeTranscript(taskId);

    const pending = tool.handler(
      { task_id: taskId, message: "one more thing" },
      { conversationId: "c1" }
    );
    const second = harness.invocations[1]!;
    emitOkEnvelope(second.child, "continued answer");
    const envelope = (await pending) as SubAgentEnvelope;
    assert.equal(envelope.status, "ok");
    assert.equal(envelope.result, "continued answer");
    // foreground-hop delivery → terminal state excluded from host drain (same mutual-exclusion contract as spawn).
    await waitForTerminal(harness.manager, taskId);
    assert.deepEqual(
      harness.manager.drainCompleted("c1").map((d) => d.taskId),
      []
    );
    assert.equal(harness.invocations[1]!.def.excludeFromHostDrain, true);
  });
});

describe("subagent_continue — AciToolDef 元数据", () => {
  it("name/description/schema/aci 形态（装配镜像 spawn 的等待契约）", () => {
    const { manager } = makeManagerHarness();
    const tool = createSubAgentContinueTool({ manager });
    assert.equal(tool.name, "subagent_continue");
    assert.ok(tool.description.length > 0);
    assert.ok(Object.isFrozen(tool));
    const schema = tool.inputSchema as {
      required: string[];
      additionalProperties: boolean;
      properties: Record<string, { type: string }>;
    };
    assert.deepEqual(schema.required, ["task_id", "message"]);
    assert.equal(schema.additionalProperties, false);
    assert.equal(schema.properties.task_id.type, "string");
    assert.equal(schema.properties.message.type, "string");
    assert.equal(schema.properties.wait.type, "boolean");
    assert.equal(tool.aci.lazy, false);
    assert.equal(tool.aci.timeoutTier, "unbounded");
    assert.equal(tool.aci.isConcurrencySafe, true);
    assert.equal(tool.aci.interruptBehavior, "cancel");
  });
});
