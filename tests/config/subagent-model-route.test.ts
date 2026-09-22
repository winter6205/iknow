/**
 * Sub-agent worker route from `settings.subagent.model` (ADR-0122).
 *
 * Two layers, each pinned where its contract actually lives:
 *  - settings parse (drop-not-throw): non-string / blank dropped, trimmed
 *    literal kept, a lone `model` survives (the emptiness early-return accounts
 *    for it), and the project layer never contributes `subagent` (ADR-0084);
 *  - `loadIknowEnv` resolution: a registered route with a non-empty api-key env
 *    yields the resolved `env.subagent.model` (same transport triple as
 *    `LiteModelEnv`); every illegal state or `LlmProviderConfigError` leaves the
 *    key absent (never `null`); a non-config throw propagates.
 */
import assert from "node:assert/strict";
import { describe, it, beforeAll, afterAll } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadIknowEnv, wireModelFromRoute } from "../../src/config/env.ts";
import { loadIknowSettings } from "../../src/config/settings.ts";
import type { IknowSettings } from "../../src/config/settings.ts";

const MAIN_KEY_ENV = "IKNOW_TEST_SUBAGENT_MAIN_KEY";
const SUB_KEY_ENV = "IKNOW_TEST_SUBAGENT_SUB_KEY";
const MISSING_KEY_ENV = "IKNOW_TEST_SUBAGENT_KEY_NEVER_SET";

const MAIN_PROVIDER = {
  id: "main",
  baseUrl: "http://main.test/v1",
  apiKeyEnv: MAIN_KEY_ENV,
  models: [{ id: "model" }],
};

const SUB_PROVIDER = {
  id: "sub",
  baseUrl: "http://sub.test/v1/",
  apiKeyEnv: SUB_KEY_ENV,
  headers: { "X-Sub": "1" },
  models: [{ id: "sub-model" }],
};

/** A keyless provider — registered, but its api-key env is never set. */
const KEYLESS_PROVIDER = {
  id: "keyless",
  baseUrl: "http://keyless.test/v1",
  apiKeyEnv: MISSING_KEY_ENV,
  models: [{ id: "k" }],
};

/** baseUrl non-string → resolveLlmTransport crashes on `.replace` (a NON-config throw). */
const CRASH_PROVIDER = {
  id: "crash",
  baseUrl: 12345 as unknown as string,
  apiKeyEnv: SUB_KEY_ENV,
  models: [{ id: "m" }],
};

function settings(
  subagentModel: unknown,
  providers: unknown[] = [MAIN_PROVIDER, SUB_PROVIDER]
): IknowSettings {
  return {
    llm: {
      model: "main/model",
      providers,
    } as IknowSettings["llm"],
    subagent:
      subagentModel === undefined
        ? undefined
        : ({ model: subagentModel } as IknowSettings["subagent"]),
  };
}

