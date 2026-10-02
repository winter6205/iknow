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
  EXA_API_KEY_ENV_KEY,
  TAVILY_API_KEY_ENV_KEY,
  BRAVE_API_KEY_ENV_KEY,
} from "../../src/config/env.ts";
import { WEB_SEARCH_BACKEND_VALUES } from "../../src/config/settings.ts";
import { resolveWebCapability } from "../../src/config/aci-web-backend.ts";
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
// The three vendor keys MUST be in this list: a developer's shell commonly exports EXA_API_KEY, and
// env wins over settings — without the cleanup, every "settings-only" key assertion below would
// silently read the ambient value instead of the fixture.
const ENV_KEYS = [
  SEARCH_BACKEND_ENV_KEY,
  EXA_API_KEY_ENV_KEY,
  TAVILY_API_KEY_ENV_KEY,
  BRAVE_API_KEY_ENV_KEY,
] as const;
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

/**
 * `settings.web.backendKey` — the settings-side carrier for the key of the **selected**
 * backend, so a normal install configures backend + key in one file without authoring an
 * env file. Deliberately vendor-neutral: env.ts routes it into the slot of whatever
 * `searchBackend` resolved to, so no vendor is baked into the field name and a config
 * keeps working when the selection changes.
 *
 * Contract pinned here:
 *  - value shape: a literal or a `${VAR}` / `$VAR` placeholder (guarded by
 *    isApiKeyOrPlaceholder, same discipline as llm.apiKey); illegal placeholder residue and
 *    non-strings drop the field (drop-not-throw).
 *  - a key-only section (no searchBackend) is legal — the backend falls back to "bing".
 *  - `web` stays user-layer only: the project file's web section is dropped by the allowlist,
 *    so a cloned repo can never ship a key.
 *  - env chain: process.env > .env.local/.env > settings > undefined (env still wins, matching
 *    web.searchBackend).
 *  - a settings `${VAR}` that fails to resolve → undefined, never the literal "${VAR}" leaking
 *    downstream into an Authorization header.
 */
