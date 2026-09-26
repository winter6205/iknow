/**
 * Per-route request output budgets (ADR-0094 route resolution + ADR-0122
 * amendment 2026-09-26).
 *
 * The env layer resolves and never decides: it surfaces the `maxTokens` of the
 * `models[]` entry matched by that route's model id, and leaves the 32,000
 * fallback to request assembly. That keeps "the entry declares a budget"
 * distinguishable from "the entry is silent" for every consumer, and keeps one
 * route's budget from ever being read as another route's cap.
 *
 * Match discipline follows ADR-0094: the entry is looked up by the wire model
 * (the route tail after the first `/`), the provider id never participates.
 */
import assert from "node:assert/strict";
import { describe, it, beforeAll, afterAll } from "vitest";
import { loadIknowEnv, DEFAULT_MAX_OUTPUT_TOKENS } from "../../src/config/env.ts";
import type { IknowSettings } from "../../src/config/settings.ts";

const MAIN_KEY_ENV = "IKNOW_TEST_ROUTE_BUDGET_MAIN_KEY";
const SUB_KEY_ENV = "IKNOW_TEST_ROUTE_BUDGET_SUB_KEY";
const LITE_KEY_ENV = "IKNOW_TEST_ROUTE_BUDGET_LITE_KEY";
const KEYLESS_ENV = "IKNOW_TEST_ROUTE_BUDGET_NEVER_SET";

/** `routeMaxTokens` is the resolved field these cases pin; local alias keeps lines short. */
const BUDGET_FIELD = "routeMaxTokens";

const MAIN_PROVIDER = {
  id: "main",
  baseUrl: "http://main.test/v1",
  apiKeyEnv: MAIN_KEY_ENV,
  models: [
    { id: "opus", maxTokens: 72_000 },
    // silent entry: no maxTokens at all
    { id: "quiet" },
    { id: "MiniMax-M3", maxTokens: 131_072 },
    // above the documented M3 maximum: resolution must pass it through untouched
    { id: "m3-over", maxTokens: 524_289 },
    { id: "deep/edge", maxTokens: 45_000 },
    // the registry is not deduplicated: the first entry with the id wins
    { id: "dup", maxTokens: 11_000 },
    { id: "dup", maxTokens: 22_000 },
  ],
};

const SUB_PROVIDER = {
  id: "sub",
  baseUrl: "http://sub.test/v1",
  apiKeyEnv: SUB_KEY_ENV,
  headers: { "X-Sub": "1" },
  models: [{ id: "sub-model", maxTokens: 64_000 }, { id: "sub-quiet" }],
};

const LITE_PROVIDER = {
  id: "lite",
  baseUrl: "http://lite.test/v1",
  apiKeyEnv: LITE_KEY_ENV,
  models: [{ id: "lite-model", maxTokens: 8_000 }],
};

/** Route whose provider is registered but whose api-key env is never set. */
const KEYLESS_PROVIDER = {
  id: "keyless",
  baseUrl: "http://keyless.test/v1",
  apiKeyEnv: KEYLESS_ENV,
  models: [{ id: "k", maxTokens: 4_000 }],
};

function settings(opts: {
  readonly model: string;
  readonly subagentModel?: string;
  readonly liteModel?: string;
  readonly providers?: readonly unknown[];
}): IknowSettings {
  return {
    llm: {
      model: opts.model,
      providers: [MAIN_PROVIDER, SUB_PROVIDER, LITE_PROVIDER, KEYLESS_PROVIDER],
      ...(opts.liteModel === undefined
        ? {}
        : { liteModel: opts.liteModel }),
    } as IknowSettings["llm"],
    ...(opts.subagentModel === undefined
      ? {}
      : {
          subagent: {
            model: opts.subagentModel,
          } as IknowSettings["subagent"],
        }),
  };
}

