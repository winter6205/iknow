/**
 * tests/tui/subagent-message-lines.test.tsx
 *
 * Certification of the **retained surface** (cross-module sharing and
 * single-source) of `src/tui/subagent-message-lines.ts`, per
 * specs/tui-subagent-transcript-live.md.
 *
 * This file formerly certified the "live list spread flat" projection and the
 * identity strip above the prompt; that behavior was superseded (the
 * projection became a per-card join keyed by `toolUseId`, the identity strip
 * was removed). The superseded propositions vanished with their subject and
 * are deliberately not rewritten here; the full input-contract matrix for the
 * card-level join lives in `tests/tui/subagent-card-lines.test.ts` (the SSOT
 * projection test for this module).
 *
 * What this file now pins — three things still true and lost if deleted:
 *   1) `isLiveSubagent` remains the shared exported predicate — `SubagentPanel`
 *      (`src/tui/subagent-panel.tsx`) and the Ctrl+X kill dispatch
 *      (`src/tui/subagent-kill.ts`) both import it; predicate drift would
 *      desynchronize "focused row ↔ whom to kill". `resolveIdentityRole` /
 *      `IDENTITY_FALLBACK_ROLE` are the role-resolution surface shared by the
 *      card projection and this file;
 *   2) single source: `IDENTITY_FALLBACK_ROLE` equals `SUBAGENT_ROLE_FALLBACK`
 *      in `src/shared/tool-line.ts` (tool card and two-line projection must
 *      not each print their own role name);
 *   3) composition: line 1 of the card projection = same-source role
 *      resolution + verbatim ` running...` (asserted on the projection's
 *      output, not by re-exporting the module constant — that would be
 *      tautological), and an unjoinable key never borrows another worker's
 *      preview (lock clause 6).
 */
import { describe, expect, test } from "bun:test";
import {
  IDENTITY_FALLBACK_ROLE,
  isLiveSubagent,
  projectSubagentCardLines,
  resolveIdentityRole,
} from "../../src/tui/subagent-message-lines.js";
import { SUBAGENT_ROLE_FALLBACK } from "../../src/shared/tool-line.js";
import { visualWidth } from "../../src/tui/tool-summary.js";
import type { SubagentInfo } from "../../src/harness/subagent/manager.js";

const T0 = Date.parse("2026-09-07T12:00:00.000Z");

function iso(offsetMs: number): string {
  return new Date(T0 + offsetMs).toISOString();
}

let fixtureCounter = 0;
function makeSubagent(overrides: Partial<SubagentInfo> = {}): SubagentInfo {
  fixtureCounter += 1;
  return {
    taskId: `t-msg-${fixtureCounter}`,
    state: "running",
    taskPreview: "查找文档",
    startedAt: iso(-1000),
    toolUseId: `toolu_${fixtureCounter}`,
    ...overrides,
  };
}

// ============================================================================
// 1) Shared surface intact: isLiveSubagent / resolveIdentityRole / RUNNING_SUFFIX
// ============================================================================

describe("isLiveSubagent — 面板 / Ctrl+X 分派共用判据", () => {
  test("starting / running 为 live；completed / failed 不是", () => {
    expect(isLiveSubagent(makeSubagent({ state: "starting" }))).toBe(true);
    expect(isLiveSubagent(makeSubagent({ state: "running" }))).toBe(true);
    expect(isLiveSubagent(makeSubagent({ state: "completed" }))).toBe(false);
    expect(isLiveSubagent(makeSubagent({ state: "failed" }))).toBe(false);
  });
});

describe("resolveIdentityRole — negative 边界（永不输出「子代理」字面值）", () => {
  test("role 缺席 / 空串 / 纯空白 → catalog fallback", () => {
    expect(resolveIdentityRole(makeSubagent({ role: undefined }))).toBe(
      IDENTITY_FALLBACK_ROLE
    );
    expect(resolveIdentityRole(makeSubagent({ role: "" }))).toBe(
      IDENTITY_FALLBACK_ROLE
    );
    expect(resolveIdentityRole(makeSubagent({ role: "   \t  " }))).toBe(
      IDENTITY_FALLBACK_ROLE
    );
  });

  test("role 非空 → trim 后原样（不强制 catalog fallback）", () => {
    expect(resolveIdentityRole(makeSubagent({ role: "explore" }))).toBe(
      "explore"
    );
    expect(
      resolveIdentityRole(makeSubagent({ role: "  general-purpose  " }))
    ).toBe("general-purpose");
  });

  test("钉死约束：任何输入都不返回「子代理」", () => {
    const cases: ReadonlyArray<Partial<SubagentInfo>> = [
      {},
      { role: undefined },
      { role: "" },
      { role: "   " },
    ];
    for (const c of cases) {
      expect(resolveIdentityRole(makeSubagent(c))).not.toBe("子代理");
    }
  });
});

