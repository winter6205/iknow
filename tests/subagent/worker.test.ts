import assert from "node:assert/strict";
import { describe, it, vi } from "vitest";
import { createStubModel } from "../../src/harness/stubs/stub-model.ts";
import { createStubTool } from "../../src/harness/stubs/stub-tool.ts";
import { createRegistry } from "../../src/harness/tools/registry.ts";
import { createExecutor } from "../../src/harness/tools/executor.ts";
import {
  buildThinkingParams,
  createRealAnthropicAdapter,
} from "../../src/harness/model-adapter/anthropic-adapter.ts";
import { ProtocolError } from "../../src/harness/errors.ts";
import {
  applyEnvelopeOverrides,
  createWorkerDeps,
  runWorkerOnce,
  toFailedEnvelope,
  toOkEnvelope,
  type CreateWorkerDepsOptions,
} from "../../src/harness/subagent/worker.ts";
import { createSkillCatalog } from "../../src/harness/skill/catalog.ts";
import { createNoopTraceService } from "../../src/harness/trace/noop.ts";
import type {
  SubAgentEnvelope,
  WorkerEnvelope,
} from "../../src/harness/subagent/envelope.ts";
import { assistantResult } from "../cli/_fixtures.ts";
import type { LoopEngineDeps } from "../../src/harness/loop-engine.ts";
import type { IknowEnv } from "../../src/config/env.ts";

/** 测试用 minimal IknowEnv — createWorkerDeps 路径类型要求, 不真发请求。 */
const TEST_ENV: IknowEnv = {
  llm: {
    apiKey: "test-key",
    baseUrl: "https://example.test",
    model: "test-model",
    fallback: [],
    maxOutputTokens: 1024,
    temperature: 0,
    stream: "off",
    thinking: { type: "disabled" },
    maxTurns: undefined,
    timeoutMs: undefined,
  },
  web: { proxy: undefined, searchUrl: undefined },
  compress: { contextWindow: 200000, thresholdTokens: undefined },
  chat: { showThinking: false, quiet: false },
};

/** 构造 stub-model + LoopEngineDeps。registry/executor 占位 (run 路径需要 list/get)；
 *  system/promptTools 必须是函数形态 (loop-engine:509 promptTools?.()). */
function makeDeps(adapter: LoopEngineDeps["adapter"]): LoopEngineDeps {
  return {
    adapter,
    executor: undefined as never,
    registry: {
      list: () => [],
      get: () => undefined,
    },
    system: () => undefined,
    promptTools: () => [],
  } as unknown as LoopEngineDeps;
}

/** 构造 minimal RunResult for toOkEnvelope 直接验证。 */
function fakeResult(finalText: string | null) {
  return {
    finalText,
    lastUsage: null,
    messages: [],
    stopReason: "completed" as const,
    turnCount: 1,
  };
}

// ---------------------------------------------------------------------------
// A. envelope 派生纯函数 (toOkEnvelope / toFailedEnvelope) — 直接覆盖
// ---------------------------------------------------------------------------

