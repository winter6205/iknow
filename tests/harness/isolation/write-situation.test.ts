/**
 * Three-state write-situation decision.
 *
 * Pinned contract:
 *   - `writeSituation(false, <any non-empty root>)` -> `writable_main`,
 *     **including the "isolation OFF + tree-shaped path" combination** — the
 *     negative arm is pinned so the boundness check can never be misused on its
 *     own (the ADR-0037 lesson: a path-shape test alone would let reads / writes
 *     escape the sandbox).
 *   - `writeSituation(true, <bound root>)` -> `writable_tree`;
 *     `writeSituation(true, <non-bound root>)` -> `no_writable_root`. Boundness
 *     is the injected predicate, defaulting to `isBoundWorktreeRoot` (issue
 *     1231: task-shaped OR an explicitly-entered external linked worktree).
 *     The module does no disk I/O itself — the DEFAULT predicate reads the
 *     target root's gitdir entered-stamp; inject a stub for a pure decision.
 *   - Empty / whitespace root -> typed result; never throws, never silent.
 *   - Overflow: very long / deep nesting / trailing separators — the boundness
 *     decision still delegates to the injected predicate, no second logic.
 *   - Dependency direction: `src/harness/skill/body.ts` must not import
 *     `src/harness/isolation/` (the decision lives in isolation, rendering in
 *     skill, the enum in session-roots).
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

import { writeSituation } from "../../../src/harness/isolation/write-situation.ts";
import {
  enteredStampOf,
  isBoundWorktreeRoot,
  isTaskWorktreePath,
  markWorktreeEntered,
} from "../../../src/harness/isolation/worktree-gate.ts";

// -- fixtures -----------------------------------------------------------------

const TREE_ROOT = "/repo/.iknow/worktrees/conv1234";
const MAIN_ROOT = "/home/user/project";

let roots: string[] = [];

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8" });

/**
 * A real git repo plus a LINKED worktree created OUTSIDE `.iknow/worktrees/`
 * — the external shape (issue 1231): `.git` is a file, `isTaskWorktreePath`
 * is false. This is the root class whose boundness the entered stamp decides.
 */
function makeExternalWorktree(): string {
  const repo = mkdtempSync(join(tmpdir(), "iknow-ws-repo-"));
  const parent = mkdtempSync(join(tmpdir(), "iknow-ws-parent-"));
  roots.push(repo, parent);
  git(repo, "init", "-q");
  git(
    repo,
    "-c",
    "user.email=t@t",
    "-c",
    "user.name=t",
    "commit",
    "--allow-empty",
    "-qm",
    "init"
  );
  const external = join(parent, "manual-checkout");
  git(repo, "worktree", "add", "-q", "-b", "manual", external);
  return external;
}

afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
  roots = [];
});

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

describe("writeSituation — entered external linked worktree (issue 1231)", () => {
  it("never-entered external linked worktree → no_writable_root（fail-closed，堵 cd 洞）", () => {
    const external = makeExternalWorktree();
    expect(isTaskWorktreePath(external)).toBe(false); // external, non-task shape
    expect(enteredStampOf(external)).toBeUndefined(); // never entered
    // A session cd'd into a random registered worktree must stay read-only.
    expect(writeSituation(true, external)).toBe("no_writable_root");
  });

  it("entered external linked worktree → writable_tree", () => {
    const external = makeExternalWorktree();
    markWorktreeEntered(external, "conv-entered");
    expect(enteredStampOf(external)).toBe("conv-entered");
    expect(writeSituation(true, external)).toBe("writable_tree");
  });

  it("isolation OFF 忽略 boundness — entered external root 仍 writable_main", () => {
    const external = makeExternalWorktree();
    markWorktreeEntered(external, "conv-entered");
    expect(writeSituation(false, external)).toBe("writable_main");
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

  it("尾随分隔符：形状裁决仍按 isBoundWorktreeRoot 裁决", () => {
    const trailingTree = `${TREE_ROOT}/`;
    expect(writeSituation(true, trailingTree)).toBe(
      isBoundWorktreeRoot(trailingTree) ? "writable_tree" : "no_writable_root"
    );
    const trailingMain = `${MAIN_ROOT}/`;
    expect(writeSituation(true, trailingMain)).toBe(
      isBoundWorktreeRoot(trailingMain) ? "writable_tree" : "no_writable_root"
    );
  });
});

describe("writeSituation — boundness 逻辑单一来源", () => {
  // The tree arm must reuse `isBoundWorktreeRoot` verbatim: for any input the
  // three-state result is decided solely by it, and this property assertion
  // over representative samples blocks a "second boundness logic" from
  // appearing. (For these on-disk-absent samples the stamp arm of
  // `isBoundWorktreeRoot` is undefined, so it reduces to the path shape.)
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

  it("isolation ON 时 boundness 臂与 isBoundWorktreeRoot 一一对应", () => {
    for (const root of samples) {
      expect(writeSituation(true, root)).toBe(
        isBoundWorktreeRoot(root) ? "writable_tree" : "no_writable_root"
      );
    }
  });

  it("isolation OFF 且根非空白时一律 writable_main（boundness 判定不参与）", () => {
    for (const root of samples) {
      if (root.trim() === "") continue;
      expect(writeSituation(false, root)).toBe("writable_main");
    }
  });

  it("boundness 臂完全委托给注入的 predicate（无第二份逻辑）", () => {
    // A non-bound shape reports writable_tree only because the injected
    // predicate says so; a bound shape refuses because the injected predicate
    // says so. Delegation, not an internal shape/stamp re-check.
    expect(writeSituation(true, MAIN_ROOT, () => true)).toBe("writable_tree");
    expect(writeSituation(true, TREE_ROOT, () => false)).toBe(
      "no_writable_root"
    );
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
