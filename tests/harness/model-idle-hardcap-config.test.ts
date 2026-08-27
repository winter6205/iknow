/**
 * #742 T1:idle / 硬顶的配置链 —— `IKNOW_LLM_IDLE_TIMEOUT_MS` /
 * `IKNOW_LLM_HARD_CAP_MS`(env)> `settings.llm.idleTimeoutMs` /
 * `settings.llm.hardCapMs` > 代码默认值。
 *
 * 放在 tests/harness/ 而不是 tests/config/:这两个旋钮的语义属于
 * harness 的模型调用双钟(CONTEXT「model-call idle / 模型调用硬顶」),
 * 与 loop-engine 侧的 `model-idle-hardcap.test.ts` 同一票据、同处查阅。
 * 校验纪律仍镜像既有 `llm.timeoutMs`(有限正整数,drop-not-throw)。
 */

import {
  afterEach,
  beforeEach,
  describe,
  it,
  beforeAll,
  afterAll,
} from "vitest";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadIknowEnv } from "../../src/config/env.ts";
import {
  loadIknowSettings,
  type IknowSettings,
} from "../../src/config/settings.ts";

const EMPTY_SETTINGS: IknowSettings = { llm: { model: "test-model" } };
const ENV_KEYS = [
  "IKNOW_LLM_TIMEOUT_MS",
  "IKNOW_LLM_IDLE_TIMEOUT_MS",
  "IKNOW_LLM_HARD_CAP_MS",
] as const;

let workDir: string;
beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), "iknow-idle-hardcap-"));
});
afterAll(async () => {
  await rm(workDir, { recursive: true, force: true });
});

async function makeSettings(
  user: Record<string, unknown>
): Promise<{ home: string; cwd: string }> {
  const home = join(workDir, "home", Math.random().toString(36).slice(2));
  const cwd = join(workDir, "cwd", Math.random().toString(36).slice(2));
  await mkdir(join(home, ".iknow"), { recursive: true });
  await mkdir(join(cwd, ".iknow"), { recursive: true });
  await writeFile(join(home, ".iknow", "settings.json"), JSON.stringify(user));
  return { home, cwd };
}

describe("#742 T1 env: idle / 硬顶默认值", () => {
  beforeEach(() => {
    for (const k of ENV_KEYS) delete process.env[k];
  });
  afterEach(() => {
    for (const k of ENV_KEYS) delete process.env[k];
  });

  it("默认 idle=120000、硬顶=900000", () => {
    const env = loadIknowEnv(process.cwd(), EMPTY_SETTINGS);
    assert.equal(env.llm.idleTimeoutMs, 120_000);
    assert.equal(env.llm.hardCapMs, 900_000);
  });

  it("默认满足 idle < 硬顶,且硬顶有限", () => {
    const env = loadIknowEnv(process.cwd(), EMPTY_SETTINGS);
    assert.ok(env.llm.idleTimeoutMs! < env.llm.hardCapMs!);
    assert.ok(Number.isFinite(env.llm.hardCapMs!));
  });

  it("默认硬顶严格大于今日单钟默认值,否则持续出字仍被误杀", () => {
    const env = loadIknowEnv(process.cwd(), EMPTY_SETTINGS);
    assert.equal(env.llm.timeoutMs, 300_000);
    assert.ok(env.llm.hardCapMs! > env.llm.timeoutMs);
  });
});

describe("#742 T1 env: idle / 硬顶覆盖链", () => {
  beforeEach(() => {
    for (const k of ENV_KEYS) delete process.env[k];
  });
  afterEach(() => {
    for (const k of ENV_KEYS) delete process.env[k];
  });

  it("env 显式值直接生效", () => {
    process.env.IKNOW_LLM_IDLE_TIMEOUT_MS = "45000";
    process.env.IKNOW_LLM_HARD_CAP_MS = "600000";
    const env = loadIknowEnv(process.cwd(), EMPTY_SETTINGS);
    assert.equal(env.llm.idleTimeoutMs, 45_000);
    assert.equal(env.llm.hardCapMs, 600_000);
  });

  it("env 不设、settings 设了 → settings 生效", () => {
    const env = loadIknowEnv(process.cwd(), {
      llm: { model: "test-model", idleTimeoutMs: 30_000, hardCapMs: 400_000 },
    });
    assert.equal(env.llm.idleTimeoutMs, 30_000);
    assert.equal(env.llm.hardCapMs, 400_000);
  });

  it("env > settings", () => {
    process.env.IKNOW_LLM_IDLE_TIMEOUT_MS = "45000";
    process.env.IKNOW_LLM_HARD_CAP_MS = "600000";
    const env = loadIknowEnv(process.cwd(), {
      llm: { model: "test-model", idleTimeoutMs: 30_000, hardCapMs: 400_000 },
    });
    assert.equal(env.llm.idleTimeoutMs, 45_000);
    assert.equal(env.llm.hardCapMs, 600_000);
  });

  it("env 非法(空串 / abc)视为未设 → 回落默认", () => {
    for (const bad of ["", "abc"]) {
      process.env.IKNOW_LLM_IDLE_TIMEOUT_MS = bad;
      process.env.IKNOW_LLM_HARD_CAP_MS = bad;
      const env = loadIknowEnv(process.cwd(), EMPTY_SETTINGS);
      assert.equal(env.llm.idleTimeoutMs, 120_000, `idle bad=${bad}`);
      assert.equal(env.llm.hardCapMs, 900_000, `hardCap bad=${bad}`);
    }
  });
});

describe("#742 T1 settings: idleTimeoutMs / hardCapMs 校验", () => {
  it("合法正整数透传", async () => {
    const { home, cwd } = await makeSettings({
      llm: { idleTimeoutMs: 90_000, hardCapMs: 1_200_000 },
    });
    assert.deepEqual(loadIknowSettings({ home, cwd }), {
      llm: { idleTimeoutMs: 90_000, hardCapMs: 1_200_000 },
    });
  });

  it('drop-not-throw: 0 / -5 / "abc" / 1.5 / null / true → 丢弃', async () => {
    for (const bad of [0, -5, "abc", 1.5, null, true]) {
      const { home, cwd } = await makeSettings({
        llm: { idleTimeoutMs: bad, hardCapMs: bad },
      });
      assert.deepEqual(
        loadIknowSettings({ home, cwd }),
        {},
        `${JSON.stringify(bad)} 应丢弃`
      );
    }
  });

  it("非法值丢弃后不污染同段合法字段", async () => {
    const { home, cwd } = await makeSettings({
      llm: { timeoutMs: 60_000, idleTimeoutMs: -1, hardCapMs: 400_000 },
    });
    assert.deepEqual(loadIknowSettings({ home, cwd }), {
      llm: { timeoutMs: 60_000, hardCapMs: 400_000 },
    });
  });
});
