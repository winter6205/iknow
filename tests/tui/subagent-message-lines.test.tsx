/**
 * tests/tui/subagent-message-lines.test.tsx
 *
 * Certification of the **retained surface** (cross-module sharing and
 * single-source) of `src/tui/subagent-message-lines.ts`, per
 * specs/subagent-card-title.md.
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
 *   3) composition: line 1 of a no-title card = same-source role resolution
 *      verbatim — spec SC1 retired the old ` running...` suffix, so the
 *      output bytes must contain no such suffix in any state (asserted on the
 *      projection's output, not by re-exporting module constants), and an
 *      unjoinable key never borrows another worker's title or activity.
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
// 1) Shared surface intact: isLiveSubagent / resolveIdentityRole
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

describe("第 1 行无状态后缀（逐字形态钉在输出上）", () => {
  test("live / completed 第 1 行逐字相同、均不含 running", () => {
    // Assert the projection's **output bytes**, not module-internal constants:
    // line 1 is a stable title that never changes across the worker's
    // lifetime, so a suffix re-introduced on either side shows up here.
    const live = makeSubagent({
      role: "explore",
      state: "running",
      toolUseId: "t-sfx",
    });
    const done = makeSubagent({
      role: "explore",
      state: "completed",
      toolUseId: "t-sfx",
    });
    const liveCard = projectSubagentCardLines([live], "t-sfx", 80)!;
    const doneCard = projectSubagentCardLines([done], "t-sfx", 80)!;
    expect(liveCard.titleLine).toBe("explore");
    expect(doneCard.titleLine).toBe("explore");
    expect(liveCard.titleLine.includes("running")).toBe(false);
    expect(doneCard.titleLine.includes("running")).toBe(false);
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
// 3) Composition: card projection consumes same-source role resolution verbatim
// ============================================================================

describe("卡级投影的组合面 — 无 title 时第 1 行与 join 键（SC1 / join 契约）", () => {
  test("无 title 的第 1 行 = resolveIdentityRole(info) 逐字投影（不另加后缀）", () => {
    for (const info of [
      makeSubagent({ role: "explore", toolUseId: "toolu_c1" }),
      makeSubagent({ role: undefined, toolUseId: "toolu_c2" }),
      makeSubagent({ role: "  ", toolUseId: "toolu_c3" }),
    ]) {
      const card = projectSubagentCardLines([info], info.toolUseId, 80);
      expect(card!.titleLine).toBe(resolveIdentityRole(info));
    }
  });

  test("缺关联键 → null；不把列表里别的 worker 的 title / 活动名顶上来", () => {
    const other = makeSubagent({
      toolUseId: "toolu_other",
      role: "explore",
      activity: { toolName: "Bash", toolInput: {} },
    });
    expect(projectSubagentCardLines([other], undefined, 80)).toBeNull();
    expect(projectSubagentCardLines([other], "  ", 80)).toBeNull();
    expect(projectSubagentCardLines([other], "toolu_nobody", 80)).toBeNull();
  });

  test("completed：第 2 行逐字 `✓ Done`，taskPreview 不上卡（SC7 的宿主可见形态）", () => {
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
    expect(card!.titleLine).toBe("explore");
    expect(card!.detailLine).toBe("✓ Done");
    expect(card!.detailLine.includes("查找文档")).toBe(false);
    expect(card!.done).toBe(true);
  });

  test("overflow：两行各自按 cols 视觉宽度收口（永不换行）", () => {
    const card = projectSubagentCardLines(
      [
        makeSubagent({
          role: "a".repeat(100),
          toolUseId: "toolu_narrow",
          activity: { toolName: "b".repeat(100), toolInput: {} },
        }),
      ],
      "toolu_narrow",
      12
    );
    expect(visualWidth(card!.titleLine)).toBeLessThanOrEqual(12);
    expect(visualWidth(card!.detailLine)).toBeLessThanOrEqual(12);
    expect(card!.titleLine.includes("\n")).toBe(false);
    expect(card!.detailLine.includes("\n")).toBe(false);
  });
});
