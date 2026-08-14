/** @jsxImportSource @opentui/react */
/**
 * tests/tui/run-stats.test.ts
 *
 * mode 行右侧运行时长 + 压缩耗时纯函数单测（run-stats.ts）。
 */
import { describe, expect, test } from "bun:test";
import { formatCrunched, formatRunDuration } from "../../src/tui/run-stats.js";

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

describe("formatCrunched", () => {
  test("0 / 负值 / NaN → 空串", () => {
    expect(formatCrunched(0)).toBe("");
    expect(formatCrunched(-5)).toBe("");
    expect(formatCrunched(Number.NaN)).toBe("");
  });

  test("秒级：`Crunched for 45s`", () => {
    expect(formatCrunched(45)).toBe("Crunched for 45s");
  });

  test("分钟级：`Crunched for 3m 46s`", () => {
    expect(formatCrunched(226)).toBe("Crunched for 3m 46s");
  });

  test("小时级：`Crunched for 1h 0m`", () => {
    expect(formatCrunched(3600)).toBe("Crunched for 1h 0m");
  });
});
