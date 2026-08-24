import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { partitionConcurrencyWaves } from "../../../src/harness/tools/concurrency-waves.ts";

describe("partitionConcurrencyWaves", () => {
  it("empty → []", () => {
    assert.deepEqual(
      partitionConcurrencyWaves([], () => true),
      []
    );
  });

  it("consecutive safe items share one wave", () => {
    const waves = partitionConcurrencyWaves(["a", "b", "c"], () => true);
    assert.deepEqual(
      waves.map((w) => [...w]),
      [["a", "b", "c"]]
    );
  });

  it("unsafe item is a singleton wave-breaker", () => {
    const safe = new Set(["a", "c", "d"]);
    const waves = partitionConcurrencyWaves(["a", "u", "c", "d"], (x) =>
      safe.has(x)
    );
    assert.deepEqual(
      waves.map((w) => [...w]),
      [["a"], ["u"], ["c", "d"]]
    );
  });
});
