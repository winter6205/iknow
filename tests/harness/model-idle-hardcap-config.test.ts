/**
 * Config chain for the idle / hard-cap clocks:
 * `IKNOW_LLM_IDLE_TIMEOUT_MS` / `IKNOW_LLM_HARD_CAP_MS` (env) >
 * `settings.llm.idleTimeoutMs` / `settings.llm.hardCapMs` > code defaults.
 *
 * Lives in tests/harness/ rather than tests/config/ because these two knobs
 * are semantics of the harness's model-call dual clocks (model-call idle /
 * hard cap), reviewed together with the loop-engine side in
 * `model-idle-hardcap.test.ts`. Validation discipline mirrors the existing
 * `llm.timeoutMs` (finite positive integer, drop-not-throw).
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
import { loadIknowSettings } from "../../src/config/settings.ts";
import {
  installTestProviderApiKey,
  withTestLlmProvider,
} from "../_helpers/test-llm-settings.ts";

const EMPTY_SETTINGS = withTestLlmProvider();
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
    installTestProviderApiKey();
  });
  afterEach(() => {
    for (const k of ENV_KEYS) delete process.env[k];
  });

  // Per specs/transport-continue-persist.md, the streaming arm's default idle
  // moved to minute-scale (~5 min). Invariants: idle stays strictly < hard
  // cap, the cap stays finite, and it remains far above the 5-min timeoutMs
  // default — any breach here means spec drift.
  it("默认 idle=300000(5 min)、硬顶=900000(15 min)", () => {
    const env = loadIknowEnv(process.cwd(), EMPTY_SETTINGS);
    assert.equal(env.llm.idleTimeoutMs, 300_000);
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

  // Default idle sits in the minute-scale range [60s, 600s] — the hard pin of
  // specs/transport-continue-persist.md invariant 3: raised from the old 120s
  // (too short; long thinking tasks were mis-killed) to 5 min, guarding
  // against a drift back down.
  it("默认 idle 落在 minute-scale 区间 [60s, 600s](spec 不变式)", () => {
    const env = loadIknowEnv(process.cwd(), EMPTY_SETTINGS);
    const idle = env.llm.idleTimeoutMs!;
    assert.ok(idle >= 60_000 && idle <= 600_000, `idle=${idle} 越界`);
  });
});

describe("#742 T1 env: idle / 硬顶覆盖链", () => {
  beforeEach(() => {
    for (const k of ENV_KEYS) delete process.env[k];
    installTestProviderApiKey();
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
    const env = loadIknowEnv(
      process.cwd(),
      withTestLlmProvider({ idleTimeoutMs: 30_000, hardCapMs: 400_000 })
    );
    assert.equal(env.llm.idleTimeoutMs, 30_000);
    assert.equal(env.llm.hardCapMs, 400_000);
  });

  it("env > settings", () => {
    process.env.IKNOW_LLM_IDLE_TIMEOUT_MS = "45000";
    process.env.IKNOW_LLM_HARD_CAP_MS = "600000";
    const env = loadIknowEnv(
      process.cwd(),
      withTestLlmProvider({ idleTimeoutMs: 30_000, hardCapMs: 400_000 })
    );
    assert.equal(env.llm.idleTimeoutMs, 45_000);
    assert.equal(env.llm.hardCapMs, 600_000);
  });

  it("env 非法(空串 / abc)视为未设 → 回落默认", () => {
    for (const bad of ["", "abc"]) {
      process.env.IKNOW_LLM_IDLE_TIMEOUT_MS = bad;
      process.env.IKNOW_LLM_HARD_CAP_MS = bad;
      const env = loadIknowEnv(process.cwd(), EMPTY_SETTINGS);
      assert.equal(env.llm.idleTimeoutMs, 300_000, `idle bad=${bad}`);
      assert.equal(env.llm.hardCapMs, 900_000, `hardCap bad=${bad}`);
    }
  });

  it("env 非正值视为未设 → 回退到 settings 或默认", () => {
    for (const bad of ["0", "-1"]) {
      process.env.IKNOW_LLM_IDLE_TIMEOUT_MS = bad;
      process.env.IKNOW_LLM_HARD_CAP_MS = bad;
      const fromSettings = loadIknowEnv(
        process.cwd(),
        withTestLlmProvider({ idleTimeoutMs: 30_000, hardCapMs: 400_000 })
      );
      assert.equal(fromSettings.llm.idleTimeoutMs, 30_000, `idle bad=${bad}`);
      assert.equal(fromSettings.llm.hardCapMs, 400_000, `hardCap bad=${bad}`);

      const fromDefaults = loadIknowEnv(process.cwd(), EMPTY_SETTINGS);
      assert.equal(fromDefaults.llm.idleTimeoutMs, 300_000, `idle bad=${bad}`);
      assert.equal(fromDefaults.llm.hardCapMs, 900_000, `hardCap bad=${bad}`);
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
