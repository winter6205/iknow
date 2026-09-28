/**
 * Plan T3 / issue 574: shared auto-goal stop rules + `/goal --max-turns` parse.
 * Hosts (slash, hub, chat) must share these fields and decisions.
 */
import { describe, expect, it } from "vitest";
import {
  decideAutoGoalAfterTurn,
  IDLE_COMPLETED_STOP,
  nextGoalAfterDecision,
  parseGoalPinInput,
} from "../../src/session-api/goal-auto.ts";
import { pinGoal, type GoalState } from "../../src/session-api/store/index.ts";

function baseGoal(): GoalState {
  return pinGoal({
    current: undefined,
    text: "ship the parser",
    now: "2026-08-20T00:00:00.000Z",
  });
}

describe("parseGoalPinInput", () => {
  it("plain text → pin text, no maxTurns (omit = no hard cap)", () => {
    expect(parseGoalPinInput("ship the parser")).toEqual({
      ok: true,
      text: "ship the parser",
    });
  });

  it("prefix --max-turns 1 → maxTurns 1 and remaining text", () => {
    expect(parseGoalPinInput("--max-turns 1 ship the parser")).toEqual({
      ok: true,
      text: "ship the parser",
      maxTurns: 1,
    });
  });

  it("negative: --max-turns 0 rejected", () => {
    const r = parseGoalPinInput("--max-turns 0 ship");
    expect(r.ok).toBe(false);
  });

  it("empty: --max-turns without value rejected", () => {
    const r = parseGoalPinInput("--max-turns");
    expect(r.ok).toBe(false);
  });

  it("overflow: --max-turns 1 with no goal text rejected", () => {
    const r = parseGoalPinInput("--max-turns 1");
    expect(r.ok).toBe(false);
  });
});

describe("decideAutoGoalAfterTurn", () => {
  it("judge not done (failed) + completed with tools → continueAuto", () => {
    const d = decideAutoGoalAfterTurn({
      autoTurnsRan: 0,
      idleCompletedStreak: 0,
      stopReason: "completed",
      roundHadToolUse: true,
      verifyOutcome: "failed",
    });
    expect(d.continueAuto).toBe(true);
    expect(d.clearGoal).toBe(false);
    expect(d.autoTurnsRan).toBe(1);
    expect(d.idleCompletedStreak).toBe(0);
  });

  // not_run joins VerifyLoopOutcome; earlyStopDecision is a plain if-chain
  // with no type-total exhaustiveness, so this arm is pinned by direct
  // assertion (spec verify-status-contract SC5 / Q-B). The shape below
  // (completed + no tool_use + streak 2) would otherwise fall through to
  // the streak computation and stop at 3 — the explicit arm must pass the
  // streak through UNCHANGED and keep the loop going.
  it("not_run → continue auto loop, no clear, idle streak unchanged (not reset)", () => {
    const d = decideAutoGoalAfterTurn({
      autoTurnsRan: 1,
      idleCompletedStreak: 2,
      stopReason: "completed",
      roundHadToolUse: false,
      verifyOutcome: "not_run",
    });
    expect(d.continueAuto).toBe(true);
    expect(d.clearGoal).toBe(false);
    expect(d.idleCompletedStreak).toBe(2);
    expect(d.autoTurnsRan).toBe(2);
  });

  it("Impossible judge reason → clearGoal, stop", () => {
    const d = decideAutoGoalAfterTurn({
      autoTurnsRan: 0,
      idleCompletedStreak: 0,
      stopReason: "completed",
      roundHadToolUse: true,
      verifyOutcome: "failed",
      judgeReason: "Impossible: the API does not exist",
    });
    expect(d.continueAuto).toBe(false);
    expect(d.clearGoal).toBe(true);
  });

  it("3 consecutive completed without tool_use → stop, keep goal", () => {
    let idle = 0;
    let ran = 0;
    let last = decideAutoGoalAfterTurn({
      autoTurnsRan: ran,
      idleCompletedStreak: idle,
      stopReason: "completed",
      roundHadToolUse: false,
      verifyOutcome: "failed",
    });
    for (let i = 1; i < IDLE_COMPLETED_STOP; i++) {
      ran = last.autoTurnsRan;
      idle = last.idleCompletedStreak;
      last = decideAutoGoalAfterTurn({
        autoTurnsRan: ran,
        idleCompletedStreak: idle,
        stopReason: "completed",
        roundHadToolUse: false,
        verifyOutcome: "failed",
      });
    }
    expect(last.continueAuto).toBe(false);
    expect(last.clearGoal).toBe(false);
    expect(last.idleCompletedStreak).toBe(IDLE_COMPLETED_STOP);
  });

  it("--max-turns 1: first turn stops even if judge not done", () => {
    const d = decideAutoGoalAfterTurn({
      maxTurns: 1,
      autoTurnsRan: 0,
      idleCompletedStreak: 0,
      stopReason: "completed",
      roundHadToolUse: true,
      verifyOutcome: "failed",
    });
    expect(d.continueAuto).toBe(false);
    expect(d.clearGoal).toBe(false);
    expect(d.autoTurnsRan).toBe(1);
  });

  it("unrecoverable auth fail → clearGoal", () => {
    const d = decideAutoGoalAfterTurn({
      autoTurnsRan: 0,
      idleCompletedStreak: 0,
      stopReason: "protocolError",
      roundHadToolUse: false,
      errorText: "authentication failed: invalid api key",
      errorName: "Error",
    });
    expect(d.clearGoal).toBe(true);
    expect(d.continueAuto).toBe(false);
  });

  it("transient rate limit → do not clear goal", () => {
    const d = decideAutoGoalAfterTurn({
      autoTurnsRan: 0,
      idleCompletedStreak: 0,
      stopReason: "protocolError",
      roundHadToolUse: false,
      errorText: "rate limit exceeded (429)",
      errorName: "Error",
    });
    expect(d.clearGoal).toBe(false);
    expect(d.continueAuto).toBe(false);
  });
});

describe("nextGoalAfterDecision", () => {
  it("clearGoal drops the goal object", () => {
    const goal = baseGoal();
    const next = nextGoalAfterDecision(goal, {
      continueAuto: false,
      clearGoal: true,
      autoTurnsRan: 1,
      idleCompletedStreak: 0,
    });
    expect(next).toBeUndefined();
  });

  it("idle stop keeps text and writes streak", () => {
    const goal = baseGoal();
    const next = nextGoalAfterDecision(goal, {
      continueAuto: false,
      clearGoal: false,
      autoTurnsRan: 3,
      idleCompletedStreak: 3,
    });
    expect(next?.text).toBe("ship the parser");
    expect(next?.idleCompletedStreak).toBe(3);
    expect(next?.autoTurnsRan).toBe(3);
  });
});
