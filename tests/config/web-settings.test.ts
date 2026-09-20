/**
 * settings-web-backend: `settings.web.searchBackend` — the settings source for web_search
 * backend selection (settable in global settings, independent of shell env / .env.local).
 *
 * Contract pinned here:
 *  - settings parse: closed set "bing"|"exa"|"tavily"|"brave"; invalid values drop-not-throw
 *    (mirroring parseIsolation discipline), dropped fields never override; non-object section → undefined.
 *  - merge (ADR-0084): `web` is a user-layer key → the project file's web section is
 *    dropped by the allowlist and never overrides user; startup emits one warning naming the key.
 *  - env fallback chain: env > settings.web.searchBackend > default "bing" (mirrors the
 *    maxTurns precedent); unset env returns undefined rather than folding into an explicit "bing".
 *  - an invalid env value still throws typed `WebEnvConfigError("invalid_search_backend")`
 *    (schema rejection is louder than silent fallback — that discipline stands).
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
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  loadIknowSettings,
  type IknowSettings,
} from "../../src/config/settings.ts";
import {
  loadIknowEnv,
  isWebEnvConfigError,
  SEARCH_BACKEND_ENV_KEY,
  SEARCH_BACKEND_VALUES,
} from "../../src/config/env.ts";
import { WEB_SEARCH_BACKEND_VALUES } from "../../src/config/settings.ts";
import {
  installTestProviderApiKey,
  withTestLlmProvider,
} from "../_helpers/test-llm-settings.ts";

let workDir: string;

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), "iknow-web-settings-"));
});

afterAll(async () => {
  await rm(workDir, { recursive: true, force: true });
});

// Parity guard for the duplicated closed set (env.ts SSOT / settings.ts import-cycle avoidance):
// drift turns red here instead of silently dropping or accepting values.
describe("web.searchBackend 闭集 parity", () => {
  it("settings 闭集与 env SSOT 同值域（sort 后 deepEqual）", () => {
    assert.deepEqual(
      [...WEB_SEARCH_BACKEND_VALUES].sort(),
      [...SEARCH_BACKEND_VALUES].sort()
    );
  });
});

// Guard against ambient env pollution: mirrors env.test.ts's ENV_KEYS cleanup discipline so unset assertions are trustworthy.
const ENV_KEYS = [SEARCH_BACKEND_ENV_KEY] as const;
beforeEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
  installTestProviderApiKey();
});
afterEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
});

async function makeSettings(
  user: Record<string, unknown>,
  project: Record<string, unknown>
): Promise<{ home: string; cwd: string }> {
  const seed = Math.random().toString(36).slice(2);
  const home = join(workDir, "home", seed);
  const cwd = join(workDir, "cwd", seed);
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

/** Same fixture as env.test.ts: minimal settings (model fail-fast needs a model source). */
function withModel(s: Record<string, unknown>): Record<string, unknown> {
  return { ...withTestLlmProvider(), ...s };
}

function loadEnvAt(cwd: string, home: string) {
  return loadIknowEnv(cwd, undefined, home);
}

