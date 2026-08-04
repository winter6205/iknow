import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { createOutputMask } from "../../../src/harness/sandbox/output-mask.js";

describe("createOutputMask", () => {
  it("masks secret values and prefers the longest value", () => {
    const mask = createOutputMask(["secret", "secret_value"]);
    assert.equal(mask.mask("hello secret_value rest"), "hello *** rest");
    assert.equal(mask.mask("secret_value_extra"), "secret_value_extra");
  });

  it("is case-sensitive and leaves empty secret lists unchanged", () => {
    const mask = createOutputMask(["Secret"]);
    assert.equal(mask.mask("secret Secret"), "secret ***");
    assert.equal(createOutputMask([]).mask("unchanged"), "unchanged");
  });
});