describe("第 1 行后缀 — 锁句的逐字形态（三个点）", () => {
  test("live 第 1 行以逐字 ` running...` 收尾；completed 只作身份不带后缀", () => {
    // Assert the projection's **output bytes**, not the module-internal
    // constant: re-exporting the constant just copies the implementation
    // (tautology); the output side is where the spec's lock clause "three
    // dots" lands. Lock clause 2 reopen: completed drops running from line 1
    // (the role title is identity only).
    for (const state of ["starting", "running"] as const) {
      const info = makeSubagent({ role: "explore", state, toolUseId: "t-sfx" });
      expect(projectSubagentCardLines([info], "t-sfx", 80)!.roleLine).toBe(
        "explore running..."
      );
    }
    const done = makeSubagent({
      role: "explore",
      state: "completed",
      toolUseId: "t-sfx",
    });
    const doneCard = projectSubagentCardLines([done], "t-sfx", 80)!;
    expect(doneCard.roleLine).toBe("explore");
    expect(doneCard.roleLine).not.toContain("running");
  });
});

// ============================================================================
// 2) Single source: fallback equals src/shared/tool-line.ts
// ============================================================================

describe("IDENTITY_FALLBACK_ROLE — 与 shared 侧单源", () => {
  test("与 SUBAGENT_ROLE_FALLBACK 逐字同值（工具卡与两行投影不各印一个角色名）", () => {
    expect(IDENTITY_FALLBACK_ROLE).toBe(SUBAGENT_ROLE_FALLBACK);
    expect(IDENTITY_FALLBACK_ROLE).toBe("general-purpose");
  });
});

// ============================================================================
// 3) Composition: card projection consumes same-source role resolution + verbatim suffix
// ============================================================================

describe("卡级投影的组合面 — role 行与 join 键（锁句 1/2/6）", () => {
  test("第 1 行 = resolveIdentityRole(info) 的投影值 + 逐字后缀", () => {
    for (const info of [
      makeSubagent({ role: "explore", toolUseId: "toolu_c1" }),
      makeSubagent({ role: undefined, toolUseId: "toolu_c2" }),
      makeSubagent({ role: "  ", toolUseId: "toolu_c3" }),
    ]) {
      const card = projectSubagentCardLines([info], info.toolUseId, 80);
      expect(card!.roleLine).toBe(`${resolveIdentityRole(info)} running...`);
    }
  });

  test("缺关联键 → null；不把列表里别的 worker 的预览顶上来（锁句 6）", () => {
    const other = makeSubagent({
      toolUseId: "toolu_other",
      taskPreview: "别的 worker 的预览",
    });
    expect(projectSubagentCardLines([other], undefined, 80)).toBeNull();
    expect(projectSubagentCardLines([other], "  ", 80)).toBeNull();
    expect(projectSubagentCardLines([other], "toolu_nobody", 80)).toBeNull();
  });

  test("completed：概述留下 + doneLine 逐字 `✓ Done`（锁句 2 reopen 的宿主可见形态）", () => {
    const card = projectSubagentCardLines(
      [
        makeSubagent({
          state: "completed",
          role: "explore",
          toolUseId: "toolu_d",
        }),
      ],
      "toolu_d",
      80
    );
    expect(card!.roleLine).toBe("explore");
    expect(card!.detailLine).toBe("查找文档");
    expect(card!.doneLine).toBe("✓ Done");
    expect(card!.done).toBe(true);
  });

  test("overflow：两行各自按 cols 视觉宽度收口（永不换行）", () => {
    const card = projectSubagentCardLines(
      [
        makeSubagent({
          role: "a".repeat(100),
          taskPreview: "查找文档并且继续往下列出更多内容",
          toolUseId: "toolu_narrow",
        }),
      ],
      "toolu_narrow",
      12
    );
    expect(visualWidth(card!.roleLine)).toBeLessThanOrEqual(12);
    expect(visualWidth(card!.detailLine)).toBeLessThanOrEqual(12);
    expect(card!.roleLine.includes("\n")).toBe(false);
    expect(card!.detailLine.includes("\n")).toBe(false);
  });
});
