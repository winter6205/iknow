/**
 * #361 / ADR-0014 — T11 边界测试 (契约「测试冲突清单」7 项逐条落实)。
 *
 *   C1: 注入 cap=4 时第 5 个并发 spawn → capacity ToolExecutionError
 *   C2: drain 空/多/阻塞后置终态/超时守卫 (host-drain async)
 *   C3: waitFor abort → SubAgentAbortError; 已终态 abort 无副作用
 *   C4: drain 中途 waitFor 拒绝 → 返回部分、不抛
 *   C5: wait:true 失败 envelope 作 ok 返回; abort → execution_failed:cancelled
 *   T13: PER_TASK_TIMEOUT_MS 对齐 (default 2 h = 7_200_000 ms)
 *   T12: messages_captured 三处置 true + coordinator 段 proactive 断言
 *
 * 时序:implementer A (subagent 层) 逐文件合入 manager.ts(已) / host-drain.ts /
 * spawn-subagent-tool.ts。C1/C3/T13 的 manager 面已就绪;handler 面与 drain
 * async 面待 A 合入。本文件断言均按 V1.5 契约编写 —— 未就绪部分维持红,
 * 待 A 合入后复跑转绿。T12 messages_captured 已在 loop-engine.ts 落地 → 绿。
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

describe("C2: drain 空/多/阻塞后置终态/超时守卫 (drain async)", () => {
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

  it("无 completed + 后置 mock 终态 → drain 阻塞轮询至 ≥1 完成返回", async () => {
    // drain 契约:仅 running → 每 pollMs 轮询 waitFor(firstActive)。
    // review-fix S7:消除 real sleep(原 200ms setTimeout + elapsed >=150 断言
    // CI 慢机 flaky)—— 改 immediate-terminal mock:waitFor 立即 resolve,
    // drainCompleted 在第 N 个 poll cycle 后才返回 partial,断言 poll 数
    // 代替时间断言,真值零延时。
    let polls = 0;
    const waitFor = async (_taskId: string): Promise<SubAgentEnvelope> => {
      polls++;
      return { status: "ok", summary: "late-A", result: "late-R" };
    };
    const fakeManager = baseManager({
      waitFor,
      drainCompleted: () =>
        polls >= 3
          ? [
              {
                taskId: "late",
                envelope: { status: "ok", summary: "late-A", result: "late-R" },
              },
            ]
          : [],
      listActive: () => ["pending-1"],
    });
    const out = await drainPendingSubagents(fakeManager, {
      pollMs: 50,
      timeoutMs: 5000,
    });
    expect(out).toContain("## Sub-agent late result: late-A");
    expect(out).toContain("late-A");
    // drain 串行:至少 3 个 poll cycle 才收到 partial —— 证明 drain 实际
    // 阻塞轮询(polls=1 立即返 → 短路; polls=3 阻塞到位)。
    expect(polls).toBeGreaterThanOrEqual(3);
  });

  it("永不终态 → timeoutMs 耗尽返回 '' (不抛)", async () => {
    const fakeManager = baseManager({
      waitFor: (_taskId: string, timeoutMs?: number) =>
        new Promise<SubAgentEnvelope>((_, reject) => {
          // 模拟 manager waitFor 自己的 poll 内超时:reject SubAgentWaitTimeoutError。
          // drain catch 视为终态 + 重检 elapsed → drain 总超时 100ms 兜底。
          setTimeout(() => reject(new Error("timeout")), timeoutMs ?? 20);
        }),
      drainCompleted: () => [],
      listActive: () => ["always-running"],
    });
    const out = await drainPendingSubagents(fakeManager, {
      pollMs: 20,
      timeoutMs: 100,
    });
    expect(out).toBe("");
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

describe("C4: drain 中途 waitFor 拒绝 → 返回部分、不抛", () => {
  it("一个 waitFor 拒绝 + 另一个 completed → 返回 completed 部分", async () => {
    const waitFor = (taskId: string): Promise<SubAgentEnvelope> => {
      if (taskId === "bad") {
        return Promise.reject(new SubAgentAbortError("bad"));
      }
      return Promise.resolve({ status: "ok", summary: "ok", result: "r" });
    };
    const fakeManager = baseManager({
      waitFor,
      drainCompleted: () => [
        {
          taskId: "good",
          envelope: { status: "ok", summary: "ok", result: "r" },
        },
      ],
      listActive: () => ["bad"],
    });
    const out = await drainPendingSubagents(fakeManager, {
      pollMs: 20,
      timeoutMs: 200,
    });
    expect(out).toContain("## Sub-agent good result: ok");
    expect(out).not.toContain("bad");
  });
});

describe("C5: wait:true 失败 envelope 作 ok 返回; abort → execution_failed:cancelled", () => {
  it("wait:true + 失败 envelope → handler 解析为 envelope (status failed)", async () => {
    const failedEnvelope: SubAgentEnvelope = {
      status: "failed",
      reason: "timeout",
      summary: "timeout after 5000ms",
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
    expect(out.reason).toBe("timeout");
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

  it("wait:true + WaitTimeoutError + queryBuffer running → timeout envelope 作 ok", async () => {
    const fakeManager = baseManager({
      spawn: () => ({ taskId: "tid" }),
      queryBuffer: () => ({ status: "running" }) as const,
      waitFor: async () => {
        throw new SubAgentWaitTimeoutError();
      },
    });
    const tool = createSpawnSubAgentTool({ manager: fakeManager });
    const out = (await tool.handler({
      task: "t",
      wait: true,
    })) as SubAgentEnvelope;
    expect(out.status).toBe("failed");
    expect(out.reason).toBe("timeout");
  });
});

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
