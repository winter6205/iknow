/**
 * tests/tui/subagent-kill.test.ts
 *
 * Pure dispatch function for Ctrl+X: force-kill the focused row; no focus →
 * no-op.
 *
 * Proposition: the taskId in the dispatch result must be **the row the panel's
 * focusedRow points at** — row order shares its source with the live prefix of
 * `projectSubagentLines` (failed / completed rows are only appended after the
 * live ones and never take part in row indexing). Hence the fixtures here
 * deliberately interleave terminal rows to pin the mapping fact
 * "live row order ≠ array order".
 *
 * Also pinned: no focus / graph focus / stale row (row out of range) → `none`;
 * the dispatch layer never fabricates a taskId (so callers cannot
 * accidentally kill a different subagent).
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
    // Array order: [completed, liveA, liveB]; live order: [liveA, liveB].
    // Focus row 0 must mean liveA (same semantics as the panel's liveIndex),
    // not array element 0.
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
    // Panel live rows' name maps 1:1 onto liveSubagents' role (same row order).
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
