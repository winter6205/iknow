import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  assertOfflineCompatible,
  assertToolProtocolSupported,
  loadIknowEnv,
} from "../src/config/env.ts";
import { createIknowRuntime } from "../src/runtime/create-runtime.ts";
import { ValidationError } from "../src/shared/errors.ts";
import { LlmIknowAgent } from "../src/agent-loop/llm-agent.ts";
import { createSeededStore } from "../src/fixtures/seed-kb.ts";
import { createSession } from "../src/agent-loop/session.ts";
import type { LlmChatClient } from "../src/agent-loop/llm-client.ts";

const KEYS = [
  "IKNOW_REQUIRE_OFFLINE",
  "IKNOW_AGENT_MODE",
  "IKNOW_EMBEDDING_MODE",
  "IKNOW_LLM_TOOL_PROTOCOL",
  "IKNOW_EMBEDDING_API_KEY_ENV",
  "NINE_ROUTER_API_KEY",
  "IKNOW_TEST_EMB_KEY",
] as const;

const saved: Partial<Record<(typeof KEYS)[number], string | undefined>> = {};

function stashEnv(): void {
  for (const k of KEYS) {
    saved[k] = process.env[k];
  }
}

function restoreEnv(): void {
  for (const k of KEYS) {
    const v = saved[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

function clearPolicyEnv(): void {
  for (const k of KEYS) {
    delete process.env[k];
  }
}

describe("offline + tool protocol policy", () => {
  beforeEach(() => {
    stashEnv();
    clearPolicyEnv();
  });
  afterEach(() => {
    restoreEnv();
  });

  it("assertOfflineCompatible throws for llm when requireOffline", () => {
    process.env.IKNOW_REQUIRE_OFFLINE = "true";
    process.env.IKNOW_AGENT_MODE = "llm";
    const env = loadIknowEnv();
    assert.equal(env.requireOffline, true);
    assert.equal(env.agentMode, "llm");
    assert.throws(
      () => assertOfflineCompatible(env),
      (e: unknown) =>
        e instanceof ValidationError &&
        e.message.includes("IKNOW_REQUIRE_OFFLINE") &&
        e.message.includes("agentMode=llm"),
    );
  });

  it("assertOfflineCompatible throws for embedding api when requireOffline", () => {
    process.env.IKNOW_REQUIRE_OFFLINE = "true";
    process.env.IKNOW_EMBEDDING_MODE = "api";
    process.env.IKNOW_EMBEDDING_API_KEY_ENV = "IKNOW_TEST_EMB_KEY";
    process.env.IKNOW_TEST_EMB_KEY = "test-not-a-real-key";
    const env = loadIknowEnv();
    assert.equal(env.embedding.mode, "api");
    assert.throws(
      () => assertOfflineCompatible(env),
      (e: unknown) =>
        e instanceof ValidationError &&
        e.message.includes("embedding mode=api"),
    );
  });

  it("createIknowRuntime fails closed on offline+llm", async () => {
    process.env.IKNOW_REQUIRE_OFFLINE = "true";
    process.env.IKNOW_AGENT_MODE = "llm";
    await assert.rejects(
      () => createIknowRuntime({ enableEmbeddings: false }),
      (e: unknown) => e instanceof ValidationError,
    );
  });

  it("assertToolProtocolSupported rejects anthropic_tools", () => {
    assert.throws(
      () => assertToolProtocolSupported("anthropic_tools"),
      (e: unknown) =>
        e instanceof ValidationError &&
        e.message === "anthropic_tools not implemented; use openai_tools",
    );
  });

  it("LlmIknowAgent rejects anthropic_tools", () => {
    const mock: LlmChatClient = {
      async chat() {
        return { content: "x" };
      },
    };
    assert.throws(
      () =>
        new LlmIknowAgent({
          store: createSeededStore(),
          session: createSession("employee"),
          llm: mock,
          toolProtocol: "anthropic_tools",
        }),
      (e: unknown) =>
        e instanceof ValidationError &&
        e.message === "anthropic_tools not implemented; use openai_tools",
    );
  });

  it("openai_tools is accepted", () => {
    assert.doesNotThrow(() => assertToolProtocolSupported("openai_tools"));
  });
});
