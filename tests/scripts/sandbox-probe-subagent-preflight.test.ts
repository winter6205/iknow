/**
 * Upstream preflight contract for scripts/sandbox-probe-subagent.ts.
 *
 * Why it matters: the preflight decides whether the whole probe runs. It must
 * speak the same protocol as the worker — the worker uses
 * `new Anthropic({ baseURL: env.llm.baseUrl })`, so the SDK hits
 * `${baseUrl}/v1/messages` + `x-api-key`. If the preflight instead used the
 * OpenAI-shaped `${baseUrl}/chat/completions` + Bearer, it would 404 forever on
 * an Anthropic-shaped gateway: the probe never runs, and the 404 gets
 * mis-reported as "429/quota".
 */
import assert from "node:assert/strict";
import { describe, it } from "vitest";

import {
  buildPreflightRequest,
  classifyPreflightStatus,
} from "../../scripts/sandbox-probe-subagent.ts";

const env = {
  llm: {
    apiKey: "test-key",
    baseUrl: "https://api.example.com/anthropic",
    model: "test-model",
  },
};

describe("sandbox-probe-subagent 上游预检", () => {
  it("打 Anthropic Messages 端点,与 worker 的 SDK 客户端同一协议面", () => {
    const req = buildPreflightRequest(env);
    assert.equal(req.url, "https://api.example.com/anthropic/v1/messages");
    assert.equal(req.headers["x-api-key"], "test-key");
    assert.ok(req.headers["anthropic-version"], "必须带 anthropic-version");
    assert.equal(
      req.headers.Authorization,
      undefined,
      "Anthropic 端点不认 Bearer"
    );
    const body = JSON.parse(req.body) as Record<string, unknown>;
    assert.equal(body.model, "test-model");
    assert.equal(typeof body.max_tokens, "number");
    assert.ok(Array.isArray(body.messages));
  });

  it("baseUrl 末尾斜杠归一,不出现 // ", () => {
    const req = buildPreflightRequest({
      llm: { ...env.llm, baseUrl: "https://api.example.com/anthropic/" },
    });
    assert.equal(req.url, "https://api.example.com/anthropic/v1/messages");
  });

  it("apiKey 缺席时不把 undefined 塞进 header", () => {
    const req = buildPreflightRequest({
      llm: { baseUrl: env.llm.baseUrl, model: env.llm.model },
    });
    assert.equal(req.headers["x-api-key"], "");
  });

  it("响应状态分类区分 quota / 配置错 / 其它不可用", () => {
    assert.equal(classifyPreflightStatus(200), "ok");
    assert.equal(classifyPreflightStatus(429), "quota");
    assert.equal(classifyPreflightStatus(401), "unauthorized");
    assert.equal(classifyPreflightStatus(403), "unauthorized");
    // 404 means "wrong endpoint", not quota — the old implementation lumped it
    // into 429/quota, sending debugging in the wrong direction on Anthropic-shaped gateways.
    assert.equal(classifyPreflightStatus(404), "not-found");
    assert.equal(classifyPreflightStatus(500), "unavailable");
  });
});
