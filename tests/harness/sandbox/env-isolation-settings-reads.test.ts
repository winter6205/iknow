/**
 * env-isolation `currentSecretValues()` settings-read discipline.
 *
 * `currentSecretValues()` sits on the output-masking hot path (every
 * stream-draft refresh, trace write, bash output). Before the single-read
 * refactor it called `loadIknowSettings()` twice per invocation (once inside
 * `configuredSecretNames()`, once inside `literalApiKey()`), and each
 * `loadIknowSettings()` itself reads up to two files (user + project layers).
 *
 * These tests pin three things:
 *  1. the exact mask-set output per `settings.llm.apiKey` input class
 *     (literal / placeholder / multi-segment / absent key / absent llm
 *     section) — byte-identical to the pre-refactor output;
 *  2. exactly ONE `loadIknowSettings()` call per `currentSecretValues()`
 *     invocation (observing the settings module via vi.mock — the unit under
 *     test itself is never mocked);
 *  3. the degradation path: `loadIknowSettings()` throwing must not make
 *     `currentSecretValues()` throw, and env-derived secret values must still
 *     join the mask set (the security layer degrades, never crashes).
 *
 * The mocked-settings groups never touch the real settings loader or the real
 * HOME — `loadIknowSettings` is the only settings dependency of the unit
 * under test (its other import, `extractPlaceholders`, is a pure parser).
 * Synthetic key values and synthetic env names/values only; nothing here is
 * real user data.
 */
import { describe, it, vi, beforeEach, afterEach } from "vitest";
import assert from "node:assert/strict";

const loadIknowSettingsMock = vi.hoisted(() =>
  // Default implementation: an empty settings object — the same shape the real
  // loader produces when no settings file exists. Needed because the module
  // under test resolves SECRET_ENV_NAMES at import time (one loadIknowSettings
  // call before any per-test configuration). vitest 3 mockReset() restores
  // this original implementation.
  vi.fn<() => IknowSettings>(() => ({}))
);

vi.mock("../../../src/config/settings.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../src/config/settings.js")>();
  return {
    ...actual,
    loadIknowSettings: loadIknowSettingsMock,
  };
});

import {
  DEFAULT_OWNER,
  clearActiveExtraSecrets,
  currentSecretValues,
} from "../../../src/harness/sandbox/env-isolation.js";
import { LLM_MODEL_MISSING_MESSAGE } from "../../../src/config/messages.js";
import type { IknowSettings } from "../../../src/config/settings.js";

// Synthetic env var matching the SECRET_PATTERN fallback (contains "API_KEY");
// its value is a synthetic string, set/cleared around every case.
const FALLBACK_VAR = "IKNOW_SV_API_KEY_VAR";
const FALLBACK_VALUE = "synthetic-mask-value-fallback-env-value";

function settingsWithApiKey(apiKey: string | undefined): IknowSettings {
  return apiKey === undefined ? {} : { llm: { apiKey } };
}

beforeEach(() => {
  process.env[FALLBACK_VAR] = FALLBACK_VALUE;
  clearActiveExtraSecrets(DEFAULT_OWNER);
});

afterEach(() => {
  delete process.env[FALLBACK_VAR];
  clearActiveExtraSecrets(DEFAULT_OWNER);
  loadIknowSettingsMock.mockReset();
});

