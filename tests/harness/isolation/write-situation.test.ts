/**
 * Three-state write-situation decision (expand; no consumers yet).
 *
 * Pinned contract:
 *   - `writeSituation(false, <any non-empty root>)` -> `writable_main`,
 *     **including the "isolation OFF + tree-shaped path" combination** — the
 *     negative arm is pinned so the shape check can never be misused on its
 *     own (the ADR-0037 lesson: `taskWorktreeOwnerOf` is only a path-shape
 *     test; alone it would let reads escape the sandbox).
 *   - `writeSituation(true, <tree-shaped root>)` -> `writable_tree`;
 *     `writeSituation(true, <non-tree root>)` -> `no_writable_root`.
 *   - Empty / whitespace root -> typed result; never throws, never silent.
 *   - Overflow: very long / deep nesting / trailing separators — shape
 *     decisions still delegate to `isTaskWorktreePath`, no second shape logic.
 *   - Dependency direction: `src/harness/skill/body.ts` must not import
 *     `src/harness/isolation/` (the decision lives in isolation, rendering in
 *     skill, the enum in session-roots).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { writeSituation } from "../../../src/harness/isolation/write-situation.ts";
import { isTaskWorktreePath } from "../../../src/harness/isolation/worktree-gate.ts";

// -- fixtures -----------------------------------------------------------------

const TREE_ROOT = "/repo/.iknow/worktrees/conv1234";
const MAIN_ROOT = "/home/user/project";

describe("writeSituation — SC1 三态", () => {
  it("isolation OFF + 普通主仓根 → writable_main", () => {
    expect(writeSituation(false, MAIN_ROOT)).toBe("writable_main");
  });

  it("isolation ON + 树形根 → writable_tree", () => {
    expect(writeSituation(true, TREE_ROOT)).toBe("writable_tree");
  });

  it("isolation ON + 非树形根 → no_writable_root", () => {
    expect(writeSituation(true, MAIN_ROOT)).toBe("no_writable_root");
  });

  it("negative 臂：isolation OFF + 树形路径 → writable_main（防形状判断被单独误用）", () => {
    expect(isTaskWorktreePath(TREE_ROOT)).toBe(true);
    expect(writeSituation(false, TREE_ROOT)).toBe("writable_main");
  });
});

describe("writeSituation — empty 臂（空 / 空白根）", () => {
  // An empty root has nothing writable, so writable_main would be a lie;
  // fail-closed to no_writable_root (a legal member of the typed union) —
  // no throw, no silent pass.
  it("空串 → no_writable_root，不 throw", () => {
    expect(writeSituation(false, "")).toBe("no_writable_root");
    expect(writeSituation(true, "")).toBe("no_writable_root");
  });

  it("仅空白（空格 / 制表 / 换行）→ no_writable_root，不 throw", () => {
    expect(writeSituation(false, "   ")).toBe("no_writable_root");
    expect(writeSituation(true, "\t\n ")).toBe("no_writable_root");
  });
});

describe("writeSituation — overflow 臂", () => {
  it("极长绝对路径（非树形）→ no_writable_root", () => {
    const long = `/home/user/${"very-long-segment/".repeat(300)}repo`;
    expect(long.length).toBeGreaterThan(4096);
    expect(writeSituation(true, long)).toBe("no_writable_root");
    expect(writeSituation(false, long)).toBe("writable_main");
  });

  it("深层嵌套的树形路径 → writable_tree", () => {
    const deep = `/a/${"b/".repeat(200)}.iknow/worktrees/leaf`;
    expect(writeSituation(true, deep)).toBe("writable_tree");
  });

  it("尾随分隔符：形状裁决仍按 isTaskWorktreePath 裁决", () => {
    const trailingTree = `${TREE_ROOT}/`;
    expect(writeSituation(true, trailingTree)).toBe(
      isTaskWorktreePath(trailingTree) ? "writable_tree" : "no_writable_root"
    );
    const trailingMain = `${MAIN_ROOT}/`;
    expect(writeSituation(true, trailingMain)).toBe(
      isTaskWorktreePath(trailingMain) ? "writable_tree" : "no_writable_root"
    );
  });
});

describe("writeSituation — 形状逻辑单一来源", () => {
  // The tree arm must reuse isTaskWorktreePath verbatim: for any input the
  // three-state result is decided solely by it, and this property assertion
  // over representative samples blocks a "second shape logic" from appearing.
  const samples = [
    TREE_ROOT,
    MAIN_ROOT,
    `${TREE_ROOT}/`,
    "",
    "   ",
    "relative/path",
    "/.iknow/worktrees/leaf",
    "/repo/.iknow/worktrees/",
    "/repo/.iknow/worktrees",
    "/repo/other/worktrees/leaf",
    "/repo/.iknow/other/leaf",
  ];

  it("isolation ON 时树形臂与 isTaskWorktreePath 一一对应", () => {
    for (const root of samples) {
      expect(writeSituation(true, root)).toBe(
        isTaskWorktreePath(root) ? "writable_tree" : "no_writable_root"
      );
    }
  });

  it("isolation OFF 且根非空白时一律 writable_main（形状判定不参与）", () => {
    for (const root of samples) {
      if (root.trim() === "") continue;
      expect(writeSituation(false, root)).toBe("writable_main");
    }
  });
});

describe("SC4 依赖方向 — skill/body.ts 不 import isolation/", () => {
  const bodySource = readFileSync(
    fileURLToPath(
      new URL("../../../src/harness/skill/body.ts", import.meta.url)
    ),
    "utf8"
  );

  it("源码中不出现 isolation 模块引用", () => {
    expect(bodySource).not.toMatch(/from\s+["'][^"']*isolation\//);
    expect(bodySource).not.toMatch(/import\(["'][^"']*isolation\//);
  });
});
