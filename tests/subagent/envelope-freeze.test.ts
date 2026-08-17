/**
 * #358 T9 — envelope wire schema 冻结断言 + maxTurns undefined 用例
 *
 * SC9（契约不破）：envelope.ts wire schema snapshot — status/reason 枚举
 * + `minimum: 1` + `additionalProperties: false` 全部维持。零生产代码改动。
 *
 * SC10（maxTurns 语义对齐）：worker maxTurns undefined = 无限（ADR-0012），
 * 显式值经 envelope 透传生效。新增 worker 装配层 `opts.maxTurns === undefined`
 * → deps.maxTurns 保持 undefined（不注入层自动值）。
 *
 * Acceptance（plans/358 §T9）：
 *   1. envelope wire schema snapshot 锁定。
 *   2. maxTurns undefined 用例绿。
 *   3. npm test 全量回归闸（已通过，记录在本测试外的 final 验证报告）。
 */

import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
  WORKER_SCHEMA,
  PARENT_SCHEMA,
  parseWorkerEnvelope,
  parseParentEnvelope,
} from "../../src/harness/subagent/envelope.ts";

/**
 * 深度遍历 schema 对象，收集所有 `{ enum: [...] }` 子句 + `{ minimum: <n> }` 约束，
 * 用于快照比对——任何新增的枚举值或 missing 最小值都立刻被识别。
 */
function collectEnumConstraints(
  node: unknown,
  path = "$"
): Array<{ path: string; enum: ReadonlyArray<string> }> {
  const out: Array<{ path: string; enum: ReadonlyArray<string> }> = [];
  if (node === null || typeof node !== "object") return out;
  const obj = node as Record<string, unknown>;
  if (Array.isArray(obj.enum)) {
    out.push({ path, enum: [...(obj.enum as ReadonlyArray<string>)] });
  }
  for (const [key, value] of Object.entries(obj)) {
    out.push(...collectEnumConstraints(value, `${path}.${key}`));
  }
  return out;
}

function collectMinConstraints(
  node: unknown,
  path = "$"
): Array<{ path: string; minimum: number }> {
  const out: Array<{ path: string; minimum: number }> = [];
  if (node === null || typeof node !== "object") return out;
  const obj = node as Record<string, unknown>;
  if (typeof obj.minimum === "number") {
    out.push({ path, minimum: obj.minimum });
  }
  for (const [key, value] of Object.entries(obj)) {
    out.push(...collectMinConstraints(value, `${path}.${key}`));
  }
  return out;
}

// ─── SC9: wire schema 冻结快照 ─────────────────────────────────────────────

describe("envelope wire schema freeze (#358 SC9)", () => {
  it("PARENT_SCHEMA.status enum 锁定为 [ok, failed]，未扩", () => {
    const enums = collectEnumConstraints(PARENT_SCHEMA);
    const status = enums.find((e) => e.path === "$.properties.status");
    assert.ok(status, "status enum 存在");
    assert.deepEqual([...status!.enum], ["ok", "failed"]);
  });

  it("PARENT_SCHEMA.reason enum 冻结（4 值, 无 cancelled/timeout 等扩展）", () => {
    const enums = collectEnumConstraints(PARENT_SCHEMA);
    const reason = enums.find((e) => e.path === "$.properties.reason");
    assert.ok(reason, "reason enum 存在");
    assert.deepEqual([...reason!.enum].sort(), [
      "crashed",
      "maxTurnsExceeded",
      "protocolError",
      "timeout",
    ]);
  });

  it("PARENT_SCHEMA.required = [status, summary, result]", () => {
    const required = (PARENT_SCHEMA as { required: ReadonlyArray<string> })
      .required;
    assert.deepEqual([...required].sort(), ["result", "status", "summary"]);
  });

  it("PARENT_SCHEMA.additionalProperties: false（不吞额外字段）", () => {
    assert.equal(
      (PARENT_SCHEMA as { additionalProperties: boolean }).additionalProperties,
      false
    );
  });

  it("WORKER_SCHEMA.required = [task, sandboxRoot]", () => {
    const required = (WORKER_SCHEMA as { required: ReadonlyArray<string> })
      .required;
    assert.deepEqual([...required].sort(), ["sandboxRoot", "task"]);
  });

  it("WORKER_SCHEMA.maxTurns / timeoutMs 维持 minimum:1（D7 模型不可关寿命上限）", () => {
    const mins = collectMinConstraints(WORKER_SCHEMA);
    const maxTurns = mins.find((m) => m.path === "$.properties.maxTurns");
    const timeoutMs = mins.find((m) => m.path === "$.properties.timeoutMs");
    assert.ok(maxTurns, "maxTurns minimum 存在");
    assert.equal(maxTurns!.minimum, 1);
    assert.ok(timeoutMs, "timeoutMs minimum 存在");
    assert.equal(timeoutMs!.minimum, 1);
  });

  it("WORKER_SCHEMA.additionalProperties: false", () => {
    assert.equal(
      (WORKER_SCHEMA as { additionalProperties: boolean }).additionalProperties,
      false
    );
  });

  it("timeoutMs: 0 仍被拒（minimum:1 生效）", () => {
    const json = JSON.stringify({
      task: "x",
      sandboxRoot: "/tmp/sb",
      timeoutMs: 0,
    });
    assert.throws(() => parseWorkerEnvelope(json), /timeoutMs/);
  });

  it("timeoutMs: -1 仍被拒", () => {
    const json = JSON.stringify({
      task: "x",
      sandboxRoot: "/tmp/sb",
      timeoutMs: -1,
    });
    assert.throws(() => parseWorkerEnvelope(json));
  });

  it("maxTurns: 0 仍被拒（最小值 1）", () => {
    const json = JSON.stringify({
      task: "x",
      sandboxRoot: "/tmp/sb",
      maxTurns: 0,
    });
    assert.throws(() => parseWorkerEnvelope(json), /maxTurns/);
  });

  it('status 枚举外值 ["running"] 被拒', () => {
    const json = JSON.stringify({
      status: "running",
      summary: "x",
      result: "y",
    });
    assert.throws(() => parseParentEnvelope(json));
  });

  it('reason 枚举外值 ["cancelled"] 被拒（即便 loop-engine StopReason 含 cancelled）', () => {
    const json = JSON.stringify({
      status: "failed",
      reason: "cancelled",
      summary: "x",
      result: "",
    });
    assert.throws(() => parseParentEnvelope(json), /reason/);
  });
});