describe("loadIknowEnv — subagent.model route resolution", () => {
  beforeAll(() => {
    process.env[MAIN_KEY_ENV] = "main-key";
    process.env[SUB_KEY_ENV] = "sub-key";
    delete process.env[MISSING_KEY_ENV];
  });
  afterAll(() => {
    delete process.env[MAIN_KEY_ENV];
    delete process.env[SUB_KEY_ENV];
    delete process.env[MISSING_KEY_ENV];
  });

  it("registered provider/model with non-empty apiKeyEnv → resolved field carries the transport triple", () => {
    const env = loadIknowEnv(process.cwd(), settings("sub/sub-model"));
    assert.ok(env.subagent.model, "resolved route should be present");
    assert.equal(env.subagent.model.model, "sub/sub-model");
    // trailing slash stripped by resolveLlmTransport, provider headers carried.
    assert.equal(env.subagent.model.baseUrl, "http://sub.test/v1");
    assert.equal(env.subagent.model.apiKey, "sub-key");
    assert.deepEqual(env.subagent.model.headers, { "X-Sub": "1" });
    // The worker's wire model is the route tail, not the provider-prefixed literal.
    assert.equal(wireModelFromRoute(env.subagent.model.model), "sub-model");
  });

  it("absent subagent.model → key absent (never null), main route untouched", () => {
    const env = loadIknowEnv(process.cwd(), settings(undefined));
    assert.equal("model" in env.subagent, false);
    assert.equal(env.llm.model, "main/model");
  });

  it("empty / empty-after-trim subagent.model → key absent", () => {
    for (const blank of ["", "   ", "\t"]) {
      const env = loadIknowEnv(process.cwd(), settings(blank));
      assert.equal(
        "model" in env.subagent,
        false,
        `blank ${JSON.stringify(blank)} should not produce a key`
      );
    }
  });

  it("provider not registered (LlmProviderConfigError) → key absent, spawn not failed, main route kept", () => {
    const env = loadIknowEnv(process.cwd(), settings("nope/whatever"));
    assert.equal("model" in env.subagent, false);
    assert.equal(env.llm.model, "main/model");
  });

  it("provider api-key env unset (LlmProviderConfigError) → key absent, main route kept", () => {
    const env = loadIknowEnv(
      process.cwd(),
      settings("keyless/k", [MAIN_PROVIDER, SUB_PROVIDER, KEYLESS_PROVIDER])
    );
    assert.equal("model" in env.subagent, false);
    assert.equal(env.llm.model, "main/model");
    assert.equal(env.llm.apiKey, "main-key");
  });

  it("a NON-config throw during resolution propagates (not swallowed into the fallback)", () => {
    // `crash` provider is registered and its key is set, so the only failure is
    // baseUrl.replace on a non-string — a plain TypeError, not LlmProviderConfigError.
    assert.throws(
      () =>
        loadIknowEnv(
          process.cwd(),
          settings("crash/m", [MAIN_PROVIDER, SUB_PROVIDER, CRASH_PROVIDER])
        ),
      TypeError
    );
  });
});

describe("loadIknowSettings — subagent.model parse/allowlist", () => {
  let root: string;
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "iknow-subagent-model-settings-"));
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function write(
    user: Record<string, unknown>,
    project: Record<string, unknown>
  ): Promise<{ home: string; cwd: string }> {
    const stamp = Math.random().toString(36).slice(2);
    const home = join(root, "home", stamp);
    const cwd = join(root, "cwd", stamp);
    await mkdir(join(home, ".iknow"), { recursive: true });
    await mkdir(join(cwd, ".iknow"), { recursive: true });
    await writeFile(
      join(home, ".iknow", "settings.json"),
      JSON.stringify(user)
    );
    if (Object.keys(project).length > 0) {
      await writeFile(
        join(cwd, ".iknow", "settings.json"),
        JSON.stringify(project)
      );
    }
    return { home, cwd };
  }

  it("non-string / blank model is dropped (drop-not-throw); a lone valid model survives the section", async () => {
    for (const bad of [123, true, {}, [], "", "   "]) {
      const { home, cwd } = await write({ subagent: { model: bad } }, {});
      assert.deepEqual(
        loadIknowSettings({ home, cwd }),
        {},
        `model ${JSON.stringify(bad)} should drop the whole section`
      );
    }
    const ok = await write({ subagent: { model: "  sub/sub-model  " } }, {});
    assert.deepEqual(loadIknowSettings(ok), {
      subagent: { model: "sub/sub-model" },
    });
  });

  it("a project `subagent` section does not override user-layer subagent.model (ADR-0084)", async () => {
    const { home, cwd } = await write(
      { subagent: { model: "user/model" } },
      { subagent: { model: "project/model" } }
    );
    const warnings: string[] = [];
    assert.deepEqual(
      loadIknowSettings({ home, cwd, onWarn: (m) => warnings.push(m) }),
      { subagent: { model: "user/model" } }
    );
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /"subagent"/);
  });
});
