/**
 * `approval.timeoutMs` settings and env resolution
 * (ADR-0147 Amendment 2026-10-20, R4 — no approval timeout by default).
 *
 * Pins:
 *  - parser: absent section → undefined; `0` is legal and preserved (it means
 *    "wait without limit"); a finite integer >= 1 is legal; negative /
 *    fractional / string / wrong-typed values are dropped (drop-not-throw).
 *  - merge: project wins over user, including an explicit project `0` over a
 *    positive user value; a dropped project field does not override user.
 *  - project allowlist: `approval` is accepted from the project file (no
 *    "ignored" warning) and takes effect.
 *  - env: `IKNOW_APPROVAL_TIMEOUT_MS` > settings; `0` accepted; invalid values
 *    fall through to settings.
 *
 * Every settings read goes through isolated temp home/cwd pairs; the real
 * `~/.iknow` is never touched.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  it,
} from "vitest";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadIknowSettings,
  type IknowSettings,
} from "../../src/config/settings.ts";
import {
  APPROVAL_TIMEOUT_ENV_KEY,
  loadIknowEnv,
  resolveApprovalTimeoutMs,
} from "../../src/config/env.ts";
import {
  installTestProviderApiKey,
  TEST_LLM_PROVIDER_API_KEY_ENV,
  withTestLlmProvider,
} from "../_helpers/test-llm-settings.ts";

let workDir: string;
beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), "iknow-approval-timeout-"));
});
afterAll(async () => {
  await rm(workDir, { recursive: true, force: true });
});

/** Writes one settings file per layer (user / project), returns isolated opts. */
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

describe("approval.timeoutMs — parser", () => {
  it("absent section → no approval key", async () => {
    const { home, cwd } = await makeSettings({}, {});
    assert.deepEqual(loadIknowSettings({ home, cwd }), {});
  });

  it("0 is legal and preserved (wait without limit)", async () => {
    const { home, cwd } = await makeSettings(
      { approval: { timeoutMs: 0 } },
      {}
    );
    assert.deepEqual(loadIknowSettings({ home, cwd }), {
      approval: { timeoutMs: 0 },
    });
  });

  it("a positive integer is legal and preserved", async () => {
    const { home, cwd } = await makeSettings(
      { approval: { timeoutMs: 90_000 } },
      {}
    );
    assert.deepEqual(loadIknowSettings({ home, cwd }), {
      approval: { timeoutMs: 90_000 },
    });
  });

  it("negative / fractional / string / wrong-typed values are dropped", async () => {
    for (const bad of [-1, 1.5, "5000", null, true, {}]) {
      const { home, cwd } = await makeSettings(
        { approval: { timeoutMs: bad } },
        {}
      );
      assert.deepEqual(
        loadIknowSettings({ home, cwd }),
        {},
        `timeoutMs=${JSON.stringify(bad)} should be dropped`
      );
    }
  });

  it("a non-object approval section is dropped", async () => {
    for (const bad of [5, "90000", [], null]) {
      const { home, cwd } = await makeSettings({ approval: bad }, {});
      assert.deepEqual(
        loadIknowSettings({ home, cwd }),
        {},
        `approval=${JSON.stringify(bad)} should be dropped`
      );
    }
  });
});

describe("approval.timeoutMs — user/project merge", () => {
  it("project value wins over user", async () => {
    const { home, cwd } = await makeSettings(
      { approval: { timeoutMs: 60_000 } },
      { approval: { timeoutMs: 30_000 } }
    );
    assert.deepEqual(loadIknowSettings({ home, cwd }), {
      approval: { timeoutMs: 30_000 },
    });
  });

  it("user-only value applies when project is absent", async () => {
    const { home, cwd } = await makeSettings(
      { approval: { timeoutMs: 60_000 } },
      {}
    );
    assert.deepEqual(loadIknowSettings({ home, cwd }), {
      approval: { timeoutMs: 60_000 },
    });
  });

  it("project-only value applies when user is absent", async () => {
    const { home, cwd } = await makeSettings(
      {},
      { approval: { timeoutMs: 30_000 } }
    );
    assert.deepEqual(loadIknowSettings({ home, cwd }), {
      approval: { timeoutMs: 30_000 },
    });
  });

  it("project 0 wins over a positive user value (explicit 0 is a value)", async () => {
    const { home, cwd } = await makeSettings(
      { approval: { timeoutMs: 60_000 } },
      { approval: { timeoutMs: 0 } }
    );
    assert.deepEqual(loadIknowSettings({ home, cwd }), {
      approval: { timeoutMs: 0 },
    });
  });

  it("a dropped project field does not override the user value", async () => {
    const { home, cwd } = await makeSettings(
      { approval: { timeoutMs: 60_000 } },
      { approval: { timeoutMs: -1 } }
    );
    assert.deepEqual(loadIknowSettings({ home, cwd }), {
      approval: { timeoutMs: 60_000 },
    });
  });
});

