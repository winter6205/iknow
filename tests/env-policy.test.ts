import { describe, it, beforeEach, afterEach } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  assertOfflineCompatible,
  assertToolProtocolSupported,
  getApiKey,
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
  "IKNOW_LLM_TEMPERATURE",
  "IKNOW_LLM_API_KEY_ENV",
  "IKNOW_EMBEDDING_API_KEY_ENV",
  "NINE_ROUTER_API_KEY",
  "IKNOW_TEST_EMB_KEY",
  "IKNOW_TEST_LLM_KEY",
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

describe("getApiKey + dotenv precedence", () => {
  beforeEach(() => {
    stashEnv();
    clearPolicyEnv();
  });
  afterEach(() => {
    restoreEnv();
  });

  it("getApiKey prefers process.env over fileMap", () => {
    process.env.IKNOW_TEST_LLM_KEY = "from-process";
    assert.equal(
      getApiKey("IKNOW_TEST_LLM_KEY", { IKNOW_TEST_LLM_KEY: "from-file" }),
      "from-process",
    );
  });

  it("getApiKey falls back to fileMap when process unset", () => {
    delete process.env.IKNOW_TEST_LLM_KEY;
    assert.equal(
      getApiKey("IKNOW_TEST_LLM_KEY", { IKNOW_TEST_LLM_KEY: "from-file" }),
      "from-file",
    );
  });

  it('getApiKey treats "yes" (any case) as unset placeholder', () => {
    process.env.IKNOW_TEST_LLM_KEY = "YES";
    assert.equal(getApiKey("IKNOW_TEST_LLM_KEY"), undefined);
    delete process.env.IKNOW_TEST_LLM_KEY;
    assert.equal(
      getApiKey("IKNOW_TEST_LLM_KEY", { IKNOW_TEST_LLM_KEY: "yes" }),
      undefined,
    );
  });

  it("getApiKey returns undefined for empty name or blank value", () => {
    assert.equal(getApiKey(""), undefined);
    process.env.IKNOW_TEST_LLM_KEY = "   ";
    assert.equal(getApiKey("IKNOW_TEST_LLM_KEY"), undefined);
  });

  it("loadIknowEnv: .env.local overrides .env; process still wins", () => {
    const dir = mkdtempSync(join(tmpdir(), "iknow-env-"));
    try {
      writeFileSync(
        join(dir, ".env"),
        "IKNOW_LLM_MODEL=from-env\nIKNOW_LLM_PROVIDER=base\n",
      );
      writeFileSync(
        join(dir, ".env.local"),
        "IKNOW_LLM_MODEL=from-local\n",
      );
      const env = loadIknowEnv(dir);
      assert.equal(env.llm.model, "from-local");
      assert.equal(env.llm.provider, "base");

      process.env.IKNOW_LLM_MODEL = "from-process";
      // KEYS doesn't include IKNOW_LLM_MODEL — restore manually
      try {
        const env2 = loadIknowEnv(dir);
        assert.equal(env2.llm.model, "from-process");
      } finally {
        delete process.env.IKNOW_LLM_MODEL;
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("loadIknowEnv resolves apiKey from dotenv fileMap", () => {
    const dir = mkdtempSync(join(tmpdir(), "iknow-env-key-"));
    try {
      writeFileSync(
        join(dir, ".env.local"),
        [
          "IKNOW_LLM_API_KEY_ENV=IKNOW_TEST_LLM_KEY",
          "IKNOW_TEST_LLM_KEY=secret-from-dotenv",
          "IKNOW_EMBEDDING_MODE=api",
          "IKNOW_EMBEDDING_API_KEY_ENV=IKNOW_TEST_EMB_KEY",
          "IKNOW_TEST_EMB_KEY=emb-secret-from-dotenv",
          "",
        ].join("\n"),
      );
      delete process.env.IKNOW_TEST_LLM_KEY;
      delete process.env.IKNOW_TEST_EMB_KEY;
      const env = loadIknowEnv(dir);
      assert.equal(env.llm.apiKey, "secret-from-dotenv");
      assert.equal(env.embedding.apiKey, "emb-secret-from-dotenv");
      assert.equal(env.embedding.mode, "api");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("loadIknowEnv parses temperature as float via envNumber", () => {
    process.env.IKNOW_LLM_TEMPERATURE = "0.7";
    const env = loadIknowEnv();
    assert.equal(env.llm.temperature, 0.7);
  });
});
