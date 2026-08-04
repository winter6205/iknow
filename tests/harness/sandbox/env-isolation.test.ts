import { describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  BASE_ENV_WHITELIST,
  SECRET_ENV_NAMES,
  createEnvIsolation,
} from "../../../src/harness/sandbox/env-isolation.js";

describe("createEnvIsolation", () => {
  it("filters to explicitly allowed non-secret names", () => {
    const isolation = createEnvIsolation({ allowEnv: BASE_ENV_WHITELIST });
    const filtered = isolation.filter({
      PATH: "/bin",
      HOME: "/h",
      FOO: "bar",
      API_KEY: "secret",
    });
    assert.deepEqual(filtered, { PATH: "/bin", HOME: "/h" });
    assert.ok(Object.isFrozen(filtered));
  });

  it("derives at least one canonical secret name from env configuration", () => {
    assert.ok(SECRET_ENV_NAMES.length > 0);
    assert.ok(createEnvIsolation({ allowEnv: [] }).forbiddenNames().length > 0);
  });

  it("never includes values for names identified as secrets", () => {
    const isolation = createEnvIsolation({ allowEnv: SECRET_ENV_NAMES });
    const filtered = isolation.filter(
      Object.fromEntries(SECRET_ENV_NAMES.map((name) => [name, "secret"]))
    );
    assert.deepEqual(filtered, {});
  });
});
