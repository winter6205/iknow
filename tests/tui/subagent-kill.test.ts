/**
 * tests/tui/subagent-kill.test.ts
 *
 * spec Slice D / SC14（聚焦行 Ctrl+X 强杀）+ SC15 empty（无聚焦 → 空操作）
 * / plan task 8：Ctrl+X 分派纯函数。
 *
 * 命题：分派结果里的 taskId 必须是**面板 focusedRow 所指的那一行** ——
 * 行序与 `projectSubagentLines` 的 live 前缀同源（failed / completed 只
 * 追加在 live 之后，不参与行下标）。所以本文件的 fixture 故意把终态行
 * 穿插进数组，钉死「live 行序 ≠ 数组序」这一映射事实。
 *
 * 同时钉死 SC15：无聚焦 / graph 聚焦 / 陈旧行（row 越界）→ `none`，
 * 分派层绝不伪造 taskId（调用方因此不会误杀别的子代理）。
 */
import { describe, expect, test } from "bun:test";
import {
  dispatchKillFocusedSubagent,
  liveSubagents,
} from "../../src/tui/subagent-kill.js";
import { projectSubagentLines } from "../../src/tui/subagent-panel.js";
import type { ChromeFocus } from "../../src/tui/chrome-focus.js";
import type { SubagentInfo } from "../../src/harness/subagent/manager.js";

const T0 = Date.parse("2026-09-07T12:00:00.000Z");

function iso(offsetMs: number): string {
  return new Date(T0 + offsetMs).toISOString();
}

let fixtureCounter = 0;
function makeSubagent(overrides: Partial<SubagentInfo>): SubagentInfo {
  fixtureCounter += 1;
  return {
    taskId: `t-kill-${fixtureCounter}`,
    state: "running",
    taskPreview: "查找文档",
    startedAt: iso(-1000),
    ...overrides,
  };
}

const LIVE_A = makeSubagent({ taskId: "task-a", role: "explore" });
const LIVE_B = makeSubagent({ taskId: "task-b", role: "general-purpose" });
const DONE = makeSubagent({
  taskId: "task-done",
  state: "completed",
  endedAt: iso(-1000),
});

describe("dispatchKillFocusedSubagent — 聚焦行 → 正确 taskId", () => {
  test("focus=subagent(0) → live 第 0 行 taskId（数组序与 live 序一致的基线）", () => {
    const focus: ChromeFocus = { kind: "subagent", row: 0 };
    expect(dispatchKillFocusedSubagent(focus, [LIVE_A, LIVE_B])).toEqual({
      kind: "kill",
      taskId: "task-a",
      role: "explore",
    });
  });

  test("focus=subagent(1) → live 第 1 行 taskId", () => {
    const focus: ChromeFocus = { kind: "subagent", row: 1 };
    expect(
      dispatchKillFocusedSubagent(focus, [LIVE_A, LIVE_B]).kind === "kill"
        ? dispatchKillFocusedSubagent(focus, [LIVE_A, LIVE_B])
        : undefined
    ).toEqual({ kind: "kill", taskId: "task-b", role: "general-purpose" });
  });

  test("终态行穿插 → 行序仍按 live 前缀（数组下标不复用）", () => {
    // 数组序：[completed, liveA, liveB]；live 序：[liveA, liveB]。
    // focus row 0 必须指 liveA（面板 liveIndex 同款语义），不是数组第 0 项。
    const focus: ChromeFocus = { kind: "subagent", row: 0 };
    const dispatch = dispatchKillFocusedSubagent(focus, [DONE, LIVE_A, LIVE_B]);
    expect(dispatch).toEqual({
      kind: "kill",
      taskId: "task-a",
      role: "explore",
    });
  });

  test("与面板 focusedRow 同源：projectSubagentLines 的 live 前缀 = liveSubagents", () => {
    const subagents = [DONE, LIVE_A, LIVE_B];
    const panelLive = projectSubagentLines(subagents, T0, 80).slice(
      0,
      liveSubagents(subagents).length
    );
    // 面板 live 行的 name 与 liveSubagents 的 role 一一对应（同一行序）。
    expect(panelLive).toHaveLength(2);
    expect(panelLive[0]?.text).toContain("explore");
    expect(panelLive[1]?.text).toContain("general-purpose");
    expect(liveSubagents(subagents).map((s) => s.taskId)).toEqual([
      "task-a",
      "task-b",
    ]);
  });

  test("role 缺席 → 分派结果不带 role 字段（不伪造角色名）", () => {
    const noRole = makeSubagent({ taskId: "task-x", role: undefined });
    expect(
      dispatchKillFocusedSubagent({ kind: "subagent", row: 0 }, [noRole])
    ).toEqual({ kind: "kill", taskId: "task-x" });
  });
});

describe("dispatchKillFocusedSubagent — SC15 empty / 陈旧行 → 空操作", () => {
  test("focus=input → none（无聚焦不杀）", () => {
    expect(
      dispatchKillFocusedSubagent({ kind: "input" }, [LIVE_A, LIVE_B])
    ).toEqual({ kind: "none" });
  });

  test("focus=graph → none（graph 环没有子代理行）", () => {
    expect(
      dispatchKillFocusedSubagent({ kind: "graph" }, [LIVE_A, LIVE_B])
    ).toEqual({ kind: "none" });
  });

  test("无 live 子代理 → none（数组空 / 仅终态）", () => {
    expect(
      dispatchKillFocusedSubagent({ kind: "subagent", row: 0 }, [])
    ).toEqual({ kind: "none" });
    expect(
      dispatchKillFocusedSubagent({ kind: "subagent", row: 0 }, [DONE])
    ).toEqual({ kind: "none" });
  });

  test("陈旧行：row ≥ live 数 → none，不越界取到队友", () => {
    expect(
      dispatchKillFocusedSubagent({ kind: "subagent", row: 2 }, [
        LIVE_A,
        LIVE_B,
      ])
    ).toEqual({ kind: "none" });
    expect(
      dispatchKillFocusedSubagent({ kind: "subagent", row: 99 }, [LIVE_A])
    ).toEqual({ kind: "none" });
  });

  test("非法 row（负数 / NaN / 小数）→ none，不抛错", () => {
    for (const row of [-1, Number.NaN, 0.5, Number.POSITIVE_INFINITY]) {
      expect(
        dispatchKillFocusedSubagent({ kind: "subagent", row }, [LIVE_A])
      ).toEqual({ kind: "none" });
    }
  });

  test("子代理刚终态（live 缩到 0）→ 同一 focus 由 kill 退化为 none", () => {
    const focus: ChromeFocus = { kind: "subagent", row: 0 };
    expect(dispatchKillFocusedSubagent(focus, [LIVE_A]).kind).toBe("kill");
    expect(dispatchKillFocusedSubagent(focus, [DONE]).kind).toBe("none");
  });
});
