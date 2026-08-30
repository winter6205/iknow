/**
 * T1 — web_search backend env loading (#826 pluggable-web-search-backends)。
 *
 * 覆盖 spec Assumption 3-5 + plan T1 acceptance：
 *  - `WebEnv` 多 4 字段（searchBackend 默认 "bing"，exaApiKey/tavilyApiKey/braveApiKey 可选）；
 *  - `IKNOW_WEB_SEARCH_BACKEND` 闭集 `["bing","tavily","exa","brave"]` 校验，非法值抛
 *    typed `WebEnvConfigError( "invalid_search_backend" )`，**不**静默回退 default；
 *  - 三 keyed env var（vendor 命名 `EXA_API_KEY` / `TAVILY_API_KEY` / `BRAVE_API_KEY`）：
 *    字面 → 原样；未设 / 空串 / "yes" / `${UNSET_VAR}` 占位符解析失败 → undefined，
 *    抛错一致走 expandPlaceholders 链路（与 settings.llm.apiKey 同款）。
 *
 * 隔离：所有 .env.local fixture 走 tmp dir（不碰真实 repo 配置）。process.env 直设路径
 * 走 `withCleanEnv` 闭包隔离避免 case 间污染。
 */
import { afterEach, beforeEach, describe, it } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadIknowEnv,
  SEARCH_BACKEND_ENV_KEY,
  EXA_API_KEY_ENV_KEY,
  TAVILY_API_KEY_ENV_KEY,
  BRAVE_API_KEY_ENV_KEY,
  SEARCH_BACKEND_VALUES,
  isWebEnvConfigError,
} from "../../src/config/env.ts";
import type { IknowSettings } from "../../src/config/settings.ts";

/**
 * #353 review: 既有 env 测试不测 settings，统一注入最小 settings 隔离
 * 真实 ~/.iknow/<cwd>/.iknow/settings.json。loadIknowEnv 传 settings 时跳过文件读取。
 * llm.model = "test-model" 防 loader fail-fast（model 必须有来源）。
 */
const EMPTY_SETTINGS: IknowSettings = { llm: { model: "test-model" } };

/** Test-only env var 隔离清单（loader 不直读，但 case 间用 `withCleanEnv` 显式 delete）。
 *  因为 searchBackend keyed 的 3 个 vendor key 是 project 内通用 env var，提前收口避免
 *  本机 / CI 漏配导致 case 间污染。 */
const SEARCH_BACKEND_KEYS = [
  SEARCH_BACKEND_ENV_KEY,
  EXA_API_KEY_ENV_KEY,
  TAVILY_API_KEY_ENV_KEY,
  BRAVE_API_KEY_ENV_KEY,
] as const;

function makeTmpCwd(prefix: string): {
  cwd: string;
  cleanup: () => void;
} {
  const cwd = mkdtempSync(join(tmpdir(), prefix));
  return {
    cwd,
    cleanup: () => rmSync(cwd, { recursive: true, force: true }),
  };
}

