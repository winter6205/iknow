/**
 * Per-conversation model route resolution (ADR-0145 §7, spec invariant 5).
 *
 * `resolveLlmEnvForRoute(defaultEnv, route)` turns a `provider/model` route ID
 * into the env one conversation must run on: the route's own transport
 * (baseUrl / apiKey / headers / routeMaxTokens) plus every non-route field of
 * the default env (temperature / stream / thinking / thinkingEffort / fallback).
 *
 * Contract pinned here:
 *  - a route on a second provider takes that provider's transport, never the
 *    default provider's;
 *  - a route that does not resolve throws the typed `LlmProviderConfigError` —
 *    it never falls back to the default env (a silent fallback would be the
 *    original cross-conversation bug through a side door);
 *  - the default route resolves to exactly the env `loadIknowEnv` produced.
 *
 * Synthetic values only: the provider keys are placeholder strings owned by
 * this file's env var names.
 */
import assert from "node:assert/strict";
import { describe, it, beforeAll, afterAll } from "vitest";
import {
  isLlmProviderConfigError,
  loadIknowEnv,
  resolveLlmEnvForRoute,
} from "../../src/config/env.ts";
import type { IknowSettings } from "../../src/config/settings.ts";

const DEFAULT_KEY_ENV = "IKNOW_TEST_ROUTE_RESOLVE_DEFAULT_KEY";
const SECOND_KEY_ENV = "IKNOW_TEST_ROUTE_RESOLVE_SECOND_KEY";
const PLAIN_KEY_ENV = "IKNOW_TEST_ROUTE_RESOLVE_PLAIN_KEY";
const QUIET_KEY_ENV = "IKNOW_TEST_ROUTE_RESOLVE_QUIET_KEY";
const KEYLESS_ENV = "IKNOW_TEST_ROUTE_RESOLVE_NEVER_SET";

const DEFAULT_PROVIDER = {
  id: "primary",
  baseUrl: "http://primary.test/v1",
  apiKeyEnv: DEFAULT_KEY_ENV,
  headers: { "X-Default": "1" },
  models: [{ id: "default-model", maxTokens: 16_000 }],
};

const SECOND_PROVIDER = {
  id: "secondary",
  // trailing slash: the resolver must normalize it away like loadIknowEnv does
  baseUrl: "http://secondary.test/v1/",
  apiKeyEnv: SECOND_KEY_ENV,
  headers: { "X-Second": "2" },
  models: [{ id: "second-model", maxTokens: 64_000 }],
};

/** No headers configured: the route must not inherit the default provider's. */
const PLAIN_PROVIDER = {
  id: "plain",
  baseUrl: "http://plain.test/v1",
  apiKeyEnv: PLAIN_KEY_ENV,
  models: [{ id: "plain-model", maxTokens: 8_000 }],
};

/** Silent model entry: no maxTokens, so the route must not carry the default's. */
const QUIET_PROVIDER = {
  id: "quiet",
  baseUrl: "http://quiet.test/v1",
  apiKeyEnv: QUIET_KEY_ENV,
  models: [{ id: "quiet-model" }],
};

const KEYLESS_PROVIDER = {
  id: "keyless",
  baseUrl: "http://keyless.test/v1",
  apiKeyEnv: KEYLESS_ENV,
  models: [{ id: "k", maxTokens: 4_000 }],
};

function settings(): IknowSettings {
  return {
    llm: {
      model: "primary/default-model",
      fallback: ["primary/default-model"],
      providers: [
        DEFAULT_PROVIDER,
        SECOND_PROVIDER,
        PLAIN_PROVIDER,
        QUIET_PROVIDER,
        KEYLESS_PROVIDER,
      ],
    },
  };
}

function defaultEnv() {
  return loadIknowEnv(process.cwd(), settings());
}

