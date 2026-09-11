/**
 * 输出投影层单测（SC12「输出投影」；契约 D2/D3；SC4/SC5/SC6/SC7）。
 *
 * 锁的不变式：
 *   - `paths`：每个唯一文件一条相对路径，条数按**文件**计（SC4）。
 *   - `content`：`path:line:text`（SC5）。
 *   - `count`：`path:条数` + 全库 `total:` = **未切片前**命中总数（SC5）。
 *   - `content + context`：上下文行 `-` 分隔、组间 `--`，不被切成假
 *     `path:line:text`（SC6）。
 *   - 有命中但 offset 越过最后一条 → 精确 `No entries at this offset`（SC7）。
 */

import assert from "node:assert/strict";
import { describe, it } from "vitest";

import {
  projectContent,
  projectCount,
  projectPaths,
  projectContext,
  type ProjectionInput,
} from "../../../../src/harness/aci/search/project.ts";
import { NO_ENTRIES_AT_OFFSET } from "../../../../src/harness/aci/search/paginate.ts";

function input(
  lines: ProjectionInput["hits"]["lines"],
  overrides: Partial<ProjectionInput> = {}
): ProjectionInput {
  return {
    hits: { lines },
    offset: 0,
    headLimit: 50,
    ...overrides,
  };
}

describe("projectPaths — 默认出法（SC4）", () => {
  it("每个唯一文件一条，按 path 排序；条数按文件计", () => {
    const out = projectPaths(
      input([
        { path: "b.ts", line: 1, text: "x" },
        { path: "a.ts", line: 9, text: "y" },
        { path: "a.ts", line: 2, text: "z" },
      ])
    );

    assert.equal(out, "a.ts\nb.ts");
  });

  it("模型可见行皆相对路径、无 `:行号:` 形匹配行（SC4）", () => {
    const out = projectPaths(
      input([{ path: "src/deep/a.ts", line: 42, text: "secret" }])
    );

    assert.equal(out, "src/deep/a.ts");
    assert.ok(!/:\d+:/.test(out), `no line-number shape expected; got ${out}`);
    assert.ok(!out.includes("secret"), "content must not leak in paths mode");
  });

  it("head_limit 按文件计（3 个文件、head_limit=2 → 2 条）", () => {
    const out = projectPaths(
      input(
        [
          { path: "a.ts", line: 1, text: "x" },
          { path: "b.ts", line: 1, text: "x" },
          { path: "c.ts", line: 1, text: "x" },
        ],
        { headLimit: 2 }
      )
    );

    assert.equal(out, "a.ts\nb.ts");
  });

  it("无命中 → 空串；offset 越过最后一条 → 精确回执（SC7）", () => {
    assert.equal(projectPaths(input([])), "");
    assert.equal(
      projectPaths(
        input([{ path: "a.ts", line: 1, text: "x" }], { offset: 5 })
      ),
      NO_ENTRIES_AT_OFFSET
    );
  });
});

describe("projectContent — 显式出法（SC5）", () => {
  it("每条为 path:line:text，按 (path, line) 排序", () => {
    const out = projectContent(
      input([
        { path: "b.ts", line: 3, text: "hit b" },
        { path: "a.ts", line: 10, text: "hit a10" },
        { path: "a.ts", line: 2, text: "hit a2" },
      ])
    );

    assert.deepEqual(out.split("\n"), [
      "a.ts:2:hit a2",
      "a.ts:10:hit a10",
      "b.ts:3:hit b",
    ]);
  });

  it("line 是数值序不是字典序（10 排在 2 之后）", () => {
    const out = projectContent(
      input([
        { path: "a.ts", line: 10, text: "ten" },
        { path: "a.ts", line: 2, text: "two" },
      ])
    );

    assert.equal(out.split("\n")[0], "a.ts:2:two");
    assert.equal(out.split("\n")[1], "a.ts:10:ten");
  });

  it("空 text 仍产出合法行（不误删）", () => {
    const out = projectContent(input([{ path: "a.ts", line: 7, text: "" }]));

    assert.equal(out, "a.ts:7:");
  });
});

describe("projectCount — 显式出法（SC5）", () => {
  it("每文件一条 `path:条数`，并给全库 total（未切片前）", () => {
    const out = projectCount(
      input([
        { path: "b.ts", line: 1, text: "x" },
        { path: "a.ts", line: 1, text: "x" },
        { path: "a.ts", line: 2, text: "x" },
      ])
    );

    assert.deepEqual(out.split("\n"), ["a.ts:2", "b.ts:1", "total:3"]);
  });

  it("total 是切片前总数：head_limit 只切文件名单，不改 total（SC5）", () => {
    const lines = Array.from({ length: 7 }, (_, i) => ({
      path: `f${String(i)}.ts`,
      line: 1,
      text: "x",
    }));

    const out = projectCount(input(lines, { headLimit: 3 }));

    assert.deepEqual(out.split("\n"), [
      "f0.ts:1",
      "f1.ts:1",
      "f2.ts:1",
      "total:7",
    ]);
  });

  it("offset 切片后 total 仍是整库总数（不受 offset 影响）", () => {
    const lines = Array.from({ length: 5 }, (_, i) => ({
      path: `f${String(i)}.ts`,
      line: 1,
      text: "x",
    }));

    const out = projectCount(input(lines, { offset: 2, headLimit: 2 }));

    assert.deepEqual(out.split("\n"), ["f2.ts:1", "f3.ts:1", "total:5"]);
  });

  it("无命中 → 空串（不产出 total:0 假行）", () => {
    assert.equal(projectCount(input([])), "");
  });

  it("有命中但 offset 越过最后一条 → 精确回执（SC7）", () => {
    assert.equal(
      projectCount(
        input([{ path: "a.ts", line: 1, text: "x" }], { offset: 9 })
      ),
      NO_ENTRIES_AT_OFFSET
    );
  });
});

describe("projectContext — content + context（SC6）", () => {
  it("匹配行用 `:`、上下文行用 `-`、组间 `--` 分隔", () => {
    const out = projectContext([
      {
        entries: [
          { path: "m.txt", line: 4, text: "line4", isMatch: false },
          { path: "m.txt", line: 5, text: "hit A", isMatch: true },
          { path: "m.txt", line: 6, text: "line6", isMatch: false },
        ],
      },
      {
        entries: [{ path: "m.txt", line: 15, text: "hit B", isMatch: true }],
      },
    ]);

    assert.deepEqual(out.split("\n"), [
      "m.txt-4-line4",
      "m.txt:5:hit A",
      "m.txt-6-line6",
      "--",
      "m.txt:15:hit B",
    ]);
  });

  it("上下文行的内容含冒号时仍不被切成假 path:line:text（SC6）", () => {
    const out = projectContext([
      {
        entries: [
          { path: "a.ts", line: 3, text: "key: value", isMatch: false },
          { path: "a.ts", line: 4, text: "hit", isMatch: true },
        ],
      },
    ]);

    const lines = out.split("\n");
    assert.equal(lines[0], "a.ts-3-key: value");
    // 关键：第一行不得被读成 `path:line:text`。
    assert.equal(/^[^:]+:\d+:/.test(lines[0]!), false);
    assert.equal(lines[1], "a.ts:4:hit");
  });

  it("单组不产出 `--` 前后缀", () => {
    const out = projectContext([
      { entries: [{ path: "a.ts", line: 1, text: "x", isMatch: true }] },
    ]);

    assert.equal(out, "a.ts:1:x");
  });

  it("无组 → 空串", () => {
    assert.equal(projectContext([]), "");
  });
});
