/**
 * env.ts thinking/effort env read + 非法值回退 (#151 T4)。
 *
 * 验证 IKNOW_LLM_THINKING / IKNOW_LLM_THINKING_EFFORT 的解析:
 *  - 默认 off / 空 effort;
 *  - 合法值原样透传;
 *  - 非法值回退(THINKING 非法 → off;EFFORT 非法 → 空)。
 *
 * 不构造真实 .env 文件,直接通过 process.env 控制输入(loadIknowEnv 读
 * process.env > .env.local > .env;此处只设 process.env,无需 .env)。
 */

import { afterEach, beforeEach, describe, it } from "vitest";
import assert from "node:assert/strict";
import { loadIknowEnv } from "../../src/config/env.ts";

const ENV_KEYS = [
  "IKNOW_LLM_THINKING",
  "IKNOW_LLM_THINKING_EFFORT",
  "IKNOW_CHAT_SHOW_THINKING",
  // #179 T6: streaming arm env (default on, invalid → on).
  "IKNOW_LLM_STREAM",
  "IKNOW_WEB_SEARCH_URL",
  // #119 T1: compression config env keys.
  "IKNOW_MODEL_CONTEXT_WINDOW",
  "IKNOW_AUTO_COMPACT_THRESHOLD_TOKENS",
] as const;

describe("loadIknowEnv — thinking config (#151 T4)", () => {
  beforeEach(() => {
    for (const k of ENV_KEYS) delete process.env[k];
  });
  afterEach(() => {
    for (const k of ENV_KEYS) delete process.env[k];
  });

  it("default: thinking=off, effort=空(均未设 env)", () => {
    const env = loadIknowEnv();
    assert.equal(env.llm.thinking, "off");
    assert.equal(env.llm.thinkingEffort, "");
  });

  it("explicit adaptive 通过", () => {
    process.env.IKNOW_LLM_THINKING = "adaptive";
    const env = loadIknowEnv();
    assert.equal(env.llm.thinking, "adaptive");
    assert.equal(env.llm.thinkingEffort, "");
  });

  it("explicit off 仍 off", () => {
    process.env.IKNOW_LLM_THINKING = "off";
    const env = loadIknowEnv();
    assert.equal(env.llm.thinking, "off");
  });

  it("THINKING 非法值 → 回退 off 且不崩溃", () => {
    process.env.IKNOW_LLM_THINKING = "garbage";
    const env = loadIknowEnv();
    assert.equal(env.llm.thinking, "off");
  });

  it("EFFORT 五个合法值均原样透传", () => {
    for (const v of ["low", "medium", "high", "xhigh", "max"]) {
      process.env.IKNOW_LLM_THINKING_EFFORT = v;
      const env = loadIknowEnv();
      assert.equal(env.llm.thinkingEffort, v, `effort=${v} 应透传`);
    }
  });

  it("EFFORT 非法值 → 视同空(不发送)", () => {
    process.env.IKNOW_LLM_THINKING_EFFORT = "extreme";
    const env = loadIknowEnv();
    assert.equal(env.llm.thinkingEffort, "");
  });

  it("THINKING 与 EFFORT 独立:off + 合法 effort 不报错,但 effort 不发送(adapter 决定)", () => {
    process.env.IKNOW_LLM_THINKING = "off";
    process.env.IKNOW_LLM_THINKING_EFFORT = "high";
    const env = loadIknowEnv();
    assert.equal(env.llm.thinking, "off");
    assert.equal(env.llm.thinkingEffort, "high");
  });
});

describe("loadIknowEnv — chat show-thinking flag (#152 T5)", () => {
  beforeEach(() => {
    for (const k of ENV_KEYS) delete process.env[k];
  });
  afterEach(() => {
    for (const k of ENV_KEYS) delete process.env[k];
  });

  it("default: chat.showThinking=false (env 不设时)", () => {
    const env = loadIknowEnv();
    assert.equal(env.chat.showThinking, false);
  });

  it("explicit on: 通过", () => {
    process.env.IKNOW_CHAT_SHOW_THINKING = "on";
    const env = loadIknowEnv();
    assert.equal(env.chat.showThinking, true);
  });

  it("explicit off: 仍 off", () => {
    process.env.IKNOW_CHAT_SHOW_THINKING = "off";
    const env = loadIknowEnv();
    assert.equal(env.chat.showThinking, false);
  });

  it("大小写不敏感:ON / On 同 ON", () => {
    process.env.IKNOW_CHAT_SHOW_THINKING = "ON";
    const env = loadIknowEnv();
    assert.equal(env.chat.showThinking, true);
  });

  it("非法值 → 回退 off (不抛错)", () => {
    process.env.IKNOW_CHAT_SHOW_THINKING = "garbage";
    const env = loadIknowEnv();
    assert.equal(env.chat.showThinking, false);
  });
});