function withCleanEnv<T>(fn: () => T): T {
  const saved: Record<string, string | undefined> = {};
  for (const k of SEARCH_BACKEND_KEYS) {
    if (k in process.env) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  }
  try {
    return fn();
  } finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

describe("loadIknowEnv — WebEnv.searchBackend (#826 T1, default 'bing')", () => {
  beforeEach(() => {
    for (const k of SEARCH_BACKEND_KEYS) delete process.env[k];
  });
  afterEach(() => {
    for (const k of SEARCH_BACKEND_KEYS) delete process.env[k];
  });

  it("env 未设 → 默认 'bing'（HTML 解析路径不变）", () => {
    const env = loadIknowEnv(process.cwd(), EMPTY_SETTINGS);
    assert.equal(env.web.searchBackend, "bing");
  });

  it("env 空串 → 默认 'bing'（与未设同义）", () => {
    process.env[SEARCH_BACKEND_ENV_KEY] = "";
    const env = loadIknowEnv(process.cwd(), EMPTY_SETTINGS);
    assert.equal(env.web.searchBackend, "bing");
  });

  it("env='exa' → 透传 'exa'", () => {
    process.env[SEARCH_BACKEND_ENV_KEY] = "exa";
    const env = loadIknowEnv(process.cwd(), EMPTY_SETTINGS);
    assert.equal(env.web.searchBackend, "exa");
  });

  it("env='tavily' → 透传 'tavily'", () => {
    process.env[SEARCH_BACKEND_ENV_KEY] = "tavily";
    const env = loadIknowEnv(process.cwd(), EMPTY_SETTINGS);
    assert.equal(env.web.searchBackend, "tavily");
  });

  it("env='brave' → 透传 'brave'", () => {
    process.env[SEARCH_BACKEND_ENV_KEY] = "brave";
    const env = loadIknowEnv(process.cwd(), EMPTY_SETTINGS);
    assert.equal(env.web.searchBackend, "brave");
  });

  it("env 非法值 'google' → 抛 typed WebEnvConfigError('invalid_search_backend')，不静默回退", () => {
    process.env[SEARCH_BACKEND_ENV_KEY] = "google";
    assert.throws(
      () => loadIknowEnv(process.cwd(), EMPTY_SETTINGS),
      (err: unknown) => {
        return (
          isWebEnvConfigError(err) &&
          err.kind === "invalid_search_backend" &&
          err.varName === SEARCH_BACKEND_ENV_KEY &&
          err.value === "google" &&
          JSON.stringify(err.expected) === JSON.stringify(SEARCH_BACKEND_VALUES)
        );
      }
    );
  });

  it("env 非法值 'Bing'（大小写敏感）→ 抛 typed error（不静默回退）", () => {
    // 闭集字面值小写;大小写敏感落到非法分支 → typed error（避免配错静默）。
    process.env[SEARCH_BACKEND_ENV_KEY] = "Bing";
    assert.throws(
      () => loadIknowEnv(process.cwd(), EMPTY_SETTINGS),
      isWebEnvConfigError
    );
  });

  it(".env.local 文件里的合法 backend id 透传（process.env 优先级 > .env.local）", () => {
    const { cwd, cleanup } = makeTmpCwd("iknow-search-backend-file-");
    try {
      // 未设 process.env → 走 .env.local 分支
      mkdirSync(cwd, { recursive: true });
      writeFileSync(join(cwd, ".env.local"), `${SEARCH_BACKEND_ENV_KEY}=exa\n`);
      const env = loadIknowEnv(cwd, EMPTY_SETTINGS);
      assert.equal(env.web.searchBackend, "exa");
    } finally {
      cleanup();
    }
  });
});

describe("loadIknowEnv — WebEnv.*ApiKey (vendor 命名, expandPlaceholders 链路)", () => {
  beforeEach(() => {
    for (const k of SEARCH_BACKEND_KEYS) delete process.env[k];
  });
  afterEach(() => {
    for (const k of SEARCH_BACKEND_KEYS) delete process.env[k];
  });

  it("EXA_API_KEY 未设 → exaApiKey = undefined", () => {
    const env = loadIknowEnv(process.cwd(), EMPTY_SETTINGS);
    assert.equal(env.web.exaApiKey, undefined);
  });

  it("EXA_API_KEY 空串 → exaApiKey = undefined（与未设同义）", () => {
    process.env[EXA_API_KEY_ENV_KEY] = "";
    const env = loadIknowEnv(process.cwd(), EMPTY_SETTINGS);
    assert.equal(env.web.exaApiKey, undefined);
  });

  it("EXA_API_KEY 字面密钥 → exaApiKey 原样返回", () => {
    process.env[EXA_API_KEY_ENV_KEY] = "exa-literal-key-123";
    const env = loadIknowEnv(process.cwd(), EMPTY_SETTINGS);
    assert.equal(env.web.exaApiKey, "exa-literal-key-123");
  });

  it("EXA_API_KEY 字面前后空白 → trim 后原样", () => {
    process.env[EXA_API_KEY_ENV_KEY] = "  exa-trim-key  ";
    const env = loadIknowEnv(process.cwd(), EMPTY_SETTINGS);
    assert.equal(env.web.exaApiKey, "exa-trim-key");
  });

  it("EXA_API_KEY='yes' → exaApiKey = undefined（dotenv 风格占位符回退）", () => {
    process.env[EXA_API_KEY_ENV_KEY] = "yes";
    const env = loadIknowEnv(process.cwd(), EMPTY_SETTINGS);
    assert.equal(env.web.exaApiKey, undefined);
  });

  it("EXA_API_KEY='${UNSET_VAR}'（占位符解析失败）→ exaApiKey = undefined，**不抛错**", () => {
    // 负测 T1 acceptance #6: .env.local literal `${UNSET_VAR}` → 字段 = undefined。
    // 也覆盖 process.env 等价形态（同一 expandPlaceholders 链路）。
    process.env[EXA_API_KEY_ENV_KEY] = "${UNSET_VAR}";
    let env: ReturnType<typeof loadIknowEnv> | undefined;
    assert.doesNotThrow(() => {
      env = loadIknowEnv(process.cwd(), EMPTY_SETTINGS);
    });
    assert.equal(env!.web.exaApiKey, undefined);
  });

  it("EXA_API_KEY='${UNSET_VAR}' 写在 .env.local fixture 里 → exaApiKey = undefined（spec acceptance #6）", async () => {
    // 等价的 .env.local 文件形态（与 settings.llm.apiKey 占位符解析失败路径同源）：
    // 文件里 literal `${UNSET_VAR}` → 解析不到 → undefined，不静默落空串。
    const { cwd, cleanup } = makeTmpCwd("iknow-search-exa-fixture-");
    try {
      mkdirSync(cwd, { recursive: true });
      writeFileSync(join(cwd, ".env.local"), `EXA_API_KEY=\${UNSET_VAR}\n`);
      const env = loadIknowEnv(cwd, EMPTY_SETTINGS);
      assert.equal(env.web.exaApiKey, undefined);
    } finally {
      cleanup();
    }
  });

  it("EXA_API_KEY='${VAR}' + process.env 同名 → 展开", () => {
    withCleanEnv(() => {
      process.env[EXA_API_KEY_ENV_KEY] = "${IKNOW_TEST_EXA}";
      process.env.IKNOW_TEST_EXA = "exa-from-env";
      const env = loadIknowEnv(process.cwd(), EMPTY_SETTINGS);
      assert.equal(env.web.exaApiKey, "exa-from-env");
    });
  });

  it("TAVILY_API_KEY 字面密钥 → tavilyApiKey 原样", () => {
    process.env[TAVILY_API_KEY_ENV_KEY] = "tavily-literal-key-456";
    const env = loadIknowEnv(process.cwd(), EMPTY_SETTINGS);
    assert.equal(env.web.tavilyApiKey, "tavily-literal-key-456");
  });

  it("TAVILY_API_KEY='${UNSET_VAR}' → tavilyApiKey = undefined（占位符解析失败）", () => {
    process.env[TAVILY_API_KEY_ENV_KEY] = "${UNSET_VAR}";
    const env = loadIknowEnv(process.cwd(), EMPTY_SETTINGS);
    assert.equal(env.web.tavilyApiKey, undefined);
  });

  it("TAVILY_API_KEY='yes' → tavilyApiKey = undefined", () => {
    process.env[TAVILY_API_KEY_ENV_KEY] = "yes";
    const env = loadIknowEnv(process.cwd(), EMPTY_SETTINGS);
    assert.equal(env.web.tavilyApiKey, undefined);
  });

  it("BRAVE_API_KEY 字面密钥 → braveApiKey 原样", () => {
    process.env[BRAVE_API_KEY_ENV_KEY] = "brave-literal-key-789";
    const env = loadIknowEnv(process.cwd(), EMPTY_SETTINGS);
    assert.equal(env.web.braveApiKey, "brave-literal-key-789");
  });

  it("BRAVE_API_KEY='${UNSET_VAR}' → braveApiKey = undefined（占位符解析失败）", () => {
    process.env[BRAVE_API_KEY_ENV_KEY] = "${UNSET_VAR}";
    const env = loadIknowEnv(process.cwd(), EMPTY_SETTINGS);
    assert.equal(env.web.braveApiKey, undefined);
  });

  it("BRAVE_API_KEY='yes' → braveApiKey = undefined", () => {
    process.env[BRAVE_API_KEY_ENV_KEY] = "yes";
    const env = loadIknowEnv(process.cwd(), EMPTY_SETTINGS);
    assert.equal(env.web.braveApiKey, undefined);
  });
});

describe("loadIknowEnv — WebEnv search backend 字段独立性（互不影响）", () => {
  beforeEach(() => {
    for (const k of SEARCH_BACKEND_KEYS) delete process.env[k];
  });
  afterEach(() => {
    for (const k of SEARCH_BACKEND_KEYS) delete process.env[k];
  });

  it("三个 keyed key 同时设置后各自独立", () => {
    process.env[EXA_API_KEY_ENV_KEY] = "exa-key";
    process.env[TAVILY_API_KEY_ENV_KEY] = "tavily-key";
    process.env[BRAVE_API_KEY_ENV_KEY] = "brave-key";
    const env = loadIknowEnv(process.cwd(), EMPTY_SETTINGS);
    assert.equal(env.web.exaApiKey, "exa-key");
    assert.equal(env.web.tavilyApiKey, "tavily-key");
    assert.equal(env.web.braveApiKey, "brave-key");
  });

  it("searchBackend='exa' + EXA_API_KEY 已设 → 两字段并行生效", () => {
    process.env[SEARCH_BACKEND_ENV_KEY] = "exa";
    process.env[EXA_API_KEY_ENV_KEY] = "exa-key";
    const env = loadIknowEnv(process.cwd(), EMPTY_SETTINGS);
    assert.equal(env.web.searchBackend, "exa");
    assert.equal(env.web.exaApiKey, "exa-key");
  });

  it("searchBackend + 三 key 同时配 + 既有 web.searchUrl/web.proxy 互不影响", () => {
    process.env[SEARCH_BACKEND_ENV_KEY] = "exa";
    process.env[EXA_API_KEY_ENV_KEY] = "exa-key";
    process.env[TAVILY_API_KEY_ENV_KEY] = "tavily-key";
    process.env[BRAVE_API_KEY_ENV_KEY] = "brave-key";
    process.env.IKNOW_WEB_SEARCH_URL = "https://html.duckduckgo.com/html/";
    process.env.IKNOW_WEB_PROXY = "http://proxy.local:8080";
    const env = loadIknowEnv(process.cwd(), EMPTY_SETTINGS);
    assert.equal(env.web.searchBackend, "exa");
    assert.equal(env.web.exaApiKey, "exa-key");
    assert.equal(env.web.tavilyApiKey, "tavily-key");
    assert.equal(env.web.braveApiKey, "brave-key");
    assert.equal(env.web.searchUrl, "https://html.duckduckgo.com/html/");
    assert.equal(env.web.proxy, "http://proxy.local:8080");
  });
});

describe("envOptionalEnum — helper direct API test (#826 T1, 暴露面 ref)", () => {
  // 这组 case 锁住 helper 直接形态（同形 envInt/envOptional），后续 WebEnv
  // // 装配回归只需调用同 helper，而不必重测 helper 自身。
  // 由于 envOptionalEnum 是模块私有（not exported），通过 WebEnv 装配反推。
  // 此 describe 仍走 loader API，行为即 helper 实现快照。
  beforeEach(() => {
    for (const k of SEARCH_BACKEND_KEYS) delete process.env[k];
  });
  afterEach(() => {
    for (const k of SEARCH_BACKEND_KEYS) delete process.env[k];
  });

  it("闭集内合法值通过；不对 values 顺序敏感", () => {
    // helper 接受 readonly array,因此闭集顺序不影响判定。
    for (const v of SEARCH_BACKEND_VALUES) {
      process.env[SEARCH_BACKEND_ENV_KEY] = v;
      const env = loadIknowEnv(process.cwd(), EMPTY_SETTINGS);
      assert.equal(env.web.searchBackend, v);
    }
  });
});
