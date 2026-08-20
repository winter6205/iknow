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
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadIknowEnv } from "../../src/config/env.ts";
import {
  loadIknowSettings,
  type IknowSettings,
} from "../../src/config/settings.ts";

/**
 * #353 review: 既有 env 测试不测 settings，统一注入最小 settings 以隔离
 * 真实 `~/.iknow/settings.json` / `<cwd>/.iknow/settings.json`（避免本地配置
 * 污染导致断言非确定）。loadIknowEnv 传 settings 时跳过文件读取。
 * 含最小 `llm.model`（env loader fail-fast：model 必须有来源，否则 loader 抛错）。
 */
const EMPTY_SETTINGS: IknowSettings = { llm: { model: "test-model" } };

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
  // plan T5: maxTurns env (optional int; unset → undefined = 无限).
  "IKNOW_LLM_MAX_TURNS",
  // #378 根因 B: MCP 连接超时 env (int; 非法 → fallback 60_000)。
  "IKNOW_MCP_CONNECT_TIMEOUT_MS",
  // #358 T1: settings 双字段通道 — llm.timeoutMs (per-call) + subagent.taskTimeoutMs (per-task)。
  "IKNOW_LLM_TIMEOUT_MS",
  "IKNOW_SUBAGENT_TASK_TIMEOUT_MS",
] as const;