describe("resolveLlmEnvForRoute — route transport + default env's other fields", () => {
  beforeAll(() => {
    process.env[DEFAULT_KEY_ENV] = "default-key";
    process.env[SECOND_KEY_ENV] = "second-key";
    process.env[PLAIN_KEY_ENV] = "plain-key";
    process.env[QUIET_KEY_ENV] = "quiet-key";
    delete process.env[KEYLESS_ENV];
    // pinned so the "non-route fields come from the default env" assertions
    // compare against known values instead of loader defaults
    process.env.IKNOW_LLM_TEMPERATURE = "0.4";
    process.env.IKNOW_LLM_THINKING = "adaptive";
    process.env.IKNOW_LLM_THINKING_EFFORT = "high";
    process.env.IKNOW_LLM_STREAM = "off";
  });
  afterAll(() => {
    delete process.env[DEFAULT_KEY_ENV];
    delete process.env[SECOND_KEY_ENV];
    delete process.env[PLAIN_KEY_ENV];
    delete process.env[QUIET_KEY_ENV];
    delete process.env[KEYLESS_ENV];
    delete process.env.IKNOW_LLM_TEMPERATURE;
    delete process.env.IKNOW_LLM_THINKING;
    delete process.env.IKNOW_LLM_THINKING_EFFORT;
    delete process.env.IKNOW_LLM_STREAM;
  });

  it("第二 provider 的路由 → 该 provider 的 baseUrl / apiKey / headers / routeMaxTokens，默认 env 的 temperature 等非路由字段不变", () => {
    const env = defaultEnv();
    const routeEnv = resolveLlmEnvForRoute(env, "secondary/second-model");

    assert.equal(routeEnv.llm.model, "secondary/second-model");
    assert.equal(routeEnv.llm.baseUrl, "http://secondary.test/v1");
    assert.equal(routeEnv.llm.apiKey, "second-key");
    assert.deepEqual(routeEnv.llm.headers, { "X-Second": "2" });
    assert.equal(routeEnv.llm.routeMaxTokens, 64_000);

    assert.equal(routeEnv.llm.temperature, 0.4);
    assert.equal(routeEnv.llm.temperature, env.llm.temperature);
    assert.equal(routeEnv.llm.thinking, "adaptive");
    assert.equal(routeEnv.llm.thinkingEffort, "high");
    assert.equal(routeEnv.llm.stream, "off");
    assert.deepEqual(routeEnv.llm.fallback, env.llm.fallback);
  });

  it("默认 provider 的字段不被路由结果继承：headers / routeMaxTokens 各自独立", () => {
    const env = defaultEnv();
    const routeEnv = resolveLlmEnvForRoute(env, "plain/plain-model");

    assert.equal("headers" in routeEnv.llm, false);
    assert.equal(routeEnv.llm.routeMaxTokens, 8_000);
    assert.notEqual(routeEnv.llm.routeMaxTokens, env.llm.routeMaxTokens);
  });

  it("路由条目静默 → routeMaxTokens 键缺席（不保留默认路由的数值）", () => {
    const env = defaultEnv();
    const routeEnv = resolveLlmEnvForRoute(env, "quiet/quiet-model");

    assert.equal("routeMaxTokens" in routeEnv.llm, false);
    assert.equal(env.llm.routeMaxTokens, 16_000);
  });

  it("解析不改动默认 env（无副作用）", () => {
    const env = defaultEnv();
    const snapshot = { ...env, llm: { ...env.llm } };

    const routeEnv = resolveLlmEnvForRoute(env, "secondary/second-model");

    assert.deepEqual(env, snapshot);
    assert.notEqual(routeEnv, env);
    assert.notEqual(routeEnv.llm, env.llm);
  });

  it("默认路由 → 结果与 loadIknowEnv 的输出逐字段相同（默认路径不受影响）", () => {
    const env = defaultEnv();
    const routeEnv = resolveLlmEnvForRoute(env, env.llm.model);

    assert.deepEqual(routeEnv, env);
  });
});

describe("resolveLlmEnvForRoute — 不解析的路由抛 typed error，不回落默认 env", () => {
  beforeAll(() => {
    process.env[DEFAULT_KEY_ENV] = "default-key";
    process.env[SECOND_KEY_ENV] = "second-key";
    delete process.env[KEYLESS_ENV];
  });
  afterAll(() => {
    delete process.env[DEFAULT_KEY_ENV];
    delete process.env[SECOND_KEY_ENV];
    delete process.env[KEYLESS_ENV];
  });

  it("未注册的 provider → 抛 LlmProviderConfigError（provider_model_not_registered）", () => {
    const env = defaultEnv();
    assert.throws(
      () => resolveLlmEnvForRoute(env, "ghost/ghost-model"),
      isLlmProviderConfigError
    );
    try {
      resolveLlmEnvForRoute(env, "ghost/ghost-model");
      assert.fail("expected resolveLlmEnvForRoute to throw");
    } catch (err) {
      assert.ok(isLlmProviderConfigError(err));
      assert.equal(err.kind, "provider_model_not_registered");
      if (err.kind !== "provider_model_not_registered")
        throw new Error("wrong kind");
      assert.equal(err.model, "ghost/ghost-model");
    }
  });

  it("路由 provider 已注册但 api-key env 未设 → 抛 provider_api_key_missing", () => {
    const env = defaultEnv();
    assert.throws(
      () => resolveLlmEnvForRoute(env, "keyless/k"),
      isLlmProviderConfigError
    );
    try {
      resolveLlmEnvForRoute(env, "keyless/k");
      assert.fail("expected resolveLlmEnvForRoute to throw");
    } catch (err) {
      assert.ok(isLlmProviderConfigError(err));
      assert.equal(err.kind, "provider_api_key_missing");
      if (err.kind !== "provider_api_key_missing")
        throw new Error("wrong kind");
      assert.equal(err.providerId, "keyless");
      assert.equal(err.apiKeyEnv, KEYLESS_ENV);
    }
  });

  it("非法路由（空串 / 全空白 / 无 provider 前缀 / 尾段空）→ 抛 typed error，不回落默认 env", () => {
    const env = defaultEnv();
    for (const bad of ["", "   ", "bare-model", "secondary/"]) {
      assert.throws(
        () => resolveLlmEnvForRoute(env, bad),
        isLlmProviderConfigError,
        `route=${JSON.stringify(bad)} 应抛 typed error`
      );
    }
  });
});
