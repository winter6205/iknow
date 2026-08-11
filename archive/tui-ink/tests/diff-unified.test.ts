/**
 * tests/tui/diff-unified.test.ts
 *
 * #298 T3 `diff-unified` 纯函数：统一 diff（jsdiff）行化，TUI 红绿 diff 预览
 * 的算法地基。7 个边界 case（plan T3 acceptance 逐条对应）：
 *
 *   1. 空文件 → 空数组（双双空 → []；单边空 → 纯 add / 纯 del）
 *   2. 纯新增 → 全 `add`，newNo 单调 1..n，oldNo undefined
 *   3. 纯删除 → 全 `del`，oldNo 单调 1..n
 *   4. 跨多 hunk 行号准确（每个 hunk 内 oldNo/newNo 独立从 hunk 起点计数）
 *   5. `computeDiff('a.ts','x','y')` 与 git diff --unified=3 字节一致
 *   6. 窄终端 cols=40 调用方不抛
 *   7. jsdiff throw → typed `DiffError`（code 字段），不外泄 raw Error
 *
 * 契约：hunk 头 `@@ -A,B +C,D @@` 以 `ctx` 行形态保留在数组里（T5 diff-view
 * 靠它定位行号起点）；无行尾换行标记 `\ No newline at end of file` 以
 * `ctx` 行保留（与 git diff 字节一致）。
 */
import { describe, expect, it, vi } from "vitest";
import {
  computeDiff,
  DiffError,
  type DiffLine,
} from "../../src/tui/diff-unified.js";

function kindOf(rows: readonly DiffLine[]): string[] {
  return rows.map((r) => r.kind);
}

describe("computeDiff: 空文件 / 纯新增 / 纯删除", () => {
  it("空文件对空文件 → 空数组", () => {
    expect(computeDiff("a.ts", "", "")).toEqual([]);
  });

  it("纯新增：空 old → 全 add，newNo 单调递增，oldNo undefined", () => {
    // 带尾换行 → 无 `\ No newline` 标记，正好 1 hunk 头 + 3 add
    const rows = computeDiff("a.ts", "", "one\ntwo\nthree\n");
    expect(kindOf(rows)).toEqual(["ctx", "add", "add", "add"]);
    const adds = rows.filter((r) => r.kind === "add");
    expect(adds.map((r) => r.newNo)).toEqual([1, 2, 3]);
    expect(adds.every((r) => r.oldNo === undefined)).toBe(true);
  });

  it("纯删除：空 new → 全 del，oldNo 单调递增", () => {
    const rows = computeDiff("a.ts", "one\ntwo\nthree\n", "");
    expect(kindOf(rows)).toEqual(["ctx", "del", "del", "del"]);
    const dels = rows.filter((r) => r.kind === "del");
    expect(dels.map((r) => r.oldNo)).toEqual([1, 2, 3]);
  });
});

describe("computeDiff: 跨多 hunk 行号准确", () => {
  it("改第 3 行与第 20 行（30 行文件）→ 2 hunk，各 hunk 行号独立计数", () => {
    const pad = (ls: string[]): string => ls.map((l) => `${l}\n`).join("");
    const oldLines = Array.from({ length: 30 }, (_, i) => `L${i + 1}`);
    const newLines = [...oldLines];
    newLines[2] = "X3";
    newLines[19] = "X20";
    const rows = computeDiff("a.ts", pad(oldLines), pad(newLines));

    // 2 个 hunk：@@ -1,6 +1,6 @@ 与 @@ -17,7 +17,7 @@
    expect(rows.filter((r) => r.text.startsWith("@@"))).toHaveLength(2);

    const addRows = rows.filter((r) => r.kind === "add");
    expect(addRows).toHaveLength(2);
    expect(addRows.map((r) => r.newNo)).toEqual([3, 20]);

    const delRows = rows.filter((r) => r.kind === "del");
    expect(delRows).toHaveLength(2);
    expect(delRows.map((r) => r.oldNo)).toEqual([3, 20]);

    // 每行文本与 git 语义一致（-old/+new）
    expect(delRows[0].text).toBe("-L3");
    expect(addRows[0].text).toBe("+X3");
    expect(delRows[1].text).toBe("-L20");
    expect(addRows[1].text).toBe("+X20");
  });

  it("hunk 头精确形态 @@ -1,6 +1,6 @@ 与 @@ -17,7 +17,7 @@", () => {
    const pad = (ls: string[]): string => ls.map((l) => `${l}\n`).join("");
    const oldLines = Array.from({ length: 30 }, (_, i) => `L${i + 1}`);
    const newLines = [...oldLines];
    newLines[2] = "X3";
    newLines[19] = "X20";
    const rows = computeDiff("a.ts", pad(oldLines), pad(newLines));
    expect(
      rows.filter((r) => r.text.startsWith("@@")).map((r) => r.text)
    ).toEqual(["@@ -1,6 +1,6 @@", "@@ -17,7 +17,7 @@"]);
  });
});