describe("settings.web.searchBackend — settings surface", () => {
  it("absent section: no web key in parsed settings", async () => {
    const { home, cwd } = await makeSettings(withModel({}), {});
    const settings: IknowSettings = loadIknowSettings({ cwd, home });
    assert.equal(settings.web, undefined);
  });

  it("legal value parses through the closed set", async () => {
    const { home, cwd } = await makeSettings(
      withModel({ web: { searchBackend: "exa" } }),
      {}
    );
    const settings = loadIknowSettings({ cwd, home });
    assert.equal(settings.web?.searchBackend, "exa");
  });

  it("each closed-set member is accepted", async () => {
    for (const backend of SEARCH_BACKEND_VALUES) {
      const { home, cwd } = await makeSettings(
        withModel({ web: { searchBackend: backend } }),
        {}
      );
      const settings = loadIknowSettings({ cwd, home });
      assert.equal(settings.web?.searchBackend, backend, `backend=${backend}`);
    }
  });

  it("drops an illegal value (drop-not-throw)", async () => {
    const { home, cwd } = await makeSettings(
      withModel({ web: { searchBackend: "google" } }),
      {}
    );
    const settings = loadIknowSettings({ cwd, home });
    assert.equal(settings.web, undefined);
  });

  it("drops a non-string value and a non-object section", async () => {
    for (const bad of [123, true, null, ["exa"], { too: "deep" }]) {
      const { home, cwd } = await makeSettings(
        withModel({ web: { searchBackend: bad } }),
        {}
      );
      assert.equal(loadIknowSettings({ cwd, home }).web, undefined);
    }
    const { home, cwd } = await makeSettings(withModel({ web: "exa" }), {});
    assert.equal(loadIknowSettings({ cwd, home }).web, undefined);
  });

  it("ADR-0084：web 在项目允许名单外 → 项目值被丢弃，user 值胜出（非 project 覆盖）", async () => {
    const { home, cwd } = await makeSettings(
      withModel({ web: { searchBackend: "exa" } }),
      { web: { searchBackend: "tavily" } }
    );
    const warnings: string[] = [];
    const settings = loadIknowSettings({
      cwd,
      home,
      onWarn: (m) => warnings.push(m),
    });
    assert.equal(settings.web?.searchBackend, "exa");
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /"web"/);
  });

  it("keeps the user value when project has no web section", async () => {
    const { home, cwd } = await makeSettings(
      withModel({ web: { searchBackend: "exa" } }),
      {}
    );
    const settings = loadIknowSettings({ cwd, home });
    assert.equal(settings.web?.searchBackend, "exa");
  });

  it("drops an illegal project value without clobbering the user layer", async () => {
    const { home, cwd } = await makeSettings(
      withModel({ web: { searchBackend: "exa" } }),
      { web: { searchBackend: "google" } }
    );
    const settings = loadIknowSettings({ cwd, home });
    assert.equal(settings.web?.searchBackend, "exa");
  });

  it("freezes the parsed section", async () => {
    const { home, cwd } = await makeSettings(
      withModel({ web: { searchBackend: "exa" } }),
      {}
    );
    const settings = loadIknowSettings({ cwd, home });
    assert.throws(() => {
      (settings.web as { searchBackend?: string }).searchBackend = "bing";
    });
  });
});

describe("loadIknowEnv — web.searchBackend 回退链", () => {
  it("default: no env, no settings → bing", async () => {
    const { home, cwd } = await makeSettings(withModel({}), {});
    const env = loadEnvAt(cwd, home);
    assert.equal(env.web.searchBackend, "bing");
  });

  it("settings-only: settings.web.searchBackend=exa, no env → exa", async () => {
    const { home, cwd } = await makeSettings(
      withModel({ web: { searchBackend: "exa" } }),
      {}
    );
    const env = loadEnvAt(cwd, home);
    assert.equal(env.web.searchBackend, "exa");
  });

  it("env wins over settings: env=tavily, settings=exa → tavily", async () => {
    const { home, cwd } = await makeSettings(
      withModel({ web: { searchBackend: "exa" } }),
      {}
    );
    process.env[SEARCH_BACKEND_ENV_KEY] = "tavily";
    try {
      const env = loadEnvAt(cwd, home);
      assert.equal(env.web.searchBackend, "tavily");
    } finally {
      delete process.env[SEARCH_BACKEND_ENV_KEY];
    }
  });

  it("explicit env bing overrides settings exa (no folding: unset ≠ bing)", async () => {
    const { home, cwd } = await makeSettings(
      withModel({ web: { searchBackend: "exa" } }),
      {}
    );
    process.env[SEARCH_BACKEND_ENV_KEY] = "bing";
    try {
      const env = loadEnvAt(cwd, home);
      assert.equal(env.web.searchBackend, "bing");
    } finally {
      delete process.env[SEARCH_BACKEND_ENV_KEY];
    }
  });

  it("illegal env value throws typed invalid_search_backend (even when settings has a legal value)", async () => {
    const { home, cwd } = await makeSettings(
      withModel({ web: { searchBackend: "exa" } }),
      {}
    );
    process.env[SEARCH_BACKEND_ENV_KEY] = "google";
    try {
      assert.throws(() => loadEnvAt(cwd, home), isWebEnvConfigError);
      try {
        loadEnvAt(cwd, home);
        assert.fail("expected loadIknowEnv to throw");
      } catch (err) {
        assert.ok(isWebEnvConfigError(err));
        // typed-error payload contract: varName / value / expected must all be present,
        // else the renderer lacks the load-bearing fields of the kind (typed-error discipline).
        assert.equal(err.varName, SEARCH_BACKEND_ENV_KEY);
        assert.equal(err.value, "google");
        assert.deepEqual(err.expected, [...SEARCH_BACKEND_VALUES]);
      }
    } finally {
      delete process.env[SEARCH_BACKEND_ENV_KEY];
    }
  });

  it("illegal settings value falls through to default bing (drop-not-throw end-to-end)", async () => {
    const { home, cwd } = await makeSettings(
      withModel({ web: { searchBackend: "google" } }),
      {}
    );
    const env = loadEnvAt(cwd, home);
    assert.equal(env.web.searchBackend, "bing");
  });
});