describe("currentSecretValues — mask-set output pinned per apiKey input class", () => {
  it("literal apiKey → [fallback var value, literal key value]", () => {
    loadIknowSettingsMock.mockReturnValue(
      settingsWithApiKey("synthetic-mask-value-literal-key")
    );
    assert.deepEqual(currentSecretValues({ [FALLBACK_VAR]: FALLBACK_VALUE }), [
      "synthetic-mask-value-fallback-env-value",
      "synthetic-mask-value-literal-key",
    ]);
  });

  it("literal apiKey with surrounding whitespace → only the trimmed value is masked", () => {
    loadIknowSettingsMock.mockReturnValue(
      settingsWithApiKey("  synthetic-mask-value-literal-key  ")
    );
    assert.deepEqual(currentSecretValues({ [FALLBACK_VAR]: FALLBACK_VALUE }), [
      "synthetic-mask-value-fallback-env-value",
      "synthetic-mask-value-literal-key",
    ]);
  });

  it("whitespace-only apiKey → treated as no key (empty mask set beyond env fallback)", () => {
    loadIknowSettingsMock.mockReturnValue(settingsWithApiKey("   "));
    assert.deepEqual(currentSecretValues({ [FALLBACK_VAR]: FALLBACK_VALUE }), [
      "synthetic-mask-value-fallback-env-value",
    ]);
  });

  it("placeholder apiKey with var unset → only the fallback var value (no placeholder text)", () => {
    loadIknowSettingsMock.mockReturnValue(
      settingsWithApiKey("${IKNOW_SV_PLACEHOLDER_VAR}")
    );
    assert.deepEqual(currentSecretValues({ [FALLBACK_VAR]: FALLBACK_VALUE }), [
      "synthetic-mask-value-fallback-env-value",
    ]);
  });

  it("placeholder apiKey with var set → var value joins, placeholder text does not", () => {
    loadIknowSettingsMock.mockReturnValue(
      settingsWithApiKey("${IKNOW_SV_PLACEHOLDER_VAR}")
    );
    // The env argument replaces the process.env default, so every var the
    // mask set should draw from must be present in it.
    assert.deepEqual(
      currentSecretValues({
        IKNOW_SV_PLACEHOLDER_VAR: "synthetic-mask-value-placeholder-value",
        [FALLBACK_VAR]: FALLBACK_VALUE,
      }),
      [
        "synthetic-mask-value-placeholder-value",
        "synthetic-mask-value-fallback-env-value",
      ]
    );
  });

  it("multi-segment ${A}literal${B} → both var values (no literal fragment; pins current behavior)", () => {
    loadIknowSettingsMock.mockReturnValue(
      settingsWithApiKey(
        "${IKNOW_SV_PLACEHOLDER_VAR}literal-mid${IKNOW_SV_API_KEY_VAR}"
      )
    );
    // extractPlaceholders() is non-empty for this apiKey, so the whole raw
    // string is treated as placeholder-form: no literal fragment enters the
    // mask set (pre-existing behavior, pinned here so the refactor does not
    // change it — flagged in the handoff report as a possible masking gap).
    assert.deepEqual(
      currentSecretValues({
        IKNOW_SV_PLACEHOLDER_VAR: "synthetic-mask-value-multi-a",
        [FALLBACK_VAR]: FALLBACK_VALUE,
      }),
      [
        "synthetic-mask-value-multi-a",
        "synthetic-mask-value-fallback-env-value",
      ]
    );
  });

  it("no apiKey field at all → only the fallback var value", () => {
    loadIknowSettingsMock.mockReturnValue(settingsWithApiKey(undefined));
    assert.deepEqual(currentSecretValues({ [FALLBACK_VAR]: FALLBACK_VALUE }), [
      "synthetic-mask-value-fallback-env-value",
    ]);
  });

  it("no llm section at all → only the fallback var value", () => {
    loadIknowSettingsMock.mockReturnValue({});
    assert.deepEqual(currentSecretValues({ [FALLBACK_VAR]: FALLBACK_VALUE }), [
      "synthetic-mask-value-fallback-env-value",
    ]);
  });
});

describe("currentSecretValues — loadIknowSettings call count (hot-path discipline)", () => {
  it("exactly one loadIknowSettings call per currentSecretValues invocation", () => {
    loadIknowSettingsMock.mockReturnValue(
      settingsWithApiKey("${IKNOW_SV_PLACEHOLDER_VAR}")
    );
    currentSecretValues({ [FALLBACK_VAR]: FALLBACK_VALUE });
    assert.equal(loadIknowSettingsMock.mock.calls.length, 1);
  });

  it("two invocations → two calls total (fresh read per call, no cross-call caching)", () => {
    loadIknowSettingsMock.mockReturnValue(
      settingsWithApiKey("synthetic-mask-value-literal-key")
    );
    currentSecretValues({ [FALLBACK_VAR]: FALLBACK_VALUE });
    currentSecretValues({ [FALLBACK_VAR]: FALLBACK_VALUE });
    assert.equal(loadIknowSettingsMock.mock.calls.length, 2);
  });

  it("callers without an apiKey still resolve names via their own single read (module-slot call sites keep one read)", () => {
    // configuredSecretNames() with no argument (module init / createEnvIsolation /
    // currentSecretEnvNames call shape) must keep reading settings itself —
    // exactly once — and still derive placeholder names.
    loadIknowSettingsMock.mockReturnValue(
      settingsWithApiKey("${IKNOW_SV_PLACEHOLDER_VAR}")
    );
    const values = currentSecretValues({
      IKNOW_SV_PLACEHOLDER_VAR: "synthetic-mask-value-placeholder-value",
      [FALLBACK_VAR]: FALLBACK_VALUE,
    });
    assert.deepEqual(values, [
      "synthetic-mask-value-placeholder-value",
      "synthetic-mask-value-fallback-env-value",
    ]);
    assert.equal(loadIknowSettingsMock.mock.calls.length, 1);
  });
});

describe("currentSecretValues — degradation when loadIknowSettings throws", () => {
  it("does not throw and still returns env-derived secret values", () => {
    // The real fail-fast: loadIknowEnv throws when no model is configured.
    // env-isolation must degrade (env scanning only), never crash.
    loadIknowSettingsMock.mockImplementation(() => {
      throw new Error(LLM_MODEL_MISSING_MESSAGE);
    });
    const values = currentSecretValues({ [FALLBACK_VAR]: FALLBACK_VALUE });
    assert.deepEqual(values, ["synthetic-mask-value-fallback-env-value"]);
  });
});
