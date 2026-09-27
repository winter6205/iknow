/**
 * `llm.providers[].models[].maxTokens` input contract at the settings layer.
 *
 * The field carries the request output budget. Absence is legal (request
 * assembly falls back to 32,000 elsewhere); every *explicit* illegal value is a
 * typed configuration error naming the provider/model entry and the field, and
 * never degrades into that fallback. Sibling model fields (`contextWindow`)
 * keep this file's drop-not-throw discipline, so both are pinned side by side.
 *
 * Loading goes through the real reader over temp home / temp cwd files, and each
 * throwing case compares the settings file bytes before and after: validation
 * never rewrites the operator's file.
 */
import { describe, it, beforeAll, afterAll } from "vitest";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  formatLlmBudgetConfigError,
  isLlmBudgetConfigError,
  loadIknowSettings,
  type LlmBudgetConfigError,
} from "../../src/config/settings.ts";

let workDir: string;
beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), "iknow-model-max-tokens-"));
});
afterAll(async () => {
  await rm(workDir, { recursive: true, force: true });
});

function settingsJsonWithModels(models: unknown[]): Record<string, unknown> {
  return {
    llm: {
      model: "p/m",
      providers: [{ id: "p", baseUrl: "https://x", apiKeyEnv: "K", models }],
    },
  };
}

/** Writes the user-layer settings file into a fresh temp home; returns both layer dirs. */
async function writeUserSettings(
  settings: Record<string, unknown>
): Promise<{ home: string; cwd: string; userPath: string }> {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const home = join(workDir, "home", stamp);
  const cwd = join(workDir, "cwd", stamp);
  await mkdir(join(home, ".iknow"), { recursive: true });
  await mkdir(join(cwd, ".iknow"), { recursive: true });
  const userPath = join(home, ".iknow", "settings.json");
  await writeFile(userPath, JSON.stringify(settings, null, 2) + "\n", "utf8");
  return { home, cwd, userPath };
}

/**
 * Loads real temp-file settings and reports the thrown value (undefined on
 * success) together with the user-layer file bytes taken before and after the
 * load attempt.
 */
async function loadAndCapture(settings: Record<string, unknown>): Promise<{
  err: unknown;
  home: string;
  cwd: string;
  userPath: string;
  before: string;
  after: string;
}> {
  const dirs = await writeUserSettings(settings);
  const before = await readFile(dirs.userPath, "utf8");
  let err: unknown;
  try {
    loadIknowSettings({ home: dirs.home, cwd: dirs.cwd });
  } catch (caught) {
    err = caught;
  }
  const after = await readFile(dirs.userPath, "utf8");
  return { ...dirs, err, before, after };
}

type ModelMaxTokensError = Extract<
  LlmBudgetConfigError,
  { kind: "model_max_tokens_invalid" }
>;

/** Fails with the received payload unless `err` is the model-budget typed error. */
function requireMaxTokensError(err: unknown): ModelMaxTokensError {
  if (!isLlmBudgetConfigError(err) || err.kind !== "model_max_tokens_invalid") {
    assert.fail(`期望 model_max_tokens_invalid,实际 ${JSON.stringify(err)}`);
  }
  return err;
}

const ILLEGAL_MAX_TOKENS: ReadonlyArray<readonly [string, unknown]> = [
  ["null", null],
  ["字符串 '32000'", "32000"],
  ["空字符串", ""],
  ["对象", {}],
  ["数组", [64000]],
  ["布尔 true", true],
  ["零", 0],
  ["负数", -1],
  ["小数 1.5", 1.5],
  ["超出安全整数", Number.MAX_SAFE_INTEGER + 1],
  ["科学计数大值 1e21", 1e21],
];

