/**
 * env-isolation / SC20 遮蔽（settings-model-extension）。
 *
 * configuredSecretNames 的来源 = settings.llm.apiKey 占位符指向的变量名
 * + process.env 中命中 SECRET_PATTERN 的变量名（兜底扫描）。
 *
 * 由于 `SECRET_ENV_NAMES` / `currentSecretEnvNames()` 在模块加载时经
 * `loadIknowSettings()`（真实 HOME / cwd）解析，单测无法注入 tmp settings——
 * 这里用真实文件链路验证占位符语义（把 HOME 重定向到 tmp，写
 * `{llm:{apiKey:"${VAR}"}}` 后再加载模块级函数），以及字面 apiKey
 * 不加入 secret 名、SC20 遮蔽不退化。
 */
import { describe, it, beforeAll, afterAll } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BASE_ENV_WHITELIST,
  SECRET_ENV_NAMES,
  createEnvIsolation,
  currentSecretEnvNames,
  currentSecretValues,
} from "../../../src/harness/sandbox/env-isolation.js";
// SECRET_ENV_NAMES 在模块加载期经 loadIknowSettings() 解析（真实 HOME / cwd），
// 单测无法稳定注入 tmp settings —— 本文件断言占位符语义走 currentSecretEnvNames()
// （实时解析），SECRET_ENV_NAMES 仅用于「至少一个 canonical secret 名」的既有断言。

describe("createEnvIsolation", () => {
  it("filters to explicitly allowed non-secret names", () => {
    const isolation = createEnvIsolation({ allowEnv: BASE_ENV_WHITELIST });
    const filtered = isolation.filter({
      PATH: "/bin",
      HOME: "/h",
      FOO: "bar",
      API_KEY: "secret",
    });
    assert.deepEqual(filtered, { PATH: "/bin", HOME: "/h" });
    assert.ok(Object.isFrozen(filtered));
  });

  // 注：原「derives at least one canonical secret name from env configuration」
  // 断言已删除（用户授权）：SECRET_ENV_NAMES 是模块加载期固化值，依赖 CI
  // runner 导出命中 SECRET_PATTERN 的 token 类 env 变量（如 ACTIONS_RUNTIME_TOKEN），
  // 该依赖不可移植（runner 不保证导出），CI 偶发 false。其「secret 名推导非空」
  // 语义已由下方 configuredSecretNames 系列的 currentSecretEnvNames() 实时断言
  // 覆盖（占位符 / SECRET_PATTERN 兜底 / 多段遮蔽），删除不丢真覆盖。

  it("never includes values for names identified as secrets", () => {
    const isolation = createEnvIsolation({ allowEnv: SECRET_ENV_NAMES });
    const filtered = isolation.filter(
      Object.fromEntries(SECRET_ENV_NAMES.map((name) => [name, "secret"]))
    );
    assert.deepEqual(filtered, {});
  });
});

