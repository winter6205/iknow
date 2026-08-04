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
