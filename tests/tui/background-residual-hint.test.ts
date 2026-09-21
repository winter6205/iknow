/**
 * tests/tui/background-residual-hint.test.ts — pure-layer unit for the
 * #1081 background residual hint:
 *   - countLiveBackgroundSubagents: live (starting/running) AND
 *     foreground !== true AND conversationId === the active session. A
 *     foreground (wait:true) worker is already truthfully represented by the
 *     parent's running-fg chrome; counting it here would paint the worker as
 *     parent "running". Terminal states never count (the line must disappear
 *     when no live background remains). Rows without a conversationId
 *     (judge / graph-node / direct-manager population, manager.ts projection)
 *     belong to no session and never count anywhere.
 *   - formatBackgroundRunningHint: dim English count line text; singular vs
 *     plural; 0 (and absent) → undefined so the tail renders no line. The
 *     only producer is countLiveBackgroundSubagents, so negatives are not a
 *     representable input. Never the Chinese "running" label (CONTEXT.md
 *     "background residual hint" entry, _Avoid_ list).
 */
import { describe, expect, test } from "bun:test";
import type { SubagentInfo } from "../../src/harness/subagent/manager.js";
import {
  countLiveBackgroundSubagents,
  formatBackgroundRunningHint,
} from "../../src/tui/subagent-message-lines.js";

function info(over: Partial<SubagentInfo> & { taskId: string }): SubagentInfo {
  return {
    state: "running",
    taskPreview: "p",
    startedAt: "2026-09-19T00:00:00.000Z",
    conversationId: "s1",
    ...over,
  };
}

describe("countLiveBackgroundSubagents", () => {
  test("empty list → 0 (never-spawned session renders no line)", () => {
    expect(countLiveBackgroundSubagents([], "s1")).toBe(0);
  });

  test("live background (starting + running, foreground absent) counts", () => {
    expect(
      countLiveBackgroundSubagents(
        [
          info({ taskId: "a", state: "running" }),
          info({ taskId: "b", state: "starting" }),
        ],
        "s1"
      )
    ).toBe(2);
  });

  test("foreground===true live workers are excluded (parent chrome truth)", () => {
    expect(
      countLiveBackgroundSubagents(
        [info({ taskId: "fg", foreground: true }), info({ taskId: "bg" })],
        "s1"
      )
    ).toBe(1);
  });

  test("terminal states never count (all-terminal → 0, line disappears)", () => {
    expect(
      countLiveBackgroundSubagents(
        [
          info({ taskId: "done", state: "completed" }),
          info({ taskId: "bad", state: "failed" }),
        ],
        "s1"
      )
    ).toBe(0);
  });

  test("foreground flag absent ≠ true: unknown provenance counts as background", () => {
    // Postel contract on SubagentInfo.foreground: only true is present.
    expect(
      countLiveBackgroundSubagents(
        [info({ taskId: "x", foreground: undefined })],
        "s1"
      )
    ).toBe(1);
  });

  test("another session's live background rows are excluded (per-session hint)", () => {
    expect(
      countLiveBackgroundSubagents(
        [
          info({ taskId: "own" }),
          info({ taskId: "other", conversationId: "s2" }),
        ],
        "s1"
      )
    ).toBe(1);
  });

  test("rows without conversationId never count in any session", () => {
    // judge / graph-node / direct-manager rows belong to no session ledger
    // (same skip as the manager's own scoped listSubagents).
    expect(
      countLiveBackgroundSubagents(
        [info({ taskId: "sessionless", conversationId: undefined })],
        "s1"
      )
    ).toBe(0);
    expect(
      countLiveBackgroundSubagents(
        [info({ taskId: "sessionless", conversationId: undefined })],
        undefined
      )
    ).toBe(0);
  });

  test("active session without conversationId → 0 (draft session)", () => {
    expect(
      countLiveBackgroundSubagents([info({ taskId: "a" })], undefined)
    ).toBe(0);
  });
});

describe("formatBackgroundRunningHint", () => {
  test("0 → undefined (no line)", () => {
    expect(formatBackgroundRunningHint(0)).toBeUndefined();
  });

  test("undefined → undefined (absent prop renders no line)", () => {
    expect(formatBackgroundRunningHint(undefined)).toBeUndefined();
  });

  test("1 → singular English line", () => {
    expect(formatBackgroundRunningHint(1)).toBe(
      "1 background subagent running"
    );
  });

  test("2 → plural English line", () => {
    expect(formatBackgroundRunningHint(2)).toBe(
      "2 background subagents running"
    );
  });

  test("never renders Chinese 运行中", () => {
    expect(formatBackgroundRunningHint(3)).not.toContain("运行中");
  });
});