// ─── SC10: maxTurns undefined = 无限（ADR-0012 对齐）────────────────────────

describe("subagent maxTurns undefined = 无限（ADR-0012，#358 SC10）", () => {
  it("WorkerEnvelope.maxTurns 缺省不影响解析（undefined 透传）", () => {
    const env = parseWorkerEnvelope(
      JSON.stringify({ task: "x", sandboxRoot: "/tmp/sb" })
    );
    assert.equal(env.maxTurns, undefined);
  });

  it("WorkerEnvelope.maxTurns 显式值原样透传", () => {
    const env = parseWorkerEnvelope(
      JSON.stringify({
        task: "x",
        sandboxRoot: "/tmp/sb",
        maxTurns: 7,
      })
    );
    assert.equal(env.maxTurns, 7);
  });

  it("createWorkerDeps: opts.maxTurns undefined → 缺省透传（不注入自动值）", async () => {
    // 装配层 createWorkerDeps（worker.ts）应在 opts.maxTurns 为 undefined 时
    // 保留 deps.maxTurns = env.llm.maxTurns（undefined），不向 deps 注入伪造值。
    // 该契约保证 loop-engine 见到 undefined 即按"无限"处理（ADR-0012）。
    const { createWorkerDeps } =
      await import("../../src/harness/subagent/worker.ts");
    const deps = await createWorkerDeps({
      env: {
        llm: {
          baseUrl: "http://invalid",
          model: "test",
          fallback: [],
          apiKey: "k",
          maxOutputTokens: 128,
          timeoutMs: 5000,
          temperature: 0,
          thinking: "off",
          thinkingEffort: "",
          stream: "off",
          maxTurns: undefined,
        },
        chat: { showThinking: false },
        web: { searchUrl: undefined, proxy: undefined },
        compress: { contextWindow: 200000, thresholdTokens: undefined },
        mcp: { connectTimeoutMs: 60000 },
        subagent: { taskTimeoutMs: undefined },
        workspaceRoot: "/tmp/sb",
      } as never,
      sandboxRoot: "/tmp/sb",
    });
    assert.equal(deps.maxTurns, undefined, "undefined 透传, 不注入自动值");
  });

  it("createWorkerDeps: opts.maxTurns 显式值原样透传", async () => {
    const { createWorkerDeps } =
      await import("../../src/harness/subagent/worker.ts");
    const deps = await createWorkerDeps({
      env: {
        llm: {
          baseUrl: "http://invalid",
          model: "test",
          fallback: [],
          apiKey: "k",
          maxOutputTokens: 128,
          timeoutMs: 5000,
          temperature: 0,
          thinking: "off",
          thinkingEffort: "",
          stream: "off",
          maxTurns: undefined,
        },
        chat: { showThinking: false },
        web: { searchUrl: undefined, proxy: undefined },
        compress: { contextWindow: 200000, thresholdTokens: undefined },
        mcp: { connectTimeoutMs: 60000 },
        subagent: { taskTimeoutMs: undefined },
        workspaceRoot: "/tmp/sb",
      } as never,
      sandboxRoot: "/tmp/sb",
      maxTurns: 12,
    });
    assert.equal(deps.maxTurns, 12);
  });
});
