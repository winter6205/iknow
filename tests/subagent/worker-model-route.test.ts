/**
 * Worker adapter route selection (ADR-0122).
 *
 * `createWorkerDeps` never hands the client or adapter back, so the only
 * observable surface is the constructor/factory args. Technique: subclass the
 * real Anthropic to capture the client triple, and wrap
 * `createRealAnthropicAdapter` to capture the wire model + sampling while
 * delegating to the real implementation (so assembly stays a genuine run). The
 * injected-adapter test seam (`opts.model`) is NOT used here — these cases
 * exercise the default route-resolution branch.
 */
import assert from "node:assert/strict";
import { describe, it, beforeEach, vi } from "vitest";

const ctorOpts = vi.hoisted(() => [] as Array<Record<string, unknown>>);
const adapterArgs = vi.hoisted(() => [] as Array<Record<string, unknown>>);

vi.mock("@anthropic-ai/sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@anthropic-ai/sdk")>();
  class CapturingAnthropic extends actual.default {
    constructor(opts?: Record<string, unknown>) {
      super(opts as never);
      ctorOpts.push(opts ?? {});
    }
  }
  return { ...actual, default: CapturingAnthropic };
});

vi.mock(
  "../../src/harness/model-adapter/anthropic-adapter.ts",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("../../src/harness/model-adapter/anthropic-adapter.ts")
      >();
    return {
      ...actual,
      createRealAnthropicAdapter: (
        args: Parameters<typeof actual.createRealAnthropicAdapter>[0]
      ) => {
        adapterArgs.push(args as unknown as Record<string, unknown>);
        return actual.createRealAnthropicAdapter(args);
      },
    };
  }
);

import { buildThinkingParams } from "../../src/harness/model-adapter/anthropic-adapter.ts";
import { createSkillCatalog } from "../../src/harness/skill/catalog.ts";
import { createNoopTraceService } from "../../src/harness/trace/noop.ts";
import {
  createWorkerDeps,
  type CreateWorkerDepsOptions,
} from "../../src/harness/subagent/worker.ts";
import type { IknowEnv } from "../../src/config/env.ts";

/** Main-session transport the client must fall back to when no route resolved. */
const MAIN = {
  apiKey: "main-key",
  baseUrl: "http://main.test/v1",
  headers: { "X-Main": "m" },
};

function baseEnv(): IknowEnv {
  return {
    llm: {
      apiKey: MAIN.apiKey,
      baseUrl: MAIN.baseUrl,
      model: "main/main-model",
      headers: MAIN.headers,
      fallback: [],
      maxOutputTokens: 1024,
      temperature: 0.3,
      stream: "off",
      thinking: "off",
      thinkingEffort: "",
      maxTurns: undefined,
      timeoutMs: undefined,
    },
    web: { proxy: undefined, searchUrl: undefined },
    compress: { contextWindow: 200000, thresholdTokens: undefined },
    chat: { showThinking: false, quiet: false },
    mcp: { connectTimeoutMs: 60_000 },
    subagent: { taskTimeoutMs: undefined, maxConcurrentWorkers: 15 },
    workspaceRoot: undefined,
    productRoot: undefined,
  } as unknown as IknowEnv;
}

function probeOpts(
  env: IknowEnv,
  parentThinking?: { readonly mode: "off" | "adaptive"; readonly effort: string }
): CreateWorkerDepsOptions {
  return {
    env,
    sandboxRoot: "/tmp/sb-model-route",
    cwd: "/tmp/sb-model-route",
    userHome: "/tmp/sb-model-route",
    skillCatalog: createSkillCatalog([]),
    system: async () => undefined,
    trace: createNoopTraceService(),
    ...(parentThinking !== undefined ? { parentThinking } : {}),
  } as unknown as CreateWorkerDepsOptions;
}

beforeEach(() => {
  ctorOpts.length = 0;
  adapterArgs.length = 0;
});