describe("subagent worker: toOkEnvelope (envelope 派生 / SC2 / SC10)", () => {
  it("finalText 透传 → summary === result === finalText", () => {
    const env = toOkEnvelope(fakeResult("hello"));
    assert.equal(env.status, "ok");
    assert.equal(env.summary, "hello");
    assert.equal(env.result, "hello");
    assert.equal(env.reason, undefined);
    assert.equal(env.truncated, undefined);
  });

  it("finalText = null → result 空串 (浓缩兜底, 父 drain 不挂)", () => {
    const env = toOkEnvelope(fakeResult(null));
    assert.equal(env.status, "ok");
    assert.equal(env.summary, "");
    assert.equal(env.result, "");
  });

  it("SC10: result 超 20000 → 截断为短交差且保持成功状态", async () => {
    const big = "y".repeat(25000);
    // 直接调 truncateEnvelopeResult 验证 (与 envelope.ts 行为对齐)
    const { truncateEnvelopeResult } =
      await import("../../src/harness/subagent/envelope.ts");
    const env = toOkEnvelope(fakeResult(big));
    const truncated = truncateEnvelopeResult(env);
    assert.equal(truncated.status, "ok");
    assert.equal(truncated.truncated, true);
    assert.equal(truncated.totalLength, 25000);
    assert.ok(truncated.summary.length < big.length);
    assert.ok(truncated.result.length < 20000);
    assert.notEqual(truncated.result, big);
    assert.match(truncated.result, /report folded/);
    assert.equal(truncated.stop_reason, "completed");
  });

  it("SC10 边界: result 恰好 20000 → 不截断", async () => {
    const { truncateEnvelopeResult } =
      await import("../../src/harness/subagent/envelope.ts");
    const exact = "z".repeat(20000);
    const env = toOkEnvelope(fakeResult(exact));
    const out = truncateEnvelopeResult(env);
    assert.equal(out.truncated, undefined);
    assert.equal(out.totalLength, undefined);
    assert.equal(out.result.length, 20000);
  });
});

describe("subagent worker: toFailedEnvelope (SC6 reason 四值)", () => {
  it("reason = crashed → status=failed, summary/result 空", () => {
    const env = toFailedEnvelope("crashed");
    assert.equal(env.status, "failed");
    assert.equal(env.reason, "crashed");
    assert.equal(env.summary, "");
    assert.equal(env.result, "");
  });

  it("reason = maxTurnsExceeded", () => {
    const env = toFailedEnvelope("maxTurnsExceeded");
    assert.equal(env.reason, "maxTurnsExceeded");
  });

  it("reason = timeout", () => {
    const env = toFailedEnvelope("timeout");
    assert.equal(env.reason, "timeout");
  });

  it("reason = protocolError", () => {
    const env = toFailedEnvelope("protocolError");
    assert.equal(env.reason, "protocolError");
  });
});

// ---------------------------------------------------------------------------
// B. runWorkerOnce 集成测试 — stub-model 走真 loop-engine 短链 (单 step)
//    单测只覆盖最小语义: stub 给 ok → ok envelope / stub 给空 queue →
//    ProtocolError → failed envelope。
// ---------------------------------------------------------------------------

describe("subagent worker: runWorkerOnce 端到端 (stub-model + 全 deps)", () => {
  const baseEnvelope: WorkerEnvelope = {
    task: "investigate X",
    sandboxRoot: "/tmp/sb",
  };

  it("OK 路径: stub-model 给一条 ok 回应 → envelope status=ok", async () => {
    const adapter = createStubModel({
      responses: [assistantResult({ texts: ["investigation complete"] })],
    });
    const env = await runWorkerOnce({
      workerEnvelope: baseEnvelope,
      deps: makeDeps(adapter),
    });
    assert.equal(env.status, "ok");
    assert.equal(env.result, "investigation complete");
    assert.equal(env.summary, "investigation complete");
  });

  it("SC10: stub 给超长文本 → runWorkerOnce 端到端截断", async () => {
    const big = "y".repeat(25000);
    const adapter = createStubModel({
      responses: [assistantResult({ texts: [big] })],
    });
    const env = await runWorkerOnce({
      workerEnvelope: baseEnvelope,
      deps: makeDeps(adapter),
    });
    assert.equal(env.status, "ok");
    assert.equal(env.truncated, true);
    assert.equal(env.totalLength, 25000);
  });

  it("SC6 protocolError: stub queue 耗尽 → run() 抛 ProtocolError → envelope status=failed, reason=protocolError", async () => {
    // responses:[] → stub.step() 立即抛 ProtocolError "responses exhausted"
    // runWorkerOnce 捕到 → toFailedEnvelope("protocolError")
    const adapter = createStubModel({ responses: [] });
    const env = await runWorkerOnce({
      workerEnvelope: baseEnvelope,
      deps: makeDeps(adapter),
    });
    assert.equal(env.status, "failed");
    assert.equal(env.reason, "protocolError");
  });

  it("672 SC: stopReason fused → failed envelope, not ok", async () => {
    const boom = createStubTool({
      name: "boom",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: { n: { type: "number" } },
        required: ["n"],
      },
      next: () => {
        throw new Error("same boom");
      },
    });
    const registry = createRegistry([boom]);
    const responses = [] as ReturnType<typeof assistantResult>[];
    for (let i = 0; i < 8; i += 1) {
      responses.push(
        assistantResult({
          texts: [],
          toolCalls: [{ id: `call_${i}`, name: "boom", input: { n: 1 } }],
        })
      );
    }
    responses.push(
      assistantResult({
        texts: ["done"],
        toolCalls: [],
        supplierStop: "success",
      })
    );
    const env = await runWorkerOnce({
      workerEnvelope: { task: "go", sandboxRoot: "/tmp/sb" },
      deps: {
        adapter: createStubModel({ responses }),
        executor: createExecutor(registry),
        registry,
        maxTurns: 20,
      },
    });
    assert.equal(env.status, "failed");
    assert.equal(env.reason, "protocolError");
    assert.equal(env.summary, "fused");
  });

  it("workerEnvelope.maxTurns 字段透传 (不影响 envelope 内容)", async () => {
    const adapter = createStubModel({
      responses: [assistantResult({ texts: ["ok"] })],
    });
    const env = await runWorkerOnce({
      workerEnvelope: { ...baseEnvelope, maxTurns: 7 },
      deps: makeDeps(adapter),
    });
    assert.equal(env.status, "ok");
    assert.equal(env.result, "ok");
  });
});

