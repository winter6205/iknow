/**
 * `also` line-window filtering unit tests.
 *
 * Contract: `also` is a **filter**, not a display feature. After a primary
 * hit, the second needle is sought only within ±within_lines; no hit in the
 * window → the primary hit doesn't count. No bare multi-line regex.
 *
 * This layer is engine-agnostic: input is "file → array of lines", output is
 * the kept primary-hit line numbers. Both engines (rg / Node) share it, so
 * Node full-semantics parity inherits the same verdicts for free.
 */

import assert from "node:assert/strict";
import { describe, it } from "vitest";

import {
  expandAlsoNeedle,
  filterHitsByAlsoWindow,
} from "../../../../src/harness/aci/search/also-window.ts";

describe("filterHitsByAlsoWindow — 窗内 / 窗外", () => {
  const file = [
    "alpha", // 1
    "primary hit", // 2
    "beta", // 3
    "gamma", // 4
    "also hit", // 5
    "delta", // 6
  ];

  it("第二段在窗内 → 回报", () => {
    // Primary on line 2, withinLines=3 → window = [1..5]; also hits line 5.
    const kept = filterHitsByAlsoWindow({
      matches: [{ path: "a.ts", line: 2, text: "primary hit" }],
      also: /also hit/,
      withinLines: 3,
      readLines: () => file,
    });

    assert.deepEqual(kept, [{ path: "a.ts", line: 2, text: "primary hit" }]);
  });

  it("第二段在窗外 → 不回报", () => {
    // Primary on line 2, withinLines=1 → window = [1..3]; also on line 5 → outside.
    const kept = filterHitsByAlsoWindow({
      matches: [{ path: "a.ts", line: 2, text: "primary hit" }],
      also: /also hit/,
      withinLines: 1,
      readLines: () => file,
    });

    assert.deepEqual(kept, []);
  });

  it("窗是闭区间（边界行算命中）", () => {
    // Primary on line 2, withinLines=3 → window upper bound = 5 → boundary counts.
    const kept = filterHitsByAlsoWindow({
      matches: [{ path: "a.ts", line: 2, text: "primary hit" }],
      also: /also hit/,
      withinLines: 3,
      readLines: () => file,
    });

    assert.equal(kept.length, 1);
  });

  it("主词行自身也算窗内（withinLines=0 时只查本行）", () => {
    const same = [
      "primary hit and also here", // 1
      "primary hit alone", // 2
    ];
    const kept = filterHitsByAlsoWindow({
      matches: [
        { path: "a.ts", line: 1, text: same[0]! },
        { path: "a.ts", line: 2, text: same[1]! },
      ],
      also: /also here/,
      withinLines: 0,
      readLines: () => same,
    });

    assert.deepEqual(kept, [{ path: "a.ts", line: 1, text: same[0]! }]);
  });

  it("文件头尾的窗被夹到实际行范围（不越界、不抛错）", () => {
    const kept = filterHitsByAlsoWindow({
      matches: [{ path: "a.ts", line: 1, text: "primary hit" }],
      also: /also hit/,
      withinLines: 99,
      readLines: () => file,
    });

    assert.equal(kept.length, 1);
  });

  it("同一文件的多个主词命中各自独立判定", () => {
    const lines = [
      "primary hit", // 1
      "also hit", // 2
      "primary hit", // 3
      "gap", // 4
      "gap", // 5
      "gap", // 6
      "gap", // 7
      "gap", // 8
      "gap", // 9
    ];
    const kept = filterHitsByAlsoWindow({
      matches: [
        { path: "a.ts", line: 1, text: lines[0]! },
        { path: "a.ts", line: 3, text: lines[2]! },
      ],
      also: /also hit/,
      withinLines: 1,
      readLines: () => lines,
    });

    // Line 1 window [1..2] hits; line 3 window [2..4] hits (also on line 2).
    assert.deepEqual(
      kept.map((h) => h.line),
      [1, 3]
    );
  });

  it("also 命中主词行之外的上下文也算（窗是行范围不是匹配集）", () => {
    const lines = ["context has also", "primary hit"];
    const kept = filterHitsByAlsoWindow({
      matches: [{ path: "a.ts", line: 2, text: lines[1]! }],
      also: /context has also/,
      withinLines: 1,
      readLines: () => lines,
    });

    assert.equal(kept.length, 1);
  });

  it("readLines 返回 null（不可读 / 二进制 / 超大）→ 该命中不算", () => {
    const kept = filterHitsByAlsoWindow({
      matches: [{ path: "a.ts", line: 1, text: "primary hit" }],
      also: /also/,
      withinLines: 5,
      readLines: () => null,
    });

    assert.deepEqual(kept, []);
  });

  it("同一文件只读一次（readLines 调用数 = 去重后文件数）", () => {
    const seen: string[] = [];
    filterHitsByAlsoWindow({
      matches: [
        { path: "a.ts", line: 1, text: "primary hit" },
        { path: "a.ts", line: 2, text: "primary hit" },
        { path: "b.ts", line: 1, text: "primary hit" },
      ],
      also: /also hit/,
      withinLines: 3,
      readLines: (path) => {
        seen.push(path);
        return file;
      },
    });

    assert.deepEqual([...seen].sort(), ["a.ts", "b.ts"]);
  });
});

describe("expandAlsoNeedle — also 是普通文本时按正则编译", () => {
  it("合法正则直接编译（与 pattern 同口径）", () => {
    const re = expandAlsoNeedle("foo|bar", false);
    assert.ok(re.test("xx bar yy"));
  });

  it("ignoreCase 生效", () => {
    assert.equal(expandAlsoNeedle("foo", false).test("FOO"), false);
    assert.equal(expandAlsoNeedle("foo", true).test("FOO"), true);
  });

  it("坏正则 → typed ToolExecutionError（与未知 type 文案不同）", () => {
    const bad = "(unclosed";
    assert.throws(
      () => expandAlsoNeedle(bad, false),
      (error: unknown) =>
        error instanceof Error &&
        /also/.test(error.message) &&
        error.message.includes(bad)
    );
  });
});