describe("worker adapter route (settings.subagent.model)", () => {
  it("resolved route → wire model + client triple from route; thinking/maxTokens/temperature stay main", async () => {
    const env = baseEnv();
    env.subagent.model = {
      model: "sub/sub-model",
      baseUrl: "http://sub.test/v1",
      apiKey: "sub-key",
      headers: { "X-Sub": "s" },
    };
    await createWorkerDeps(probeOpts(env));

    assert.equal(adapterArgs.length, 1);
    assert.equal(ctorOpts.length, 1);
    assert.equal(adapterArgs[0]!.model, "sub-model"); // wireModelFromRoute(route)
    const client = ctorOpts[0]!;
    assert.equal(client.baseURL, "http://sub.test/v1");
    assert.equal(client.apiKey, "sub-key");
    assert.deepEqual(client.defaultHeaders, { "X-Sub": "s" });
    // host-level sampling remains the MAIN llm values even though the route differs.
    assert.equal(adapterArgs[0]!.maxTokens, env.llm.maxOutputTokens);
    assert.equal(adapterArgs[0]!.temperature, env.llm.temperature);
    assert.deepEqual(adapterArgs[0]!.thinking, buildThinkingParams(env.llm));
  });

  it("resolved route without headers → defaultHeaders key absent (does not borrow main headers)", async () => {
    const env = baseEnv();
    env.subagent.model = {
      model: "sub/sub-model",
      baseUrl: "http://sub.test/v1",
      apiKey: "sub-key",
    };
    await createWorkerDeps(probeOpts(env));
    assert.equal(
      Object.prototype.hasOwnProperty.call(ctorOpts[0]!, "defaultHeaders"),
      false
    );
  });

  it("absent route → wire model from llm.model and the main-session transport", async () => {
    const env = baseEnv();
    await createWorkerDeps(probeOpts(env));
    assert.equal(adapterArgs[0]!.model, "main-model");
    const client = ctorOpts[0]!;
    assert.equal(client.baseURL, "http://main.test/v1");
    assert.equal(client.apiKey, "main-key");
    assert.deepEqual(client.defaultHeaders, { "X-Main": "m" });
  });

  it("explicit subagent thinking settings override the parent's snapshot", async () => {
    const env = baseEnv();
    Object.assign(env.subagent, {
      thinking: "adaptive",
      thinkingEffort: "high",
    });

    await createWorkerDeps(
      probeOpts(env, { mode: "off", effort: "low" })
    );

    assert.deepEqual(adapterArgs[0]!.thinking, {
      mode: "adaptive",
      effort: "high",
    });
  });

  it("unset subagent settings inherit both parent thinking values", async () => {
    const env = baseEnv();

    await createWorkerDeps(
      probeOpts(env, { mode: "adaptive", effort: "xhigh" })
    );

    assert.deepEqual(adapterArgs[0]!.thinking, {
      mode: "adaptive",
      effort: "xhigh",
    });
  });

  it("effort-only subagent setting enables adaptive thinking", async () => {
    const env = baseEnv();
    Object.assign(env.subagent, { thinkingEffort: "medium" });

    await createWorkerDeps(
      probeOpts(env, { mode: "off", effort: "low" })
    );

    assert.deepEqual(adapterArgs[0]!.thinking, {
      mode: "adaptive",
      effort: "medium",
    });
  });

  it("mode-only subagent setting inherits the parent's effort", async () => {
    const env = baseEnv();
    Object.assign(env.subagent, { thinking: "adaptive" });

    await createWorkerDeps(
      probeOpts(env, { mode: "off", effort: "max" })
    );

    assert.deepEqual(adapterArgs[0]!.thinking, {
      mode: "adaptive",
      effort: "max",
    });
  });

  it("explicit off mode overrides an adaptive parent", async () => {
    const env = baseEnv();
    env.llm.thinking = "adaptive";
    env.llm.thinkingEffort = "low";
    Object.assign(env.subagent, { thinking: "off" });

    await createWorkerDeps(
      probeOpts(env, { mode: "adaptive", effort: "high" })
    );

    assert.equal(
      (adapterArgs[0]!.thinking as { readonly mode: string }).mode,
      "off"
    );
  });

  it("legacy worker without a parent snapshot falls back to env.llm thinking", async () => {
    const env = baseEnv();
    env.llm.thinking = "adaptive";
    env.llm.thinkingEffort = "max";

    await createWorkerDeps(probeOpts(env));

    assert.deepEqual(adapterArgs[0]!.thinking, buildThinkingParams(env.llm));
  });
});