describe("settings models[].maxTokens — 显式非法值抛 typed 配置错误", () => {
  for (const [label, value] of ILLEGAL_MAX_TOKENS) {
    it(`${label} → typed model_max_tokens_invalid,点名条目与字段,不改文件`, async () => {
      const { err, before, after } = await loadAndCapture(
        settingsJsonWithModels([{ id: "m", maxTokens: value }])
      );
      const budget = requireMaxTokensError(err);
      assert.equal(budget.providerId, "p");
      assert.equal(budget.modelId, "m");
      assert.equal(budget.field, "maxTokens");
      const text = formatLlmBudgetConfigError(budget);
      assert.match(text, /p\/m/);
      assert.match(text, /models\[\]\.maxTokens/);
      assert.equal(after, before, "校验失败不得改写用户层 settings 文件");
    });
  }

  it("出错文件仍保留用户原值(未注入任何默认)", async () => {
    const { err, after } = await loadAndCapture(
      settingsJsonWithModels([{ id: "m", maxTokens: 0 }])
    );
    requireMaxTokensError(err);
    assert.match(after, /"maxTokens": 0/);
  });

  it("同一条目里 contextWindow 非法只丢字段,maxTokens 非法仍抛(两种纪律并存)", async () => {
    const { err } = await loadAndCapture(
      settingsJsonWithModels([
        { id: "m", contextWindow: 0, maxTokens: "64000" },
      ])
    );
    assert.equal(requireMaxTokensError(err).field, "maxTokens");
  });

  it("多个模型条目时,错误点名真正出错的那一条", async () => {
    const { err } = await loadAndCapture(
      settingsJsonWithModels([
        { id: "good", maxTokens: 131072 },
        { id: "bad", name: "Bad Entry", maxTokens: -5 },
      ])
    );
    const budget = requireMaxTokensError(err);
    assert.equal(budget.modelId, "bad");
    assert.equal(budget.providerId, "p");
    assert.match(formatLlmBudgetConfigError(budget), /bad/);
  });
});

describe("settings models[].maxTokens — 合法值、缺省与既有丢弃边界", () => {
  it("字段缺省 → 正常加载,条目不产出 maxTokens 键", async () => {
    const { home, cwd } = await writeUserSettings(
      settingsJsonWithModels([{ id: "m", name: "M" }])
    );
    const s = loadIknowSettings({ home, cwd });
    const model = s.llm?.providers?.[0]?.models[0];
    assert.equal(model?.id, "m");
    assert.equal(
      Object.prototype.hasOwnProperty.call(model, "maxTokens"),
      false
    );
  });

  for (const legal of [1, 32_000, 131072, Number.MAX_SAFE_INTEGER]) {
    it(`${legal} → 原样透传(正安全整数)`, async () => {
      const { home, cwd } = await writeUserSettings(
        settingsJsonWithModels([{ id: "m", maxTokens: legal }])
      );
      const s = loadIknowSettings({ home, cwd });
      assert.equal(s.llm?.providers?.[0]?.models[0]?.maxTokens, legal);
    });
  }

  it("非法值挂在整条丢弃的条目上(缺 id 模型 / 坏形状 provider)→ 维持既有静默丢弃", async () => {
    const missingId = await loadAndCapture(
      settingsJsonWithModels([{ maxTokens: 0 }])
    );
    assert.equal(missingId.err, undefined);
    assert.equal(
      loadIknowSettings({
        home: missingId.home,
        cwd: missingId.cwd,
      }).llm?.providers,
      undefined
    );

    const brokenProvider = await loadAndCapture({
      llm: {
        model: "p/m",
        providers: [
          { id: "q", apiKeyEnv: "K", models: [{ id: "m", maxTokens: 0 }] },
        ],
      },
    });
    assert.equal(brokenProvider.err, undefined);
    assert.equal(
      loadIknowSettings({
        home: brokenProvider.home,
        cwd: brokenProvider.cwd,
      }).llm?.providers,
      undefined
    );
  });
});

describe("isLlmBudgetConfigError / formatLlmBudgetConfigError 判别面", () => {
  it("普通 Error 与形状不符的对象不被误判为 typed 预算错误", () => {
    assert.equal(isLlmBudgetConfigError(new Error("boom")), false);
    assert.equal(
      isLlmBudgetConfigError({ kind: "provider_api_key_missing" }),
      false
    );
    assert.equal(
      isLlmBudgetConfigError({
        kind: "model_max_tokens_invalid",
        providerId: "p",
        modelId: 7,
        field: "maxTokens",
        value: 0,
      }),
      false
    );
    assert.equal(
      isLlmBudgetConfigError({
        kind: "legacy_max_output_tokens_env",
        varName: "IKNOW_LLM_MAX_OUTPUT_TOKENS",
      }),
      false
    );
  });

  it("legacy 载荷形状齐备时判真,且格式化点名变量与 models[].maxTokens 迁移", () => {
    const err: LlmBudgetConfigError = {
      kind: "legacy_max_output_tokens_env",
      varName: "IKNOW_LLM_MAX_OUTPUT_TOKENS",
      value: "4096",
    };
    assert.ok(isLlmBudgetConfigError(err));
    const text = formatLlmBudgetConfigError(err);
    assert.match(text, /IKNOW_LLM_MAX_OUTPUT_TOKENS/);
    assert.match(text, /models\[\]\.maxTokens/);
  });
});
