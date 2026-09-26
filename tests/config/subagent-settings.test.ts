/**
 * subagent settings two-field integration (per-call llm.timeoutMs + per-task subagent.taskTimeoutMs).
 *
 * settings + env together:
 *  - settings file-layer parse/merge (drop-not-throw); since ADR-0084 llm/subagent
 *    are both user-layer keys → same-named sections in the project file are dropped
 *    by the allowlist and never merged;
 *  - env file layer + process.env fallback (env > settings);
 *  - cross-process inheritance (a subagent self-assembles with the same cwd + home →
 *    inherits both user-settings fields).
 *
 * Coverage: single field, both fields coexisting, merge override, env overriding settings, cross-process inheritance, frozen.
 */
import { describe, it, beforeAll, afterAll } from "vitest";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadIknowSettings } from "../../src/config/settings.ts";
import { loadIknowEnv } from "../../src/config/env.ts";
import {
  installTestProviderApiKey,
  withTestLlmProvider,
  TEST_LLM_PROVIDER_API_KEY_ENV,
} from "../_helpers/test-llm-settings.ts";

let workDir: string;
beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), "iknow-subagent-settings-"));
});
afterAll(async () => {
  await rm(workDir, { recursive: true, force: true });
});

/** env loader: must hit the providers registry. */
const EMPTY = withTestLlmProvider();

/** Writes one settings file per layer (user / project), returns isolated LoadSettingsOpts. */
async function makeSettings(
  user: Record<string, unknown>,
  project: Record<string, unknown>
): Promise<{ home: string; cwd: string }> {
  const home = join(workDir, "home", `${Math.random().toString(36).slice(2)}`);
  const cwd = join(workDir, "cwd", `${Math.random().toString(36).slice(2)}`);
  await mkdir(join(home, ".iknow"), { recursive: true });
  await mkdir(join(cwd, ".iknow"), { recursive: true });
  if (Object.keys(user).length > 0) {
    await writeFile(
      join(home, ".iknow", "settings.json"),
      JSON.stringify(user)
    );
  }
  if (Object.keys(project).length > 0) {
    await writeFile(
      join(cwd, ".iknow", "settings.json"),
      JSON.stringify(project)
    );
  }
  return { home, cwd };
}

describe("subagent settings — settings 文件层 parse (#358 T1)", () => {
  it("仅 subagent.taskTimeoutMs → 出 subagent 段（不含 llm）", async () => {
    const { home, cwd } = await makeSettings(
      { subagent: { taskTimeoutMs: 7_200_000 } },
      {}
    );
    assert.deepEqual(loadIknowSettings({ home, cwd }), {
      subagent: { taskTimeoutMs: 7_200_000 },
    });
  });

  it("仅 llm.timeoutMs → 出 llm 段带 timeoutMs（不含 subagent）", async () => {
    const { home, cwd } = await makeSettings(
      { llm: { timeoutMs: 60_000 } },
      {}
    );
    assert.deepEqual(loadIknowSettings({ home, cwd }), {
      llm: { timeoutMs: 60_000 },
    });
  });

  it("同时配 llm.timeoutMs + subagent.taskTimeoutMs → 两段都保留", async () => {
    const { home, cwd } = await makeSettings(
      { llm: { timeoutMs: 60_000 }, subagent: { taskTimeoutMs: 7_200_000 } },
      {}
    );
    assert.deepEqual(loadIknowSettings({ home, cwd }), {
      llm: { timeoutMs: 60_000 },
      subagent: { taskTimeoutMs: 7_200_000 },
    });
  });

  it("drop-not-throw: taskTimeoutMs 0/-5/'abc'/1.5 → 丢弃 subagent 段", async () => {
    for (const bad of [0, -5, "abc", 1.5]) {
      const { home, cwd } = await makeSettings(
        { subagent: { taskTimeoutMs: bad } },
        {}
      );
      assert.deepEqual(
        loadIknowSettings({ home, cwd }),
        {},
        `taskTimeoutMs=${JSON.stringify(bad)} 应丢弃`
      );
    }
  });

  it("drop-not-throw: llm.timeoutMs 0/-5/'abc'/1.5 → 丢弃 llm.timeoutMs 字段", async () => {
    for (const bad of [0, -5, "abc", 1.5]) {
      const { home, cwd } = await makeSettings({ llm: { timeoutMs: bad } }, {});
      assert.deepEqual(
        loadIknowSettings({ home, cwd }),
        {},
        `timeoutMs=${JSON.stringify(bad)} 应丢弃`
      );
    }
  });
});