describe("settings.web.backendKey — settings surface", () => {
  it("accepts a literal key", async () => {
    const { home, cwd } = await makeSettings(
      withModel({ web: { searchBackend: "exa", backendKey: "literal-exa-key" } }),
      {}
    );
    const settings = loadIknowSettings({ cwd, home });
    assert.equal(settings.web?.backendKey, "literal-exa-key");
  });

  it("accepts a ${VAR} placeholder and preserves it verbatim for env.ts to resolve", async () => {
    const { home, cwd } = await makeSettings(
      withModel({ web: { searchBackend: "exa", backendKey: "${EXA_API_KEY}" } }),
      {}
    );
    const settings = loadIknowSettings({ cwd, home });
    assert.equal(settings.web?.backendKey, "${EXA_API_KEY}");
  });

  it("trims surrounding whitespace on a literal", async () => {
    const { home, cwd } = await makeSettings(
      withModel({ web: { backendKey: "  padded-key  " } }),
      {}
    );
    assert.equal(loadIknowSettings({ cwd, home }).web?.backendKey, "padded-key");
  });

  it("drops illegal `${` residue and non-strings (drop-not-throw)", async () => {
    for (const bad of ["${}", "${1BAD}", "${UNCLOSED"]) {
      const { home, cwd } = await makeSettings(
        withModel({ web: { searchBackend: "exa", backendKey: bad } }),
        {}
      );
      const settings = loadIknowSettings({ cwd, home });
      // searchBackend survives, the illegal key does not.
      assert.equal(settings.web?.searchBackend, "exa", `backend kept for bad=${String(bad)}`);
      assert.equal(settings.web?.backendKey, undefined, `backendKey dropped for bad=${String(bad)}`);
    }
    for (const bad of [123, true, null, [], {}]) {
      const { home, cwd } = await makeSettings(
        withModel({ web: { searchBackend: "exa", backendKey: bad } }),
        {}
      );
      const settings = loadIknowSettings({ cwd, home });
      assert.equal(settings.web?.searchBackend, "exa");
      assert.equal(settings.web?.backendKey, undefined, `backendKey dropped for bad=${String(bad)}`);
    }
  });

  it("a bare `$` that forms no `$VAR` is kept as a literal (aligns with llm.apiKey)", async () => {
    // analyzePlaceholderSyntax only treats `${` residue as illegal; `foo$bar` is a legal
    // literal (settings.ts:1090-1093). Pinned here so a future tightening of that rule
    // surfaces as a deliberate change rather than a silent behavior shift.
    const { home, cwd } = await makeSettings(
      withModel({ web: { backendKey: "has $ but no var" } }),
      {}
    );
    assert.equal(loadIknowSettings({ cwd, home }).web?.backendKey, "has $ but no var");
  });

  it("drops an empty / whitespace-only key", async () => {
    for (const bad of ["", "   "]) {
      const { home, cwd } = await makeSettings(
        withModel({ web: { backendKey: bad } }),
        {}
      );
      assert.equal(loadIknowSettings({ cwd, home }).web, undefined);
    }
  });

  it("a key-only section survives (searchBackend falls back to bing at the env layer)", async () => {
    const { home, cwd } = await makeSettings(withModel({ web: { backendKey: "k" } }), {});
    const settings = loadIknowSettings({ cwd, home });
    assert.equal(settings.web?.searchBackend, undefined);
    assert.equal(settings.web?.backendKey, "k");
    assert.equal(loadEnvAt(cwd, home).web.searchBackend, "bing");
  });

  it("no per-vendor settings fields — one vendor-neutral backendKey", async () => {
    // The settings surface is deliberately vendor-neutral. Per-vendor settings fields
    // would bake a vendor into the config and would be dead config for the backends
    // that are still `not_shipped` stubs. TAVILY_API_KEY / BRAVE_API_KEY stay env-only.
    const { home, cwd } = await makeSettings(
      withModel({
        web: {
          searchBackend: "exa",
          backendKey: "k-exa",
          exaApiKey: "k-via-old-field",
          tavilyApiKey: "k-tavily",
          braveApiKey: "k-brave",
        },
      }),
      {}
    );
    const settings = loadIknowSettings({ cwd, home });
    assert.equal(settings.web?.backendKey, "k-exa");
    const serialized = JSON.stringify(settings);
    for (const stale of ["k-via-old-field", "k-tavily", "k-brave"]) {
      assert.ok(!serialized.includes(stale), `${stale} must not survive parsing`);
    }
    // ...and the env side still resolves the other vendors from their env vars, unchanged.
    process.env[TAVILY_API_KEY_ENV_KEY] = "env-tavily";
    process.env[BRAVE_API_KEY_ENV_KEY] = "env-brave";
    try {
      const withEnv = loadEnvAt(cwd, home);
      assert.equal(withEnv.web.exaApiKey, "k-exa");
      assert.equal(withEnv.web.tavilyApiKey, "env-tavily");
      assert.equal(withEnv.web.braveApiKey, "env-brave");
    } finally {
      delete process.env[TAVILY_API_KEY_ENV_KEY];
      delete process.env[BRAVE_API_KEY_ENV_KEY];
    }
  });

  it("backendKey routes into the slot of the SELECTED backend, not a fixed vendor", async () => {
    // This is the point of the vendor-neutral name: whatever `searchBackend` resolved to
    // receives the key, so a config written today keeps working if the selection moves to
    // a backend that becomes real, and no vendor is hard-coded in the field name.
    const cases = [
      { backend: "exa", slot: "exaApiKey" },
      { backend: "tavily", slot: "tavilyApiKey" },
      { backend: "brave", slot: "braveApiKey" },
    ] as const;
    for (const { backend, slot } of cases) {
      const { home, cwd } = await makeSettings(
        withModel({ web: { searchBackend: backend, backendKey: "the-one-key" } }),
        {}
      );
      const env = loadEnvAt(cwd, home);
      assert.equal(env.web[slot], "the-one-key", `${backend} → ${slot}`);
      for (const other of cases.filter((c) => c.slot !== slot)) {
        assert.equal(env.web[other.slot], undefined, `${backend} must not fill ${other.slot}`);
      }
    }
  });

  it("searchBackend=bing has no key slot, so backendKey lands nowhere", async () => {
    // bing is the zero-key default path (absent from KEYED_BACKEND_ENV_KEYS); the key
    // is simply unused rather than erroring.
    const { home, cwd } = await makeSettings(
      withModel({ web: { searchBackend: "bing", backendKey: "unused" } }),
      {}
    );
    const env = loadEnvAt(cwd, home);
    assert.equal(env.web.searchBackend, "bing");
    assert.equal(env.web.exaApiKey, undefined);
    assert.equal(env.web.tavilyApiKey, undefined);
    assert.equal(env.web.braveApiKey, undefined);
  });

  it("web 在项目允许名单外 → 项目层的 key 被丢弃，user 层的 key 胜出（不泄漏到克隆仓库）", async () => {
    const { home, cwd } = await makeSettings(
      withModel({ web: { searchBackend: "exa", backendKey: "user-key" } }),
      { web: { searchBackend: "exa", backendKey: "attacker-key" } }
    );
    const warnings: string[] = [];
    const settings = loadIknowSettings({ cwd, home, onWarn: (m) => warnings.push(m) });
    assert.equal(settings.web?.backendKey, "user-key");
    assert.ok(
      !JSON.stringify(settings).includes("attacker-key"),
      "project-layer key must never reach the merged settings"
    );
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /"web"/);
  });
});

