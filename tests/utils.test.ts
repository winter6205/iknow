import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { sumEven } from "../src/utils.js";

describe("sumEven", () => {
  it("sums even numbers and ignores odd ones", () => {
    assert.equal(sumEven([1, 2, 3, 4, 5, 6]), 12);
  });

  it("returns 0 for an empty array", () => {
    assert.equal(sumEven([]), 0);
  });

  it("returns 0 when there are no even numbers", () => {
    assert.equal(sumEven([1, 3, 5]), 0);
  });

  it("handles negative even numbers", () => {
    assert.equal(sumEven([-2, -4, 1]), -6);
  });

  it("does not mutate the input array", () => {
    const input = [2, 4, 6];
    sumEven(input);
    assert.deepEqual(input, [2, 4, 6]);
  });
});