describe("subagent settings — 项目层不参与（ADR-0084 允许名单）", () => {
  it("project 的 llm 被丢弃并告警 → user 值胜出（不再被 project 覆盖）", async () => {
    const { home, cwd } = await makeSettings(
      { llm: { timeoutMs: 60_000 } },
      { llm: { timeoutMs: 30_000 } }
    );
    const warnings: string[] = [];
    assert.deepEqual(
      loadIknowSettings({ home, cwd, onWarn: (m) => warnings.push(m) }),
      { llm: { timeoutMs: 60_000 } }
    );
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /"llm"/);
  });

  it("project 的 subagent 被丢弃并告警 → user 值胜出", async () => {
    const { home, cwd } = await makeSettings(
      { subagent: { taskTimeoutMs: 7_200_000 } },
      { subagent: { taskTimeoutMs: 1_800_000 } }
    );
    const warnings: string[] = [];
    assert.deepEqual(
      loadIknowSettings({ home, cwd, onWarn: (m) => warnings.push(m) }),
      { subagent: { taskTimeoutMs: 7_200_000 } }
    );
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /"subagent"/);
  });

  it("user 只配 llm.timeoutMs、project 只配 subagent → 项目段丢弃，仅 user 段保留", async () => {
    const { home, cwd } = await makeSettings(
      { llm: { timeoutMs: 60_000 } },
      { subagent: { taskTimeoutMs: 7_200_000 } }
    );
    const warnings: string[] = [];
    assert.deepEqual(
      loadIknowSettings({ home, cwd, onWarn: (m) => warnings.push(m) }),
      { llm: { timeoutMs: 60_000 } }
    );
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /"subagent"/);
  });

  it("user 只配 subagent.taskTimeoutMs、project 只配 llm → 项目段丢弃，仅 user 段保留", async () => {
    const { home, cwd } = await makeSettings(
      { subagent: { taskTimeoutMs: 7_200_000 } },
      { llm: { timeoutMs: 30_000 } }
    );
    const warnings: string[] = [];
    assert.deepEqual(
      loadIknowSettings({ home, cwd, onWarn: (m) => warnings.push(m) }),
      { subagent: { taskTimeoutMs: 7_200_000 } }
    );
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /"llm"/);
  });

  it("project llm 段整体丢弃 → user timeoutMs 胜出（project 非法值未参与校验）", async () => {
    const { home, cwd } = await makeSettings(
      { llm: { timeoutMs: 60_000 } },
      { llm: { timeoutMs: "bad" } }
    );
    assert.deepEqual(loadIknowSettings({ home, cwd }), {
      llm: { timeoutMs: 60_000 },
    });
  });

  it("project subagent 段整体丢弃 → user taskTimeoutMs 胜出（project 非法值未参与校验）", async () => {
    const { home, cwd } = await makeSettings(
      { subagent: { taskTimeoutMs: 7_200_000 } },
      { subagent: { taskTimeoutMs: -1 } }
    );
    assert.deepEqual(loadIknowSettings({ home, cwd }), {
      subagent: { taskTimeoutMs: 7_200_000 },
    });
  });
});

