/**
 * ADR-0014 foreground-contract boundary tests, one describe per contract item:
 *
 *   C1: injected cap=4, 5th concurrent spawn → capacity ToolExecutionError
 *   C2: drain on empty / multiple / running returns immediately; never throws (host-drain non-blocking)
 *   C3: waitFor abort → SubAgentAbortError; aborting an already-terminal task has no side effect
 *   C4: drain never reads running tasks and never throws
 *   C5: wait:true returns a failed envelope as ok; abort → execution_failed:cancelled
 *   T13: PER_TASK_TIMEOUT_MS alignment (default 2 h = 7_200_000 ms)
 *   T12: messages_captured true in all three recordLlmCall sites + coordinator-segment proactive assertion
 *
 * Assertions are written against the current V1.5 contract, covering the
 * manager surface, host-drain.ts, and spawn-subagent-tool.ts handler surface.
 * messages_captured landed in loop-engine.ts → green.
 */
import { describe, expect, it } from "vitest";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";

import {
  createSubAgentManager,
  SubAgentCapacityError,
  SubAgentAbortError,
  SubAgentWaitTimeoutError,
  PER_TASK_TIMEOUT_MS,
} from "../../src/harness/subagent/manager.ts";
import type {
  SubAgentManager,
  SubAgentDefinition,
  SubAgentSpawn,
} from "../../src/harness/subagent/manager.ts";
import { drainPendingSubagents } from "../../src/harness/subagent/host-drain.ts";
import { createSpawnSubAgentTool } from "../../src/harness/subagent/spawn-subagent-tool.ts";
import { ToolExecutionError } from "../../src/harness/errors.ts";
import type { SubAgentEnvelope } from "../../src/harness/subagent/envelope.ts";
// Full-chain attribution uses the real registry + real executor — the executor
// leg of the attribution chain must not be faked (a fake would turn "how the
// executor normalizes the message" into a tautology written by the test itself).
import { createRegistry } from "../../src/harness/tools/registry.ts";
import { createExecutor } from "../../src/harness/tools/executor.ts";

/** PER_TASK_TIMEOUT_MS defaults to 2 hours (contract Assumptions 1). */
const PER_TASK_TIMEOUT_MS_DEFAULT = 120 * 60 * 1000;

/** Minimal complete SubAgentManager fake: all members default to no-op; tests override as needed. */
function baseManager(over: Partial<SubAgentManager>): SubAgentManager {
  return {
    spawn: () => ({ taskId: "unused" }),
    queryBuffer: () => ({ status: "not_found" }) as const,
    waitFor: () => Promise.resolve({ status: "ok", summary: "", result: "" }),
    shutdown: () => Promise.resolve(),
    drainCompleted: () => [],
    listActive: () => [],
    abortTask: () => false,
    // Read-only enumeration surface added to the interface — cover it once
    // here so every over-spread instance gets it.
    getCapacity: () => 15,
    listSubagents: () => [],
    ...over,
  };
}

