/**
 * tests/tui/subagent-message-lines.test.tsx
 *
 * specs/tui-subagent-transcript-live.md —— `src/tui/subagent-message-lines.ts`
 * 的**保留面**（跨模块共享与单源）认证。
 *
 * 本文件原认证「live 列表整体铺开」投影与 prompt 上方身份条的渲染；该行为已
 * 被取代（投影改为按 `toolUseId` 卡级 join，身份条拆除）。被取代的命题连主体
 * 一起消失，故不在此重写；卡级 join 的完整 input-contract 矩阵在
 * `tests/tui/subagent-card-lines.test.ts`（该模块的投影 SSOT 测）。
 *
 * 本文件现在钉三件仍然为真、且删除后会失守的事：
 *   1) `isLiveSubagent` 仍是对外导出的共享判据 —— `SubagentPanel`
 *      （`src/tui/subagent-panel.tsx`）与 Ctrl+X 强杀分派
 *      （`src/tui/subagent-kill.ts`）都 import 它，判据漂移会让
 *      「聚焦行 ↔ 杀谁」错位；`resolveIdentityRole` /
 *      `IDENTITY_FALLBACK_ROLE` 是卡级投影与本文件共用的 role 解析面；
 *   2) 单源：`IDENTITY_FALLBACK_ROLE` 与 `src/shared/tool-line.ts` 的
 *      `SUBAGENT_ROLE_FALLBACK` 同值（工具卡与两行投影不得各印一个角色名）；
 *   3) 组合：卡级投影的第 1 行 = 同源 role 解析 + 逐字 ` running...`（后缀在
 *      投影输出侧断言，不从模块重新导出比对 —— 那是同义反复），且 join 不上
 *      的键不借用别的 worker 的预览（锁句 6）。
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
// 1) 共享面仍在：isLiveSubagent / resolveIdentityRole / RUNNING_SUFFIX
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
  test("投影产出的第 1 行以逐字 ` running...` 收尾（live 与 completed 共用）", () => {
    // 断言投影的**输出字节**而非模块内的常量：常量重新导出只是把
    // 实现照抄一遍（同义反复），输出侧才是 spec 锁句「三个点」的落点。
    for (const state of ["starting", "running", "completed"] as const) {
      const info = makeSubagent({ role: "explore", state, toolUseId: "t-sfx" });
      expect(projectSubagentCardLines([info], "t-sfx", 80)!.roleLine).toBe(
        "explore running..."
      );
    }
  });
});

// ============================================================================
// 2) 单源：fallback 与 src/shared/tool-line.ts 同值
// ============================================================================

describe("IDENTITY_FALLBACK_ROLE — 与 shared 侧单源", () => {
  test("与 SUBAGENT_ROLE_FALLBACK 逐字同值（工具卡与两行投影不各印一个角色名）", () => {
    expect(IDENTITY_FALLBACK_ROLE).toBe(SUBAGENT_ROLE_FALLBACK);
    expect(IDENTITY_FALLBACK_ROLE).toBe("general-purpose");
  });
});

// ============================================================================
// 3) 组合：卡级投影消费同源 role 解析 + 逐字后缀
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

  test("completed：第 1 行不动、第 2 行逐字 `done`（锁句 2 的宿主可见形态）", () => {
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
    expect(card!.roleLine).toBe("explore running...");
    expect(card!.detailLine).toBe("done");
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