describe("approval — project allowlist", () => {
  it("a project approval section is accepted without an ignore warning", async () => {
    const { home, cwd } = await makeSettings(
      { approval: { timeoutMs: 60_000 } },
      { approval: { timeoutMs: 30_000 } }
    );
    const warnings: string[] = [];
    const settings = loadIknowSettings({
      home,
      cwd,
      onWarn: (m) => warnings.push(m),
    });
    assert.deepEqual(settings, { approval: { timeoutMs: 30_000 } });
    assert.deepEqual(warnings, []);
    assert.ok(!warnings.some((m) => /approval|ignored/.test(m)));
  });
});

describe("approval.timeoutMs — illegal value warning", () => {
  /** Loads once with an injected sink so the count and text are both observable. */
  async function loadWithWarnings(
    user: Record<string, unknown>,
    project: Record<string, unknown>
  ): Promise<{ settings: IknowSettings; warnings: string[] }> {
    const { home, cwd } = await makeSettings(user, project);
    const warnings: string[] = [];
    const settings = loadIknowSettings({
      home,
      cwd,
      onWarn: (m) => warnings.push(m),
    });
    return { settings, warnings };
  }

  it("a negative user value warns once and is dropped", async () => {
    const { settings, warnings } = await loadWithWarnings(
      { approval: { timeoutMs: -1 } },
      {}
    );
    assert.deepEqual(settings, {});
    assert.equal(warnings.length, 1, `warnings: ${JSON.stringify(warnings)}`);
    assert.match(
      warnings[0]!,
      /^\[settings\] approval\.timeoutMs -1 dropped: /
    );
    assert.match(warnings[0]!, /negative/);
  });

  it("a fractional user value warns once with a not-an-integer reason", async () => {
    const { settings, warnings } = await loadWithWarnings(
      { approval: { timeoutMs: 1.5 } },
      {}
    );
    assert.deepEqual(settings, {});
    assert.equal(warnings.length, 1, `warnings: ${JSON.stringify(warnings)}`);
    assert.match(
      warnings[0]!,
      /^\[settings\] approval\.timeoutMs 1\.5 dropped: /
    );
    assert.match(warnings[0]!, /not an integer/);
  });

  it("a string user value warns once with a not-a-number reason", async () => {
    const { settings, warnings } = await loadWithWarnings(
      { approval: { timeoutMs: "5000" } },
      {}
    );
    assert.deepEqual(settings, {});
    assert.equal(warnings.length, 1, `warnings: ${JSON.stringify(warnings)}`);
    assert.match(
      warnings[0]!,
      /^\[settings\] approval\.timeoutMs "5000" dropped: /
    );
    assert.match(warnings[0]!, /not a number/);
  });

  it("a non-plain approval section warns once and is dropped", async () => {
    for (const bad of [5, "90000", [], null]) {
      const { settings, warnings } = await loadWithWarnings(
        { approval: bad },
        {}
      );
      assert.deepEqual(settings, {});
      assert.equal(
        warnings.length,
        1,
        `approval=${JSON.stringify(bad)} warnings: ${JSON.stringify(warnings)}`
      );
      assert.match(warnings[0]!, /^\[settings\] approval section .* dropped: /);
    }
  });

  it("a bad project value warns once on its own layer", async () => {
    const { settings, warnings } = await loadWithWarnings(
      {},
      { approval: { timeoutMs: -1 } }
    );
    assert.deepEqual(settings, {});
    assert.equal(warnings.length, 1, `warnings: ${JSON.stringify(warnings)}`);
    assert.match(
      warnings[0]!,
      /^\[settings\] approval\.timeoutMs -1 dropped: /
    );
  });

  it("bad values on both layers warn once each", async () => {
    const { settings, warnings } = await loadWithWarnings(
      { approval: { timeoutMs: -1 } },
      { approval: { timeoutMs: 2.5 } }
    );
    assert.deepEqual(settings, {});
    assert.equal(warnings.length, 2, `warnings: ${JSON.stringify(warnings)}`);
    assert.match(
      warnings[0]!,
      /^\[settings\] approval\.timeoutMs -1 dropped: /
    );
    assert.match(
      warnings[1]!,
      /^\[settings\] approval\.timeoutMs 2\.5 dropped: /
    );
  });

  it("legal values (0 / positive integer) warn not at all", async () => {
    for (const good of [0, 1, 90_000]) {
      const { settings, warnings } = await loadWithWarnings(
        { approval: { timeoutMs: 60_000 } },
        { approval: { timeoutMs: good } }
      );
      assert.deepEqual(settings, { approval: { timeoutMs: good } });
      assert.deepEqual(
        warnings,
        [],
        `timeoutMs=${good} should not warn: ${JSON.stringify(warnings)}`
      );
    }
  });

  it("an absent approval section warns not at all", async () => {
    const { settings, warnings } = await loadWithWarnings({}, {});
    assert.deepEqual(settings, {});
    assert.deepEqual(warnings, []);
  });
});

