/**
 * T3 (plans/write-situation-disclosure.md) — 三态写处境判定（expand，无消费方）。
 *
 * SC1 / 输入五类 A 表（specs/write-situation-disclosure.md）：
 *   - `writeSituation(false, <任意非空根>)` → `writable_main`，**含「隔离 OFF +
 *     树形路径」组合**——negative 臂钉死，防形状判断被单独误用（对齐 ADR-0037 §4
 *     「taskWorktreeOwnerOf 只是路径形状判断，单靠它会拿到沙箱外的读放行」教训）。
 *   - `writeSituation(true, <树形根>)` → `writable_tree`；
 *     `writeSituation(true, <非树形根>)` → `no_writable_root`。
 *   - 空 / 空白根 → typed 结果，不 throw 不静默。
 *   - overflow：极长 / 深嵌套 / 尾随分隔符——形状裁决仍按 `isTaskWorktreePath`，
 *     不自造第二套形状逻辑。
 *   - SC4 依赖方向：`src/harness/skill/body.ts` 不 import `src/harness/isolation/`
 *     （判定住 isolation，渲染住 skill，枚举住 session-roots）。
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
  // 空根没有任何可写对象，writable_main 会是谎话；fail-closed 落
  // no_writable_root（typed 联合内的合法成员），不 throw、不静默放行。
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
  // 树形臂必须逐字复用 isTaskWorktreePath：任何一组输入下三态结果都由它
  // 唯一裁决，这里用代表性样本性质断言堵住「第二份形状逻辑」。
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
