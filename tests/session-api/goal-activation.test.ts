/**
 * The one goal-feature activation read.
 *
 * Activation answers exactly one question — "is the goal feature running" —
 * and is defined as a non-empty `goal.text`. It carries the goal because the
 * verify dispatch needs the judge task the moment it learns activation; the
 * alternative is re-evaluating the condition to re-derive `userText`.
 *
 * The rule is stated over the goal and lifted to the session so a consumer
 * holding a bare goal (`/continue`) and a consumer holding a loaded session
 * cannot drift apart. `/continue`'s question stays narrower on purpose: it
 * rejects only a user-pinned goal, so a legacy `user_initial` goal must
 * activate the dispatch sites without tripping `goal_active`.
 */
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import type { AnthropicNativeMessage } from "../../src/harness/index.js";
import {
  goalActivation,
  sessionGoalActivation,
  type GoalActivation,
} from "../../src/session-api/goal/index.js";
import { evaluateContinuePending } from "../../src/session-api/continue-pending.js";
import { pinGoal, type GoalState } from "../../src/session-api/store/index.js";

function pinned(text = "ship the parser"): GoalState {
  return pinGoal({ current: undefined, text, now: "2026-08-25T00:00:00.000Z" });
}

function legacySeed(text = "legacy seed"): GoalState {
  return {
    ...pinned(text),
    source: "user_initial",
  };
}

function userText(text: string): AnthropicNativeMessage {
  return { role: "user", content: [{ type: "text", text }] };
}

function activeGoal(activation: GoalActivation): GoalState {
  assert.equal(activation.active, true);
  if (!activation.active) throw new Error("expected an active goal");
  return activation.goal;
}

describe("goalActivation (rule over the goal itself)", () => {
  it("absent goal → inactive, carries no goal", () => {
    assert.deepEqual(goalActivation(undefined), { active: false });
  });

  it("goal present with empty text → inactive", () => {
    assert.deepEqual(goalActivation(pinned("")), { active: false });
  });

  it("goal present with non-empty text → active and carries that goal", () => {
    const goal = pinned();
    assert.equal(activeGoal(goalActivation(goal)), goal);
  });

  it("the source clause is not part of activation (legacy user_initial activates)", () => {
    const goal = legacySeed();
    assert.equal(activeGoal(goalActivation(goal)), goal);
  });

  it("activation never reads goal.status", () => {
    // An achieved / aborted goal stays "running" for activation: clearing
    // goal.status is what the writeback and the auto loop decide, so reading
    // it here would let activation inherit terminal vocabulary.
    for (const status of ["achieved", "aborted", "superseded"] as const) {
      assert.equal(goalActivation({ ...pinned(), status }).active, true);
    }
    assert.equal(
      goalActivation({ ...pinned(""), status: "achieved" }).active,
      false
    );
  });
});

describe("sessionGoalActivation (same rule lifted to the session)", () => {
  it("session with no goal → inactive", () => {
    assert.deepEqual(sessionGoalActivation({}), { active: false });
  });

  it("session goal with empty text → inactive", () => {
    assert.deepEqual(sessionGoalActivation({ goal: pinned("") }), {
      active: false,
    });
  });

  it("session goal with non-empty text → active and carries the goal", () => {
    const goal = pinned();
    assert.equal(activeGoal(sessionGoalActivation({ goal })), goal);
  });

  it("the lift adds nothing to the rule", () => {
    for (const goal of [undefined, pinned(""), pinned(), legacySeed()]) {
      assert.deepEqual(
        sessionGoalActivation(goal === undefined ? {} : { goal }),
        goalActivation(goal)
      );
    }
  });
});

describe("the narrower /continue question stays layered on activation", () => {
  it("user_pin non-empty goal → goal_active exit", () => {
    const v = evaluateContinuePending({
      messages: [userText("do")],
      goal: pinned(),
    });
    assert.equal(v.ok, false);
    if (!v.ok) assert.equal(v.exit, "goal_active");
  });

  it("user_initial non-empty goal → activation is true but /continue proceeds", () => {
    const goal = legacySeed();
    assert.equal(goalActivation(goal).active, true);
    assert.equal(
      evaluateContinuePending({ messages: [userText("do")], goal }).ok,
      true
    );
  });

  it("empty-text goal activates neither question", () => {
    const goal = pinned("");
    assert.equal(goalActivation(goal).active, false);
    assert.equal(
      evaluateContinuePending({ messages: [userText("do")], goal }).ok,
      true
    );
  });
});