describe("subagent settings — env > settings 链 (#358 T1)", () => {
  const ENV_KEYS_SUBAGENT = [
    "IKNOW_LLM_TIMEOUT_MS",
    "IKNOW_SUBAGENT_TASK_TIMEOUT_MS",
  ] as const;

  beforeAll(() => {
    for (const k of ENV_KEYS_SUBAGENT) delete process.env[k];
    installTestProviderApiKey();
  });
  afterAll(() => {
    for (const k of ENV_KEYS_SUBAGENT) delete process.env[k];
  });

  it("settings 配 llm.timeoutMs + subagent.taskTimeoutMs → env 透传", () => {
    const env = loadIknowEnv(process.cwd(), {
      ...withTestLlmProvider({ timeoutMs: 45_000 }),
      subagent: { taskTimeoutMs: 3_600_000 },
    });
    assert.equal(env.llm.timeoutMs, 45_000);
    assert.equal(env.subagent?.taskTimeoutMs, 3_600_000);
  });

  it("env 配 llm.timeoutMs + subagent.taskTimeoutMs → env wins（覆盖 settings）", () => {
    process.env.IKNOW_LLM_TIMEOUT_MS = "30000";
    process.env.IKNOW_SUBAGENT_TASK_TIMEOUT_MS = "7200000";
    const env = loadIknowEnv(process.cwd(), {
      ...withTestLlmProvider({ timeoutMs: 45_000 }),
      subagent: { taskTimeoutMs: 3_600_000 },
    });
    assert.equal(env.llm.timeoutMs, 30_000);
    assert.equal(env.subagent?.taskTimeoutMs, 7_200_000);
  });

  it("env 非法 + settings 未配 → llm.timeoutMs 300000 fallback、subagent.taskTimeoutMs undefined", () => {
    process.env.IKNOW_LLM_TIMEOUT_MS = "abc";
    process.env.IKNOW_SUBAGENT_TASK_TIMEOUT_MS = "abc";
    const env = loadIknowEnv(process.cwd(), EMPTY);
    assert.equal(env.llm.timeoutMs, 300_000);
    assert.equal(env.subagent?.taskTimeoutMs, undefined);
  });

  it("仅 subagent.taskTimeoutMs env、llm.timeoutMs 未配 → subagent 有值、llm 走 fallback", () => {
    process.env.IKNOW_SUBAGENT_TASK_TIMEOUT_MS = "7200000";
    const env = loadIknowEnv(process.cwd(), EMPTY);
    assert.equal(env.subagent?.taskTimeoutMs, 7_200_000);
    assert.equal(env.llm.timeoutMs, 300_000);
  });
});

describe("subagent settings — 跨进程继承 (#358 T1, 跨 process boundary)", () => {
  const ENV_KEYS_CROSS = [
    "IKNOW_LLM_TIMEOUT_MS",
    "IKNOW_SUBAGENT_TASK_TIMEOUT_MS",
  ] as const;

  beforeAll(() => {
    for (const k of ENV_KEYS_CROSS) delete process.env[k];
    installTestProviderApiKey();
  });
  afterAll(() => {
    for (const k of ENV_KEYS_CROSS) delete process.env[k];
  });

  it("子代理 process 在相同 cwd + 相同 home → 继承 user settings 的 llm.timeoutMs + subagent.taskTimeoutMs", async () => {
    // ADR-0084: llm/subagent are user-layer keys → the inheritance anchor is <home>/.iknow/settings.json;
    // home is injected explicitly (on POSIX os.homedir() does follow $HOME, and relying on it works
    // but is implicit and easy to break).
    const tmpCwd = await mkdtemp(join(tmpdir(), "iknow-subagent-inherit-t1-"));
    const emptyHome = await mkdtemp(
      join(tmpdir(), "iknow-subagent-inherit-home-")
    );
    await mkdir(join(tmpCwd, ".iknow"), { recursive: true });
    await mkdir(join(emptyHome, ".iknow"), { recursive: true });
    await writeFile(
      join(emptyHome, ".iknow", "settings.json"),
      JSON.stringify({
        ...withTestLlmProvider({ timeoutMs: 45_000 }),
        subagent: { taskTimeoutMs: 7_200_000 },
      })
    );

    try {
      const env = loadIknowEnv(tmpCwd, undefined, emptyHome);
      assert.equal(env.llm.timeoutMs, 45_000);
      assert.equal(env.subagent?.taskTimeoutMs, 7_200_000);
    } finally {
      await rm(tmpCwd, { recursive: true, force: true });
      await rm(emptyHome, { recursive: true, force: true });
    }
  });

  it("隔离 cwd（无 settings）→ env 端 subagent/taskTimeoutMs undefined（不静默回退）", async () => {
    const tmpEmpty = await mkdtemp(join(tmpdir(), "iknow-subagent-empty-cwd-"));
    const emptyHome = await mkdtemp(
      join(tmpdir(), "iknow-subagent-empty-home-")
    );
    try {
      assert.throws(
        () => loadIknowEnv(tmpEmpty, undefined, emptyHome),
        /no LLM model configured/
      );
    } finally {
      await rm(tmpEmpty, { recursive: true, force: true });
      await rm(emptyHome, { recursive: true, force: true });
    }
  });
});

