import { describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  getAutoCompactThreshold,
  validateThreshold,
} from "../../../src/harness/compress/threshold.ts";
import {
  AUTOCOMPACT_BUFFER_TOKENS,
  MAX_OUTPUT_TOKENS_FOR_SUMMARY,
} from "../../../src/harness/compress/constant.ts";

describe("getAutoCompactThreshold", () => {
  it("缺省推导:window 200000 → 200000 - 20000 - 13000 = 167000", () => {
    assert.equal(getAutoCompactThreshold(200_000, undefined), 167_000);
    assert.equal(
      getAutoCompactThreshold(200_000, undefined),
      200_000 - MAX_OUTPUT_TOKENS_FOR_SUMMARY - AUTOCOMPACT_BUFFER_TOKENS
    );
  });

  it("显式 threshold = 0 → 忽略,走推导 (不 throw)", () => {
    assert.equal(getAutoCompactThreshold(200_000, 0), 167_000);
  });

  it("显式负数 (如 -1) → 不满足 > 0,走推导 (不 throw)", () => {
    assert.equal(getAutoCompactThreshold(200_000, -1), 167_000);
  });

  it("显式 threshold 优先:150000 < window → 返回 150000", () => {
    assert.equal(getAutoCompactThreshold(200_000, 150_000), 150_000);
  });

  it("边界:显式 threshold 恰好 = window - 1 → 合法返回", () => {
    assert.equal(getAutoCompactThreshold(200_000, 199_999), 199_999);
  });

  it("边界:显式 threshold ≥ window → throw,message 含 'must be < contextWindow'", () => {
    assert.throws(
      () => getAutoCompactThreshold(200_000, 200_000),
      /must be < contextWindow/
    );
    assert.throws(
      () => getAutoCompactThreshold(200_000, 300_000),
      /must be < contextWindow/
    );
  });
});

describe("validateThreshold", () => {
  it("合法 (threshold < window) → 返回 true", () => {
    assert.equal(validateThreshold(200_000, 167_000), true);
  });

  it("边界:threshold = window - 1 → true", () => {
    assert.equal(validateThreshold(200_000, 199_999), true);
  });

  it("边界:threshold ≥ window → throw,message 含 'must be < contextWindow'", () => {
    assert.throws(
      () => validateThreshold(200_000, 200_000),
      /must be < contextWindow/
    );
    assert.throws(
      () => validateThreshold(200_000, 1_000_000),
      /must be < contextWindow/
    );
  });
});
