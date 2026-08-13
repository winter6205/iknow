/** @jsxImportSource @opentui/react */
/**
 * tests/tui/run-stats.test.ts
 *
 * mode 行右侧运行时长 + token 统计纯函数单测（run-stats.ts）。
 */
import { describe, expect, test } from "bun:test";
import {
  formatRunDuration,
  formatRunStats,
  formatRunTokens,
} from "../../src/tui/run-stats.js";

describe("formatRunDuration", () => {
  test("不足 1 分钟：仅秒", () => {
    expect(formatRunDuration(0)).toBe("0s");
    expect(formatRunDuration(45)).toBe("45s");
    expect(formatRunDuration(59)).toBe("59s");
  });

  test("分钟：`3m 46s`", () => {
    expect(formatRunDuration(60)).toBe("1m 0s");
    expect(formatRunDuration(226)).toBe("3m 46s");
    expect(formatRunDuration(3599)).toBe("59m 59s");
  });

  test("小时：`1h 5m`", () => {
    expect(formatRunDuration(3600)).toBe("1h 0m");
    expect(formatRunDuration(3900)).toBe("1h 5m");
    expect(formatRunDuration(7325)).toBe("2h 2m");
  });

  test("负值 / NaN 兜底 0", () => {
    expect(formatRunDuration(-5)).toBe("0s");
    expect(formatRunDuration(Number.NaN)).toBe("0s");
  });
});

describe("formatRunTokens", () => {
  test("千分位：`↓ 1.5k`", () => {
    expect(formatRunTokens(1500)).toBe("↓ 1.5k");
    expect(formatRunTokens(12345)).toBe("↓ 12.3k");
  });

  test("null / undefined / 0 / NaN → 空串", () => {
    expect(formatRunTokens(null)).toBe("");
    expect(formatRunTokens(undefined)).toBe("");
    expect(formatRunTokens(0)).toBe("");
    expect(formatRunTokens(Number.NaN)).toBe("");
  });
});

describe("formatRunStats", () => {
  test("时长 + token：`3m 46s · ↓ 1.5k tokens`", () => {
    expect(formatRunStats(226, 1500)).toBe("3m 46s · ↓ 1.5k tokens");
  });

  test("无 token（null）→ 只有时长", () => {
    expect(formatRunStats(226, null)).toBe("3m 46s");
  });

  test("无 token（0）→ 只有时长", () => {
    expect(formatRunStats(45, 0)).toBe("45s");
  });
});
