import { describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  AUTO_COMPACT_STRATEGY_RATIO,
  getAutoCompactThreshold,
  validateThreshold,
} from "../../../src/harness/compress/threshold.ts";
import {
  AUTOCOMPACT_BUFFER_TOKENS,
  MAX_OUTPUT_TOKENS_FOR_SUMMARY,
} from "../../../src/harness/compress/constant.ts";

describe("getAutoCompactThreshold", () => {
  it("缺省推导 (ADR-0100):window 200000 → floor(0.95 × window) = 190000", () => {
    assert.equal(getAutoCompactThreshold(200_000, undefined), 190_000);
    assert.equal(
      getAutoCompactThreshold(200_000, undefined),
      Math.floor(200_000 * AUTO_COMPACT_STRATEGY_RATIO)
    );
  });

  it("缺省闸不得再是旧余量公式 window − 20000 − 13000 (ADR-0100 否决)", () => {
    // 反例钉住:余量公式只在分母≈供应商真上限时合理;策略预算上会过早压缩。
    // 常量本身仍在 constant.ts 供 full-compact 摘要预算使用,只是不进这条闸。
    assert.notEqual(
      getAutoCompactThreshold(200_000, undefined),
      200_000 - MAX_OUTPUT_TOKENS_FOR_SUMMARY - AUTOCOMPACT_BUFFER_TOKENS
    );
    assert.notEqual(
      getAutoCompactThreshold(256_000, undefined),
      256_000 - MAX_OUTPUT_TOKENS_FOR_SUMMARY - AUTOCOMPACT_BUFFER_TOKENS
    );
  });

  it("仓库缺省策略预算窗口 256000 → 缺省闸 243200", () => {
    assert.equal(getAutoCompactThreshold(256_000, undefined), 243_200);
  });

  it("缺省闸向下取整:不可整除的 window 不产分数阈值", () => {
    assert.equal(getAutoCompactThreshold(1_001, undefined), 950);
    assert.equal(getAutoCompactThreshold(9, undefined), 8);
  });

  it("显式 threshold = 0 → 忽略,走推导 (不 throw)", () => {
    assert.equal(getAutoCompactThreshold(200_000, 0), 190_000);
  });

  it("显式负数 (如 -1) → 不满足 > 0,走推导 (不 throw)", () => {
    assert.equal(getAutoCompactThreshold(200_000, -1), 190_000);
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
