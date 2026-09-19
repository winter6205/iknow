import assert from "node:assert/strict";
import { describe, it, vi } from "vitest";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * specs/tui-model-command SC9：worker 的 client 构造（未注入 `model` 时的
 * 默认分支）把 `env.llm.headers` 透传为 SDK `defaultHeaders`，缺席不传该键。
 *
 * 观测手段 = 子类化真实 Anthropic（不是替身）：`createWorkerDeps` 不把 client
 * 交回调用方，构造参数是唯一可观察面；继承真类保证 `new Anthropic(...)` 的
 * 其余行为（含 key/baseURL）不受影响。默认 `opts.model` 注入的用例走 stub，
 * 不经过本记录器 —— 既有装配语义不变。
 */
const anthropicCtorOpts = vi.hoisted(
  () => [] as Array<Record<string, unknown>>
);
vi.mock("@anthropic-ai/sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@anthropic-ai/sdk")>();
  class CapturingAnthropic extends actual.default {
    constructor(opts?: Record<string, unknown>) {
      super(opts as never);
      anthropicCtorOpts.push(opts ?? {});
    }
  }
  return { ...actual, default: CapturingAnthropic };
});

import { createStubModel } from "../../src/harness/stubs/stub-model.ts";
import { createStubTool } from "../../src/harness/stubs/stub-tool.ts";
import { createRegistry } from "../../src/harness/tools/registry.ts";
import { createExecutor } from "../../src/harness/tools/executor.ts";
import {
  buildThinkingParams,
  createRealAnthropicAdapter,
} from "../../src/harness/model-adapter/anthropic-adapter.ts";
import {
  MaxTurnsExceeded,
  ModelStreamIncompleteError,
  ProtocolError,
  TransportRetryExhaustedError,
} from "../../src/harness/errors.ts";
import {
  applyEnvelopeOverrides,
  createWorkerDeps,
  runWorkerOnce,
  toFailedEnvelope,
  toOkEnvelope,
  type CreateWorkerDepsOptions,
} from "../../src/harness/subagent/worker.ts";
import { createSkillCatalog } from "../../src/harness/skill/catalog.ts";
import { getAgentEntry } from "../../src/harness/subagent/catalog.ts";
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

  it("SC10 边界: result 恰好 20000 → IPC 不截断，父可见层仍短交差", async () => {
    const { truncateEnvelopeResult, projectParentVisibleEnvelope } =
      await import("../../src/harness/subagent/envelope.ts");
    const exact = "z".repeat(20000);
    const env = toOkEnvelope(fakeResult(exact));
    const ipc = truncateEnvelopeResult(env);
    assert.equal(ipc.result.length, 20000);
    assert.equal(ipc.truncated, undefined);
    const parent = projectParentVisibleEnvelope(env);
    assert.equal(parent.truncated, true);
    assert.notEqual(parent.result, exact);
    assert.ok(parent.result.length < 20000);
  });
});