/**
 * Per-route output budgets read from a real user settings file: main and
 * separately routed sub-agent each keep their own model entry's value, so
 * neither route can be read as the other's cap.
 */
describe("subagent settings — 每条路由各自的输出预算（真实 settings 文件）", () => {
  beforeAll(() => {
    installTestProviderApiKey();
  });
  afterAll(() => {
    delete process.env[TEST_LLM_PROVIDER_API_KEY_ENV];
  });

  /** Two providers, one model entry each; an omitted budget stays omitted. */
  function routeSettings(mainTokens?: number, subTokens?: number): object {
    const entry = (id: string, tokens?: number) => ({
      id,
      ...(tokens === undefined ? {} : { maxTokens: tokens }),
    });
    return {
      llm: {
        model: "main/main-model",
        providers: [
          {
            id: "main",
            baseUrl: "http://main.test/v1",
            apiKeyEnv: TEST_LLM_PROVIDER_API_KEY_ENV,
            models: [entry("main-model", mainTokens)],
          },
          {
            id: "sub",
            baseUrl: "http://sub.test/v1",
            apiKeyEnv: TEST_LLM_PROVIDER_API_KEY_ENV,
            models: [entry("sub-model", subTokens)],
          },
        ],
      },
      subagent: { model: "sub/sub-model" },
    };
  }

  it("SC12/SC18: main 72000 + subagent 64000 → 两侧各自保留自身值", async () => {
    const { home, cwd } = await makeSettings(routeSettings(72_000, 64_000), {});
    const env = loadIknowEnv(cwd, undefined, home);
    assert.equal(env.llm.routeMaxTokens, 72_000);
    assert.ok(env.subagent.model);
    assert.equal(env.subagent.model.maxTokens, 64_000);
  });

  it("SC12: subagent 条目省略 maxTokens → 该路由无预算键，主路由不受影响", async () => {
    const { home, cwd } = await makeSettings(routeSettings(72_000), {});
    const env = loadIknowEnv(cwd, undefined, home);
    assert.ok(env.subagent.model);
    assert.equal("maxTokens" in env.subagent.model, false);
    assert.equal(env.llm.routeMaxTokens, 72_000);
  });

  it("SC2: 主条目省略 maxTokens → 主路由无预算键（装配侧落 32000）", async () => {
    const { home, cwd } = await makeSettings(
      routeSettings(undefined, 64_000),
      {}
    );
    const env = loadIknowEnv(cwd, undefined, home);
    assert.equal("routeMaxTokens" in env.llm, false);
    assert.ok(env.subagent.model);
    assert.equal(env.subagent.model.maxTokens, 64_000);
  });
});