describe("approval timeout — env resolution", () => {
  const ENV_KEYS = [APPROVAL_TIMEOUT_ENV_KEY] as const;
  beforeEach(() => {
    for (const key of ENV_KEYS) delete process.env[key];
  });
  afterEach(() => {
    for (const key of ENV_KEYS) delete process.env[key];
  });

  const settingsWithTimeout = (timeoutMs: number) => ({
    approval: { timeoutMs },
  });

  it("env wins over settings", () => {
    assert.equal(
      resolveApprovalTimeoutMs(
        { [APPROVAL_TIMEOUT_ENV_KEY]: "120000" },
        settingsWithTimeout(5_000)
      ),
      120_000
    );
  });

  it("env 0 is accepted and wins over a positive setting", () => {
    assert.equal(
      resolveApprovalTimeoutMs(
        { [APPROVAL_TIMEOUT_ENV_KEY]: "0" },
        settingsWithTimeout(5_000)
      ),
      0
    );
  });

  it("invalid env values (negative / fractional / non-numeric) fall back to settings", () => {
    for (const bad of ["-5", "1.5", "abc", "  "]) {
      assert.equal(
        resolveApprovalTimeoutMs(
          { [APPROVAL_TIMEOUT_ENV_KEY]: bad },
          settingsWithTimeout(5_000)
        ),
        5_000,
        `env=${JSON.stringify(bad)} should fall back`
      );
    }
  });

  it("unset env + absent setting → undefined (wait without limit)", () => {
    assert.equal(resolveApprovalTimeoutMs({}, {}), undefined);
  });

  it("unset env + setting → the settings value", () => {
    assert.equal(
      resolveApprovalTimeoutMs({}, settingsWithTimeout(7_000)),
      7_000
    );
  });

  it("process.env is read by the same resolver", () => {
    process.env[APPROVAL_TIMEOUT_ENV_KEY] = "90000";
    assert.equal(
      resolveApprovalTimeoutMs({}, settingsWithTimeout(5_000)),
      90_000
    );
  });

  it("loadIknowEnv carries the resolved value onto IknowEnv.approval", () => {
    installTestProviderApiKey();
    try {
      const base = withTestLlmProvider();
      const env = loadIknowEnv(workDir, base);
      assert.equal(env.approval?.timeoutMs, undefined);

      const withSettings = loadIknowEnv(workDir, {
        ...base,
        ...settingsWithTimeout(45_000),
      });
      assert.equal(withSettings.approval?.timeoutMs, 45_000);

      process.env[APPROVAL_TIMEOUT_ENV_KEY] = "0";
      const overridden = loadIknowEnv(workDir, {
        ...base,
        ...settingsWithTimeout(45_000),
      });
      assert.equal(overridden.approval?.timeoutMs, 0);

      process.env[APPROVAL_TIMEOUT_ENV_KEY] = "not-a-number";
      const invalid = loadIknowEnv(workDir, {
        ...base,
        ...settingsWithTimeout(45_000),
      });
      assert.equal(invalid.approval?.timeoutMs, 45_000);
    } finally {
      delete process.env[TEST_LLM_PROVIDER_API_KEY_ENV];
    }
  });
});