describe("loadIknowEnv — main-route output budget from the matched models[] entry", () => {
  beforeAll(() => {
    process.env[MAIN_KEY_ENV] = "main-key";
    process.env[SUB_KEY_ENV] = "sub-key";
    process.env[LITE_KEY_ENV] = "lite-key";
    delete process.env[KEYLESS_ENV];
  });
  afterAll(() => {
    delete process.env[MAIN_KEY_ENV];
    delete process.env[SUB_KEY_ENV];
    delete process.env[LITE_KEY_ENV];
    delete process.env[KEYLESS_ENV];
  });

  it("SC1: 选中条目 maxTokens 72000 → 解析结果为该值", () => {
    const env = loadIknowEnv(process.cwd(), settings({ model: "main/opus" }));
    assert.equal(env.llm[BUDGET_FIELD], 72_000);
  });

  it("SC2: 条目省略 maxTokens → 键缺席（fallback 属装配侧，不在解析侧写死）", () => {
    const env = loadIknowEnv(process.cwd(), settings({ model: "main/quiet" }));
    assert.equal(
      BUDGET_FIELD in env.llm,
      false,
      "silent entry must not produce the key"
    );
    assert.equal(DEFAULT_MAX_OUTPUT_TOKENS, 32_000);
  });

  it("SC2: 路由命中 provider 但 models[] 无该条目 → 键缺席", () => {
    const env = loadIknowEnv(
      process.cwd(),
      settings({ model: "main/not-listed" })
    );
    assert.equal(BUDGET_FIELD in env.llm, false);
    // the route itself still resolves: absence of an entry is not a load failure
    assert.equal(env.llm.model, "main/not-listed");
    assert.equal(env.llm.baseUrl, "http://main.test/v1");
  });

  it("SC3: 切换选中模型 → 解析跟随新条目，不保留旧值", () => {
    const first = loadIknowEnv(
      process.cwd(),
      settings({ model: "main/opus" })
    );
    const second = loadIknowEnv(
      process.cwd(),
      settings({ model: "main/MiniMax-M3" })
    );
    assert.equal(first.llm[BUDGET_FIELD], 72_000);
    assert.equal(second.llm[BUDGET_FIELD], 131_072);
    assert.notEqual(second.llm[BUDGET_FIELD], first.llm[BUDGET_FIELD]);
  });

  it("SC3: llm.fallback 中的条目成为生效模型 → 取该条目自身的值", () => {
    const configured = {
      ...settings({ model: "main/opus" }),
      llm: {
        ...(settings({ model: "main/opus" }).llm as object),
        fallback: ["main/MiniMax-M3"],
      },
    } as IknowSettings;
    const selected = loadIknowEnv(process.cwd(), configured);
    // the fallback route is not in force while the selection stands
    assert.equal(selected.llm[BUDGET_FIELD], 72_000);
    const afterSwitch = loadIknowEnv(
      process.cwd(),
      {
        ...configured,
        llm: { ...(configured.llm as object), model: "main/MiniMax-M3" },
      } as IknowSettings
    );
    assert.equal(afterSwitch.llm[BUDGET_FIELD], 131_072);
  });

  it("wire-model 尾段含 / → 按尾段匹配条目", () => {
    const env = loadIknowEnv(
      process.cwd(),
      settings({ model: "main/deep/edge" })
    );
    assert.equal(env.llm[BUDGET_FIELD], 45_000);
  });

  it("重复 id 条目不去重：首条命中生效", () => {
    const env = loadIknowEnv(process.cwd(), settings({ model: "main/dup" }));
    assert.equal(env.llm[BUDGET_FIELD], 11_000);
  });

  it("SC15: 超出文档上限的正安全整数原样解析，不夹取", () => {
    const env = loadIknowEnv(
      process.cwd(),
      settings({ model: "main/m3-over" })
    );
    assert.equal(env.llm[BUDGET_FIELD], 524_289);
  });

  it("budget 与其它解析臂互不干扰：headers / apiKey / model 原样", () => {
    const env = loadIknowEnv(process.cwd(), settings({ model: "main/opus" }));
    assert.equal(env.llm.apiKey, "main-key");
    assert.equal(env.llm.model, "main/opus");
    assert.equal("headers" in env.llm, false);
    // the retired snapshot field keeps its documented constant value
    assert.equal(env.llm.maxOutputTokens, DEFAULT_MAX_OUTPUT_TOKENS);
  });
});

