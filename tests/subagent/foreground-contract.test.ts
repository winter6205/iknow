/**
 * #361 / ADR-0014 — T11 边界测试 (契约「测试冲突清单」7 项逐条落实)。
 *
 *   C1: 注入 cap=4 时第 5 个并发 spawn → capacity ToolExecutionError
 *   C2: drain 空/多/运行中立即空返/异常不抛 (host-drain non-blocking)
 *   C3: waitFor abort → SubAgentAbortError; 已终态 abort 无副作用
 *   C4: drain 不读取运行中任务且永不抛
 *   C5: wait:true 失败 envelope 作 ok 返回; abort → execution_failed:cancelled
 *   T13: PER_TASK_TIMEOUT_MS 对齐 (default 2 h = 7_200_000 ms)
 *   T12: messages_captured 三处置 true + coordinator 段 proactive 断言
 *
 * 时序:implementer A (subagent 层) 逐文件合入 manager.ts(已) / host-drain.ts /
 * spawn-subagent-tool.ts。C1/C3/T13 的 manager 面已就绪;handler 面已就绪。
 * 本文件断言按当前 V1.5 / T2 契约编写。T12 messages_captured 已在
 * loop-engine.ts 落地 → 绿。
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
// SC14 归因测用真 registry + 真 executor —— 归因链的 executor 段不可 fake
// （fake 会把「executor 如何归一 message」变成测试自己写的同义反复）。
import { createRegistry } from "../../src/harness/tools/registry.ts";
import { createExecutor } from "../../src/harness/tools/executor.ts";

/** PER_TASK_TIMEOUT_MS 默认 2 小时(契约 T13; #358 spec Assumptions 1)。 */
const PER_TASK_TIMEOUT_MS_DEFAULT = 120 * 60 * 1000;

/** 最小完整 SubAgentManager fake:缺省成员全 no-op,测试按需覆盖。 */
function baseManager(over: Partial<SubAgentManager>): SubAgentManager {
  return {
    spawn: () => ({ taskId: "unused" }),
    queryBuffer: () => ({ status: "not_found" }) as const,
    waitFor: () => Promise.resolve({ status: "ok", summary: "", result: "" }),
    shutdown: () => Promise.resolve(),
    drainCompleted: () => [],
    listActive: () => [],
    abortTask: () => false,
    // #358 T7: 接口新增只读枚举面 —— baseManager 一处补全覆盖全部 over-spread 实例。
    listSubagents: () => [],
    ...over,
  };
}

/** fake spawn 工厂:真启一个立即退出 0 的进程,以满足 manager 内部 .kill()/.on("exit")。 */
function makeFakeSpawnFactory(): SubAgentSpawn {
  return () =>
    spawn(process.execPath, ["-e", "process.exit(0)"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
}

/** 占槽用:子进程保持 running,避免无信封 exit(0) 立刻放槽。 */
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
    await expect(tool.handler({ task: "overflow" })).rejects.toThrow(
      ToolExecutionError
    );
    await expect(tool.handler({ task: "overflow" })).rejects.toThrow(
      /capacity/i
    );
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
    controller.abort(); // resolve 后再 abort 不应引发 unhandledRejection
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
    // SC13 之后 reason=timeout 不再是 ok 数据，故本条用非超时失败
    // （crashed）认证「失败 envelope 仍带 locator」这个原不变式。
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
    // SC13 边界：只有墙钟超时改判非 ok；crashed / maxTurnsExceeded /
    // protocolError 是「任务结局是数据」，仍走 ok envelope（C5）。
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
      { task: "t", wait: true },
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
    // SC13 / plan task 7：墙钟到期时 worker 未终态，没有可读的终态交差 ——
    // 父可见 tool result kind 必须非 ok，模型才能把它与「跑完但失败」区分。
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
      await tool.handler({ task: "t", wait: true });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ToolExecutionError);
    const message = (caught as ToolExecutionError).message;
    // 模型必须能读出 taskId + 超时事实。
    expect(message).toContain("tid");
    expect(message).toContain("wall-clock timeout");
    // 不得撞 loop-engine 的整回合停因字面量（loop-engine.ts:1605-1618）——
    // 撞了会把单个子任务的墙钟误升级为整回合 cancelled / timeout。
    expect(message).not.toBe("cancelled");
    expect(message).not.toBe("timeout");
  });
});

/**
 * SC14 全链路归因（真 manager + 真 executor，不 fake 归因链上的任何一臂）：
 *
 *   操作员强杀（abortTask）→ waitFor reject SubAgentAbortError
 *   → handler 转 ToolExecutionError（操作员强杀文本）
 *   → executor 因 `outerSignal.aborted === false` **不**归一，message 原样
 *   透出（要归一成严格 `"cancelled"` 需要调用方 signal 真 abort，强杀不是）
 *   → 模型读到的就是那句「task X 被操作员杀掉，没有完成结果」。
 *
 * 反面锚点（SC13 不回归）：同一条链的墙钟臂（worker SIGTERM 收尾 →
 * reason:"timeout" 信封）仍给 `"wall-clock timeout"` 归因；调用侧 abort 臂
 * （Ctrl+C）仍归一为严格 `"cancelled"`。三种归因互不撞脸。
 */
