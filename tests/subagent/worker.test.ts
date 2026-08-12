import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { createStubModel } from "../../src/harness/stubs/stub-model.ts";
import {
  buildThinkingParams,
  createRealAnthropicAdapter,
} from "../../src/harness/model-adapter/anthropic-adapter.ts";
import { ProtocolError } from "../../src/harness/errors.ts";
import {
  runWorkerOnce,
  toFailedEnvelope,
  toOkEnvelope,
  type CreateWorkerDepsOptions,
} from "../../src/harness/subagent/worker.ts";
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

  it("SC10: result 超 20000 → truncateEnvelopeResult 截断并合成 marker", async () => {
    const big = "y".repeat(25000);
    // 直接调 truncateEnvelopeResult 验证 (与 envelope.ts 行为对齐)
    const { truncateEnvelopeResult } =
      await import("../../src/harness/subagent/envelope.ts");
    const env = toOkEnvelope(fakeResult(big));
    const truncated = truncateEnvelopeResult(env);
    assert.equal(truncated.status, "ok");
    assert.equal(truncated.truncated, true);
    assert.equal(truncated.totalLength, 25000);
    assert.match(
      truncated.result,
      /^\[\.\.\.truncated to 20000 chars; total 25000\]$/
    );
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
});
