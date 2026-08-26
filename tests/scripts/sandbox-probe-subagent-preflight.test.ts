/**
 * scripts/sandbox-probe-subagent.ts 的上游预检契约。
 *
 * 为什么需要:预检决定整个探针跑不跑。它必须和 worker 说同一种协议 ——
 * worker 走 `new Anthropic({ baseURL: env.llm.baseUrl })`,SDK 打的是
 * `${baseUrl}/v1/messages` + `x-api-key`。预检若改打 OpenAI 形态的
 * `${baseUrl}/chat/completions` + Bearer,在 Anthropic 形态的网关上恒 404,
 * 探针永远 not-run,且把 404 误报成 "429/quota"。
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
    // 404 是"端点打错了",不是配额 —— 旧实现把它一并叫 429/quota,
    // 于是在 Anthropic 形态网关上误导排查方向整整 10 分钟。
    assert.equal(classifyPreflightStatus(404), "not-found");
    assert.equal(classifyPreflightStatus(500), "unavailable");
  });
});
