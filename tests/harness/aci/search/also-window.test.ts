/**
 * D5 行窗过滤单测（SC8）。
 *
 * 契约要点：`also` 是**过滤**不是展示。主词命中后只在 ±within_lines 行窗内
 * 找第二段；窗内没有 → 该主词命中当没中。不做裸跨行正则。
 *
 * 本层与引擎无关：输入「文件 → 行数组」，输出保留下来的主词命中行号。
 * 两种引擎（rg / Node）共用它，因此 SC9 的「Node 全语义」自动继承同一套
 * 判定。
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
    // 主词在第 2 行，withinLines=3 → 窗 = [1..5]，also 在第 5 行命中。
    const kept = filterHitsByAlsoWindow({
      matches: [{ path: "a.ts", line: 2, text: "primary hit" }],
      also: /also hit/,
      withinLines: 3,
      readLines: () => file,
    });

    assert.deepEqual(kept, [{ path: "a.ts", line: 2, text: "primary hit" }]);
  });

  it("第二段在窗外 → 不回报", () => {
    // 主词第 2 行、withinLines=1 → 窗 = [1..3]，also 在第 5 行 → 窗外。
    const kept = filterHitsByAlsoWindow({
      matches: [{ path: "a.ts", line: 2, text: "primary hit" }],
      also: /also hit/,
      withinLines: 1,
      readLines: () => file,
    });

    assert.deepEqual(kept, []);
  });

  it("窗是闭区间（边界行算命中）", () => {
    // 主词第 2 行、withinLines=3 → 窗上界 = 5 → 边界命中。
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

    // 第 1 行窗 [1..2] 命中；第 3 行窗 [2..4] 命中（also 在第 2 行）。
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