// ---------------------------------------------------------------------------
// G. #358 T2 / D8: applyEnvelopeOverrides + runWorkerOnce 的 per-call 隔离
//    deps.timeoutMs 只能来自 env (createWorkerDeps 侧), 绝不从 spawn 的
//    per-task timeoutMs 渗入 —— 否则一次正常 LLM 调用会按任务寿命竞速
//    (per-call 保护失效 / 显式小值误杀)。
// ---------------------------------------------------------------------------

describe("subagent worker: applyEnvelopeOverrides (D8 per-call 隔离, SC5)", () => {
  const baseEnvelope: WorkerEnvelope = {
    task: "investigate X",
    sandboxRoot: "/tmp/sb",
  };

  it("envelope 携带 timeoutMs → deps.timeoutMs 不变 (只处理 maxTurns)", () => {
    const deps = makeDeps(
      createStubModel({ responses: [assistantResult({ texts: ["ok"] })] })
    );
    const out = applyEnvelopeOverrides(
      { ...baseEnvelope, maxTurns: 7, timeoutMs: 999_999 },
      deps
    );
    assert.equal(out.timeoutMs, deps.timeoutMs, "timeoutMs 不被 envelope 覆盖");
    // 仅 maxTurns 生效, 其余字段逐位保留 (spread 守卫)
    assert.equal(out.maxTurns, 7);
    assert.equal(out.adapter, deps.adapter);
    assert.equal(out.registry, deps.registry);
  });

  it("envelope 无 maxTurns/timeoutMs → 原 deps 引用不变 (零覆盖)", () => {
    const deps = makeDeps(
      createStubModel({ responses: [assistantResult({ texts: ["ok"] })] })
    );
    const out = applyEnvelopeOverrides(baseEnvelope, deps);
    assert.equal(out, deps, "无覆盖时应返回同一 deps 引用");
  });

  it("仅 timeoutMs 无 maxTurns → deps 原引用不变 (timeoutMs 完全不在覆盖面)", () => {
    const deps = makeDeps(
      createStubModel({ responses: [assistantResult({ texts: ["ok"] })] })
    );
    const out = applyEnvelopeOverrides({ ...baseEnvelope, timeoutMs: 1 }, deps);
    assert.equal(out, deps, "timeoutMs 单独出现不触发任何对象重建");
  });

  it("runWorkerOnce 端到端: envelope timeoutMs:1 + 宽松 deps.timeoutMs → 正常完成 (旧 spread 会在 1ms 竞速超时)", async () => {
    vi.useFakeTimers();
    try {
      // 单条 ok 回应:NEW 路径由正常 step 消费 (完成); OLD 路径 1ms 竞速
      // 超时 → 该回应被 epilogue 摘要消费 → finalText null → result ""。
      const adapter = createStubModel({
        responses: [assistantResult({ texts: ["complete"] })],
        delayMs: 200,
      });
      const p = runWorkerOnce({
        workerEnvelope: { ...baseEnvelope, timeoutMs: 1 },
        // deps.timeoutMs 宽松 (60s) — envelope.timeoutMs=1 是 per-task 寿命,
        // 渗入 per-call 竞速会杀掉这次正常调用 (D8)。
        deps: { ...makeDeps(adapter), timeoutMs: 60_000 },
      });
      // 让 run 的初始微任务 (system?.() / raceModel 计时器注册) 先落盘
      await Promise.resolve();
      await Promise.resolve();
      // 推进 300ms:NEW 下 200ms 步完成;OLD 下 1ms 竞速超时 + 摘要延时收敛
      await vi.advanceTimersByTimeAsync(300);
      const env = await p;
      assert.equal(env.status, "ok");
      assert.equal(env.result, "complete", "per-call 竞速不被信封寿命覆盖");
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// C. parseWorkerEnvelope 失败 → ProtocolError 上抛 (SC13) — worker.ts 透传
// ---------------------------------------------------------------------------

describe("subagent worker: parseWorkerEnvelope 失败 → ProtocolError 上抛 (SC13)", () => {
  it("空字符串 → ProtocolError", async () => {
    const { parseWorkerEnvelope } =
      await import("../../src/harness/subagent/envelope.ts");
    assert.throws(
      () => parseWorkerEnvelope(""),
      (err: unknown) => err instanceof ProtocolError
    );
  });

  it("缺 task 必填 → ProtocolError", async () => {
    const { parseWorkerEnvelope } =
      await import("../../src/harness/subagent/envelope.ts");
    assert.throws(
      () => parseWorkerEnvelope(JSON.stringify({ sandboxRoot: "/tmp/sb" })),
      (err: unknown) => err instanceof ProtocolError
    );
  });
});

// ---------------------------------------------------------------------------
// D. buildThinkingParams + createRealAnthropicAdapter seam (轻量 type sanity)
// ---------------------------------------------------------------------------

describe("subagent worker: buildThinkingParams + adapter seam (type sanity)", () => {
  it("buildThinkingParams(thinking.type=disabled) 映射为 {effort: undefined, mode:{type:'disabled'}}", () => {
    const params = buildThinkingParams(TEST_ENV.llm);
    assert.deepEqual(params, { effort: undefined, mode: { type: "disabled" } });
  });

  it("createRealAnthropicAdapter 不会因 env.llm.stream=off 抛错 (model seam 形态)", () => {
    const client = {
      messages: { create: () => Promise.resolve({}) },
    } as unknown as Parameters<typeof createRealAnthropicAdapter>[0]["client"];
    const adapter = createRealAnthropicAdapter({
      client,
      model: TEST_ENV.llm.model,
      maxTokens: TEST_ENV.llm.maxOutputTokens,
      temperature: TEST_ENV.llm.temperature,
      thinking: { type: "disabled" },
      stream: false,
    });
    assert.equal(typeof adapter.step, "function");
  });
});

// ---------------------------------------------------------------------------
// E. CreateWorkerDepsOptions 类型契约 (不下沉到装配路径)
// ---------------------------------------------------------------------------

describe("subagent worker: CreateWorkerDepsOptions seam 字段 (类型契约)", () => {
  it("opts 必须 env + sandboxRoot, 其余 seam 字段可选", () => {
    const opts: CreateWorkerDepsOptions = {
      env: TEST_ENV,
      sandboxRoot: "/tmp/sb",
    };
    assert.equal(opts.env.llm.maxTurns, undefined);
    assert.equal(opts.sandboxRoot, "/tmp/sb");
  });

  it("env.llm 的 idle / hard-cap 双钟透传到 worker loop deps", async () => {
    const deps = await createWorkerDeps({
      env: {
        ...TEST_ENV,
        llm: {
          ...TEST_ENV.llm,
          idleTimeoutMs: 12_345,
          hardCapMs: 67_890,
        },
      },
      sandboxRoot: "/tmp/sb",
      model: createStubModel({ responses: [] }),
      skillCatalog: createSkillCatalog([]),
      system: () => undefined,
      trace: createNoopTraceService(),
    });

    assert.equal(deps.modelIdleTimeoutMs, 12_345);
    assert.equal(deps.modelHardCapMs, 67_890);
  });
});

// ---------------------------------------------------------------------------
// F. #468 disallowedTools 消费 — worker 装配期把 deny-list 透传给
//    createDefaultAciRegistry, 声明工具面 = 实际工具面 (inner + visibleSchemas
//    双面断言)。不真发 LLM / 不写盘 / 不扫 fs —— 用 stub-model + noop trace +
//    空 skill catalog 保持 hermetic。
// ---------------------------------------------------------------------------

describe("subagent worker: #468 disallowedTools 透传 createDefaultAciRegistry (声明面 = 实际面)", () => {
  /** hermetic 装配缝: stub-model (零模型调用) + 空 skill catalog + noop trace。 */
  function hermeticOpts(
    extra?: Partial<CreateWorkerDepsOptions>
  ): CreateWorkerDepsOptions {
    return {
      env: TEST_ENV,
      sandboxRoot: "/tmp/sb",
      model: createStubModel({ responses: [] }),
      skillCatalog: createSkillCatalog([]),
      system: () => undefined,
      trace: createNoopTraceService(),
      ...extra,
    };
  }

  it("deny 5 禁项 → inner.list() 与 promptTools() 双面均无 bash/edit_file/write_file/web_fetch/web_search, 保留 read_file/grep/glob", async () => {
    const deps = await createWorkerDeps(
      hermeticOpts({
        disallowedTools: [
          "bash",
          "edit_file",
          "write_file",
          "web_fetch",
          "web_search",
        ],
      })
    );
    const innerNames = deps.registry.list().map((t) => t.name);
    const promptNames = deps.promptTools().map((t) => t.name);
    for (const denied of [
      "bash",
      "edit_file",
      "write_file",
      "web_fetch",
      "web_search",
    ]) {
      assert.ok(!innerNames.includes(denied), `inner.list() 不应含 ${denied}`);
      assert.ok(
        !promptNames.includes(denied),
        `promptTools() 不应含 ${denied}`
      );
    }
    for (const kept of ["read_file", "grep", "glob"]) {
      assert.ok(innerNames.includes(kept), `inner.list() 应含 ${kept}`);
      assert.ok(promptNames.includes(kept), `promptTools() 应含 ${kept}`);
    }
  });

  it("向后兼容: 不传 disallowedTools → 全量面不裁剪 (无 subagentManager → spawn_subagent 缺席, 其余工具俱在)", async () => {
    const deps = await createWorkerDeps(hermeticOpts());
    const innerNames = deps.registry.list().map((t) => t.name);
    const promptNames = deps.promptTools().map((t) => t.name);
    assert.ok(
      innerNames.includes("bash"),
      "inner.list() 应含 bash (未声明 deny-list)"
    );
    assert.ok(
      promptNames.includes("bash"),
      "promptTools() 应含 bash (未声明 deny-list)"
    );
    assert.ok(
      !innerNames.includes("spawn_subagent"),
      "worker 无 subagentManager → spawn_subagent 缺席"
    );
  });
});