describe("loadIknowEnv — LLM stream flag (#179 T6 / #147 D0)", () => {
  beforeEach(() => {
    for (const k of ENV_KEYS) delete process.env[k];
  });
  afterEach(() => {
    for (const k of ENV_KEYS) delete process.env[k];
  });

  it("default: stream=on (env 不设时)", () => {
    const env = loadIknowEnv();
    assert.equal(env.llm.stream, "on");
  });

  it("explicit on: 通过", () => {
    process.env.IKNOW_LLM_STREAM = "on";
    const env = loadIknowEnv();
    assert.equal(env.llm.stream, "on");
  });

  it("explicit off → off", () => {
    process.env.IKNOW_LLM_STREAM = "off";
    const env = loadIknowEnv();
    assert.equal(env.llm.stream, "off");
  });

  it("大小写不敏感:OFF / On 生效", () => {
    process.env.IKNOW_LLM_STREAM = "OFF";
    assert.equal(loadIknowEnv().llm.stream, "off");
    process.env.IKNOW_LLM_STREAM = "On";
    assert.equal(loadIknowEnv().llm.stream, "on");
  });

  it("非法值(yes / 1 / garbage)→ 回退 on,不抛错", () => {
    for (const v of ["yes", "1", "garbage"]) {
      process.env.IKNOW_LLM_STREAM = v;
      const env = loadIknowEnv();
      assert.equal(env.llm.stream, "on", `stream=${v} 应回退 on`);
    }
  });
});

describe("loadIknowEnv — web.searchUrl (ACI web_search 端点覆写)", () => {
  beforeEach(() => {
    for (const k of ENV_KEYS) delete process.env[k];
  });
  afterEach(() => {
    for (const k of ENV_KEYS) delete process.env[k];
  });

  it("default: web.searchUrl=undefined (env 不设时)", () => {
    const env = loadIknowEnv();
    assert.equal(env.web.searchUrl, undefined);
  });

  it("explicit 端点原样透传", () => {
    process.env.IKNOW_WEB_SEARCH_URL = "https://html.duckduckgo.com/html/";
    const env = loadIknowEnv();
    assert.equal(env.web.searchUrl, "https://html.duckduckgo.com/html/");
  });

  it("空串 → undefined（区别于有值）", () => {
    process.env.IKNOW_WEB_SEARCH_URL = "";
    const env = loadIknowEnv();
    assert.equal(env.web.searchUrl, undefined);
  });
});

describe("loadIknowEnv — compress config (#119 T1)", () => {
  beforeEach(() => {
    for (const k of ENV_KEYS) delete process.env[k];
  });
  afterEach(() => {
    for (const k of ENV_KEYS) delete process.env[k];
  });

  it("default: contextWindow=200000, thresholdTokens=undefined(均未设 env)", () => {
    const env = loadIknowEnv();
    assert.equal(env.compress.contextWindow, 200000);
    assert.equal(env.compress.thresholdTokens, undefined);
  });

  it("显式 IKNOW_MODEL_CONTEXT_WINDOW=300000 → env.compress.contextWindow=300000", () => {
    process.env.IKNOW_MODEL_CONTEXT_WINDOW = "300000";
    const env = loadIknowEnv();
    assert.equal(env.compress.contextWindow, 300000);
  });

  it("显式 IKNOW_AUTO_COMPACT_THRESHOLD_TOKENS=150000 → env.compress.thresholdTokens=150000", () => {
    process.env.IKNOW_AUTO_COMPACT_THRESHOLD_TOKENS = "150000";
    const env = loadIknowEnv();
    assert.equal(env.compress.thresholdTokens, 150000);
  });

  it("非数字字符串（如 'abc'）→ contextWindow 回退 200000（对齐 envInt 既有纪律）", () => {
    process.env.IKNOW_MODEL_CONTEXT_WINDOW = "abc";
    const env = loadIknowEnv();
    assert.equal(env.compress.contextWindow, 200000);
  });

  it("IKNOW_AUTO_COMPACT_THRESHOLD_TOKENS 非数字 → undefined（可选 int 非法回退）", () => {
    process.env.IKNOW_AUTO_COMPACT_THRESHOLD_TOKENS = "not-a-number";
    const env = loadIknowEnv();
    assert.equal(env.compress.thresholdTokens, undefined);
  });

  it("IKNOW_AUTO_COMPACT_THRESHOLD_TOKENS 空串 → undefined（与未设同义）", () => {
    process.env.IKNOW_AUTO_COMPACT_THRESHOLD_TOKENS = "";
    const env = loadIknowEnv();
    assert.equal(env.compress.thresholdTokens, undefined);
  });

  it("阈值 vs 窗口独立:显式 thresholdTokens 不影响 contextWindow", () => {
    process.env.IKNOW_MODEL_CONTEXT_WINDOW = "500000";
    process.env.IKNOW_AUTO_COMPACT_THRESHOLD_TOKENS = "100000";
    const env = loadIknowEnv();
    assert.equal(env.compress.contextWindow, 500000);
    assert.equal(env.compress.thresholdTokens, 100000);
  });
});