describe("subagent worker: toFailedEnvelope (SC6 reason 五值, ADR-0111 修订 SC9)", () => {
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

  it("reason = modelTransient (ADR-0111 Decision 2 第五值)", () => {
    const env = toFailedEnvelope("modelTransient");
    assert.equal(env.status, "failed");
    assert.equal(env.reason, "modelTransient");
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
// B2. ADR-0111 T4 — protocolError 收口支的 apiError 分流 (Decision 2(a)) 与
//     run() 逃逸 catch 的子类排序 (Decision 2(b))。
//     不变式 (Decision 2(c)): RunResult.apiError 在场 ⇔ 带 cause 的瞬时模型
//     流/传输失败 → 父侧拿到 modelTransient 而非 protocolError。
// ---------------------------------------------------------------------------

function adapterStepThrowing(err: unknown): LoopEngineDeps["adapter"] {
  const stub = createStubModel({ responses: [] });
  return {
    ...stub,
    step: (async () => {
      throw err;
    }) as typeof stub.step,
  } as unknown as LoopEngineDeps["adapter"];
}

function adapterEncodeUserTextThrowing(
  err: unknown
): LoopEngineDeps["adapter"] {
  const stub = createStubModel({
    responses: [assistantResult({ texts: ["never reached"] })],
  });
  return {
    ...stub,
    encodeUserText: (() => {
      throw err;
    }) as typeof stub.encodeUserText,
  } as unknown as LoopEngineDeps["adapter"];
}

const SDK_STREAM_SHAPE = new Error(
  "stream ended without producing a Message with role=assistant"
);

describe("subagent worker: runWorkerOnce protocolError 收口 apiError 分流 (ADR-0111 Decision 2(a))", () => {
  const baseEnvelope: WorkerEnvelope = {
    task: "investigate X",
    sandboxRoot: "/tmp/sb",
  };

  it("step 抛 ModelStreamIncompleteError (不可见断流) → failed envelope reason=modelTransient", async () => {
    const env = await runWorkerOnce({
      workerEnvelope: baseEnvelope,
      deps: makeDeps(
        adapterStepThrowing(
          new ModelStreamIncompleteError(false, SDK_STREAM_SHAPE)
        )
      ),
    });
    assert.equal(env.status, "failed");
    assert.equal(env.reason, "modelTransient");
    assert.equal(env.stop_reason, "protocolError");
  });

  it("step 抛 TransportRetryExhaustedError (重试耗尽) → failed envelope reason=modelTransient", async () => {
    const env = await runWorkerOnce({
      workerEnvelope: baseEnvelope,
      deps: makeDeps(
        adapterStepThrowing(
          new TransportRetryExhaustedError(5, SDK_STREAM_SHAPE)
        )
      ),
    });
    assert.equal(env.status, "failed");
    assert.equal(env.reason, "modelTransient");
    assert.equal(env.stop_reason, "protocolError");
  });

  it("step 抛无 cause 裸 ProtocolError → apiError 缺席 → 维持 reason=protocolError", async () => {
    const env = await runWorkerOnce({
      workerEnvelope: baseEnvelope,
      deps: makeDeps(adapterStepThrowing(new ProtocolError("bad wire shape"))),
    });
    assert.equal(env.status, "failed");
    assert.equal(env.reason, "protocolError");
    assert.equal(env.stop_reason, "protocolError");
  });

  it("stopReason=emptyFinalResponse (无 apiError) → 维持 reason=protocolError", async () => {
    const adapter = createStubModel({
      responses: [assistantResult({ texts: [] })],
    });
    const env = await runWorkerOnce({
      workerEnvelope: baseEnvelope,
      deps: makeDeps(adapter),
    });
    assert.equal(env.status, "failed");
    assert.equal(env.stop_reason, "emptyFinalResponse");
    assert.equal(env.reason, "protocolError");
  });

  it("run() 逃逸 catch: ModelStreamIncompleteError 支排在 ProtocolError 通用支之前 → modelTransient (Decision 2(b))", async () => {
    // encodeUserText 在 step 收口面之外抛出本类错误 (loop 收口面之外的逃逸形态)。
    const env = await runWorkerOnce({
      workerEnvelope: { ...baseEnvelope, finalText: "host dialogue" },
      deps: makeDeps(
        adapterEncodeUserTextThrowing(
          new ModelStreamIncompleteError(true, SDK_STREAM_SHAPE)
        )
      ),
    });
    assert.equal(env.status, "failed");
    assert.equal(env.reason, "modelTransient");
  });

  it("run() 逃逸 catch: 非子类的 ProtocolError → 仍 protocolError (排序不破既有语义)", async () => {
    const env = await runWorkerOnce({
      workerEnvelope: { ...baseEnvelope, finalText: "host dialogue" },
      deps: makeDeps(
        adapterEncodeUserTextThrowing(new ProtocolError("escape proto"))
      ),
    });
    assert.equal(env.status, "failed");
    assert.equal(env.reason, "protocolError");
  });

  it("run() 逃逸 catch: MaxTurnsExceeded 不变 → maxTurnsExceeded", async () => {
    const env = await runWorkerOnce({
      workerEnvelope: { ...baseEnvelope, finalText: "host dialogue" },
      deps: makeDeps(
        adapterEncodeUserTextThrowing(new MaxTurnsExceeded(0, "test"))
      ),
    });
    assert.equal(env.status, "failed");
    assert.equal(env.reason, "maxTurnsExceeded");
  });
});

describe("subagent worker: runEscapeEnvelope (ADR-0111 不变式 (b) run 阶段派生 SSOT)", () => {
  it("分类: ModelStreamIncompleteError→modelTransient / MaxTurnsExceeded→maxTurnsExceeded / ProtocolError→protocolError / 其他→crashed", async () => {
    const { runEscapeEnvelope } = (await import(
      "../../src/harness/subagent/worker.ts"
    )) as unknown as {
      runEscapeEnvelope: (err: unknown) => SubAgentEnvelope;
    };
    assert.equal(
      runEscapeEnvelope(new ModelStreamIncompleteError(true, "x")).reason,
      "modelTransient"
    );
    assert.equal(
      runEscapeEnvelope(new MaxTurnsExceeded(3, "loop")).reason,
      "maxTurnsExceeded"
    );
    assert.equal(
      runEscapeEnvelope(new ProtocolError("proto")).reason,
      "protocolError"
    );
    assert.equal(runEscapeEnvelope(new Error("boom")).reason, "crashed");
    assert.match(runEscapeEnvelope(new Error("boom")).summary, /boom/);
  });

  it("plain-object typed error 渲染不塌缩成 [object Object] (code-quality typed-error catch 契约)", async () => {
    const { runEscapeEnvelope } = (await import(
      "../../src/harness/subagent/worker.ts"
    )) as unknown as {
      runEscapeEnvelope: (err: unknown) => SubAgentEnvelope;
    };
    const env = runEscapeEnvelope({
      kind: "llm_provider_config",
      providerId: "acme",
    });
    assert.equal(env.reason, "crashed");
    assert.equal(env.summary.includes("[object Object]"), false);
    assert.match(env.summary, /acme/);
    assert.match(env.summary, /llm_provider_config/);
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
  it("general-purpose worker 注入项目 AGENTS.md, 即使 memoryEnabled=false", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "iknow-worker-static-"));
    try {
      const marker = "WORKER_PROJECT_INSTRUCTIONS";
      await writeFile(join(cwd, "AGENTS.md"), marker);
      const deps = await createWorkerDeps({
        env: TEST_ENV,
        sandboxRoot: cwd,
        cwd,
        userHome: cwd,
        role: "general-purpose",
        model: createStubModel({ responses: [] }),
        skillCatalog: createSkillCatalog([]),
        trace: createNoopTraceService(),
      });

      const system = (await deps.system?.()) ?? "";

      assert.ok(system.includes(marker));
      assert.ok(!system.includes("memory_recall"));
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("无 AGENTS.md 时 worker 仍注入 general-purpose persona 且不抛", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "iknow-worker-no-agents-"));
    try {
      const deps = await createWorkerDeps({
        env: TEST_ENV,
        sandboxRoot: cwd,
        cwd,
        userHome: cwd,
        model: createStubModel({ responses: [] }),
        skillCatalog: createSkillCatalog([]),
        trace: createNoopTraceService(),
      });

      const system = (await deps.system?.()) ?? "";
      assert.ok(system.includes(getAgentEntry("general-purpose").body));
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("explore worker 不注入完整项目 AGENTS.md 说明书静态层", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "iknow-worker-explore-static-"));
    try {
      const marker = "EXPLORE_MUST_NOT_SEE_AGENTS";
      await writeFile(join(cwd, "AGENTS.md"), marker);
      const deps = await createWorkerDeps({
        env: TEST_ENV,
        sandboxRoot: cwd,
        cwd,
        userHome: cwd,
        role: "explore",
        model: createStubModel({ responses: [] }),
        skillCatalog: createSkillCatalog([]),
        trace: createNoopTraceService(),
      });

      const system = (await deps.system?.()) ?? "";
      assert.ok(!system.includes(marker));
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("改绑分裂根：general-purpose 注入 projectIdentityRoot 的 AGENTS.md，不读树上诱饵", async () => {
    const productRoot = await mkdtemp(
      join(tmpdir(), "iknow-worker-split-identity-")
    );
    const taskRoot = join(productRoot, ".iknow", "worktrees", "conv-1");
    try {
      await mkdir(taskRoot, { recursive: true });
      const identityMarker = "IDENTITY_ROOT_AGENTS";
      const decoyMarker = "TASK_TREE_DECOY_AGENTS";
      await writeFile(join(productRoot, "AGENTS.md"), identityMarker);
      await writeFile(join(taskRoot, "AGENTS.md"), decoyMarker);

      const deps = await createWorkerDeps({
        env: TEST_ENV,
        sandboxRoot: taskRoot,
        cwd: taskRoot,
        userHome: productRoot,
        projectIdentityRoot: productRoot,
        role: "general-purpose",
        model: createStubModel({ responses: [] }),
        skillCatalog: createSkillCatalog([]),
        trace: createNoopTraceService(),
      });

      const system = (await deps.system?.()) ?? "";
      assert.ok(system.includes(identityMarker));
      assert.ok(!system.includes(decoyMarker));
    } finally {
      await rm(productRoot, { recursive: true, force: true });
    }
  });

  it("改绑分裂根：explore 仍不注入身份根或树上的项目 AGENTS.md", async () => {
    const productRoot = await mkdtemp(
      join(tmpdir(), "iknow-worker-split-explore-")
    );
    const taskRoot = join(productRoot, ".iknow", "worktrees", "conv-1");
    try {
      await mkdir(taskRoot, { recursive: true });
      const identityMarker = "IDENTITY_ROOT_AGENTS_EXPLORE";
      const decoyMarker = "TASK_TREE_DECOY_EXPLORE";
      await writeFile(join(productRoot, "AGENTS.md"), identityMarker);
      await writeFile(join(taskRoot, "AGENTS.md"), decoyMarker);

      const deps = await createWorkerDeps({
        env: TEST_ENV,
        sandboxRoot: taskRoot,
        cwd: taskRoot,
        userHome: productRoot,
        projectIdentityRoot: productRoot,
        role: "explore",
        model: createStubModel({ responses: [] }),
        skillCatalog: createSkillCatalog([]),
        trace: createNoopTraceService(),
      });

      const system = (await deps.system?.()) ?? "";
      assert.ok(!system.includes(identityMarker));
      assert.ok(!system.includes(decoyMarker));
    } finally {
      await rm(productRoot, { recursive: true, force: true });
    }
  });

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

  it("default worker trace output is anchored to workspaceRoot, not cwd", async () => {
    const workspaceRoot = await mkdtemp(
      join(tmpdir(), "iknow-worker-trace-root-")
    );
    const cwd = await mkdtemp(join(tmpdir(), "iknow-worker-trace-cwd-"));
    const previousTraceOut = process.env.IKNOW_TRACE_OUT;
    delete process.env.IKNOW_TRACE_OUT;
    try {
      const deps = await createWorkerDeps({
        env: TEST_ENV,
        sandboxRoot: cwd,
        workspaceRoot,
        cwd,
        model: createStubModel({ responses: [] }),
        skillCatalog: createSkillCatalog([]),
        system: () => undefined,
      });
      await deps.trace!.recordSubagentSpawn({
        id: "worker-trace-test",
        taskId: "worker-trace-test",
        origin: "child",
        startedAt: new Date().toISOString(),
        status: "ok",
        ts: new Date().toISOString(),
      });

      const traceFiles = await readdir(join(workspaceRoot, "trace"));
      assert.equal(traceFiles.length, 1);
      await assert.rejects(readdir(join(cwd, "trace")));
    } finally {
      if (previousTraceOut === undefined) delete process.env.IKNOW_TRACE_OUT;
      else process.env.IKNOW_TRACE_OUT = previousTraceOut;
      await rm(workspaceRoot, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
    }
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

// ---------------------------------------------------------------------------
// G. T5 review-fix H1 — worker content trace file-mode 接线。envelope
//    traceFilePath 是「文件路径」(manager 已在 spawn 期建好普通文件
//    `agent-<taskId>.jsonl`),worker 侧必须用 JsonlTraceOptions 的 file-mode
//    键 `traceFilePath`,不能用目录模式键 `filePath`(那会把文件路径当目录,
//    落 `agent-<taskId>.jsonl/<taskId>.jsonl` → ENOTDIR → 静默零行)。
//    断言锚点:worker content 记录与 manager lifecycle 行共存于同一
//    `agent-<taskId>.jsonl` 单文件,conversation_id 一律 == taskId。
// ---------------------------------------------------------------------------

describe("subagent worker: traceFilePath file-mode 接线 (T5 H1 review-fix)", () => {
  it("traceFilePath + taskId 在场 → file-mode 落同一文件,与 manager lifecycle 行共存", async () => {
    const subagentsDir = await mkdtemp(
      join(tmpdir(), "iknow-worker-filemode-")
    );
    const taskId = "11111111-2222-4333-8444-555555555555";
    const traceFilePath = join(subagentsDir, `agent-${taskId}.jsonl`);
    const previousTraceOut = process.env.IKNOW_TRACE_OUT;
    delete process.env.IKNOW_TRACE_OUT;
    try {
      // 模拟 manager 已建好的普通文件 + 一条 lifecycle 行 (file-mode 写入
      // 必须以 append 方式共存,不能因路径被同名目录占据而 ENOTDIR)。
      const { appendFileSync } = await import("node:fs");
      appendFileSync(
        traceFilePath,
        JSON.stringify({
          conversation_id: taskId,
          record_type: "subagent_spawn",
          subagent_id: taskId,
        }) + "\n",
        "utf8"
      );

      const deps = await createWorkerDeps({
        env: TEST_ENV,
        sandboxRoot: subagentsDir,
        cwd: subagentsDir,
        model: createStubModel({ responses: [] }),
        skillCatalog: createSkillCatalog([]),
        system: () => undefined,
        traceFilePath,
        taskId,
      });

      // worker content 记录经这条 trace 服务落盘 —— 若走错目录模式键,
      // appendFileSync 目标是 <traceFilePath>/<taskId>.jsonl (ENOTDIR) 或
      // 构造期 EEXIST 失败 → traceWriteFailures > 0 / 无行落盘。
      const trace = deps.trace;
      assert.ok(trace, "traceFilePath 在场时必须装配 JsonlTraceService");
      const id = await trace.recordTurn({
        turnIndex: 0,
        startedAt: new Date().toISOString(),
        endedAt: new Date().toISOString(),
        durationMs: 1,
        llmCallIds: [],
        toolCallIds: [],
        decision: "completed",
      });
      assert.ok(typeof id === "string", "file-mode 写盘必须成功");

      const { readFileSync, statSync } = await import("node:fs");
      const lines = readFileSync(traceFilePath, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Record<string, unknown>);
      // manager lifecycle 行仍在,worker turn 行追加其后。
      assert.equal(lines[0]?.record_type, "subagent_spawn");
      assert.equal(lines[lines.length - 1]?.record_type, "turn");
      assert.equal(lines[lines.length - 1]?.conversation_id, taskId);
      // 绝无把 traceFilePath 当目录二次嵌套的产物。
      assert.equal(
        statSync(traceFilePath).isFile(),
        true,
        "agent-<taskId>.jsonl 必须保持普通文件"
      );
    } finally {
      if (previousTraceOut === undefined) delete process.env.IKNOW_TRACE_OUT;
      else process.env.IKNOW_TRACE_OUT = previousTraceOut;
      await rm(subagentsDir, { recursive: true, force: true });
    }
  });

  it("traceFilePath 在场而 taskId 缺席 → 装配期 fail-loud (随机 UUID 假 scope 已退役)", async () => {
    const subagentsDir = await mkdtemp(
      join(tmpdir(), "iknow-worker-filemode-noid-")
    );
    try {
      await assert.rejects(
        createWorkerDeps({
          env: TEST_ENV,
          sandboxRoot: subagentsDir,
          model: createStubModel({ responses: [] }),
          skillCatalog: createSkillCatalog([]),
          system: () => undefined,
          traceFilePath: join(subagentsDir, "agent-x.jsonl"),
        }),
        /taskId/
      );
    } finally {
      await rm(subagentsDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// G. specs/tui-model-command SC9: provider.headers → SDK defaultHeaders
//    (worker 侧 client 构造, 未注入 model 的默认分支)
// ---------------------------------------------------------------------------

describe("subagent worker: env.llm.headers → client defaultHeaders (SC9)", () => {
  /** 裸装配选项: 不传 model → 走默认分支真构造 Anthropic client。 */
  function headerProbeOpts(env: IknowEnv): CreateWorkerDepsOptions {
    return {
      env,
      sandboxRoot: "/tmp/sb-headers",
      cwd: "/tmp/sb-headers",
      userHome: "/tmp/sb-headers",
      skillCatalog: createSkillCatalog([]),
      system: async () => undefined,
      trace: createNoopTraceService(),
    };
  }

  it("headers 在场 → defaultHeaders 键值透传", async () => {
    anthropicCtorOpts.length = 0;
    const env = {
      ...TEST_ENV,
      llm: { ...TEST_ENV.llm, headers: { "X-Foo": "bar" } },
    };
    await createWorkerDeps(headerProbeOpts(env));
    assert.equal(anthropicCtorOpts.length, 1);
    assert.deepEqual(anthropicCtorOpts[0]!.defaultHeaders, {
      "X-Foo": "bar",
    });
  });

  it("headers 缺席 → 构造 options 不含 defaultHeaders 键 (与今日逐字节一致)", async () => {
    anthropicCtorOpts.length = 0;
    await createWorkerDeps(headerProbeOpts(TEST_ENV));
    assert.equal(anthropicCtorOpts.length, 1);
    assert.equal(
      Object.prototype.hasOwnProperty.call(
        anthropicCtorOpts[0]!,
        "defaultHeaders"
      ),
      false
    );
  });
});
