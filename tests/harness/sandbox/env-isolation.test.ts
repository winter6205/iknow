/**
 * env-isolation / secret masking.
 *
 * configuredSecretNames derives from: the variable names pointed to by the
 * settings.llm.apiKey placeholders + names in process.env matching
 * SECRET_PATTERN (fallback scan).
 *
 * Because `SECRET_ENV_NAMES` / `currentSecretEnvNames()` are resolved at module
 * load through `loadIknowSettings()` (real HOME / cwd), unit tests cannot inject
 * tmp settings — so this file verifies the placeholder semantics over the real
 * file chain (redirect HOME to tmp, write `{llm:{apiKey:"${VAR}"}}`, then load
 * the module-level functions), and checks that a literal apiKey adds no secret
 * name and that masking never degrades.
 */
import {
  describe,
  it,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
} from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BASE_ENV_WHITELIST,
  SECRET_ENV_NAMES,
  applyCwdReadonlyFenceEnv,
  clearActiveExtraSecrets,
  createEnvIsolation,
  currentSecretEnvNames,
  currentSecretValues,
  setActiveExtraSecrets,
} from "../../../src/harness/sandbox/env-isolation.js";
// SECRET_ENV_NAMES is resolved at module load via loadIknowSettings() (real HOME / cwd),
// so unit tests cannot stably inject tmp settings — placeholder assertions here go
// through the live currentSecretEnvNames(); SECRET_ENV_NAMES only backs the existing
// "at least one canonical secret name" assertion.

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

  it("applyCwdReadonlyFenceEnv injects GIT_OPTIONAL_LOCKS without mutating freeze", () => {
    const isolation = createEnvIsolation({ allowEnv: BASE_ENV_WHITELIST });
    const filtered = isolation.filter({ PATH: "/bin" });
    const withLocks = applyCwdReadonlyFenceEnv(filtered, true);
    assert.equal(filtered.GIT_OPTIONAL_LOCKS, undefined);
    assert.equal(withLocks.GIT_OPTIONAL_LOCKS, "0");
    assert.equal(applyCwdReadonlyFenceEnv(filtered, false), filtered);
    assert.equal(applyCwdReadonlyFenceEnv(filtered, undefined), filtered);
  });

  // Note: the old "derives at least one canonical secret name from env
  // configuration" assertion was removed (user-authorized): SECRET_ENV_NAMES is
  // frozen at module load and depended on the CI runner exporting token-like env
  // vars matching SECRET_PATTERN (e.g. ACTIONS_RUNTIME_TOKEN), an unportable
  // dependency that caused sporadic CI false failures. Its "secret-name
  // derivation is non-empty" meaning is fully covered by the live
  // currentSecretEnvNames() assertions below (placeholders / SECRET_PATTERN
  // fallback / multi-segment masking), so removing it loses no real coverage.

  it("never includes values for names identified as secrets", () => {
    const isolation = createEnvIsolation({ allowEnv: SECRET_ENV_NAMES });
    const filtered = isolation.filter(
      Object.fromEntries(SECRET_ENV_NAMES.map((name) => [name, "secret"]))
    );
    assert.deepEqual(filtered, {});
  });

  it("keeps host GIT_SSH_COMMAND out of the fence (ssh-bridge T3 白名单钉)", () => {
    // specs/egress-ssh-bridge.md: GIT_SSH_COMMAND is not in BASE_ENV_WHITELIST —
    // the host value never enters the fence; inside the fence this env can only
    // come from egress spec.env (invariant 3: no seam = no injection = the
    // fully-offline homomorphic state).
    assert.ok(!BASE_ENV_WHITELIST.includes("GIT_SSH_COMMAND"));
    const isolation = createEnvIsolation({ allowEnv: BASE_ENV_WHITELIST });
    const filtered = isolation.filter({
      PATH: "/bin",
      GIT_SSH_COMMAND: "ssh -o ProxyCommand=host-evilsocat",
    });
    assert.equal(filtered.GIT_SSH_COMMAND, undefined);
    assert.deepEqual(Object.keys(filtered), ["PATH"]);
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
    // settings.llm.apiKey = ${IKNOW_TEST_SECRET_VAR} → configuredSecretNames should include that variable name.
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
  // Independent from the first describe group's constant (same name, different scope, to avoid cross-block references).
  const LITERAL_SECRET_PATTERN_VAR = "IKNOW_TEST_SECRET_VAR";
  let origHome: string | undefined;
  let tmpHome: string;

  beforeAll(() => {
    origHome = process.env.HOME;
    tmpHome = mkdtempSync(join(tmpdir(), "iknow-secret-literal-"));
    mkdirSync(join(tmpHome, ".iknow"), { recursive: true });
    // literal apiKey: no variable name to mask, but the SECRET_PATTERN fallback
    // scan still adds process.env names matching *API_KEY* to the secret-name list.
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
    // even when settings holds only a literal key, the SECRET_PATTERN fallback
    // still treats names like IKNOW_TEST_SECRET_VAR as secrets (leak prevention).
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
    // literal apiKey written into settings (no ${VAR} placeholder → contributes no var name).
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
    // LITERAL_KEY is a literal key (a value), not an env variable name → it must not appear in the name list.
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
    // multi-segment placeholder mixed with a literal (a valid form); the masking list should collect both variable names.
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

// ---------------------------------------------------------------------------
// currentSecretValues extraSecrets merge + the activeExtraSecrets module slot
// ---------------------------------------------------------------------------
// These groups do not depend on the settings file (currentSecretValues takes an
// env parameter / the module slot), but the SECRET_PATTERN fallback scan needs to
// hit one env variable name — MY_TOKEN_X (matches the TOKEN substring) verifies
// that env-derived values join the union. beforeEach/afterEach clear the slot to
// avoid cross-test pollution.
describe("#406 T3 — currentSecretValues extraSecrets 合并 (A3)", () => {
  const EXTRA_VAR = "MY_TOKEN_X";

  beforeEach(() => {
    delete process.env[EXTRA_VAR];
  });
  afterEach(() => {
    delete process.env[EXTRA_VAR];
  });

  it("extraSecrets 与 env 派生值并集 + 去重（env 值只出现一次）", () => {
    const env: NodeJS.ProcessEnv = { [EXTRA_VAR]: "sk-already-in-env-value" };
    const result = currentSecretValues(env, [
      "sk-new-xxx",
      "sk-already-in-env-value",
    ]);
    assert.ok(
      result.includes("sk-already-in-env-value"),
      `应含 env 派生值（实际=${JSON.stringify(result)}）`
    );
    assert.ok(
      result.includes("sk-new-xxx"),
      `应含显式 extraSecrets 值（实际=${JSON.stringify(result)}）`
    );
    const occurrences = result.filter(
      (v) => v === "sk-already-in-env-value"
    ).length;
    assert.equal(occurrences, 1, "env 派生值与 extraSecrets 重复时只保留一份");
  });

  it("env 值缺省时 extraSecrets 仍独立进入遮蔽集", () => {
    const result = currentSecretValues({}, ["sk-standalone-extra"]);
    assert.ok(result.includes("sk-standalone-extra"));
  });

  it("空值 extraSecrets 不污染遮蔽集", () => {
    const result = currentSecretValues({}, ["", undefined as never]);
    assert.ok(!result.includes(""));
  });
});

describe("#406 T3 — activeExtraSecrets 模块槽位 (A4 trace/jsonl 路径)", () => {
  beforeEach(() => clearActiveExtraSecrets());
  afterEach(() => clearActiveExtraSecrets());

  it("setActiveExtraSecrets 后 currentSecretValues() 无参调用含值", () => {
    setActiveExtraSecrets(["sk-registry-secret"]);
    const result = currentSecretValues({});
    assert.ok(
      result.includes("sk-registry-secret"),
      `无参调用应覆盖 registry 值（实际=${JSON.stringify(result)}）`
    );
  });

  it("clearActiveExtraSecrets 后 currentSecretValues() 无参调用不含值", () => {
    setActiveExtraSecrets(["sk-registry-secret"]);
    clearActiveExtraSecrets();
    const result = currentSecretValues({});
    assert.ok(!result.includes("sk-registry-secret"));
  });

  it("setActiveExtraSecrets 入参去重（重复值只留一份）", () => {
    setActiveExtraSecrets(["sk-dup", "sk-dup", "sk-other"]);
    const result = currentSecretValues({});
    const occurrences = result.filter((v) => v === "sk-dup").length;
    assert.equal(occurrences, 1);
  });

  it("显式 extraSecrets 优先于模块槽位（?? 语义）", () => {
    setActiveExtraSecrets(["from-module"]);
    const result = currentSecretValues({}, ["from-explicit"]);
    assert.ok(
      result.includes("from-explicit"),
      `显式 extraSecrets 应生效（实际=${JSON.stringify(result)}）`
    );
    assert.ok(
      !result.includes("from-module"),
      "显式 extraSecrets 在场时模块槽位被覆盖"
    );
  });
});
