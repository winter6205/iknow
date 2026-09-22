/**
 * envelope wire schema freeze assertions + maxTurns undefined cases.
 *
 * Contract-not-broken: envelope.ts wire schema snapshot — status/reason enums
 * + `minimum: 1` + `additionalProperties: false` all maintained. Zero production-code changes.
 *
 * maxTurns semantics alignment: worker maxTurns undefined = unlimited (ADR-0012);
 * explicit values pass through the envelope and take effect. Worker assembly keeps
 * `opts.maxTurns === undefined` → deps.maxTurns stays undefined (no auto-injected value).
 *
 * Acceptance:
 *   1. envelope wire schema snapshot locked.
 *   2. maxTurns undefined cases green.
 *   3. full npm test regression gate (verified separately outside this test).
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
 * Deep-walk the schema object, collecting every `{ enum: [...] }` clause + `{ minimum: <n> }`
 * constraint for snapshot comparison — any new enum value or missing minimum is caught immediately.
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

// ─── wire schema freeze snapshot ─────────────────────────────────────────────

describe("envelope wire schema freeze (#358 SC9)", () => {
  it("PARENT_SCHEMA.status enum 锁定为 [ok, failed]，未扩", () => {
    const enums = collectEnumConstraints(PARENT_SCHEMA);
    const status = enums.find((e) => e.path === "$.properties.status");
    assert.ok(status, "status enum 存在");
    assert.deepEqual([...status!.enum], ["ok", "failed"]);
  });

  it("PARENT_SCHEMA.reason enum 冻结（5 值, ADR-0111 显式修订 SC9 追加 modelTransient；封闭性不破）", () => {
    const enums = collectEnumConstraints(PARENT_SCHEMA);
    const reason = enums.find((e) => e.path === "$.properties.reason");
    assert.ok(reason, "reason enum 存在");
    assert.deepEqual([...reason!.enum].sort(), [
      "crashed",
      "maxTurnsExceeded",
      "modelTransient",
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

  it("WORKER_SCHEMA.properties 无 model（ADR-0122 删除 per-spawn 字段）", () => {
    const props = (WORKER_SCHEMA as { properties: Record<string, unknown> })
      .properties;
    assert.ok(!("model" in props), "model must not be a schema property");
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

  it('reason 枚举内值 ["modelTransient"] 被接受（ADR-0111 第五值）', () => {
    const env = parseParentEnvelope(
      JSON.stringify({
        status: "failed",
        reason: "modelTransient",
        summary: "x",
        result: "",
      })
    );
    assert.equal(env.reason, "modelTransient");
  });
});

// ─── maxTurns undefined = unlimited (ADR-0012 alignment) ────────────────────

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
    // The assembly layer createWorkerDeps (worker.ts) must keep
    // deps.maxTurns = env.llm.maxTurns (undefined) when opts.maxTurns is
    // undefined — no fabricated value injected into deps. This contract lets
    // loop-engine treat undefined as "unlimited" (ADR-0012).
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