describe("loadIknowEnv — separately routed subagent / lite budgets", () => {
  beforeAll(() => {
    process.env[MAIN_KEY_ENV] = "main-key";
    process.env[SUB_KEY_ENV] = "sub-key";
    process.env[LITE_KEY_ENV] = "lite-key";
    delete process.env[KEYLESS_ENV];
  });
  afterAll(() => {
    delete process.env[MAIN_KEY_ENV];
    delete process.env[SUB_KEY_ENV];
    delete process.env[LITE_KEY_ENV];
    delete process.env[KEYLESS_ENV];
  });

  it("SC12: subagent 路由条目 64000 → 路由记录携带自身值，主路由值不覆盖它", () => {
    const env = loadIknowEnv(
      process.cwd(),
      settings({ model: "main/opus", subagentModel: "sub/sub-model" })
    );
    assert.equal(env.llm[BUDGET_FIELD], 72_000);
    assert.ok(env.subagent.model);
    assert.equal(env.subagent.model.maxTokens, 64_000);
  });

  it("SC12: subagent 条目省略 maxTokens → 该路由键缺席，主路由值不受影响", () => {
    const env = loadIknowEnv(
      process.cwd(),
      settings({ model: "main/opus", subagentModel: "sub/sub-quiet" })
    );
    assert.ok(env.subagent.model);
    assert.equal("maxTokens" in env.subagent.model, false);
    assert.equal(env.llm[BUDGET_FIELD], 72_000);
  });

  it("SC12: subagent 路由无对应条目 → 键缺席（与 transport triple 同时在场）", () => {
    const env = loadIknowEnv(
      process.cwd(),
      settings({ model: "main/opus", subagentModel: "sub/unlisted" })
    );
    assert.ok(env.subagent.model);
    assert.equal(env.subagent.model.baseUrl, "http://sub.test/v1");
    assert.equal("maxTokens" in env.subagent.model, false);
  });

  it("SC18: 主路由与 subagent 路由同时配置不同值 → 各自保留自身值", () => {
    const env = loadIknowEnv(
      process.cwd(),
      settings({ model: "main/MiniMax-M3", subagentModel: "sub/sub-model" })
    );
    assert.ok(env.subagent.model);
    assert.equal(env.llm[BUDGET_FIELD], 131_072);
    assert.equal(env.subagent.model.maxTokens, 64_000);
  });

  it("SC18: 一侧缺值不影响另一侧解析", () => {
    const env = loadIknowEnv(
      process.cwd(),
      settings({ model: "main/quiet", subagentModel: "sub/sub-model" })
    );
    assert.equal(BUDGET_FIELD in env.llm, false);
    assert.ok(env.subagent.model);
    assert.equal(env.subagent.model.maxTokens, 64_000);
  });

  it("subagent 路由不可建（api-key env 未设）→ 整条路由键缺席，主路由预算保留", () => {
    const env = loadIknowEnv(
      process.cwd(),
      settings({ model: "main/opus", subagentModel: "keyless/k" })
    );
    assert.equal("model" in env.subagent, false);
    assert.equal(env.llm[BUDGET_FIELD], 72_000);
  });

  it("lite 路由走同一 ModelRouteEnv 解析 → 携带自身条目值", () => {
    const env = loadIknowEnv(
      process.cwd(),
      settings({ model: "main/opus", liteModel: "lite/lite-model" })
    );
    assert.ok(env.llm.liteModel);
    assert.equal(env.llm.liteModel.maxTokens, 8_000);
    assert.equal(env.llm[BUDGET_FIELD], 72_000);
  });
});