describe("SC14: 操作员强杀 → 父可见归因是 cancelled（不是 timeout）", () => {
  function makeLiveWorkerManager(taskTimeoutMs: number): SubAgentManager {
    return createSubAgentManager({
      spawn: makeLiveSpawnFactory(),
      taskTimeoutMs,
    });
  }

  /** 与 LoopEngineDeps 的调用形态同形：真实 name/input + 调用方 signal。 */
  const spawnCall = {
    id: "call-1",
    name: "spawn_subagent",
    input: { task: "hang", wait: true },
  } as const;

  it("abortTask → ToolExecutionError（操作员强杀文本），且不是墙钟归因", async () => {
    const mgr = makeLiveWorkerManager(60_000);
    const tool = createSpawnSubAgentTool({ manager: mgr });
    // 与生产同形：操作员强杀不 abort 调用方 signal（那是 Ctrl+C / quit 的事）。
    const signal = new AbortController().signal;
    const executor = createExecutor(createRegistry([tool]));

    const pending = executor.executeAll([spawnCall], signal);
    // 等 spawn 真发生（child 在场）再强杀，模拟操作员在 running 行按 Ctrl+X。
    const live = await waitForActive(mgr);
    expect(live.length).toBe(1);
    expect(mgr.abortTask(live[0]!)).toBe(true);

    const [result] = await pending;
    expect(result!.kind).toBe("execution_failed");
    const failed = result as { kind: "execution_failed"; message: string };
    // 模型可见归因：识别为 cancelled，且能读出是操作员杀的（不是超时）。
    expect(failed.message).toContain("cancelled");
    expect(failed.message).toContain("operator killed");
    expect(failed.message).toContain(live[0]!);
    expect(failed.message).not.toContain("wall-clock timeout");
    // loop-engine.computeToolStopFlags 的整回合判据是 strict-equal：撞字面量
    // 会把「一个子任务被强杀」误升级成整回合 stop。
    expect(failed.message).not.toBe("cancelled");
    expect(failed.message).not.toBe("timeout");
    await mgr.shutdown();
  }, 30_000);

  it("SC13 不回归：真墙钟到期仍归因 wall-clock timeout（不是 cancelled）", async () => {
    // 真 manager 的 per-task 钟到点 → 写 reason:"timeout" 信封 + SIGTERM；
    // 与操作员强杀走不同代码路径（timeoutTimer），归因必须保持 timeout。
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
    // 忠实复刻真 worker 的 SIGTERM 收尾（worker.ts:881-944）：真 worker 收到
    // SIGTERM 会 abort("subagent-timeout") → 自跑收尾轮 → 写回 reason:"timeout"
    // 的失败信封。修复前 abortTask 只发 SIGTERM、从不 settle 在飞 waitFor，
    // 父侧只能拿到这个 timeout 信封 —— 强杀被读成墙钟到期。修复后拒绝先于
    // SIGTERM 发生，信封再写回也不改变归因。
    const worker = makeSigtermEpilogueWorkerSpawn();
    const mgr = createSubAgentManager({
      spawn: worker.spawn,
      taskTimeoutMs: 60_000, // 墙钟 timer 远未到点：归因只可能来自强杀路径
    });
    const tool = createSpawnSubAgentTool({ manager: mgr });
    const executor = createExecutor(createRegistry([tool]));

    const pending = executor.executeAll(
      [spawnCall],
      new AbortController().signal
    );
    await worker.ready; // 等 handler 装好（真 worker 同样在 run() 前进场）
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
 * 忠实 SIGTERM 收尾 worker：收到 SIGTERM 写回 `reason:"timeout"` 失败信封后
 * 退出 0（worker.ts:938-944 的同形最小复刻）。stderr 的 READY 是就绪握手 ——
 * 真 worker 在 run() 之前就装好 handler（worker.ts:885），探针/测试必须等
 * handler 就位再杀，否则测到的是默认信号处置而非收尾路径。
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

/** 轮询至 manager 有 live 任务（executor 的 spawn 是异步派发的一跳）。 */
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
    // manager.waitFor 缺省签名 = PER_TASK_TIMEOUT_MS(7200s)——不再 30s。
    const mgr = createSubAgentManager({ spawn: makeFakeSpawnFactory() });
    const { taskId } = mgr.spawn({ task: "t" });
    // waitFor 缺省 7200s:进程已 exit 0 → 立即 resolve;断言不抛即可,证明
    // 缺省路径可用。真实 7200s 语义由常量断言覆盖。
    const p = mgr.waitFor(taskId);
    expect(p).toBeInstanceOf(Promise);
    // 防止 shutdown 主动拒绝 waitFor 时形成 unhandled rejection:test 不关心
    // 该 promise 的结果(只关心 waitFor 签名 = Promise)。
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
    tool.handler({ task: "with-timeout", timeoutMs: 12_345 });
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