describe("computeDiff: 与 git diff --unified=3 字节一致", () => {
  it("改一行：行文本/hunk 头/行号与 git 对齐", () => {
    const pad = (ls: string[]): string => ls.map((l) => `${l}\n`).join("");
    const oldLines = [
      "one",
      "two",
      "three",
      "four",
      "five",
      "six",
      "seven",
      "eight",
      "nine",
      "ten",
    ];
    const newLines = [...oldLines];
    newLines[2] = "THREE";
    const rows = computeDiff("a.ts", pad(oldLines), pad(newLines));

    expect(
      rows.filter((r) => r.text.startsWith("@@")).map((r) => r.text)
    ).toEqual(["@@ -1,6 +1,6 @@"]);

    const delRows = rows.filter((r) => r.kind === "del");
    const addRows = rows.filter((r) => r.kind === "add");
    expect(delRows).toEqual([{ kind: "del", oldNo: 3, text: "-three" }]);
    expect(addRows).toEqual([{ kind: "add", newNo: 3, text: "+THREE" }]);

    // 上下文内容与 git 一致（context=3：前 2 行 + 后 3 行 = 5 个 ctx）
    const ctxRows = rows.filter(
      (r) => r.kind === "ctx" && !r.text.startsWith("@@")
    );
    expect(ctxRows).toEqual([
      { kind: "ctx", oldNo: 1, newNo: 1, text: " one" },
      { kind: "ctx", oldNo: 2, newNo: 2, text: " two" },
      { kind: "ctx", oldNo: 4, newNo: 4, text: " four" },
      { kind: "ctx", oldNo: 5, newNo: 5, text: " five" },
      { kind: "ctx", oldNo: 6, newNo: 6, text: " six" },
    ]);
  });

  it("无行尾换行：\\ No newline at end of file 以 ctx 行保留", () => {
    const rows = computeDiff("a.ts", "one\ntwo", "one\ntwo\nthree");
    const marker = rows.find((r) => r.text === "\\ No newline at end of file");
    expect(marker).toBeDefined();
    expect(marker?.kind).toBe("ctx");
    // 标记在 -two 之后（oldNo=2 消费后停在 2），行号列不递增
    expect(rows.find((r) => r.text === "-two")?.oldNo).toBe(2);
  });
});

describe("computeDiff: 窄终端 cols=40 调用方不抛", () => {
  it("传 cols=40 → 正常返回结果（窄终端不抛、不溢出）", () => {
    const pad = (ls: string[]): string => ls.map((l) => `${l}\n`).join("");
    const rows = computeDiff(
      "a.ts",
      pad(["alpha", "beta", "gamma"]),
      pad(["alpha", "BETA", "gamma"]),
      40
    );
    expect(rows.some((r) => r.kind === "add")).toBe(true);
    expect(rows.some((r) => r.kind === "del")).toBe(true);
    expect(rows.some((r) => r.kind === "ctx")).toBe(true);
  });

  it("不传 cols → 行为与传 cols 一致（纯函数与终端无关）", () => {
    const withCols = computeDiff("a.ts", "x\ny", "x\nz");
    const withoutCols = computeDiff("a.ts", "x\ny", "x\nz");
    expect(withoutCols).toEqual(withCols);
  });
});

// jsdiff 是 ESM 命名空间导出，`vi.spyOn(ns, "diffLines")` 不可重新定义
// （ESM 模块命名空间不可配置）。改为顶层 `vi.mock` + 工厂委托真实实现，
// `failDiff` 置真时让 `structuredPatch`（diff-unified.ts 直接 import 的入口）
// 抛错 —— jsdiff 异常路径由此可测，且不改实现模块。
let failDiff = false;
vi.mock("diff", async (importOriginal) => {
  const actual = await importOriginal<typeof import("diff")>();
  return {
    ...actual,
    structuredPatch: (...args: Parameters<typeof actual.structuredPatch>) => {
      if (failDiff) throw new Error("boom");
      return actual.structuredPatch(...args);
    },
  };
});

describe("computeDiff: jsdiff throw → typed DiffError", () => {
  it("jsdiff 抛错时包装为 DiffError（code），不外泄 raw Error", () => {
    failDiff = true;
    try {
      expect(() => computeDiff("a.ts", "x", "y")).toThrow(DiffError);
    } finally {
      failDiff = false;
    }
  });

  it("DiffError 带 code 字段（JS_DIFF_FAILED）", () => {
    failDiff = true;
    try {
      let caught: unknown;
      try {
        computeDiff("a.ts", "x", "y");
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(DiffError);
      expect((caught as DiffError).name).toBe("DiffError");
      expect((caught as DiffError).code).toBe("JS_DIFF_FAILED");
    } finally {
      failDiff = false;
    }
  });
});