describe("loadIknowEnv — thinking config (#151 T4)", () => {
  beforeEach(() => {
    for (const k of ENV_KEYS) delete process.env[k];
  });
  afterEach(() => {
    for (const k of ENV_KEYS) delete process.env[k];
  });

  it("default: thinking=off, effort=空(均未设 env)", () => {
    const env = loadIknowEnv(process.cwd(), EMPTY_SETTINGS);
    assert.equal(env.llm.thinking, "off");
    assert.equal(env.llm.thinkingEffort, "");
  });

  it("explicit adaptive 通过", () => {
    process.env.IKNOW_LLM_THINKING = "adaptive";
    const env = loadIknowEnv(process.cwd(), EMPTY_SETTINGS);
    assert.equal(env.llm.thinking, "adaptive");
    assert.equal(env.llm.thinkingEffort, "");
  });

  it("explicit off 仍 off", () => {
    process.env.IKNOW_LLM_THINKING = "off";
    const env = loadIknowEnv(process.cwd(), EMPTY_SETTINGS);
    assert.equal(env.llm.thinking, "off");
  });

  it("THINKING 非法值 → 回退 off 且不崩溃", () => {
    process.env.IKNOW_LLM_THINKING = "garbage";
    const env = loadIknowEnv(process.cwd(), EMPTY_SETTINGS);
    assert.equal(env.llm.thinking, "off");
  });

  it("EFFORT 五个合法值均原样透传", () => {
    for (const v of ["low", "medium", "high", "xhigh", "max"]) {
      process.env.IKNOW_LLM_THINKING_EFFORT = v;
      const env = loadIknowEnv(process.cwd(), EMPTY_SETTINGS);
      assert.equal(env.llm.thinkingEffort, v, `effort=${v} 应透传`);
    }
  });

  it("EFFORT 非法值 → 视同空(不发送)", () => {
    process.env.IKNOW_LLM_THINKING_EFFORT = "extreme";
    const env = loadIknowEnv(process.cwd(), EMPTY_SETTINGS);
    assert.equal(env.llm.thinkingEffort, "");
  });

  it("THINKING 与 EFFORT 独立:off + 合法 effort 不报错,但 effort 不发送(adapter 决定)", () => {
    process.env.IKNOW_LLM_THINKING = "off";
    process.env.IKNOW_LLM_THINKING_EFFORT = "high";
    const env = loadIknowEnv(process.cwd(), EMPTY_SETTINGS);
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
    const env = loadIknowEnv(process.cwd(), EMPTY_SETTINGS);
    assert.equal(env.chat.showThinking, false);
  });

  it("explicit on: 通过", () => {
    process.env.IKNOW_CHAT_SHOW_THINKING = "on";
    const env = loadIknowEnv(process.cwd(), EMPTY_SETTINGS);
    assert.equal(env.chat.showThinking, true);
  });

  it("explicit off: 仍 off", () => {
    process.env.IKNOW_CHAT_SHOW_THINKING = "off";
    const env = loadIknowEnv(process.cwd(), EMPTY_SETTINGS);
    assert.equal(env.chat.showThinking, false);
  });

  it("大小写不敏感:ON / On 同 ON", () => {
    process.env.IKNOW_CHAT_SHOW_THINKING = "ON";
    const env = loadIknowEnv(process.cwd(), EMPTY_SETTINGS);
    assert.equal(env.chat.showThinking, true);
  });

  it("非法值 → 回退 off (不抛错)", () => {
    process.env.IKNOW_CHAT_SHOW_THINKING = "garbage";
    const env = loadIknowEnv(process.cwd(), EMPTY_SETTINGS);
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
    const env = loadIknowEnv(process.cwd(), EMPTY_SETTINGS);
    assert.equal(env.llm.stream, "on");
  });

  it("explicit on: 通过", () => {
    process.env.IKNOW_LLM_STREAM = "on";
    const env = loadIknowEnv(process.cwd(), EMPTY_SETTINGS);
    assert.equal(env.llm.stream, "on");
  });

  it("explicit off → off", () => {
    process.env.IKNOW_LLM_STREAM = "off";
    const env = loadIknowEnv(process.cwd(), EMPTY_SETTINGS);
    assert.equal(env.llm.stream, "off");
  });

  it("大小写不敏感:OFF / On 生效", () => {
    process.env.IKNOW_LLM_STREAM = "OFF";
    assert.equal(loadIknowEnv(process.cwd(), EMPTY_SETTINGS).llm.stream, "off");
    process.env.IKNOW_LLM_STREAM = "On";
    assert.equal(loadIknowEnv(process.cwd(), EMPTY_SETTINGS).llm.stream, "on");
  });

  it("非法值(yes / 1 / garbage)→ 回退 on,不抛错", () => {
    for (const v of ["yes", "1", "garbage"]) {
      process.env.IKNOW_LLM_STREAM = v;
      const env = loadIknowEnv(process.cwd(), EMPTY_SETTINGS);
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
    const env = loadIknowEnv(process.cwd(), EMPTY_SETTINGS);
    assert.equal(env.web.searchUrl, undefined);
  });

  it("explicit 端点原样透传", () => {
    process.env.IKNOW_WEB_SEARCH_URL = "https://html.duckduckgo.com/html/";
    const env = loadIknowEnv(process.cwd(), EMPTY_SETTINGS);
    assert.equal(env.web.searchUrl, "https://html.duckduckgo.com/html/");
  });

  it("空串 → undefined（区别于有值）", () => {
    process.env.IKNOW_WEB_SEARCH_URL = "";
    const env = loadIknowEnv(process.cwd(), EMPTY_SETTINGS);
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
    const env = loadIknowEnv(process.cwd(), EMPTY_SETTINGS);
    assert.equal(env.compress.contextWindow, 200000);
    assert.equal(env.compress.thresholdTokens, undefined);
  });

  it("显式 IKNOW_MODEL_CONTEXT_WINDOW=300000 → env.compress.contextWindow=300000", () => {
    process.env.IKNOW_MODEL_CONTEXT_WINDOW = "300000";
    const env = loadIknowEnv(process.cwd(), EMPTY_SETTINGS);
    assert.equal(env.compress.contextWindow, 300000);
  });

  it("显式 IKNOW_AUTO_COMPACT_THRESHOLD_TOKENS=150000 → env.compress.thresholdTokens=150000", () => {
    process.env.IKNOW_AUTO_COMPACT_THRESHOLD_TOKENS = "150000";
    const env = loadIknowEnv(process.cwd(), EMPTY_SETTINGS);
    assert.equal(env.compress.thresholdTokens, 150000);
  });

  it("非数字字符串（如 'abc'）→ contextWindow 回退 200000（对齐 envInt 既有纪律）", () => {
    process.env.IKNOW_MODEL_CONTEXT_WINDOW = "abc";
    const env = loadIknowEnv(process.cwd(), EMPTY_SETTINGS);
    assert.equal(env.compress.contextWindow, 200000);
  });

  it("IKNOW_AUTO_COMPACT_THRESHOLD_TOKENS 非数字 → undefined（可选 int 非法回退）", () => {
    process.env.IKNOW_AUTO_COMPACT_THRESHOLD_TOKENS = "not-a-number";
    const env = loadIknowEnv(process.cwd(), EMPTY_SETTINGS);
    assert.equal(env.compress.thresholdTokens, undefined);
  });

  it("IKNOW_AUTO_COMPACT_THRESHOLD_TOKENS 空串 → undefined（与未设同义）", () => {
    process.env.IKNOW_AUTO_COMPACT_THRESHOLD_TOKENS = "";
    const env = loadIknowEnv(process.cwd(), EMPTY_SETTINGS);
    assert.equal(env.compress.thresholdTokens, undefined);
  });

  it("阈值 vs 窗口独立:显式 thresholdTokens 不影响 contextWindow", () => {
    process.env.IKNOW_MODEL_CONTEXT_WINDOW = "500000";
    process.env.IKNOW_AUTO_COMPACT_THRESHOLD_TOKENS = "100000";
    const env = loadIknowEnv(process.cwd(), EMPTY_SETTINGS);
    assert.equal(env.compress.contextWindow, 500000);
    assert.equal(env.compress.thresholdTokens, 100000);
  });
});

describe("loadIknowEnv — maxTurns (plan T5)", () => {
  beforeEach(() => {
    for (const k of ENV_KEYS) delete process.env[k];
  });
  afterEach(() => {
    for (const k of ENV_KEYS) delete process.env[k];
  });

  it("default: llm.maxTurns=undefined(env 不设时 = 无限)", () => {
    const env = loadIknowEnv(process.cwd(), EMPTY_SETTINGS);
    assert.equal(env.llm.maxTurns, undefined);
  });

  it("IKNOW_LLM_MAX_TURNS=3 → llm.maxTurns=3", () => {
    process.env.IKNOW_LLM_MAX_TURNS = "3";
    const env = loadIknowEnv(process.cwd(), EMPTY_SETTINGS);
    assert.equal(env.llm.maxTurns, 3);
  });

  it("IKNOW_LLM_MAX_TURNS=120 → llm.maxTurns=120", () => {
    process.env.IKNOW_LLM_MAX_TURNS = "120";
    const env = loadIknowEnv(process.cwd(), EMPTY_SETTINGS);
    assert.equal(env.llm.maxTurns, 120);
  });

  it("IKNOW_LLM_MAX_TURNS 空串 → undefined(与未设同义)", () => {
    process.env.IKNOW_LLM_MAX_TURNS = "";
    const env = loadIknowEnv(process.cwd(), EMPTY_SETTINGS);
    assert.equal(env.llm.maxTurns, undefined);
  });

  it("IKNOW_LLM_MAX_TURNS 非数字 (abc) → undefined(envOptionalInt 回退纪律)", () => {
    process.env.IKNOW_LLM_MAX_TURNS = "abc";
    const env = loadIknowEnv(process.cwd(), EMPTY_SETTINGS);
    assert.equal(env.llm.maxTurns, undefined);
  });

  it("IKNOW_LLM_MAX_TURNS 小数 (3.7) → trunc 为 3(envOptionalInt 用 trunc)", () => {
    process.env.IKNOW_LLM_MAX_TURNS = "3.7";
    const env = loadIknowEnv(process.cwd(), EMPTY_SETTINGS);
    assert.equal(env.llm.maxTurns, 3);
  });

  it("maxTurns 与其它 LLM env 字段独立(不影响 maxOutputTokens / timeoutMs / temperature)", () => {
    process.env.IKNOW_LLM_MAX_TURNS = "5";
    process.env.IKNOW_LLM_MAX_OUTPUT_TOKENS = "1024";
    process.env.IKNOW_LLM_TIMEOUT_MS = "30000";
    const env = loadIknowEnv(process.cwd(), EMPTY_SETTINGS);
    assert.equal(env.llm.maxTurns, 5);
    assert.equal(env.llm.maxOutputTokens, 1024);
    assert.equal(env.llm.timeoutMs, 30000);
  });
});

describe("loadIknowEnv — llm.timeoutMs (#358 settings 双字段, per-call)", () => {
  beforeEach(() => {
    for (const k of ENV_KEYS) delete process.env[k];
  });
  afterEach(() => {
    for (const k of ENV_KEYS) delete process.env[k];
  });

  it("default: env 不设且 settings 未配 → 300000 fallback（third-tier 默认）", () => {
    const env = loadIknowEnv(process.cwd(), EMPTY_SETTINGS);
    assert.equal(env.llm.timeoutMs, 300_000);
  });

  it("IKNOW_LLM_TIMEOUT_MS=30000 → env.llm.timeoutMs=30000", () => {
    process.env.IKNOW_LLM_TIMEOUT_MS = "30000";
    const env = loadIknowEnv(process.cwd(), EMPTY_SETTINGS);
    assert.equal(env.llm.timeoutMs, 30_000);
  });

  it("IKNOW_LLM_TIMEOUT_MS=7200000 → env.llm.timeoutMs=7200000（per-call 大值）", () => {
    process.env.IKNOW_LLM_TIMEOUT_MS = "7200000";
    const env = loadIknowEnv(process.cwd(), EMPTY_SETTINGS);
    assert.equal(env.llm.timeoutMs, 7_200_000);
  });

  it("IKNOW_LLM_TIMEOUT_MS 空串 → 300000（fallback，与未设同义）", () => {
    process.env.IKNOW_LLM_TIMEOUT_MS = "";
    const env = loadIknowEnv(process.cwd(), EMPTY_SETTINGS);
    assert.equal(env.llm.timeoutMs, 300_000);
  });

  it("IKNOW_LLM_TIMEOUT_MS 非数字 (abc) → 300000 fallback", () => {
    process.env.IKNOW_LLM_TIMEOUT_MS = "abc";
    const env = loadIknowEnv(process.cwd(), EMPTY_SETTINGS);
    assert.equal(env.llm.timeoutMs, 300_000);
  });

  it("IKNOW_LLM_TIMEOUT_MS 小数 (30000.7) → trunc 为 30000（envOptionalInt 用 trunc）", () => {
    process.env.IKNOW_LLM_TIMEOUT_MS = "30000.7";
    const env = loadIknowEnv(process.cwd(), EMPTY_SETTINGS);
    assert.equal(env.llm.timeoutMs, 30_000);
  });

  it("env > settings：settings 设了 45000、env 设了 30000 → env wins", () => {
    process.env.IKNOW_LLM_TIMEOUT_MS = "30000";
    const env = loadIknowEnv(process.cwd(), {
      llm: { model: "test-model", timeoutMs: 45_000 },
    });
    assert.equal(env.llm.timeoutMs, 30_000);
  });

  it("env 不设、settings 设了 → settings wins（45000）", () => {
    const env = loadIknowEnv(process.cwd(), {
      llm: { model: "test-model", timeoutMs: 45_000 },
    });
    assert.equal(env.llm.timeoutMs, 45_000);
  });

  it("env 不设、settings 未配 → 300000 fallback（third-tier 默认）", () => {
    const env = loadIknowEnv(process.cwd(), EMPTY_SETTINGS);
    assert.equal(env.llm.timeoutMs, 300_000);
  });

  it("非法 env 值视为未设 → 回退到 settings", () => {
    process.env.IKNOW_LLM_TIMEOUT_MS = "abc";
    const env = loadIknowEnv(process.cwd(), {
      llm: { model: "test-model", timeoutMs: 45_000 },
    });
    assert.equal(env.llm.timeoutMs, 45_000);
  });

  it("env 非法 + settings 未配 → 300000 fallback", () => {
    process.env.IKNOW_LLM_TIMEOUT_MS = "abc";
    const env = loadIknowEnv(process.cwd(), EMPTY_SETTINGS);
    assert.equal(env.llm.timeoutMs, 300_000);
  });

  it("timeoutMs 与其它 LLM env 字段独立(不影响 maxTurns / maxOutputTokens / temperature)", () => {
    process.env.IKNOW_LLM_TIMEOUT_MS = "45000";
    process.env.IKNOW_LLM_MAX_TURNS = "7";
    process.env.IKNOW_LLM_MAX_OUTPUT_TOKENS = "2048";
    const env = loadIknowEnv(process.cwd(), EMPTY_SETTINGS);
    assert.equal(env.llm.timeoutMs, 45_000);
    assert.equal(env.llm.maxTurns, 7);
    assert.equal(env.llm.maxOutputTokens, 2048);
  });
});

describe("loadIknowEnv — subagent.taskTimeoutMs (#358 settings 双字段, per-task)", () => {
  beforeEach(() => {
    for (const k of ENV_KEYS) delete process.env[k];
  });
  afterEach(() => {
    for (const k of ENV_KEYS) delete process.env[k];
  });

  it("default: env 不设且 settings 未配 → undefined（env 层无第三层默认，常量归 T2 manager 消费点）", () => {
    const env = loadIknowEnv(process.cwd(), EMPTY_SETTINGS);
    assert.equal(env.subagent?.taskTimeoutMs, undefined);
  });

  it("IKNOW_SUBAGENT_TASK_TIMEOUT_MS=7200000 → env.subagent.taskTimeoutMs=7200000", () => {
    process.env.IKNOW_SUBAGENT_TASK_TIMEOUT_MS = "7200000";
    const env = loadIknowEnv(process.cwd(), EMPTY_SETTINGS);
    assert.equal(env.subagent?.taskTimeoutMs, 7_200_000);
  });

  it("IKNOW_SUBAGENT_TASK_TIMEOUT_MS=1800000 → env.subagent.taskTimeoutMs=1800000（deer-flow 实测）", () => {
    process.env.IKNOW_SUBAGENT_TASK_TIMEOUT_MS = "1800000";
    const env = loadIknowEnv(process.cwd(), EMPTY_SETTINGS);
    assert.equal(env.subagent?.taskTimeoutMs, 1_800_000);
  });

  it("IKNOW_SUBAGENT_TASK_TIMEOUT_MS 空串 → undefined（与未设同义）", () => {
    process.env.IKNOW_SUBAGENT_TASK_TIMEOUT_MS = "";
    const env = loadIknowEnv(process.cwd(), EMPTY_SETTINGS);
    assert.equal(env.subagent?.taskTimeoutMs, undefined);
  });

  it("IKNOW_SUBAGENT_TASK_TIMEOUT_MS 非数字 (abc) → undefined", () => {
    process.env.IKNOW_SUBAGENT_TASK_TIMEOUT_MS = "abc";
    const env = loadIknowEnv(process.cwd(), EMPTY_SETTINGS);
    assert.equal(env.subagent?.taskTimeoutMs, undefined);
  });

  it("IKNOW_SUBAGENT_TASK_TIMEOUT_MS 小数 (1800000.7) → trunc 为 1800000（envOptionalInt 用 trunc）", () => {
    process.env.IKNOW_SUBAGENT_TASK_TIMEOUT_MS = "1800000.7";
    const env = loadIknowEnv(process.cwd(), EMPTY_SETTINGS);
    assert.equal(env.subagent?.taskTimeoutMs, 1_800_000);
  });

  it("env > settings：settings 设了 3600000、env 设了 7200000 → env wins", () => {
    process.env.IKNOW_SUBAGENT_TASK_TIMEOUT_MS = "7200000";
    const env = loadIknowEnv(process.cwd(), {
      llm: { model: "test-model" },
      subagent: { taskTimeoutMs: 3_600_000 },
    });
    assert.equal(env.subagent?.taskTimeoutMs, 7_200_000);
  });

  it("env 不设、settings 设了 → settings wins（3600000）", () => {
    const env = loadIknowEnv(process.cwd(), {
      llm: { model: "test-model" },
      subagent: { taskTimeoutMs: 3_600_000 },
    });
    assert.equal(env.subagent?.taskTimeoutMs, 3_600_000);
  });

  it("非法 env 值视为未设 → 回退到 settings", () => {
    process.env.IKNOW_SUBAGENT_TASK_TIMEOUT_MS = "abc";
    const env = loadIknowEnv(process.cwd(), {
      llm: { model: "test-model" },
      subagent: { taskTimeoutMs: 3_600_000 },
    });
    assert.equal(env.subagent?.taskTimeoutMs, 3_600_000);
  });

  it("env 非法 + settings 未配 → undefined（无第三层默认）", () => {
    process.env.IKNOW_SUBAGENT_TASK_TIMEOUT_MS = "abc";
    const env = loadIknowEnv(process.cwd(), EMPTY_SETTINGS);
    assert.equal(env.subagent?.taskTimeoutMs, undefined);
  });

  it("taskTimeoutMs 与 llm.timeoutMs 独立：互不影响", () => {
    process.env.IKNOW_SUBAGENT_TASK_TIMEOUT_MS = "7200000";
    process.env.IKNOW_LLM_TIMEOUT_MS = "45000";
    const env = loadIknowEnv(process.cwd(), EMPTY_SETTINGS);
    assert.equal(env.subagent?.taskTimeoutMs, 7_200_000);
    assert.equal(env.llm.timeoutMs, 45_000);
  });

  it("env + settings 同时配 llm.timeoutMs + subagent.taskTimeoutMs → 两者都保留", () => {
    process.env.IKNOW_LLM_TIMEOUT_MS = "45000";
    process.env.IKNOW_SUBAGENT_TASK_TIMEOUT_MS = "7200000";
    const env = loadIknowEnv(process.cwd(), EMPTY_SETTINGS);
    assert.equal(env.llm.timeoutMs, 45_000);
    assert.equal(env.subagent?.taskTimeoutMs, 7_200_000);
  });
});

describe("loadIknowEnv — maxOutputTokens default", () => {
  // 默认值选 32000 的完整 rationale 见 src/config/env.ts 该 fallback 注释。
  beforeEach(() => {
    delete process.env.IKNOW_LLM_MAX_OUTPUT_TOKENS;
  });
  afterEach(() => {
    delete process.env.IKNOW_LLM_MAX_OUTPUT_TOKENS;
  });

  it("未设 IKNOW_LLM_MAX_OUTPUT_TOKENS → 落到 32000 fallback", () => {
    const env = loadIknowEnv(process.cwd(), EMPTY_SETTINGS);
    assert.equal(env.llm.maxOutputTokens, 32_000);
  });

  it("显式 env 仍可覆盖 fallback", () => {
    process.env.IKNOW_LLM_MAX_OUTPUT_TOKENS = "4096";
    const env = loadIknowEnv(process.cwd(), EMPTY_SETTINGS);
    assert.equal(env.llm.maxOutputTokens, 4096);
  });
});

describe("loadIknowEnv — settings merge (#353)", () => {
  beforeEach(() => {
    for (const k of ENV_KEYS) delete process.env[k];
  });
  afterEach(() => {
    for (const k of ENV_KEYS) delete process.env[k];
  });

  it("settings 提供 maxTurns / compress / model → env 反映", () => {
    const env = loadIknowEnv(process.cwd(), {
      llm: {
        maxTurns: 25,
        compress: { contextWindow: 300000, thresholdTokens: 200000 },
        model: "test-model",
      },
    });
    assert.equal(env.llm.maxTurns, 25);
    assert.equal(env.compress.contextWindow, 300000);
    assert.equal(env.compress.thresholdTokens, 200000);
  });

  it("env 覆盖 settings", () => {
    process.env.IKNOW_LLM_MAX_TURNS = "10";
    process.env.IKNOW_MODEL_CONTEXT_WINDOW = "250000";
    process.env.IKNOW_AUTO_COMPACT_THRESHOLD_TOKENS = "180000";
    const env = loadIknowEnv(process.cwd(), {
      llm: {
        maxTurns: 25,
        compress: { contextWindow: 300000, thresholdTokens: 200000 },
        model: "test-model",
      },
    });
    assert.equal(env.llm.maxTurns, 10);
    assert.equal(env.compress.contextWindow, 250000);
    assert.equal(env.compress.thresholdTokens, 180000);
  });

  it("settings 只提供部分字段，其余保持默认", () => {
    const env = loadIknowEnv(process.cwd(), {
      llm: { maxTurns: 15, model: "test-model" },
    });
    assert.equal(env.llm.maxTurns, 15);
    assert.equal(env.compress.contextWindow, 200000);
    assert.equal(env.compress.thresholdTokens, undefined);
  });

  it("settings 提供 thinking / thinkingEffort（env 未设）→ env 反映", () => {
    const env = loadIknowEnv(process.cwd(), {
      llm: {
        model: "test-model",
        thinking: "adaptive",
        thinkingEffort: "high",
      },
    });
    assert.equal(env.llm.thinking, "adaptive");
    assert.equal(env.llm.thinkingEffort, "high");
  });

  it("env 覆盖 settings：THINKING=off 压过 settings adaptive", () => {
    process.env.IKNOW_LLM_THINKING = "off";
    const env = loadIknowEnv(process.cwd(), {
      llm: {
        model: "test-model",
        thinking: "adaptive",
        thinkingEffort: "max",
      },
    });
    assert.equal(env.llm.thinking, "off");
  });

  it("env 覆盖 settings：THINKING=adaptive 压过 settings off", () => {
    process.env.IKNOW_LLM_THINKING = "adaptive";
    const env = loadIknowEnv(process.cwd(), {
      llm: { model: "test-model", thinking: "off" },
    });
    assert.equal(env.llm.thinking, "adaptive");
  });

  it("env 覆盖 settings：EFFORT=low 压过 settings high", () => {
    process.env.IKNOW_LLM_THINKING_EFFORT = "low";
    const env = loadIknowEnv(process.cwd(), {
      llm: {
        model: "test-model",
        thinking: "adaptive",
        thinkingEffort: "high",
      },
    });
    assert.equal(env.llm.thinkingEffort, "low");
  });

  it("env EFFORT 非法值 = 未设，回退 settings 的 effort", () => {
    process.env.IKNOW_LLM_THINKING_EFFORT = "extreme";
    const env = loadIknowEnv(process.cwd(), {
      llm: {
        model: "test-model",
        thinking: "adaptive",
        thinkingEffort: "max",
      },
    });
    assert.equal(env.llm.thinkingEffort, "max");
  });

  it("env THINKING 非法值 = 未设，回退 settings 的 thinking", () => {
    process.env.IKNOW_LLM_THINKING = "garbage";
    const env = loadIknowEnv(process.cwd(), {
      llm: { model: "test-model", thinking: "adaptive" },
    });
    assert.equal(env.llm.thinking, "adaptive");
  });

  it("env + settings 均未设 → 默认 off / 空 effort", () => {
    const env = loadIknowEnv(process.cwd(), EMPTY_SETTINGS);
    assert.equal(env.llm.thinking, "off");
    assert.equal(env.llm.thinkingEffort, "");
  });

  it("settings 提供 thinking=adaptive + thinkingEffort=max → 两者均派生", () => {
    const env = loadIknowEnv(process.cwd(), {
      llm: {
        model: "test-model",
        thinking: "adaptive",
        thinkingEffort: "max",
      },
    });
    assert.equal(env.llm.thinking, "adaptive");
    assert.equal(env.llm.thinkingEffort, "max");
  });

  it("settings 仅 thinking → effort 保持默认空", () => {
    const env = loadIknowEnv(process.cwd(), {
      llm: { model: "test-model", thinking: "adaptive" },
    });
    assert.equal(env.llm.thinking, "adaptive");
    assert.equal(env.llm.thinkingEffort, "");
  });

  it("settings 仅 thinkingEffort → thinking 保持默认 off", () => {
    const env = loadIknowEnv(process.cwd(), {
      llm: { model: "test-model", thinkingEffort: "high" },
    });
    assert.equal(env.llm.thinking, "off");
    assert.equal(env.llm.thinkingEffort, "high");
  });

  it("未传 settings 时自动读取 .iknow/settings.json（真实文件集成）", async () => {
    const tmpCwd = await mkdtemp(join(tmpdir(), "iknow-env-settings-"));
    const settingsDir = join(tmpCwd, ".iknow");
    await mkdir(settingsDir, { recursive: true });
    await writeFile(
      join(settingsDir, "settings.json"),
      JSON.stringify({
        llm: {
          maxTurns: 42,
          compress: { contextWindow: 400000 },
          model: "test-model",
        },
      })
    );

    try {
      const env = loadIknowEnv(tmpCwd);
      assert.equal(env.llm.maxTurns, 42);
      assert.equal(env.compress.contextWindow, 400000);
      assert.equal(env.compress.thresholdTokens, undefined);
    } finally {
      await rm(tmpCwd, { recursive: true, force: true });
    }
  });

  it("真实文件集成：.iknow/settings.json 写 llm.model → env.llm.model 生效", async () => {
    const tmpCwd = await mkdtemp(join(tmpdir(), "iknow-env-settings-model-"));
    await mkdir(join(tmpCwd, ".iknow"), { recursive: true });
    await writeFile(
      join(tmpCwd, ".iknow", "settings.json"),
      JSON.stringify({ llm: { model: "hy3-combo", maxTurns: 42 } })
    );

    try {
      const env = loadIknowEnv(tmpCwd);
      assert.equal(env.llm.model, "hy3-combo");
      assert.equal(env.llm.maxTurns, 42);
    } finally {
      await rm(tmpCwd, { recursive: true, force: true });
    }
  });

  it("真实文件集成：project model 覆盖 user model（隔离 HOME）", async () => {
    const tmpCwd = await mkdtemp(join(tmpdir(), "iknow-env-model-merge-"));
    const emptyHome = await mkdtemp(join(tmpdir(), "iknow-env-model-home-"));
    await mkdir(join(tmpCwd, ".iknow"), { recursive: true });
    await writeFile(
      join(tmpCwd, ".iknow", "settings.json"),
      JSON.stringify({ llm: { model: "project-model" } })
    );
    await mkdir(join(emptyHome, ".iknow"), { recursive: true });
    await writeFile(
      join(emptyHome, ".iknow", "settings.json"),
      JSON.stringify({ llm: { model: "user-model" } })
    );

    try {
      // 隔离 HOME，让 user 级文件真实参与 merge（project > user）。
      const prevHome = process.env.HOME;
      process.env.HOME = emptyHome;
      try {
        const env = loadIknowEnv(tmpCwd);
        assert.equal(env.llm.model, "project-model");
      } finally {
        if (prevHome === undefined) delete process.env.HOME;
        else process.env.HOME = prevHome;
      }
    } finally {
      await rm(tmpCwd, { recursive: true, force: true });
      await rm(emptyHome, { recursive: true, force: true });
    }
  });

  it("非法 env 值视为未设，回退到 settings", () => {
    process.env.IKNOW_LLM_MAX_TURNS = "abc";
    process.env.IKNOW_MODEL_CONTEXT_WINDOW = "bad";
    process.env.IKNOW_AUTO_COMPACT_THRESHOLD_TOKENS = "not-a-number";
    const env = loadIknowEnv(process.cwd(), {
      llm: {
        maxTurns: 33,
        compress: { contextWindow: 330000, thresholdTokens: 220000 },
        model: "test-model",
      },
    });
    // 非法 env = 未设（envOptionalInt/envInt 回退纪律），继续走 settings 回退。
    assert.equal(env.llm.maxTurns, 33);
    assert.equal(env.compress.contextWindow, 330000);
    assert.equal(env.compress.thresholdTokens, 220000);
  });

  it("settings 值经 loadIknowEnv 进入装配入口（serve/hub/runtime 同源）", async () => {
    // serve.ts:88 / hub.ts:762 / runtime.ts:52 均直接调 loadIknowEnv()，
    // settings 自动读取后经同一链路流入 LoopEngineDeps / HealthResponse。
    const tmpCwd = await mkdtemp(join(tmpdir(), "iknow-env-serve-settings-"));
    await mkdir(join(tmpCwd, ".iknow"), { recursive: true });
    await writeFile(
      join(tmpCwd, ".iknow", "settings.json"),
      JSON.stringify({
        llm: {
          maxTurns: 9,
          compress: { contextWindow: 900000 },
          model: "test-model",
        },
      })
    );
    try {
      const env = loadIknowEnv(tmpCwd);
      assert.equal(env.llm.maxTurns, 9);
      assert.equal(env.compress.contextWindow, 900000);
      // thresholdTokens 未设 → undefined（proactive compact 关）。
      assert.equal(env.compress.thresholdTokens, undefined);
    } finally {
      await rm(tmpCwd, { recursive: true, force: true });
    }
  });
});

describe("loadIknowEnv — model source: settings.llm.model 唯一承载 (settings-model-extension)", () => {
  beforeEach(() => {
    for (const k of ENV_KEYS) delete process.env[k];
  });
  afterEach(() => {
    for (const k of ENV_KEYS) delete process.env[k];
  });

  it("settings.llm.model 生效（trim 后）", () => {
    const env = loadIknowEnv(process.cwd(), {
      llm: { model: "  from-settings  " },
    });
    assert.equal(env.llm.model, "from-settings");
  });

  it("settings 无 model → fail-fast 抛「no LLM model configured in settings.llm.model」", () => {
    const noModelSettings: IknowSettings = {};
    assert.throws(() => loadIknowEnv(process.cwd(), noModelSettings), {
      message: /no LLM model configured in settings\.llm\.model/,
    });
  });

  it("IKNOW_LLM_MODEL env 已退役：设了也不读（不再覆盖 settings）", () => {
    process.env.IKNOW_LLM_MODEL = "from-env";
    const env = loadIknowEnv(process.cwd(), {
      llm: { model: "from-settings" },
    });
    assert.equal(env.llm.model, "from-settings");
  });
});

describe("loadIknowEnv — llm.fallback (settings-model-extension)", () => {
  beforeEach(() => {
    for (const k of ENV_KEYS) delete process.env[k];
  });
  afterEach(() => {
    for (const k of ENV_KEYS) delete process.env[k];
  });

  it("settings.llm.fallback = [x, y] → env.llm.fallback = [x, y]", () => {
    const env = loadIknowEnv(process.cwd(), {
      llm: { model: "test-model", fallback: ["x", "y"] },
    });
    assert.deepEqual(env.llm.fallback, ["x", "y"]);
  });

  it("settings 未配 fallback → env.llm.fallback = []（无兜底）", () => {
    const env = loadIknowEnv(process.cwd(), {
      llm: { model: "test-model" },
    });
    assert.deepEqual(env.llm.fallback, []);
  });

  it("settings.llm.fallback 非法值由 settings 层丢弃，env 侧回退 []", async () => {
    // 经真实 settings 文件链路：fallback 非法数组在 parseLlm 被丢弃
    // （drop-not-throw）→ mergedSettings.llm.fallback 缺席 → env.llm.fallback = []。
    // 隔离 home（loadIknowEnv 显式传 emptyHome），避免真实 ~/.iknow/settings.json
    // 的 fallback 泄漏进断言（#395 引入 home 注入缝，#406 复用）。
    const tmpCwd = await mkdtemp(join(tmpdir(), "iknow-env-fallback-invalid-"));
    const emptyHome = await mkdtemp(join(tmpdir(), "iknow-env-fallback-home-"));
    await mkdir(join(tmpCwd, ".iknow"), { recursive: true });
    await mkdir(join(emptyHome, ".iknow"), { recursive: true });
    await writeFile(
      join(tmpCwd, ".iknow", "settings.json"),
      JSON.stringify({
        llm: { model: "test-model", fallback: ["x", 5] },
      })
    );
    try {
      const env = loadIknowEnv(tmpCwd, undefined, emptyHome);
      assert.equal(env.llm.model, "test-model");
      assert.deepEqual(env.llm.fallback, []);
    } finally {
      await rm(tmpCwd, { recursive: true, force: true });
      await rm(emptyHome, { recursive: true, force: true });
    }
  });
});

describe("loadIknowEnv — subagent inheritance (#353)", () => {
  const ENV_KEYS_SUBAGENT = [
    "IKNOW_LLM_MAX_TURNS",
    "IKNOW_MODEL_CONTEXT_WINDOW",
    "IKNOW_AUTO_COMPACT_THRESHOLD_TOKENS",
  ] as const;
  beforeEach(() => {
    for (const k of ENV_KEYS_SUBAGENT) delete process.env[k];
  });
  afterEach(() => {
    for (const k of ENV_KEYS_SUBAGENT) delete process.env[k];
  });

  it("子代理在相同 project cwd 自装配时继承 settings（跨进程模拟）", async () => {
    // 主代理 project settings 写入 tmpCwd/.iknow/settings.json；
    // 子代理进程重新走 loadIknowEnv(同 cwd) → 自动读同一文件，天然继承。
    const tmpCwd = await mkdtemp(join(tmpdir(), "iknow-subagent-inherit-"));
    const emptyHome = await mkdtemp(join(tmpdir(), "iknow-subagent-home-"));
    await mkdir(join(tmpCwd, ".iknow"), { recursive: true });
    await writeFile(
      join(tmpCwd, ".iknow", "settings.json"),
      JSON.stringify({
        llm: {
          maxTurns: 77,
          compress: { contextWindow: 600000 },
          model: "test-model",
        },
      })
    );
    try {
      // 模拟子代理进程：隔离 HOME（避免真实 ~/.iknow/settings.json 干扰），
      // 以 project cwd 自装配。
      const prevHome = process.env.HOME;
      process.env.HOME = emptyHome;
      try {
        const env = loadIknowEnv(tmpCwd);
        assert.equal(env.llm.maxTurns, 77);
        assert.equal(env.compress.contextWindow, 600000);
      } finally {
        if (prevHome === undefined) delete process.env.HOME;
        else process.env.HOME = prevHome;
      }
    } finally {
      await rm(tmpCwd, { recursive: true, force: true });
      await rm(emptyHome, { recursive: true, force: true });
    }
  });

  it("子代理在隔离 cwd（无 settings、无 model）→ fail-fast 抛错（不继承）", async () => {
    // 主代理 project settings 在 tmpCwdWith（含 model），但子代理被 spawn 到
    // tmpCwdEmpty（隔离 cwd）→ loadIknowEnv(tmpCwdEmpty, undefined, emptyHome)
    // 读不到 project settings 也无 user settings，env 也未设 IKNOW_LLM_MODEL
    // → model 无来源，fail-fast 抛错（不静默回退）。emptyHome 经 loadIknowEnv
    // 显式透传（os.homedir 不响应运行时 process.env.HOME 修改）。
    const tmpWith = await mkdtemp(join(tmpdir(), "iknow-subagent-with-"));
    const tmpEmpty = await mkdtemp(join(tmpdir(), "iknow-subagent-empty-"));
    const emptyHome = await mkdtemp(join(tmpdir(), "iknow-subagent-home2-"));
    await mkdir(join(tmpWith, ".iknow"), { recursive: true });
    await writeFile(
      join(tmpWith, ".iknow", "settings.json"),
      JSON.stringify({
        llm: {
          maxTurns: 77,
          compress: { contextWindow: 600000 },
          model: "test-model",
        },
      })
    );
    try {
      assert.throws(
        () => loadIknowEnv(tmpEmpty, undefined, emptyHome),
        /no LLM model configured/
      );
    } finally {
      await rm(tmpWith, { recursive: true, force: true });
      await rm(tmpEmpty, { recursive: true, force: true });
      await rm(emptyHome, { recursive: true, force: true });
    }
  });
});

describe("loadIknowEnv — mcp connect timeout (#378 根因 B)", () => {
  beforeEach(() => {
    for (const k of ENV_KEYS) delete process.env[k];
  });
  afterEach(() => {
    for (const k of ENV_KEYS) delete process.env[k];
  });

  it("default: mcp.connectTimeoutMs=60000 (env 不设时)", () => {
    const env = loadIknowEnv(process.cwd(), EMPTY_SETTINGS);
    assert.equal(env.mcp.connectTimeoutMs, 60_000);
  });

  it("合法值 90000 透传", () => {
    process.env.IKNOW_MCP_CONNECT_TIMEOUT_MS = "90000";
    const env = loadIknowEnv(process.cwd(), EMPTY_SETTINGS);
    assert.equal(env.mcp.connectTimeoutMs, 90000);
  });

  it("合法值 1 透传（极小正数不误伤）", () => {
    process.env.IKNOW_MCP_CONNECT_TIMEOUT_MS = "1";
    const env = loadIknowEnv(process.cwd(), EMPTY_SETTINGS);
    assert.equal(env.mcp.connectTimeoutMs, 1);
  });

  it("非法值 'abc' → 回退 60000", () => {
    process.env.IKNOW_MCP_CONNECT_TIMEOUT_MS = "abc";
    const env = loadIknowEnv(process.cwd(), EMPTY_SETTINGS);
    assert.equal(env.mcp.connectTimeoutMs, 60_000);
  });

  it("非法值 '-5000'（负数）→ 回退 60000", () => {
    process.env.IKNOW_MCP_CONNECT_TIMEOUT_MS = "-5000";
    const env = loadIknowEnv(process.cwd(), EMPTY_SETTINGS);
    assert.equal(env.mcp.connectTimeoutMs, 60_000);
  });

  it("非法值 '0'（零超时无意义）→ 回退 60000", () => {
    process.env.IKNOW_MCP_CONNECT_TIMEOUT_MS = "0";
    const env = loadIknowEnv(process.cwd(), EMPTY_SETTINGS);
    assert.equal(env.mcp.connectTimeoutMs, 60_000);
  });

  it("空串 → 回退 60000（与未设同义）", () => {
    process.env.IKNOW_MCP_CONNECT_TIMEOUT_MS = "";
    const env = loadIknowEnv(process.cwd(), EMPTY_SETTINGS);
    assert.equal(env.mcp.connectTimeoutMs, 60_000);
  });

  it("与 llm.timeoutMs 独立：互不影响", () => {
    process.env.IKNOW_MCP_CONNECT_TIMEOUT_MS = "120000";
    process.env.IKNOW_LLM_TIMEOUT_MS = "30000";
    const env = loadIknowEnv(process.cwd(), EMPTY_SETTINGS);
    assert.equal(env.mcp.connectTimeoutMs, 120000);
    assert.equal(env.llm.timeoutMs, 30000);
  });
});

describe("loadIknowEnv — apiKey 解析路径 (settings-model-extension)", () => {
  const API_KEY_VARS = ["ANTHROPIC_AUTH_TOKEN", "IKNOW_TEST_API_KEY"] as const;
  beforeEach(() => {
    for (const k of [...ENV_KEYS, ...API_KEY_VARS]) delete process.env[k];
  });
  afterEach(() => {
    for (const k of [...ENV_KEYS, ...API_KEY_VARS]) delete process.env[k];
  });

  it("settings.llm.apiKey 字面 → env.llm.apiKey 原样", () => {
    const env = loadIknowEnv(process.cwd(), {
      llm: { model: "test-model", apiKey: "sk-literal-123" },
    });
    assert.equal(env.llm.apiKey, "sk-literal-123");
  });

  it("settings.llm.apiKey 字面前后空白 → trim 后原样", () => {
    const env = loadIknowEnv(process.cwd(), {
      llm: { model: "test-model", apiKey: "  sk-literal-123  " },
    });
    assert.equal(env.llm.apiKey, "sk-literal-123");
  });

  it("settings.llm.apiKey ${VAR} + process.env → 展开", () => {
    process.env.IKNOW_TEST_API_KEY = "sk-from-env";
    const env = loadIknowEnv(process.cwd(), {
      llm: { model: "test-model", apiKey: "${IKNOW_TEST_API_KEY}" },
    });
    assert.equal(env.llm.apiKey, "sk-from-env");
  });

  it("settings.llm.apiKey ${VAR} 缺失（env 无）→ undefined", () => {
    const env = loadIknowEnv(process.cwd(), {
      llm: { model: "test-model", apiKey: "${IKNOW_TEST_API_KEY}" },
    });
    assert.equal(env.llm.apiKey, undefined);
  });

  it("settings.llm.apiKey ${VAR} + process.env 空 → undefined（消费点守卫触发）", () => {
    process.env.IKNOW_TEST_API_KEY = "";
    const env = loadIknowEnv(process.cwd(), {
      llm: { model: "test-model", apiKey: "${IKNOW_TEST_API_KEY}" },
    });
    assert.equal(env.llm.apiKey, undefined);
  });

  it("settings 未配 apiKey → env.llm.apiKey = undefined（不默认、不硬编码）", () => {
    const env = loadIknowEnv(process.cwd(), {
      llm: { model: "test-model" },
    });
    assert.equal(env.llm.apiKey, undefined);
  });

  it("settings 未配 apiKey + env ANTHROPIC_AUTH_TOKEN 有值 → 仍 undefined（env 不再直供 key）", () => {
    // settings-model-extension：key 唯一来源 = settings.llm.apiKey；env key 变量名
    // 不再被 loader 隐式读取（IKNOW_LLM_API_KEY_ENV 已退役）。
    process.env.ANTHROPIC_AUTH_TOKEN = "sk-should-not-be-read";
    const env = loadIknowEnv(process.cwd(), {
      llm: { model: "test-model" },
    });
    assert.equal(env.llm.apiKey, undefined);
  });

  it("settings.llm.apiKey ${VAR} + .env.local 兜底 → 展开", async () => {
    // fileMap = <cwd>/.env.local 合并；process.env 无该变量时读 file。
    const tmpCwd = await mkdtemp(join(tmpdir(), "iknow-env-apikey-file-"));
    await mkdir(join(tmpCwd, ".iknow"), { recursive: true });
    await writeFile(
      join(tmpCwd, ".iknow", "settings.json"),
      JSON.stringify({
        llm: { model: "test-model", apiKey: "${IKNOW_TEST_API_KEY}" },
      })
    );
    await writeFile(
      join(tmpCwd, ".env.local"),
      "IKNOW_TEST_API_KEY=sk-from-file\n"
    );
    try {
      const env = loadIknowEnv(tmpCwd);
      assert.equal(env.llm.apiKey, "sk-from-file");
    } finally {
      await rm(tmpCwd, { recursive: true, force: true });
    }
  });

  it('.env.local 值 = "yes" → 视同未设 → undefined', async () => {
    const tmpCwd = await mkdtemp(join(tmpdir(), "iknow-env-apikey-yes-"));
    await mkdir(join(tmpCwd, ".iknow"), { recursive: true });
    await writeFile(
      join(tmpCwd, ".iknow", "settings.json"),
      JSON.stringify({
        llm: { model: "test-model", apiKey: "${IKNOW_TEST_API_KEY}" },
      })
    );
    await writeFile(join(tmpCwd, ".env.local"), "IKNOW_TEST_API_KEY=yes\n");
    try {
      const env = loadIknowEnv(tmpCwd);
      assert.equal(env.llm.apiKey, undefined);
    } finally {
      await rm(tmpCwd, { recursive: true, force: true });
    }
  });

  it("settings.llm.apiKey 非法 ${ 未闭合 → settings 层丢弃 → env.llm.apiKey undefined", async () => {
    const env = loadIknowEnv(process.cwd(), {
      llm: { model: "test-model", apiKey: "${VAR" },
    });
    assert.equal(env.llm.apiKey, undefined);
  });

  it("IKNOW_LLM_MODEL env 已退役：设了也不读（model 仍来自 settings）", () => {
    process.env.IKNOW_LLM_MODEL = "from-env";
    const env = loadIknowEnv(process.cwd(), {
      llm: { model: "from-settings", apiKey: "sk-literal" },
    });
    assert.equal(env.llm.model, "from-settings");
  });
});
