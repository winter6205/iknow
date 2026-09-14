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
 *
 * 末尾追加 ADR-0093 provider 解析组（`llm.providers` 唯一 LLM 承载 +
 * apiKeyEnv 缺席 typed 抛）：provider 路径的 key **只读 process.env**，
 * 不走 fileMap（该组单独写 `.env.local` 负例钉这一点）。
 */

import { afterEach, beforeEach, describe, it } from "vitest";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  formatLlmProviderConfigError,
  isLlmProviderConfigError,
  loadIknowEnv,
  wireModelFromRoute,
} from "../../src/config/env.ts";
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
const TEST_LLM_PROVIDER = {
  id: "test",
  baseUrl: "http://localhost:20128/v1",
  apiKeyEnv: "IKNOW_TEST_API_KEY",
  models: [{ id: "model" }],
};

const EMPTY_SETTINGS: IknowSettings = {
  llm: {
    model: "test/model",
    providers: [TEST_LLM_PROVIDER],
  },
};

beforeEach(() => {
  process.env.IKNOW_TEST_API_KEY = "test-key";
});
afterEach(() => {
  delete process.env.IKNOW_TEST_API_KEY;
});

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
  "IKNOW_LLM_IDLE_TIMEOUT_MS",
  "IKNOW_LLM_HARD_CAP_MS",
  "IKNOW_SUBAGENT_TASK_TIMEOUT_MS",
  "IKNOW_SUBAGENT_MAX_CONCURRENT_WORKERS",
  "IKNOW_LLM_MAX_OUTPUT_TOKENS",
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
      llm: {
        model: "test/model",
        providers: [TEST_LLM_PROVIDER],
        timeoutMs: 45_000,
      },
    });
    assert.equal(env.llm.timeoutMs, 30_000);
  });

  it("env 不设、settings 设了 → settings wins（45000）", () => {
    const env = loadIknowEnv(process.cwd(), {
      llm: {
        model: "test/model",
        providers: [TEST_LLM_PROVIDER],
        timeoutMs: 45_000,
      },
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
      llm: {
        model: "test/model",
        providers: [TEST_LLM_PROVIDER],
        timeoutMs: 45_000,
      },
    });
    assert.equal(env.llm.timeoutMs, 45_000);
  });

  it("非正 env 值视为未设 → 回退到 settings 或第三层默认", () => {
    for (const bad of ["0", "-1"]) {
      process.env.IKNOW_LLM_TIMEOUT_MS = bad;
      assert.equal(
        loadIknowEnv(process.cwd(), {
          llm: {
            model: "test/model",
            providers: [TEST_LLM_PROVIDER],
            timeoutMs: 45_000,
          },
        }).llm.timeoutMs,
        45_000,
        `timeoutMs=${bad} 应回退到 settings`
      );
      assert.equal(
        loadIknowEnv(process.cwd(), EMPTY_SETTINGS).llm.timeoutMs,
        300_000,
        `timeoutMs=${bad} 且 settings 未配应回退默认`
      );
    }
  });

  it("有限正整数 env（含大值）仍覆盖 settings", () => {
    const largeFiniteInteger = Number.MAX_SAFE_INTEGER;
    process.env.IKNOW_LLM_TIMEOUT_MS = String(largeFiniteInteger);
    const env = loadIknowEnv(process.cwd(), {
      llm: {
        model: "test/model",
        providers: [TEST_LLM_PROVIDER],
        timeoutMs: 45_000,
      },
    });
    assert.equal(env.llm.timeoutMs, largeFiniteInteger);
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
      llm: { model: "test/model", providers: [TEST_LLM_PROVIDER] },
      subagent: { taskTimeoutMs: 3_600_000 },
    });
    assert.equal(env.subagent?.taskTimeoutMs, 7_200_000);
  });

  it("env 不设、settings 设了 → settings wins（3600000）", () => {
    const env = loadIknowEnv(process.cwd(), {
      llm: { model: "test/model", providers: [TEST_LLM_PROVIDER] },
      subagent: { taskTimeoutMs: 3_600_000 },
    });
    assert.equal(env.subagent?.taskTimeoutMs, 3_600_000);
  });

  it("非法 env 值视为未设 → 回退到 settings", () => {
    process.env.IKNOW_SUBAGENT_TASK_TIMEOUT_MS = "abc";
    const env = loadIknowEnv(process.cwd(), {
      llm: { model: "test/model", providers: [TEST_LLM_PROVIDER] },
      subagent: { taskTimeoutMs: 3_600_000 },
    });
    assert.equal(env.subagent?.taskTimeoutMs, 3_600_000);
  });

  it("非正 env 值视为未设 → 回退到 settings 或保持 undefined", () => {
    for (const bad of ["0", "-1"]) {
      process.env.IKNOW_SUBAGENT_TASK_TIMEOUT_MS = bad;
      assert.equal(
        loadIknowEnv(process.cwd(), {
          llm: { model: "test/model", providers: [TEST_LLM_PROVIDER] },
          subagent: { taskTimeoutMs: 3_600_000 },
        }).subagent?.taskTimeoutMs,
        3_600_000,
        `taskTimeoutMs=${bad} 应回退到 settings`
      );
      assert.equal(
        loadIknowEnv(process.cwd(), EMPTY_SETTINGS).subagent?.taskTimeoutMs,
        undefined,
        `taskTimeoutMs=${bad} 且 settings 未配应保持 undefined`
      );
    }
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

describe("loadIknowEnv — subagent.maxConcurrentWorkers (T4)", () => {
  beforeEach(() => {
    for (const k of ENV_KEYS) delete process.env[k];
  });
  afterEach(() => {
    for (const k of ENV_KEYS) delete process.env[k];
  });

  it("未设 env/settings → 默认 15", () => {
    const env = loadIknowEnv(process.cwd(), EMPTY_SETTINGS);
    assert.equal(env.subagent.maxConcurrentWorkers, 15);
  });

  it("合法 env 覆盖 settings", () => {
    process.env.IKNOW_SUBAGENT_MAX_CONCURRENT_WORKERS = "3";
    const env = loadIknowEnv(process.cwd(), {
      llm: { model: "test/model", providers: [TEST_LLM_PROVIDER] },
      subagent: { maxConcurrentWorkers: 7 },
    });
    assert.equal(env.subagent.maxConcurrentWorkers, 3);
  });

  it("env 未设时使用合法 settings", () => {
    const env = loadIknowEnv(process.cwd(), {
      llm: { model: "test/model", providers: [TEST_LLM_PROVIDER] },
      subagent: { maxConcurrentWorkers: 7 },
    });
    assert.equal(env.subagent.maxConcurrentWorkers, 7);
  });

  it("空/非数字/非正 env 视为未设并回退 settings 或默认 15", () => {
    for (const bad of ["", "abc", "0", "-1"]) {
      process.env.IKNOW_SUBAGENT_MAX_CONCURRENT_WORKERS = bad;
      assert.equal(
        loadIknowEnv(process.cwd(), {
          llm: { model: "test/model", providers: [TEST_LLM_PROVIDER] },
          subagent: { maxConcurrentWorkers: 7 },
        }).subagent.maxConcurrentWorkers,
        7,
        `maxConcurrentWorkers=${bad} 应回退到 settings`
      );
      assert.equal(
        loadIknowEnv(process.cwd(), EMPTY_SETTINGS).subagent
          .maxConcurrentWorkers,
        15,
        `maxConcurrentWorkers=${bad} 且 settings 未配应回退默认`
      );
    }
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

  it("非正或非数字 env 值 → 回退 32000，不产生 max_tokens=0", () => {
    for (const bad of ["0", "-1", "abc"]) {
      process.env.IKNOW_LLM_MAX_OUTPUT_TOKENS = bad;
      const env = loadIknowEnv(process.cwd(), EMPTY_SETTINGS);
      assert.equal(env.llm.maxOutputTokens, 32_000, `maxOutputTokens=${bad}`);
    }
  });

  it("有限正整数大值仍可作为 maxOutputTokens", () => {
    const largeFiniteInteger = Number.MAX_SAFE_INTEGER;
    process.env.IKNOW_LLM_MAX_OUTPUT_TOKENS = String(largeFiniteInteger);
    const env = loadIknowEnv(process.cwd(), EMPTY_SETTINGS);
    assert.equal(env.llm.maxOutputTokens, largeFiniteInteger);
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
        model: "test/model",
        providers: [TEST_LLM_PROVIDER],
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
        model: "test/model",
        providers: [TEST_LLM_PROVIDER],
      },
    });
    assert.equal(env.llm.maxTurns, 10);
    assert.equal(env.compress.contextWindow, 250000);
    assert.equal(env.compress.thresholdTokens, 180000);
  });

  it("settings 只提供部分字段，其余保持默认", () => {
    const env = loadIknowEnv(process.cwd(), {
      llm: {
        maxTurns: 15,
        model: "test/model",
        providers: [TEST_LLM_PROVIDER],
      },
    });
    assert.equal(env.llm.maxTurns, 15);
    assert.equal(env.compress.contextWindow, 200000);
    assert.equal(env.compress.thresholdTokens, undefined);
  });

  it("settings 提供 thinking / thinkingEffort（env 未设）→ env 反映", () => {
    const env = loadIknowEnv(process.cwd(), {
      llm: {
        model: "test/model",
        providers: [TEST_LLM_PROVIDER],
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
        model: "test/model",
        providers: [TEST_LLM_PROVIDER],
        thinking: "adaptive",
        thinkingEffort: "max",
      },
    });
    assert.equal(env.llm.thinking, "off");
  });

  it("env 覆盖 settings：THINKING=adaptive 压过 settings off", () => {
    process.env.IKNOW_LLM_THINKING = "adaptive";
    const env = loadIknowEnv(process.cwd(), {
      llm: {
        model: "test/model",
        providers: [TEST_LLM_PROVIDER],
        thinking: "off",
      },
    });
    assert.equal(env.llm.thinking, "adaptive");
  });

  it("env 覆盖 settings：EFFORT=low 压过 settings high", () => {
    process.env.IKNOW_LLM_THINKING_EFFORT = "low";
    const env = loadIknowEnv(process.cwd(), {
      llm: {
        model: "test/model",
        providers: [TEST_LLM_PROVIDER],
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
        model: "test/model",
        providers: [TEST_LLM_PROVIDER],
        thinking: "adaptive",
        thinkingEffort: "max",
      },
    });
    assert.equal(env.llm.thinkingEffort, "max");
  });

  it("env THINKING 非法值 = 未设，回退 settings 的 thinking", () => {
    process.env.IKNOW_LLM_THINKING = "garbage";
    const env = loadIknowEnv(process.cwd(), {
      llm: {
        model: "test/model",
        providers: [TEST_LLM_PROVIDER],
        thinking: "adaptive",
      },
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
        model: "test/model",
        providers: [TEST_LLM_PROVIDER],
        thinking: "adaptive",
        thinkingEffort: "max",
      },
    });
    assert.equal(env.llm.thinking, "adaptive");
    assert.equal(env.llm.thinkingEffort, "max");
  });

  it("settings 仅 thinking → effort 保持默认空", () => {
    const env = loadIknowEnv(process.cwd(), {
      llm: {
        model: "test/model",
        providers: [TEST_LLM_PROVIDER],
        thinking: "adaptive",
      },
    });
    assert.equal(env.llm.thinking, "adaptive");
    assert.equal(env.llm.thinkingEffort, "");
  });

  it("settings 仅 thinkingEffort → thinking 保持默认 off", () => {
    const env = loadIknowEnv(process.cwd(), {
      llm: {
        model: "test/model",
        providers: [TEST_LLM_PROVIDER],
        thinkingEffort: "high",
      },
    });
    assert.equal(env.llm.thinking, "off");
    assert.equal(env.llm.thinkingEffort, "high");
  });

  it("未传 settings 时自动读取用户层 .iknow/settings.json（真实文件集成）", async () => {
    // ADR-0084：llm 属用户层键 → 只有 <home>/.iknow/settings.json 是配置来源；
    // 项目文件里的 llm 被允许名单丢弃。home 须显式注入：POSIX 上 os.homedir()
    // 确实跟随 $HOME，靠它虽能工作但隐式、易被破坏（见 loader 注释）。
    const tmpCwd = await mkdtemp(join(tmpdir(), "iknow-env-settings-"));
    const tmpHome = await mkdtemp(join(tmpdir(), "iknow-env-settings-home-"));
    const settingsDir = join(tmpHome, ".iknow");
    await mkdir(settingsDir, { recursive: true });
    await writeFile(
      join(settingsDir, "settings.json"),
      JSON.stringify({
        llm: {
          maxTurns: 42,
          compress: { contextWindow: 400000 },
          model: "test/model",
          providers: [TEST_LLM_PROVIDER],
        },
      })
    );
    // 项目文件同时在场且 llm 值不同 → 必须被丢弃，不参与 env。
    await mkdir(join(tmpCwd, ".iknow"), { recursive: true });
    await writeFile(
      join(tmpCwd, ".iknow", "settings.json"),
      JSON.stringify({ llm: { maxTurns: 7, model: "project-model" } })
    );

    try {
      const env = loadIknowEnv(tmpCwd, undefined, tmpHome);
      assert.equal(env.llm.model, "test/model");
      assert.equal(env.llm.maxTurns, 42);
      assert.equal(env.compress.contextWindow, 400000);
      assert.equal(env.compress.thresholdTokens, undefined);
    } finally {
      await rm(tmpCwd, { recursive: true, force: true });
      await rm(tmpHome, { recursive: true, force: true });
    }
  });

  it("真实文件集成：用户层 settings.json 写 llm.model → env.llm.model 生效", async () => {
    const tmpCwd = await mkdtemp(join(tmpdir(), "iknow-env-settings-model-"));
    const tmpHome = await mkdtemp(
      join(tmpdir(), "iknow-env-settings-model-home-")
    );
    await mkdir(join(tmpHome, ".iknow"), { recursive: true });
    await writeFile(
      join(tmpHome, ".iknow", "settings.json"),
      JSON.stringify({
        llm: {
          model: "9router/hy3-combo",
          maxTurns: 42,
          providers: [
            {
              id: "9router",
              baseUrl: "http://localhost:20128/v1",
              apiKeyEnv: "IKNOW_TEST_API_KEY",
              models: [{ id: "hy3-combo" }],
            },
          ],
        },
      })
    );

    try {
      const env = loadIknowEnv(tmpCwd, undefined, tmpHome);
      assert.equal(env.llm.model, "9router/hy3-combo");
      assert.equal(env.llm.maxTurns, 42);
    } finally {
      await rm(tmpCwd, { recursive: true, force: true });
      await rm(tmpHome, { recursive: true, force: true });
    }
  });

  it("真实文件集成（ADR-0084）：project model 被丢弃 → user model 胜出", async () => {
    const tmpCwd = await mkdtemp(join(tmpdir(), "iknow-env-model-merge-"));
    const tmpHome = await mkdtemp(join(tmpdir(), "iknow-env-model-home-"));
    await mkdir(join(tmpCwd, ".iknow"), { recursive: true });
    await writeFile(
      join(tmpCwd, ".iknow", "settings.json"),
      JSON.stringify({ llm: { model: "project-model" } })
    );
    await mkdir(join(tmpHome, ".iknow"), { recursive: true });
    await writeFile(
      join(tmpHome, ".iknow", "settings.json"),
      JSON.stringify({
        llm: {
          model: "test/user-model",
          providers: [
            {
              id: "test",
              baseUrl: "http://localhost:20128/v1",
              apiKeyEnv: "IKNOW_TEST_API_KEY",
              models: [{ id: "user-model" }],
            },
          ],
        },
      })
    );

    try {
      // llm 是用户层键：项目文件不再覆盖 user（旧 ADR-0015 project > user
      // 对 llm 已退役）；显式注入 home 让 user 文件真实参与装配。
      const env = loadIknowEnv(tmpCwd, undefined, tmpHome);
      assert.equal(env.llm.model, "test/user-model");
    } finally {
      await rm(tmpCwd, { recursive: true, force: true });
      await rm(tmpHome, { recursive: true, force: true });
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
        model: "test/model",
        providers: [TEST_LLM_PROVIDER],
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
    // ADR-0084：llm 为用户层键 → fixture 写 <home>/.iknow/settings.json。
    const tmpCwd = await mkdtemp(join(tmpdir(), "iknow-env-serve-settings-"));
    const tmpHome = await mkdtemp(join(tmpdir(), "iknow-env-serve-home-"));
    await mkdir(join(tmpHome, ".iknow"), { recursive: true });
    await writeFile(
      join(tmpHome, ".iknow", "settings.json"),
      JSON.stringify({
        llm: {
          maxTurns: 9,
          compress: { contextWindow: 900000 },
          model: "test/model",
          providers: [TEST_LLM_PROVIDER],
        },
      })
    );
    try {
      const env = loadIknowEnv(tmpCwd, undefined, tmpHome);
      assert.equal(env.llm.maxTurns, 9);
      assert.equal(env.compress.contextWindow, 900000);
      // thresholdTokens 未设 → undefined（proactive compact 关）。
      assert.equal(env.compress.thresholdTokens, undefined);
    } finally {
      await rm(tmpCwd, { recursive: true, force: true });
      await rm(tmpHome, { recursive: true, force: true });
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
      llm: {
        model: "  test/from-settings  ",
        providers: [
          {
            ...TEST_LLM_PROVIDER,
            models: [{ id: "from-settings" }],
          },
        ],
      },
    });
    assert.equal(env.llm.model, "test/from-settings");
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
      llm: {
        model: "test/from-settings",
        providers: [
          {
            ...TEST_LLM_PROVIDER,
            models: [{ id: "from-settings" }],
          },
        ],
      },
    });
    assert.equal(env.llm.model, "test/from-settings");
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
      llm: {
        model: "test/model",
        providers: [TEST_LLM_PROVIDER],
        fallback: ["x", "y"],
      },
    });
    assert.deepEqual(env.llm.fallback, ["x", "y"]);
  });

  it("settings 未配 fallback → env.llm.fallback = []（无兜底）", () => {
    const env = loadIknowEnv(process.cwd(), {
      llm: { model: "test/model", providers: [TEST_LLM_PROVIDER] },
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
    // ADR-0084：llm 为用户层键 → 非法 fallback 的承载文件是 user settings。
    await writeFile(
      join(emptyHome, ".iknow", "settings.json"),
      JSON.stringify({
        llm: {
          model: "test/model",
          providers: [TEST_LLM_PROVIDER],
          fallback: ["x", 5],
        },
      })
    );
    try {
      const env = loadIknowEnv(tmpCwd, undefined, emptyHome);
      assert.equal(env.llm.model, "test/model");
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
    // ADR-0084：llm 是用户层键 → 继承锚点是 <home>/.iknow/settings.json；
    // 子代理进程走 loadIknowEnv(同 cwd, undefined, 同 home) → 读同一文件。
    const tmpCwd = await mkdtemp(join(tmpdir(), "iknow-subagent-inherit-"));
    const emptyHome = await mkdtemp(join(tmpdir(), "iknow-subagent-home-"));
    await mkdir(join(tmpCwd, ".iknow"), { recursive: true });
    await mkdir(join(emptyHome, ".iknow"), { recursive: true });
    await writeFile(
      join(emptyHome, ".iknow", "settings.json"),
      JSON.stringify({
        llm: {
          maxTurns: 77,
          compress: { contextWindow: 600000 },
          model: "test/model",
          providers: [TEST_LLM_PROVIDER],
        },
      })
    );
    try {
      // 模拟子代理进程：显式注入隔离 home（POSIX 上 os.homedir() 确实跟随
      // $HOME，靠它虽能工作，但隐式、易被破坏）。
      const env = loadIknowEnv(tmpCwd, undefined, emptyHome);
      assert.equal(env.llm.maxTurns, 77);
      assert.equal(env.compress.contextWindow, 600000);
    } finally {
      await rm(tmpCwd, { recursive: true, force: true });
      await rm(emptyHome, { recursive: true, force: true });
    }
  });

  it("子代理在隔离 cwd（无 settings、无 model）→ fail-fast 抛错（不继承）", async () => {
    // 子代理被 spawn 到 tmpCwdEmpty（隔离 cwd）+ emptyHome（空 user 层）
    // → loadIknowEnv(tmpCwdEmpty, undefined, emptyHome) 的 settings 链上无
    // 任何 llm.model，env 也未设 IKNOW_LLM_MODEL（该 env 支已退役）→ model
    // 无来源，fail-fast 抛错（不静默回退）。emptyHome 经 loadIknowEnv 显式透传
    // （POSIX 上 os.homedir() 确实跟随 $HOME，靠它虽能工作，但隐式、易被破坏）。
    //
    // 注：tmpCwdWith 的项目文件 fixture（llm.model）自 ADR-0084 起已完全不
    // 生效——llm 是用户层键，project 值被允许名单丢弃；即便子代理 cwd 相同也
    // 读不到。它对本用例断言始终是旁观道具（loadIknowEnv 只读 tmpEmpty +
    // emptyHome），现属 vestigial fixture，保留只为体现「主代理项目 settings
    // 含 model，子代理仍不继承」的场景原貌。
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
          model: "test/model",
          providers: [TEST_LLM_PROVIDER],
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

describe("loadIknowEnv — llm.apiKey 旧路径退役", () => {
  beforeEach(() => {
    for (const k of ENV_KEYS) delete process.env[k];
  });
  afterEach(() => {
    for (const k of ENV_KEYS) delete process.env[k];
  });

  it("settings.llm.apiKey 不再参与 LLM 传输（providers 缺席 → typed 抛）", () => {
    assert.throws(
      () =>
        loadIknowEnv(process.cwd(), {
          llm: { model: "plain-model", apiKey: "sk-literal-123" },
        }),
      isLlmProviderConfigError
    );
  });

  it("IKNOW_LLM_MODEL env 已退役：设了也不读（model 仍来自 settings）", () => {
    process.env.IKNOW_LLM_MODEL = "from-env";
    const env = loadIknowEnv(process.cwd(), {
      llm: {
        model: "test/model",
        providers: [TEST_LLM_PROVIDER],
      },
    });
    assert.equal(env.llm.model, "test/model");
  });
});

describe("loadIknowEnv — llm.providers 解析 (ADR-0093 / T3)", () => {
  // provider 命中路径的 key 只读 process.env（spec 明文），故用独立 var 名，
  // 且测后清理；fileMap 侧刻意不提供任何回退（见「只读 process.env」用例）。
  // IKNOW_LLM_BASE_URL / IKNOW_TEST_API_KEY 不在 ENV_KEYS 里，也必须在本组内清理。
  const PROVIDER_KEYS = [
    "MINIMAX_CN_API_KEY",
    "VOLCENGINE_ARK_API_KEY",
    "PROVIDER_UNSET_KEY",
    "PROVIDER_DOTENV_ONLY_KEY",
    "IKNOW_LLM_BASE_URL",
    "IKNOW_TEST_API_KEY",
  ] as const;

  beforeEach(() => {
    for (const k of [...ENV_KEYS, ...PROVIDER_KEYS]) delete process.env[k];
  });
  afterEach(() => {
    for (const k of [...ENV_KEYS, ...PROVIDER_KEYS]) delete process.env[k];
  });

  const MINIMAX_PROVIDER = {
    id: "minimax-cn",
    baseUrl: "https://api.minimax.chat/v1",
    apiKeyEnv: "MINIMAX_CN_API_KEY",
    models: [{ id: "MiniMax-M3" }],
  };

  /** 注册表最小夹具：providers 段合法（models 非空）才不被 settings 层 drop。 */
  function settingsWithProviders(
    model: string,
    providers: ReadonlyArray<Record<string, unknown>>,
    extra?: { apiKey?: string }
  ): IknowSettings {
    return {
      llm: {
        model,
        ...(extra?.apiKey === undefined ? {} : { apiKey: extra.apiKey }),
        providers,
      },
    } as IknowSettings;
  }

  it("命中注册表 → baseUrl = provider.baseUrl 去尾斜杠，apiKey = process.env[apiKeyEnv]", () => {
    process.env.MINIMAX_CN_API_KEY = "sk-xxx";
    const env = loadIknowEnv(
      process.cwd(),
      settingsWithProviders("minimax-cn/MiniMax-M3", [MINIMAX_PROVIDER])
    );
    assert.equal(env.llm.baseUrl, "https://api.minimax.chat/v1");
    assert.equal(env.llm.apiKey, "sk-xxx");
  });

  it("baseUrl 尾斜杠被去掉（与 IKNOW_LLM_BASE_URL 同款 normalize）", () => {
    process.env.MINIMAX_CN_API_KEY = "sk-xxx";
    const env = loadIknowEnv(
      process.cwd(),
      settingsWithProviders("minimax-cn/MiniMax-M3", [
        { ...MINIMAX_PROVIDER, baseUrl: "https://api.minimax.chat/v1/" },
      ])
    );
    assert.equal(env.llm.baseUrl, "https://api.minimax.chat/v1");
  });

  it("hit 时忽略 IKNOW_LLM_BASE_URL（provider baseUrl 胜出）", () => {
    process.env.MINIMAX_CN_API_KEY = "sk-xxx";
    process.env.IKNOW_LLM_BASE_URL = "http://localhost:9999/v1";
    const env = loadIknowEnv(
      process.cwd(),
      settingsWithProviders("minimax-cn/MiniMax-M3", [MINIMAX_PROVIDER])
    );
    assert.equal(env.llm.baseUrl, "https://api.minimax.chat/v1");
  });

  it("hit 时忽略 settings.llm.apiKey 字面（provider 声明走 env）", () => {
    process.env.MINIMAX_CN_API_KEY = "sk-from-provider-env";
    const env = loadIknowEnv(
      process.cwd(),
      settingsWithProviders("minimax-cn/MiniMax-M3", [MINIMAX_PROVIDER], {
        apiKey: "sk-literal-fallback",
      })
    );
    assert.equal(env.llm.apiKey, "sk-from-provider-env");
  });

  it("provider 命中且配了 headers → env.llm.headers 原样透传", () => {
    process.env.MINIMAX_CN_API_KEY = "sk-xxx";
    const env = loadIknowEnv(
      process.cwd(),
      settingsWithProviders("minimax-cn/MiniMax-M3", [
        { ...MINIMAX_PROVIDER, headers: { "X-Session": "iknow-dev" } },
      ])
    );
    assert.deepEqual(env.llm.headers, { "X-Session": "iknow-dev" });
  });

  it("provider 命中但无 headers → env.llm.headers 键缺席（不写空对象）", () => {
    process.env.MINIMAX_CN_API_KEY = "sk-xxx";
    const env = loadIknowEnv(
      process.cwd(),
      settingsWithProviders("minimax-cn/MiniMax-M3", [MINIMAX_PROVIDER])
    );
    assert.equal("headers" in env.llm, false);
  });

  it("model 拆第一个 /：modelId 保留其余 /（a/b/c → provider a）", () => {
    process.env.PROVIDER_UNSET_KEY = "sk-slash";
    const env = loadIknowEnv(
      process.cwd(),
      settingsWithProviders("volcengine-ark/deep/deeper", [
        {
          id: "volcengine-ark",
          baseUrl: "https://ark.example.com/api/v3",
          apiKeyEnv: "PROVIDER_UNSET_KEY",
          models: [{ id: "deep/deeper" }],
        },
      ])
    );
    assert.equal(env.llm.baseUrl, "https://ark.example.com/api/v3");
    assert.equal(env.llm.model, "volcengine-ark/deep/deeper");
  });

  it("model 字段原样保留（含 provider/ 前缀，不改写）", () => {
    process.env.MINIMAX_CN_API_KEY = "sk-xxx";
    const env = loadIknowEnv(
      process.cwd(),
      settingsWithProviders("minimax-cn/MiniMax-M3", [MINIMAX_PROVIDER])
    );
    assert.equal(env.llm.model, "minimax-cn/MiniMax-M3");
  });

  it("注册表不去重：同 id 两条 → 首条命中生效", () => {
    process.env.MINIMAX_CN_API_KEY = "sk-xxx";
    const env = loadIknowEnv(
      process.cwd(),
      settingsWithProviders("minimax-cn/MiniMax-M3", [
        MINIMAX_PROVIDER,
        {
          id: "minimax-cn",
          baseUrl: "https://second.example.com/v1",
          apiKeyEnv: "MINIMAX_CN_API_KEY",
          models: [{ id: "MiniMax-M3" }],
        },
      ])
    );
    assert.equal(env.llm.baseUrl, "https://api.minimax.chat/v1");
  });

  it("apiKeyEnv 未设 → 抛 typed provider_api_key_missing（不是 Error 实例）", () => {
    assert.throws(
      () =>
        loadIknowEnv(
          process.cwd(),
          settingsWithProviders("minimax-cn/MiniMax-M3", [MINIMAX_PROVIDER])
        ),
      isLlmProviderConfigError
    );
    try {
      loadIknowEnv(
        process.cwd(),
        settingsWithProviders("minimax-cn/MiniMax-M3", [MINIMAX_PROVIDER])
      );
      assert.fail("expected loadIknowEnv to throw");
    } catch (err) {
      assert.ok(isLlmProviderConfigError(err));
      // payload 承重字段齐备（否则渲染侧拿不到 provider / env 名）。
      assert.equal(err.providerId, "minimax-cn");
      assert.equal(err.apiKeyEnv, "MINIMAX_CN_API_KEY");
      assert.equal(
        formatLlmProviderConfigError(err),
        "provider_api_key_missing: minimax-cn (env MINIMAX_CN_API_KEY unset)"
      );
      // plain object 形态：callers 必须走守卫，instanceof Error 会打成 [object Object]。
      assert.equal(err instanceof Error, false);
      assert.equal(Object.prototype.toString.call(err), "[object Object]");
    }
  });

  it("apiKeyEnv 未设时不回退 settings.llm.apiKey 字面（SC4：不静默降级）", () => {
    assert.throws(
      () =>
        loadIknowEnv(
          process.cwd(),
          settingsWithProviders("minimax-cn/MiniMax-M3", [MINIMAX_PROVIDER])
        ),
      isLlmProviderConfigError
    );
  });

  it("env 值为空串 / 全空白 → 视同未设（抛 typed）", () => {
    for (const bad of ["", "   "]) {
      process.env.MINIMAX_CN_API_KEY = bad;
      assert.throws(
        () =>
          loadIknowEnv(
            process.cwd(),
            settingsWithProviders("minimax-cn/MiniMax-M3", [MINIMAX_PROVIDER])
          ),
        isLlmProviderConfigError,
        `apiKeyEnv=${JSON.stringify(bad)} 应视同缺席`
      );
    }
  });

  it("apiKey 两侧空白被 trim 后透传（不把空白带进 Authorization）", () => {
    process.env.MINIMAX_CN_API_KEY = "  sk-padded  ";
    const env = loadIknowEnv(
      process.cwd(),
      settingsWithProviders("minimax-cn/MiniMax-M3", [MINIMAX_PROVIDER])
    );
    assert.equal(env.llm.apiKey, "sk-padded");
  });

  it("apiKeyEnv 是 Object.prototype 自有键（constructor）→ typed 抛（不 TypeError）", () => {
    // process.env.constructor 命中 Object.prototype → 函数而非 string；
    // 若不收窄会 raw.trim is not a function（M2 同族原型注入）。
    assert.throws(
      () =>
        loadIknowEnv(
          process.cwd(),
          settingsWithProviders("p-proto/m1", [
            {
              id: "p-proto",
              baseUrl: "https://p-proto.example.com/v1",
              apiKeyEnv: "constructor",
              models: [{ id: "m1" }],
            },
          ])
        ),
      isLlmProviderConfigError
    );
  });

  it("providers 非空且未命中 → 抛 provider_model_not_registered", () => {
    assert.throws(
      () =>
        loadIknowEnv(
          process.cwd(),
          settingsWithProviders("unknown-provider/some-model", [
            MINIMAX_PROVIDER,
          ])
        ),
      isLlmProviderConfigError
    );
    try {
      loadIknowEnv(
        process.cwd(),
        settingsWithProviders("unknown-provider/some-model", [MINIMAX_PROVIDER])
      );
      assert.fail("expected loadIknowEnv to throw");
    } catch (err) {
      assert.ok(isLlmProviderConfigError(err));
      assert.equal(err.kind, "provider_model_not_registered");
      assert.equal(err.model, "unknown-provider/some-model");
      assert.equal(
        formatLlmProviderConfigError(err),
        "provider_model_not_registered: unknown-provider/some-model (not in llm.providers)"
      );
    }
  });

  it("providers 段缺席 → provider_model_not_registered", () => {
    assert.throws(
      () =>
        loadIknowEnv(process.cwd(), {
          llm: { model: "minimax-cn/MiniMax-M3", apiKey: "sk-legacy" },
        }),
      isLlmProviderConfigError
    );
  });

  it("providers 空数组 → provider_model_not_registered", () => {
    assert.throws(
      () =>
        loadIknowEnv(
          process.cwd(),
          settingsWithProviders("minimax-cn/MiniMax-M3", [])
        ),
      isLlmProviderConfigError
    );
  });

  it("边界：空 providerId / 空 modelId + providers 非空 → provider_model_not_registered", () => {
    for (const model of ["/MiniMax-M3", "minimax-cn/", "minimax-cn/   ", "/"]) {
      assert.throws(
        () =>
          loadIknowEnv(
            process.cwd(),
            settingsWithProviders(model, [MINIMAX_PROVIDER])
          ),
        isLlmProviderConfigError,
        `model=${JSON.stringify(model)} 应抛 typed`
      );
    }
  });

  it("边界：providerId 两侧空白被 trim 后仍能命中", () => {
    process.env.MINIMAX_CN_API_KEY = "sk-xxx";
    const env = loadIknowEnv(
      process.cwd(),
      settingsWithProviders("  minimax-cn / MiniMax-M3", [MINIMAX_PROVIDER])
    );
    assert.equal(env.llm.baseUrl, "https://api.minimax.chat/v1");
    assert.equal(env.llm.model, "minimax-cn / MiniMax-M3");
  });

  it("只读 process.env：.env 文件里的同名 key 不参与 provider 解析（抛 typed）", async () => {
    const tmpCwd = await mkdtemp(join(tmpdir(), "iknow-provider-env-only-"));
    await writeFile(
      join(tmpCwd, ".env.local"),
      "PROVIDER_DOTENV_ONLY_KEY=sk-from-dotenv\n"
    );
    try {
      assert.throws(
        () =>
          loadIknowEnv(
            tmpCwd,
            settingsWithProviders("p1/m1", [
              {
                id: "p1",
                baseUrl: "https://p1.example.com/v1",
                apiKeyEnv: "PROVIDER_DOTENV_ONLY_KEY",
                models: [{ id: "m1" }],
              },
            ])
          ),
        isLlmProviderConfigError
      );
    } finally {
      await rm(tmpCwd, { recursive: true, force: true });
    }
  });

  it("isLlmProviderConfigError 负例：Error / null / kind 或 payload 缺字段均不命中", () => {
    assert.equal(isLlmProviderConfigError(new Error("boom")), false);
    assert.equal(isLlmProviderConfigError(null), false);
    assert.equal(isLlmProviderConfigError(undefined), false);
    assert.equal(isLlmProviderConfigError("x"), false);
    assert.equal(isLlmProviderConfigError({ kind: "other" }), false);
    assert.equal(
      isLlmProviderConfigError({
        kind: "provider_api_key_missing",
        providerId: "p1",
      }),
      false
    );
    assert.equal(
      isLlmProviderConfigError({
        kind: "provider_api_key_missing",
        providerId: "p1",
        apiKeyEnv: "K",
      }),
      true
    );
  });

  it("formatLlmProviderConfigError 只出 provider id 与 env 名，不带任何 key 值", () => {
    process.env.MINIMAX_CN_API_KEY = "sk-super-secret";
    const text = formatLlmProviderConfigError({
      kind: "provider_api_key_missing",
      providerId: "minimax-cn",
      apiKeyEnv: "MINIMAX_CN_API_KEY",
    });
    assert.equal(text.includes("sk-super-secret"), false);
    assert.equal(text.includes("MINIMAX_CN_API_KEY"), true);
    assert.equal(text.includes("minimax-cn"), true);
  });
});

// ---------------------------------------------------------------------------
// ADR-0094 T1 / SC1-SC3 SC7：wire-model 解析 SSOT。
//
// wire = models[].id（provider id 只解析 baseUrl/apiKey/headers，不上 wire）。
// 注册表命中时 wire = tail（首个 `/` 之后，含后续 `/`）;miss 由
// loadIknowEnv 在装配前 typed 抛，不会进 wire 函数。
// ---------------------------------------------------------------------------

describe("wireModelFromRoute — wire = models[].id (ADR-0094 T1)", () => {
  it("a/b → wire=b", () => {
    assert.equal(wireModelFromRoute("minimax-cn/MiniMax-M3"), "MiniMax-M3");
  });

  it("a/b/c → wire=b/c（尾段保留其余 /，SC2）", () => {
    assert.equal(
      wireModelFromRoute("9router/ocg/deepseek-v4-flash"),
      "ocg/deepseek-v4-flash"
    );
  });

  it("无 / → identity（bare name 透传）", () => {
    assert.equal(wireModelFromRoute("test-model"), "test-model");
  });

  it("空尾段 a/ → identity（防御；miss 路径今日不可达，保持 total）", () => {
    assert.equal(wireModelFromRoute("minimax-cn/"), "minimax-cn/");
  });

  it("前导空白被 trim；前导 / 形态 → identity", () => {
    assert.equal(wireModelFromRoute("  minimax-cn/MiniMax-M3"), "MiniMax-M3");
    assert.equal(wireModelFromRoute("/MiniMax-M3"), "MiniMax-M3");
  });

  it("纯空串 → identity（总函数；不抛错）", () => {
    assert.equal(wireModelFromRoute(""), "");
  });
});