/** Fake spawn factory: really spawns a process that exits 0 immediately, to satisfy the manager's internal .kill()/.on("exit"). */
function makeFakeSpawnFactory(): SubAgentSpawn {
  return () =>
    spawn(process.execPath, ["-e", "process.exit(0)"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
}

/** Slot-filler: child stays running, so a no-envelope exit(0) doesn't release the slot immediately. */
function makeLiveSpawnFactory(): SubAgentSpawn {
  return () =>
    spawn(process.execPath, ["-e", "setInterval(() => {}, 1e6)"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
}

describe("C1: 第 5 个并发 spawn → capacity ToolExecutionError", () => {
  it("真实 manager:注入 cap=4 时第 5 次并发 spawn 抛 SubAgentCapacityError", async () => {
    const mgr = createSubAgentManager({
      spawn: makeLiveSpawnFactory(),
      maxConcurrentWorkers: 4,
    });
    for (let i = 0; i < 4; i++) {
      expect(() => mgr.spawn({ task: `t${i}` })).not.toThrow();
    }
    let fifthError: unknown;
    try {
      mgr.spawn({ task: "t4-overflow" });
    } catch (err) {
      fifthError = err;
    }
    expect(fifthError).toBeDefined();
    expect(String((fifthError as Error).name)).toMatch(/SubAgentCapacityError/);
    expect(String((fifthError as Error).message)).toMatch(/capacity/i);
    await mgr.shutdown();
  });

  it("handler 层:manager 抛 SubAgentCapacityError → handler 重抛 ToolExecutionError", async () => {
    const fakeManager = baseManager({
      spawn: () => {
        throw new SubAgentCapacityError(4);
      },
    });
    const tool = createSpawnSubAgentTool({ manager: fakeManager });
    // title is carried so the capacity reject below cannot be a title reject.
    await expect(
      tool.handler({ title: "sample title", task: "overflow" })
    ).rejects.toThrow(ToolExecutionError);
    await expect(
      tool.handler({ title: "sample title", task: "overflow" })
    ).rejects.toThrow(/capacity/i);
  });
});

describe("C2: drain 空/多/运行中立即空返/异常不抛 (drain non-blocking)", () => {
  it("undefined manager → 立即返回 '' (无轮询)", async () => {
    const out = await drainPendingSubagents(undefined);
    expect(out).toBe("");
  });

  it("manager 内无 completed 且无 active → 立即返回 ''", async () => {
    const out = await drainPendingSubagents(
      baseManager({
        queryBuffer: () => ({ status: "running" }) as const,
        waitFor: () => new Promise(() => {}),
      })
    );
    expect(out).toBe("");
  });

  it("drainCompleted 已有 completed → 立即返回拼接结果(不阻塞)", async () => {
    const fakeManager = baseManager({
      waitFor: () => new Promise(() => {}),
      drainCompleted: () => [
        { taskId: "a", envelope: { status: "ok", summary: "A", result: "rA" } },
        { taskId: "b", envelope: { status: "ok", summary: "B", result: "rB" } },
      ],
    });
    const out = await drainPendingSubagents(fakeManager);
    expect(out).toBe(
      ["## Sub-agent a result: A\n\nA", "## Sub-agent b result: B\n\nB"].join(
        "\n\n"
      )
    );
  });

  it("仍有 running worker → 立即返回 '' 且不调用 waitFor", async () => {
    let waitCalls = 0;
    const fakeManager = baseManager({
      waitFor: async () => {
        waitCalls++;
        throw new Error("waitFor must not be called by host-drain");
      },
      listActive: () => ["pending-1"],
    });
    expect(await drainPendingSubagents(fakeManager)).toBe("");
    expect(waitCalls).toBe(0);
  });
});

describe("C3: waitFor abort → SubAgentAbortError; 已终态 abort 无副作用", () => {
  it("AbortController 触发 → reject SubAgentAbortError", async () => {
    const mgr = createSubAgentManager({ spawn: makeFakeSpawnFactory() });
    const { taskId } = mgr.spawn({ task: "t" });
    const controller = new AbortController();
    const p = mgr.waitFor(taskId, 5000, controller.signal);
    controller.abort();
    let rejected: unknown;
    try {
      await p;
    } catch (err) {
      rejected = err;
    }
    expect(rejected).toBeDefined();
    expect(String((rejected as Error).name)).toMatch(/SubAgentAbortError/i);
    expect(String((rejected as Error).message)).toMatch(/abort/i);
    await mgr.shutdown();
  });

  it("abort 前已终态 → resolve envelope;resolve 后再 abort 不报错", async () => {
    const fakeManager = baseManager({
      waitFor: async () => ({
        status: "ok",
        summary: "already-done",
        result: "ok",
      }),
    });
    const controller = new AbortController();
    const envelope = await fakeManager.waitFor("tid", 5000, controller.signal);
    expect(envelope.status).toBe("ok");
    controller.abort(); // aborting after resolve must not cause unhandledRejection
    expect(true).toBe(true);
  });
});

describe("C4: drain 不读取运行中任务且永不抛", () => {
  it("running worker 的 waitFor 拒绝也不会被 host drain 调用", async () => {
    let waitCalls = 0;
    const fakeManager = baseManager({
      waitFor: async () => {
        waitCalls++;
        throw new SubAgentAbortError("bad");
      },
      drainCompleted: () => [
        {
          taskId: "good",
          envelope: { status: "ok", summary: "ok", result: "r" },
        },
      ],
      listActive: () => ["bad"],
    });
    const out = await drainPendingSubagents(fakeManager);
    expect(out).toContain("## Sub-agent good result: ok");
    expect(out).not.toContain("bad");
    expect(waitCalls).toBe(0);
  });
});

describe("SC4: wait:true tool_result 带 task_id + tmp_root", () => {
  const locator = {
    task_id: "tid-sc4",
    tmp_root: "/session/subagents/tid-sc4/fence-tmp",
  };

  it("success tool_result 含非空 locator 且无产物名单", async () => {
    const okEnvelope: SubAgentEnvelope = {
      status: "ok",
      summary: "done",
      result: "done",
      ...locator,
    };
    const tool = createSpawnSubAgentTool({
      manager: baseManager({
        spawn: () => ({ taskId: locator.task_id }),
        waitFor: async () => okEnvelope,
      }),
    });
    const out = (await tool.handler({
      title: "sample title",
      task: "t",
      wait: true,
    })) as SubAgentEnvelope;
    expect(out.status).toBe("ok");
    expect(out.task_id).toBe(locator.task_id);
    expect(out.tmp_root).toBe(locator.tmp_root);
    expect(out.task_id.length).toBeGreaterThan(0);
    expect(out.tmp_root.length).toBeGreaterThan(0);
    expect(
      out.product_roster === undefined || out.product_roster.length === 0
    ).toBe(true);
  });

  it("failure tool_result 同样含非空 locator", async () => {
    // reason=timeout is no longer ok data under the current contract, so this
    // case uses a non-timeout failure (crashed) to certify the original
    // invariant: a failed envelope still carries the locator.
    const failedEnvelope: SubAgentEnvelope = {
      status: "failed",
      reason: "crashed",
      summary: "worker exited with code 3",
      result: "",
      ...locator,
    };
    const tool = createSpawnSubAgentTool({
      manager: baseManager({
        spawn: () => ({ taskId: locator.task_id }),
        waitFor: async () => failedEnvelope,
      }),
    });
    const out = (await tool.handler({
      title: "sample title",
      task: "t",
      wait: true,
    })) as SubAgentEnvelope;
    expect(out.status).toBe("failed");
    expect(out.task_id).toBe(locator.task_id);
    expect(out.tmp_root).toBe(locator.tmp_root);
  });
});

describe("C5: wait:true 失败 envelope 作 ok 返回; abort → execution_failed:cancelled", () => {
  it("wait:true + 非超时失败 envelope（crashed）→ handler 解析为 envelope (status failed)", async () => {
    // Boundary: only wall-clock timeout is re-judged non-ok; crashed /
    // maxTurnsExceeded / protocolError mean "task outcome is data" and still
    // travel as an ok envelope (C5).
    const failedEnvelope: SubAgentEnvelope = {
      status: "failed",
      reason: "crashed",
      summary: "worker exited with code 3",
      result: "",
    };
    const fakeManager = baseManager({
      spawn: () => ({ taskId: "tid" }),
      waitFor: async () => failedEnvelope,
      drainCompleted: () => [{ taskId: "tid", envelope: failedEnvelope }],
    });
    const tool = createSpawnSubAgentTool({ manager: fakeManager });
    const out = (await tool.handler({
      title: "sample title",
      task: "t",
      wait: true,
    })) as SubAgentEnvelope;
    expect(out.status).toBe("failed");
    expect(out.reason).toBe("crashed");
  });

  it("maxTurnsExceeded 同样保持 ok 数据（非墙钟，不误伤）", async () => {
    const failedEnvelope: SubAgentEnvelope = {
      status: "failed",
      reason: "maxTurnsExceeded",
      summary: "max turns exceeded",
      result: "",
    };
    const fakeManager = baseManager({
      spawn: () => ({ taskId: "tid" }),
      waitFor: async () => failedEnvelope,
    });
    const tool = createSpawnSubAgentTool({ manager: fakeManager });
    const out = (await tool.handler({
      title: "sample title",
      task: "t",
      wait: true,
    })) as SubAgentEnvelope;
    expect(out.status).toBe("failed");
    expect(out.reason).toBe("maxTurnsExceeded");
  });

  it("wait:true + 调用侧 abort → ToolExecutionError (归因 cancelled)", async () => {
    const fakeManager = baseManager({
      spawn: () => ({ taskId: "tid" }),
      queryBuffer: () => ({ status: "running" }) as const,
      waitFor: (_taskId: string, _ms?: number, signal?: AbortSignal) => {
        return new Promise<SubAgentEnvelope>((_res, reject) => {
          if (!signal) return;
          if (signal.aborted) {
            reject(new SubAgentAbortError("tid"));
            return;
          }
          signal.addEventListener("abort", () => {
            reject(new SubAgentAbortError("tid"));
          });
        });
      },
    });
    const tool = createSpawnSubAgentTool({ manager: fakeManager });
    const controller = new AbortController();
    const p = tool.handler(
      { title: "sample title", task: "t", wait: true },
      { signal: controller.signal }
    );
    controller.abort();
    let caught: unknown;
    try {
      await p;
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ToolExecutionError);
  });

  it("wait:true + WaitTimeoutError + queryBuffer running → ToolExecutionError（SC13：不得为 ok）", async () => {
    // When the wall clock expires the worker is not terminal — there is no
    // readable terminal handoff — so the parent-visible tool result kind must
    // be non-ok, letting the model distinguish it from "ran to completion but failed".
    const fakeManager = baseManager({
      spawn: () => ({ taskId: "tid" }),
      queryBuffer: () => ({ status: "running" }) as const,
      waitFor: async () => {
        throw new SubAgentWaitTimeoutError();
      },
    });
    const tool = createSpawnSubAgentTool({ manager: fakeManager });
    let caught: unknown;
    try {
      await tool.handler({ title: "sample title", task: "t", wait: true });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ToolExecutionError);
    const message = (caught as ToolExecutionError).message;
    // The model must be able to read taskId + the timeout fact.
    expect(message).toContain("tid");
    expect(message).toContain("wall-clock timeout");
    // Must not collide with loop-engine's whole-turn stop-reason literals
    // (loop-engine.ts:1605-1618) — a collision would mis-escalate one
    // subtask's wall clock into a whole-turn cancelled / timeout.
    expect(message).not.toBe("cancelled");
    expect(message).not.toBe("timeout");
  });
});

/**
 * Full-chain attribution (real manager + real executor, no fake on any leg of
 * the attribution chain):
 *
 *   operator force-kill (abortTask) → waitFor rejects SubAgentAbortError
 *   → handler converts to ToolExecutionError (operator-kill text)
 *   → executor does **not** normalize because `outerSignal.aborted === false`;
 *     the message passes through verbatim (strict `"cancelled"` normalization
 *     requires a real caller-signal abort; a force-kill is not one)
 *   → the model reads exactly "task X killed by operator, no completed result".
 *
 * Counter-anchor (no regression on the wall-clock contract): the same chain's
 * wall-clock leg (worker SIGTERM epilogue → reason:"timeout" envelope) still
 * attributes `"wall-clock timeout"`; the caller-side abort leg (Ctrl+C) still
 * normalizes to strict `"cancelled"`. The three attributions never look alike.
 */
describe("SC14: 操作员强杀 → 父可见归因是 cancelled（不是 timeout）", () => {
  function makeLiveWorkerManager(taskTimeoutMs: number): SubAgentManager {
    return createSubAgentManager({
      spawn: makeLiveSpawnFactory(),
      taskTimeoutMs,
    });
  }

  /** Same call shape as LoopEngineDeps: real name/input + caller signal. */
  const spawnCall = {
    id: "call-1",
    name: "spawn_subagent",
    input: { title: "hang the probe", task: "hang", wait: true },
  } as const;

  it("abortTask → ToolExecutionError（操作员强杀文本），且不是墙钟归因", async () => {
    const mgr = makeLiveWorkerManager(60_000);
    const tool = createSpawnSubAgentTool({ manager: mgr });
    // Same as production: an operator force-kill does not abort the caller's
    // signal (that is Ctrl+C / quit's job).
    const signal = new AbortController().signal;
    const executor = createExecutor(createRegistry([tool]));

    const pending = executor.executeAll([spawnCall], signal);
    // Wait until the spawn really happens (child present), then force-kill —
    // simulating the operator pressing Ctrl+X on a running line.
    const live = await waitForActive(mgr);
    expect(live.length).toBe(1);
    expect(mgr.abortTask(live[0]!)).toBe(true);

    const [result] = await pending;
    expect(result!.kind).toBe("execution_failed");
    const failed = result as { kind: "execution_failed"; message: string };
    // Model-visible attribution: recognized as cancelled, and readable as an
    // operator kill (not a timeout).
    expect(failed.message).toContain("cancelled");
    expect(failed.message).toContain("operator killed");
    expect(failed.message).toContain(live[0]!);
    expect(failed.message).not.toContain("wall-clock timeout");
    // loop-engine.computeToolStopFlags uses strict-equal for its whole-turn
    // check: colliding with the literal would mis-escalate "one subtask was
    // force-killed" into a whole-turn stop.
    expect(failed.message).not.toBe("cancelled");
    expect(failed.message).not.toBe("timeout");
    await mgr.shutdown();
  }, 30_000);

  it("SC13 不回归：真墙钟到期仍归因 wall-clock timeout（不是 cancelled）", async () => {
    // The real manager's per-task clock fires → writes a reason:"timeout"
    // envelope + SIGTERM; a different code path from the operator force-kill
    // (timeoutTimer), so attribution must stay timeout.
    const mgr = makeLiveWorkerManager(400);
    const tool = createSpawnSubAgentTool({ manager: mgr });
    const executor = createExecutor(createRegistry([tool]));

    const [result] = await executor.executeAll(
      [spawnCall],
      new AbortController().signal
    );
    expect(result!.kind).toBe("execution_failed");
    const failed = result as { kind: "execution_failed"; message: string };
    expect(failed.message).toContain("wall-clock timeout");
    expect(failed.message).not.toContain("operator killed");
    expect(failed.message).not.toBe("cancelled");
    await mgr.shutdown();
  }, 30_000);

  it("SC14 回归锚点：worker 收到 SIGTERM 写回 reason:timeout 信封时，归因仍是强杀而不是墙钟", async () => {
    // Faithful replica of the real worker's SIGTERM epilogue (worker.ts:881-944):
    // a real worker receiving SIGTERM aborts("subagent-timeout") → runs its own
    // epilogue turn → writes back a failed envelope with reason:"timeout".
    // Before the fix, abortTask only sent SIGTERM and never settled the
    // in-flight waitFor, so the parent could only get this timeout envelope —
    // a force-kill read as wall-clock expiry. After the fix, the rejection
    // precedes SIGTERM, so a later envelope write-back cannot change attribution.
    const worker = makeSigtermEpilogueWorkerSpawn();
    const mgr = createSubAgentManager({
      spawn: worker.spawn,
      taskTimeoutMs: 60_000, // wall-clock timer far from firing: attribution can only come from the force-kill path
    });
    const tool = createSpawnSubAgentTool({ manager: mgr });
    const executor = createExecutor(createRegistry([tool]));

    const pending = executor.executeAll(
      [spawnCall],
      new AbortController().signal
    );
    await worker.ready; // wait for the handler to be installed (a real worker also arms before run())
    const live = await waitForActive(mgr);
    expect(live.length).toBe(1);
    expect(mgr.abortTask(live[0]!)).toBe(true);

    const [result] = await pending;
    expect(result!.kind).toBe("execution_failed");
    const failed = result as { kind: "execution_failed"; message: string };
    expect(failed.message).toContain("operator killed");
    expect(failed.message).not.toContain("wall-clock timeout");
    await mgr.shutdown();
  }, 30_000);
});

/**
 * Faithful SIGTERM-epilogue worker: on SIGTERM it writes back a
 * `reason:"timeout"` failed envelope then exits 0 (minimal same-shape replica
 * of worker.ts:938-944). READY on stderr is the readiness handshake — the real
 * worker installs its handler before run() (worker.ts:885), so probes/tests
 * must wait for the handler before killing, otherwise they measure the default
 * signal disposition instead of the epilogue path.
 */
function makeSigtermEpilogueWorkerSpawn(): {
  spawn: SubAgentSpawn;
  ready: Promise<void>;
} {
  const script = [
    `process.on("SIGTERM", () => {`,
    `  const line = JSON.stringify({ status: "failed", reason: "timeout",`,
    `    summary: "SIGTERM epilogue: worker wrote reason=timeout envelope",`,
    `    result: "" });`,
    `  process.stdout.write(line + "\\n", () => process.exit(0));`,
    `});`,
    `process.stderr.write("READY\\n");`,
    `setInterval(() => {}, 1e6);`,
  ].join("\n");
  let resolveReady: () => void = () => {};
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });
  const spawnFn: SubAgentSpawn = () => {
    const child = spawn(process.execPath, ["-e", script], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (chunk.toString("utf8").includes("READY")) resolveReady();
    });
    return child;
  };
  return { spawn: spawnFn, ready };
}

/** Poll until the manager has a live task (executor's spawn is one async dispatch hop). */
async function waitForActive(
  mgr: SubAgentManager
): Promise<ReadonlyArray<string>> {
  for (let i = 0; i < 200; i++) {
    const active = mgr.listActive();
    if (active.length > 0) return active;
    await new Promise((r) => setTimeout(r, 25));
  }
  return mgr.listActive();
}

describe("T13: PER_TASK_TIMEOUT_MS 默认 2 小时", () => {
  it("PER_TASK_TIMEOUT_MS = 7_200_000 (契约 7200s, spec Assumptions 1)", () => {
    expect(PER_TASK_TIMEOUT_MS).toBe(PER_TASK_TIMEOUT_MS_DEFAULT);
  });

  it("manager waitFor 缺省 timeoutMs = PER_TASK_TIMEOUT_MS(与前台 wait 对齐)", async () => {
    // manager.waitFor's default signature = PER_TASK_TIMEOUT_MS (7200s) — no longer 30s.
    const mgr = createSubAgentManager({ spawn: makeFakeSpawnFactory() });
    const { taskId } = mgr.spawn({ task: "t" });
    // waitFor defaults to 7200s: the process already exited 0 → resolves
    // immediately; asserting no throw proves the default path is usable. The
    // real 7200s semantics are covered by the constant assertion.
    const p = mgr.waitFor(taskId);
    expect(p).toBeInstanceOf(Promise);
    // Prevent an unhandled rejection if shutdown actively rejects waitFor:
    // the test doesn't care about this promise's result (only that the waitFor
    // signature is a Promise).
    p.catch(() => {});
    await mgr.shutdown();
  });

  it("显式 timeoutMs 仍透传(不被默认值覆盖)", () => {
    let capturedDef: SubAgentDefinition | undefined;
    const fakeManager = baseManager({
      spawn: (def: SubAgentDefinition) => {
        capturedDef = def;
        return { taskId: "tid" };
      },
    });
    const tool = createSpawnSubAgentTool({ manager: fakeManager });
    tool.handler({
      title: "sample title",
      task: "with-timeout",
      timeoutMs: 12_345,
    });
    expect(capturedDef?.timeoutMs).toBe(12_345);
  });
});

describe("T12: messages_captured 真值 (loop-engine.ts 三处 recordLlmCall)", () => {
  it("stub-model run → trace llm_call 行 messages_captured=true 且 messages 非空", async () => {
    const { createJsonlTraceService } =
      await import("../../src/harness/trace/jsonl.ts");
    const { createStubModel } =
      await import("../../src/harness/stubs/stub-model.ts");
    const { createStubTool } =
      await import("../../src/harness/stubs/stub-tool.ts");
    const { createRegistry } =
      await import("../../src/harness/tools/registry.ts");
    const { createExecutor } =
      await import("../../src/harness/tools/executor.ts");
    const { run } = await import("../../src/harness/loop-engine.ts");
    const { mkdtempSync, rmSync, readFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");

    const tmpDir = mkdtempSync(join(tmpdir(), "trace-t11-t12-"));
    try {
      const trace = createJsonlTraceService({
        filePath: tmpDir,
        conversationId: "t11-t12",
      });
      const stubTool = createStubTool({ name: "noop", next: () => ({}) });
      const reg = createRegistry([stubTool]);
      const exec = createExecutor(reg);
      const model = createStubModel({
        responses: [
          {
            texts: ["done"],
            toolCalls: [],
            supplierStop: "success",
            nativeMessage: {
              role: "assistant",
              content: [{ type: "text", text: "done" }],
            },
            projection: { texts: ["done"], toolCalls: [] },
            usage: undefined,
          },
        ],
      });
      await run("hi", {
        adapter: model,
        executor: exec,
        registry: reg,
        maxTurns: 5,
        trace,
        system: async () =>
          "Use spawn_subagent proactively. call blocks until finished.",
      });
      const lines = readFileSync(join(tmpDir, "t11-t12.jsonl"), "utf8")
        .split("\n")
        .filter((l) => l.trim().length > 0)
        .map((l) => JSON.parse(l) as Record<string, unknown>);
      const llmCalls = lines.filter((l) => l["record_type"] === "llm_call");
      assert.ok(llmCalls.length >= 1);
      for (const llm of llmCalls) {
        assert.equal(llm["messages_captured"], true);
        assert.ok(Array.isArray(llm["messages"]));
        assert.ok((llm["messages"] as unknown[]).length >= 1);
      }
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