describe("configuredSecretNames — settings.llm.apiKey 占位符语义 (settings-model-extension)", () => {
  const SETTINGS_VAR = "IKNOW_TEST_SECRET_VAR";
  let origHome: string | undefined;
  let tmpHome: string;

  beforeAll(() => {
    origHome = process.env.HOME;
    tmpHome = mkdtempSync(join(tmpdir(), "iknow-secret-names-"));
    mkdirSync(join(tmpHome, ".iknow"), { recursive: true });
    // settings.llm.apiKey = ${IKNOW_TEST_SECRET_VAR} → configuredSecretNames 应含该变量名。
    writeFileSync(
      join(tmpHome, ".iknow", "settings.json"),
      JSON.stringify({
        llm: { apiKey: "${" + SETTINGS_VAR + "}" },
      })
    );
    process.env.HOME = tmpHome;
  });

  afterAll(() => {
    if (origHome === undefined) delete process.env.HOME;
    else process.env.HOME = origHome;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("settings.llm.apiKey ${VAR} → secret 名单含 VAR（currentSecretEnvNames 实时解析）", () => {
    const names = currentSecretEnvNames();
    assert.ok(
      names.includes(SETTINGS_VAR),
      `secret 名单应包含 ${SETTINGS_VAR}（实际=${JSON.stringify(names)}）`
    );
  });

  it("该变量名的值在 filter 输出里被遮蔽（SC20 遮蔽语义不退化）", () => {
    const isolation = createEnvIsolation({ allowEnv: [SETTINGS_VAR] });
    const filtered = isolation.filter({ [SETTINGS_VAR]: "super-secret-value" });
    assert.deepEqual(filtered, {});
  });
});

describe("configuredSecretNames — 字面 apiKey 不加入 secret 名 (settings-model-extension)", () => {
  // 独立于第一组 describe 的常量（名字相同但作用域不同，避免跨块引用）。
  const LITERAL_SECRET_PATTERN_VAR = "IKNOW_TEST_SECRET_VAR";
  let origHome: string | undefined;
  let tmpHome: string;

  beforeAll(() => {
    origHome = process.env.HOME;
    tmpHome = mkdtempSync(join(tmpdir(), "iknow-secret-literal-"));
    mkdirSync(join(tmpHome, ".iknow"), { recursive: true });
    // 字面 apiKey：没有变量名可遮蔽，但 SECRET_PATTERN 兜底扫描仍会把
    // 命中 *API_KEY* 的 process.env 名字加入 secret 名单。
    writeFileSync(
      join(tmpHome, ".iknow", "settings.json"),
      JSON.stringify({
        llm: { apiKey: "sk-literal-key" },
      })
    );
    process.env.HOME = tmpHome;
  });

  afterAll(() => {
    if (origHome === undefined) delete process.env.HOME;
    else process.env.HOME = origHome;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("字面 apiKey 不贡献变量名（仅 SECRET_PATTERN 兜底扫描）", () => {
    // 即使 settings 只有字面 key，SECRET_PATTERN 兜底仍会把形如
    // IKNOW_TEST_SECRET_VAR 的名字视为 secret（防漏）。
    process.env[LITERAL_SECRET_PATTERN_VAR] = "x";
    try {
      const names = currentSecretEnvNames();
      assert.ok(
        names.includes(LITERAL_SECRET_PATTERN_VAR),
        `SECRET_PATTERN 兜底应含 ${LITERAL_SECRET_PATTERN_VAR}（实际=${JSON.stringify(names)}）`
      );
    } finally {
      delete process.env[LITERAL_SECRET_PATTERN_VAR];
    }
  });
});

describe("currentSecretValues — 字面 apiKey 内存值遮蔽 (M3, SC20)", () => {
  const LITERAL_KEY = "sk-test-literal-mask";
  let origHome: string | undefined;
  let tmpHome: string;

  beforeAll(() => {
    origHome = process.env.HOME;
    tmpHome = mkdtempSync(join(tmpdir(), "iknow-secret-literal-mask-"));
    mkdirSync(join(tmpHome, ".iknow"), { recursive: true });
    // M3: 字面 apiKey 写入 settings（无 ${VAR} 占位符 → 无 var 名贡献）。
    writeFileSync(
      join(tmpHome, ".iknow", "settings.json"),
      JSON.stringify({ llm: { apiKey: LITERAL_KEY } })
    );
    process.env.HOME = tmpHome;
  });

  afterAll(() => {
    if (origHome === undefined) delete process.env.HOME;
    else process.env.HOME = origHome;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("字面 apiKey 的 trimmed 值进入 currentSecretValues 遮蔽集", () => {
    const values = currentSecretValues();
    assert.ok(
      values.includes(LITERAL_KEY),
      `遮蔽集应含字面 key=${LITERAL_KEY}（实际=${JSON.stringify(values)}）`
    );
  });

  it("字面 apiKey 不贡献变量名（currentSecretEnvNames 仍只含 SECRET_PATTERN 兜底）", () => {
    const names = currentSecretEnvNames();
    // LITERAL_KEY 是字面密钥（值），不是 env 变量名 → 不应出现在名单里。
    assert.ok(
      !names.includes(LITERAL_KEY),
      `变量名名单不应含字面 key=${LITERAL_KEY}`
    );
  });
});

describe("configuredSecretNames — 多段占位符遮蔽 (M1, SC20)", () => {
  const M1_A = "IKNOW_M1_SECRET_A";
  const M1_B = "IKNOW_M1_SECRET_B";
  let origHome: string | undefined;
  let tmpHome: string;

  beforeAll(() => {
    origHome = process.env.HOME;
    tmpHome = mkdtempSync(join(tmpdir(), "iknow-secret-multi-"));
    mkdirSync(join(tmpHome, ".iknow"), { recursive: true });
    // M1: 多段占位符 + 字面混合（合法形态），遮蔽名单应收两段 var。
    writeFileSync(
      join(tmpHome, ".iknow", "settings.json"),
      JSON.stringify({
        llm: { apiKey: "${" + M1_A + "}literal${" + M1_B + "}" },
      })
    );
    process.env.HOME = tmpHome;
  });

  afterAll(() => {
    if (origHome === undefined) delete process.env.HOME;
    else process.env.HOME = origHome;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("settings.llm.apiKey 多段 ${A}literal${B} → 名单同时收 A 与 B", () => {
    const names = currentSecretEnvNames();
    assert.ok(
      names.includes(M1_A) && names.includes(M1_B),
      `名单应同时含 ${M1_A} 与 ${M1_B}（实际=${JSON.stringify(names)}）`
    );
  });

  it("两段 var 的值都进 currentSecretValues 遮蔽集", () => {
    process.env[M1_A] = "value-a";
    process.env[M1_B] = "value-b";
    try {
      const values = currentSecretValues();
      assert.ok(
        values.includes("value-a") && values.includes("value-b"),
        `遮蔽集应含两段值（实际=${JSON.stringify(values)}）`
      );
    } finally {
      delete process.env[M1_A];
      delete process.env[M1_B];
    }
  });
});