describe("loadIknowEnv — backendKey 回退链（env 优先，settings 兜底）", () => {
  it("settings literal, no env → the literal key is used", async () => {
    const { home, cwd } = await makeSettings(
      withModel({ web: { searchBackend: "exa", backendKey: "literal-key" } }),
      {}
    );
    assert.equal(loadEnvAt(cwd, home).web.exaApiKey, "literal-key");
  });

  it("settings ${VAR} placeholder → resolved from process.env", async () => {
    const { home, cwd } = await makeSettings(
      withModel({ web: { searchBackend: "exa", backendKey: "${EXA_API_KEY}" } }),
      {}
    );
    process.env[EXA_API_KEY_ENV_KEY] = "resolved-from-process-env";
    try {
      assert.equal(loadEnvAt(cwd, home).web.exaApiKey, "resolved-from-process-env");
    } finally {
      delete process.env[EXA_API_KEY_ENV_KEY];
    }
  });

  it("env wins over a settings literal", async () => {
    const { home, cwd } = await makeSettings(
      withModel({ web: { searchBackend: "exa", backendKey: "settings-key" } }),
      {}
    );
    process.env[EXA_API_KEY_ENV_KEY] = "env-key";
    try {
      assert.equal(loadEnvAt(cwd, home).web.exaApiKey, "env-key");
    } finally {
      delete process.env[EXA_API_KEY_ENV_KEY];
    }
  });

  it("env wins over a settings ${VAR} placeholder", async () => {
    const { home, cwd } = await makeSettings(
      withModel({ web: { searchBackend: "exa", backendKey: "${EXA_API_KEY}" } }),
      {}
    );
    process.env[EXA_API_KEY_ENV_KEY] = "env-key-wins";
    try {
      assert.equal(loadEnvAt(cwd, home).web.exaApiKey, "env-key-wins");
    } finally {
      delete process.env[EXA_API_KEY_ENV_KEY];
    }
  });

  it("unresolvable settings placeholder → undefined, never the literal ${VAR}", async () => {
    const { home, cwd } = await makeSettings(
      withModel({ web: { searchBackend: "exa", backendKey: "${IKNOW_TEST_UNSET_VAR}" } }),
      {}
    );
    const key = loadEnvAt(cwd, home).web.exaApiKey;
    // Leak check first: a surviving raw "${...}" string would reach an auth header.
    assert.ok(
      key === undefined || !key.includes("${"),
      `a raw placeholder must never leak downstream, got: ${String(key)}`
    );
    assert.equal(key, undefined);
  });

  it("a dotenv-style 'yes' placeholder → undefined", async () => {
    const { home, cwd } = await makeSettings(
      withModel({ web: { searchBackend: "exa", backendKey: "yes" } }),
      {}
    );
    assert.equal(loadEnvAt(cwd, home).web.exaApiKey, undefined);
  });

  it(".env.local beats a settings literal (the middle precedence tier)", async () => {
    // The documented chain is process.env > .env.local/.env > settings > no key.
    // The other env-tier cases only cover process.env; without this one, a regression
    // that let settings outrank the env file would stay green.
    const { home, cwd } = await makeSettings(
      withModel({ web: { searchBackend: "exa", backendKey: "settings-loses" } }),
      {}
    );
    await writeFile(join(cwd, ".env.local"), `${EXA_API_KEY_ENV_KEY}=file-wins\n`);
    assert.equal(loadEnvAt(cwd, home).web.exaApiKey, "file-wins");
  });

  it("an unusable .env.local value falls through to settings (first USABLE wins, not first non-empty)", async () => {
    // `envOptional` only maps length-0 → undefined, so an env file holding a dotenv
    // stub or an unresolvable placeholder is "present" and would short-circuit the
    // settings fallback — discarding a perfectly good settings key and silently
    // downgrading to the default backend. These pin that the chain is first-usable-wins.
    for (const stub of ["yes", "  ", "${IKNOW_TEST_UNSET_VAR}"]) {
      const { home, cwd } = await makeSettings(
        withModel({ web: { searchBackend: "exa", backendKey: "settings-good-key" } }),
        {}
      );
      await writeFile(join(cwd, ".env.local"), `${EXA_API_KEY_ENV_KEY}=${stub}\n`);
      assert.equal(
        loadEnvAt(cwd, home).web.exaApiKey,
        "settings-good-key",
        `settings must win over an unusable .env.local value: ${stub}`
      );
    }
  });

  it("no env, no settings → undefined (default bing has no key)", async () => {
    const { home, cwd } = await makeSettings(withModel({}), {});
    const env = loadEnvAt(cwd, home);
    assert.equal(env.web.exaApiKey, undefined);
    assert.equal(env.web.tavilyApiKey, undefined);
    assert.equal(env.web.braveApiKey, undefined);
  });

  it("settings-only config resolves the capability to exa on both legs (the whole point)", async () => {
    const { home, cwd } = await makeSettings(
      withModel({ web: { searchBackend: "exa", backendKey: "settings-only-key" } }),
      {}
    );
    const env = loadEnvAt(cwd, home);
    const capability = resolveWebCapability({
      backend: env.web.searchBackend,
      exaApiKey: env.web.exaApiKey,
      tavilyApiKey: env.web.tavilyApiKey,
      braveApiKey: env.web.braveApiKey,
    });
    assert.deepEqual(capability, { searchEngine: "exa", fetchEngine: "exa" });
  });
});
