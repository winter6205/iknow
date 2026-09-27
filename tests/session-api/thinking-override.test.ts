/**
 * thinking-override tests (T2 / #complexity anti-drift gate).
 *
 * Boundary classes per arthurpower:defensive-contract-validator:
 *   - empty:    parseThinkingOverride(undefined/null) → undefined
 *   - normal:   valid mode/effort combinations round-trip; build deps replace
 *               adapter only and keep executor/registry/maxTurns/timeoutMs.
 *   - negative: invalid mode / invalid effort / non-object / missing mode →
 *               ValidationError (400 fail-loud surface)
 *   - overflow: long inputs are not affected (validator only)
 *   - exception: env without apiKey → ValidationError (mirrors ensureDeps)
 */
import { afterEach, describe, it, vi } from "vitest";
import assert from "node:assert/strict";

/**
 * `withThinkingOverride` must build its client in the same shape as
 * build-engine's `createAdapterFromEnv` (provider.headers ->
 * `defaultHeaders`; the key is omitted when absent). The rest of this file
 * uses the real SDK + a local capture server (checking thinking fields on
 * the wire); here we only wrap a recorder at the SDK construction point —
 * subclassing the real Anthropic (not a stand-in), so existing cases behave
 * unchanged. `withThinkingOverride` never returns the client to the caller,
 * so constructor args are the only observable surface.
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

import {
  parseThinkingOverride,
  withThinkingOverride,
} from "../../src/session-api/thinking-override.ts";
import { createAdapterFromEnv } from "../../src/harness/build-engine.ts";
import { ValidationError } from "../../src/shared/errors.ts";
import { createStubTool } from "../../src/harness/stubs/stub-tool.ts";
import { createRegistry } from "../../src/harness/tools/registry.ts";
import { createExecutor } from "../../src/harness/tools/executor.ts";
import type { LoopEngineDeps } from "../../src/harness/index.ts";
import {
  MINIMAL_SDK_MESSAGE,
  makeTestLlmEnv,
  startLlmCapture,
  type LlmCapture,
} from "./_helpers/llm-capture.ts";

// -- parseThinkingOverride: empty -----------------------------------------

describe("parseThinkingOverride — empty / absent", () => {
  it("undefined → undefined", () => {
    assert.equal(parseThinkingOverride(undefined), undefined);
  });

  it("null → undefined", () => {
    assert.equal(parseThinkingOverride(null), undefined);
  });
});

// -- parseThinkingOverride: normal ---------------------------------------

describe("parseThinkingOverride — valid inputs", () => {
  it("{mode:'off'} → {mode:'off'}", () => {
    assert.deepEqual(parseThinkingOverride({ mode: "off" }), { mode: "off" });
  });

  it("{mode:'adaptive', effort:'high'} → passthrough", () => {
    assert.deepEqual(
      parseThinkingOverride({ mode: "adaptive", effort: "high" }),
      { mode: "adaptive", effort: "high" }
    );
  });

  it("effort='' is valid (means no output_config)", () => {
    assert.deepEqual(parseThinkingOverride({ mode: "adaptive", effort: "" }), {
      mode: "adaptive",
      effort: "",
    });
  });

  it("each enum effort value is accepted", () => {
    for (const effort of ["low", "medium", "high", "xhigh", "max"] as const) {
      assert.deepEqual(parseThinkingOverride({ mode: "adaptive", effort }), {
        mode: "adaptive",
        effort,
      });
    }
  });
});

// -- parseThinkingOverride: negative / fail-loud -------------------------

describe("parseThinkingOverride — invalid values throw ValidationError", () => {
  it("non-object (string) → ValidationError field=thinking", () => {
    assert.throws(
      () => parseThinkingOverride("off"),
      (err: unknown) =>
        err instanceof ValidationError &&
        err.details?.["field"] === "thinking" &&
        /object/.test(err.message)
    );
  });

  it("array → ValidationError field=thinking", () => {
    assert.throws(
      () => parseThinkingOverride(["off"]),
      (err: unknown) =>
        err instanceof ValidationError && err.details?.["field"] === "thinking"
    );
  });

  it("missing mode → ValidationError field=thinking.mode", () => {
    assert.throws(
      () => parseThinkingOverride({}),
      (err: unknown) =>
        err instanceof ValidationError &&
        err.details?.["field"] === "thinking.mode"
    );
  });

  it("invalid mode 'loud' → ValidationError field=thinking.mode", () => {
    assert.throws(
      () => parseThinkingOverride({ mode: "loud" }),
      (err: unknown) =>
        err instanceof ValidationError &&
        err.details?.["field"] === "thinking.mode" &&
        /off|adaptive/.test(err.message)
    );
  });

  it("invalid effort 'extreme' → ValidationError field=thinking.effort", () => {
    assert.throws(
      () => parseThinkingOverride({ mode: "adaptive", effort: "extreme" }),
      (err: unknown) =>
        err instanceof ValidationError &&
        err.details?.["field"] === "thinking.effort"
    );
  });

  it("non-string effort (number) → ValidationError", () => {
    assert.throws(
      () => parseThinkingOverride({ mode: "adaptive", effort: 5 }),
      (err: unknown) =>
        err instanceof ValidationError &&
        err.details?.["field"] === "thinking.effort"
    );
  });
});

// -- withThinkingOverride: construction behavior -----------------------

describe("withThinkingOverride — replaces adapter only, reuses other deps", () => {
  it("returns the effective per-turn thinking snapshot for downstream tool calls", () => {
    const deps: LoopEngineDeps = {
      adapter: {
        step: async () => {
          throw new Error("nope");
        },
        encodeUserText: () => ({ role: "user", content: [] }),
        encodeToolResults: () => [],
      },
      executor: createExecutor(createRegistry([])),
      registry: createRegistry([]),
      maxTurns: 1,
    };
    const env = makeTestLlmEnv({
      baseUrl: "http://invalid",
      model: "x",
      apiKey: "k",
      thinking: "off",
      thinkingEffort: "",
    });

    const result = withThinkingOverride({
      deps,
      override: { mode: "adaptive", effort: "high" },
      env,
    }) as LoopEngineDeps & {
      readonly parentThinking?: {
        readonly mode: string;
        readonly effort: string;
      };
    };

    assert.deepEqual(result.parentThinking, {
      mode: "adaptive",
      effort: "high",
    });
  });

  it("returned deps.executor / registry / maxTurns / timeoutMs identical to base", () => {
    const tool = createStubTool({ name: "noop", next: () => ({}) });
    const registry = createRegistry([tool]);
    const executor = createExecutor(registry);
    const baseDeps: LoopEngineDeps = {
      adapter: {
        step: async () => {
          throw new Error("nope");
        },
        encodeUserText: () => ({ role: "user", content: [] }),
        encodeToolResults: () => [],
      },
      executor,
      registry,
      maxTurns: 7,
      timeoutMs: 4321,
    };
    const env = makeTestLlmEnv({
      baseUrl: "http://invalid",
      model: "x",
      apiKey: "k",
      maxOutputTokens: 64,
      timeoutMs: 1000,
    });
    const result = withThinkingOverride({
      deps: baseDeps,
      override: { mode: "off" },
      env,
    });
    assert.equal(result.executor, baseDeps.executor);
    assert.equal(result.registry, baseDeps.registry);
    assert.equal(result.maxTurns, baseDeps.maxTurns);
    assert.equal(result.timeoutMs, baseDeps.timeoutMs);
    // adapter is replaced
    assert.notEqual(result.adapter, baseDeps.adapter);
  });

  it("env without apiKey → ValidationError (mirror of ensureDeps)", () => {
    const tool = createStubTool({ name: "noop", next: () => ({}) });
    const registry = createRegistry([tool]);
    const executor = createExecutor(registry);
    const baseDeps: LoopEngineDeps = {
      adapter: {
        step: async () => {
          throw new Error("nope");
        },
        encodeUserText: () => ({ role: "user", content: [] }),
        encodeToolResults: () => [],
      },
      executor,
      registry,
      maxTurns: 1,
    };
    const envNoKey = makeTestLlmEnv({
      baseUrl: "http://invalid",
      model: "x",
      apiKey: undefined,
      maxOutputTokens: 64,
      timeoutMs: 1000,
    });
    assert.throws(
      () =>
        withThinkingOverride({
          deps: baseDeps,
          override: { mode: "adaptive" },
          env: envNoKey,
        }),
      (err: unknown) =>
        err instanceof ValidationError &&
        /apiKey.*placeholder|no API key configured/.test(err.message)
    );
  });
});

// -- withThinkingOverride: real adapter request side --------------------
// Use a local HTTP capture server as the SDK's baseURL target. The server
// returns a minimal SdkMessage so the adapter step completes successfully,
// and we assert the captured request body contains the override-derived
// thinking / output_config fields. This directly verifies the wire-side
// contract ("adapter's request carries thinking").

let capture: LlmCapture | undefined;

afterEach(async () => {
  if (capture) {
    await capture.close();
    capture = undefined;
  }
});

describe("withThinkingOverride — request-side thinking fields via local capture server", () => {
  it("thinking=adaptive + effort=high → request carries thinking:{type:'adaptive'} + output_config:{effort:'high'}", async () => {
    capture = await startLlmCapture(MINIMAL_SDK_MESSAGE);
    const tool = createStubTool({ name: "noop", next: () => ({}) });
    const registry = createRegistry([tool]);
    const executor = createExecutor(registry);
    const baseDeps: LoopEngineDeps = {
      adapter: {
        step: async () => {
          throw new Error("should be replaced by override adapter");
        },
        encodeUserText: () => ({ role: "user", content: [] }),
        encodeToolResults: () => [],
      },
      executor,
      registry,
      maxTurns: 1,
    };
    const env = makeTestLlmEnv({
      baseUrl: capture.origin,
    });
    const result = withThinkingOverride({
      deps: baseDeps,
      override: { mode: "adaptive", effort: "high" },
      env,
    });
    await result.adapter.step({ messages: [], turnCount: 0 }, { tools: [] });
    assert.equal(capture.bodies.length, 1);
    const body = capture.bodies[0] as Record<string, unknown>;
    assert.deepEqual(body.thinking, { type: "adaptive" });
    assert.deepEqual(body.output_config, { effort: "high" });
  });

  it("thinking=off → request has no thinking / output_config fields", async () => {
    capture = await startLlmCapture(MINIMAL_SDK_MESSAGE);
    const tool = createStubTool({ name: "noop", next: () => ({}) });
    const registry = createRegistry([tool]);
    const executor = createExecutor(registry);
    const baseDeps: LoopEngineDeps = {
      adapter: {
        step: async () => {
          throw new Error("should be replaced");
        },
        encodeUserText: () => ({ role: "user", content: [] }),
        encodeToolResults: () => [],
      },
      executor,
      registry,
      maxTurns: 1,
    };
    const env = makeTestLlmEnv({
      baseUrl: capture.origin,
    });
    const result = withThinkingOverride({
      deps: baseDeps,
      override: { mode: "off" },
      env,
    });
    await result.adapter.step({ messages: [], turnCount: 0 }, { tools: [] });
    const body = capture.bodies[0] as Record<string, unknown>;
    assert.equal("thinking" in body, false);
    assert.equal("output_config" in body, false);
  });

  // -- provider.headers passthrough ------------------

  it("env.llm.headers 在场 → client 构造收到 defaultHeaders（与 build-engine 同形）", () => {
    anthropicCtorOpts.length = 0;
    withThinkingOverride({
      deps: baseDepsForHeaderProbe(),
      override: { mode: "off" },
      env: makeTestLlmEnv({
        baseUrl: "http://invalid",
        headers: { "X-Foo": "bar" },
      }),
    });
    assert.equal(anthropicCtorOpts.length, 1);
    assert.deepEqual(anthropicCtorOpts[0]!["defaultHeaders"], {
      "X-Foo": "bar",
    });
  });

  it("env.llm.headers 缺席 → 构造 options 不含 defaultHeaders 键", () => {
    anthropicCtorOpts.length = 0;
    withThinkingOverride({
      deps: baseDepsForHeaderProbe(),
      override: { mode: "off" },
      env: makeTestLlmEnv({ baseUrl: "http://invalid" }),
    });
    assert.equal(anthropicCtorOpts.length, 1);
    assert.equal(
      Object.prototype.hasOwnProperty.call(
        anthropicCtorOpts[0]!,
        "defaultHeaders"
      ),
      false
    );
  });

  // -- ADR-0094: wire-model carries only the tail segment (same shape as build-engine) ----

  it("route 含 provider 前缀 → wire model = 尾段（provider id 不上 wire）", async () => {
    capture = await startLlmCapture(MINIMAL_SDK_MESSAGE);
    const tool = createStubTool({ name: "noop", next: () => ({}) });
    const registry = createRegistry([tool]);
    const executor = createExecutor(registry);
    const baseDeps: LoopEngineDeps = {
      adapter: {
        step: async () => {
          throw new Error("should be replaced");
        },
        encodeUserText: () => ({ role: "user", content: [] }),
        encodeToolResults: () => [],
      },
      executor,
      registry,
      maxTurns: 1,
    };
    const env = makeTestLlmEnv({
      baseUrl: capture.origin,
      model: "9router/Opus4.8",
    });
    const result = withThinkingOverride({
      deps: baseDeps,
      override: { mode: "off" },
      env,
    });
    await result.adapter.step({ messages: [], turnCount: 0 }, { tools: [] });
    const body = capture.bodies[0] as { model?: string };
    assert.equal(body.model, "Opus4.8");
    assert.equal(body.model?.includes("9router"), false);
  });

  // -- ADR-0094: single thinking factory (client field table identical across both paths) ----------
  // With-override and no-override on the same env must resolve to the same client
  // construction shape (apiKey/baseUrl/headers identical), proving thinking only changes
  // its inputs and no second assembly copy exists.

  it("SC7: 同一 env 下 override / 无 override 的 client 构造 options 同形", () => {
    const baseEnv = {
      baseUrl: "http://invalid",
      headers: { "X-Session": "s1" } as Record<string, string>,
    };
    anthropicCtorOpts.length = 0;
    withThinkingOverride({
      deps: baseDepsForHeaderProbe(),
      override: { mode: "adaptive", effort: "high" },
      env: makeTestLlmEnv(baseEnv),
    });
    const withOverride = [...anthropicCtorOpts];
    anthropicCtorOpts.length = 0;
    // No-override control: call createAdapterFromEnv directly (the same path as build-engine / reloadFromEnv).
    createAdapterFromEnv(makeTestLlmEnv(baseEnv));
    const withoutOverride = [...anthropicCtorOpts];

    assert.equal(withOverride.length, 1);
    assert.equal(withoutOverride.length, 1);
    assert.deepEqual(withOverride[0], withoutOverride[0]);
  });

  it("SC7: override thinking 覆盖只改 adapter 入参（capture server 验 thinking 字段形状）", async () => {
    // One capture server, one env object: run the no-override factory first (= the
    // build-engine / reloadFromEnv path), then the thinking-override path, and compare the two wire shapes.
    capture = await startLlmCapture(MINIMAL_SDK_MESSAGE);
    const env = makeTestLlmEnv({ baseUrl: capture.origin });
    await createAdapterFromEnv(env).adapter.step(
      { messages: [], turnCount: 0 },
      { tools: [] }
    );
    const baseBody = capture.bodies[0] as Record<string, unknown>;

    const overrideAdapter = withThinkingOverride({
      deps: baseDepsForHeaderProbe(),
      override: { mode: "adaptive", effort: "high" },
      env,
    }).adapter;
    await overrideAdapter.step({ messages: [], turnCount: 0 }, { tools: [] });
    const overrideBody = capture.bodies[1] as Record<string, unknown>;

    // model / client shape share one source (same env); only the thinking input is rewritten by the override.
    assert.equal(overrideBody.model, baseBody.model);
    assert.equal("thinking" in baseBody, false); // env default is off
    assert.deepEqual(overrideBody.thinking, { type: "adaptive" });
    assert.deepEqual(overrideBody.output_config, { effort: "high" });
  });
});

/** deps for the override cases: the override swaps only the adapter; executor / registry are not involved. */
function baseDepsForHeaderProbe(): LoopEngineDeps {
  const tool = createStubTool({ name: "noop", next: () => ({}) });
  const registry = createRegistry([tool]);
  return {
    adapter: {
      step: async () => {
        throw new Error("should be replaced by override adapter");
      },
      encodeUserText: () => ({ role: "user", content: [] }),
      encodeToolResults: () => [],
    },
    executor: createExecutor(registry),
    registry,
    maxTurns: 1,
  };
}
