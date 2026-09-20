/**
 * Goal status transition pure functions.
 *
 * Design principles:
 * - Pure functions, no IO leakage (hub is the only writer; this module
 *   builds values, persistence is hub calling store.save)
 * - Everything Result-typed, fail-closed explicit
 * - Never infer from messages (avoids injection pollution)
 * - Do not extend the GoalStatus union (no schema v5→v6 bump)
 *
 * Two core functions:
 * - assertValidTransition: transition legality assertion (valid edges
 *   like active→achieved; achieved→active / self-transitions rejected)
 * - applyTransition: sets goal.status to a value already validated by
 *   assertValidTransition. Pure, no IO; updatedAt passed by caller.
 *
 * No model-propose / confirm channel: goal is a pure user-pinned
 * anchor, so hub never uses a two-phase propose/confirm path.
 */
import type { GoalState, GoalStatus } from "../store/schema.js";
import { err, goalError, ok, type GoalError, type Result } from "./errors.js";
import { VALID_GOAL_TRANSITIONS, type TransitionInput } from "./types.js";

export { err, goalError, ok };
export type { GoalError, Result };
export type { TransitionInput } from "./types.js";
export { VALID_GOAL_TRANSITIONS };

/**
 * Status transition legality assertion.
 *
 * VALID_GOAL_TRANSITIONS restricts edges to those among the current
 * four GoalStatus values (union unextended, no schema bump). A "no-op
 * transition" with the same status is invalid — explicit intent is
 * required; the verify-writeback failed/unstable path goes through
 * recordGoal instead of applyTransition, since active→active is not
 * whitelisted.
 */
export function assertValidTransition(
  input: TransitionInput
): Result<true, GoalError> {
  if (input.from === input.to) {
    return err(
      goalError(
        "invalid_transition",
        "self-transition not allowed; pick a different target status",
        { from: input.from, to: input.to }
      )
    );
  }
  const isValid = VALID_GOAL_TRANSITIONS.some(
    ([from, to]) => from === input.from && to === input.to
  );
  if (!isValid) {
    return err(
      goalError(
        "invalid_transition",
        "transition rejected by VALID_GOAL_TRANSITIONS table",
        { from: input.from, to: input.to }
      )
    );
  }
  return ok(true);
}

/**
 * Set goal.status to a new value (must have passed
 * assertValidTransition). Pure function, no IO; updatedAt comes from
 * the caller. Other fields (text/source/createdAt/history) unchanged.
 */
export function applyTransition(
  goal: GoalState,
  nextStatus: GoalStatus,
  now: string
): GoalState {
  return {
    ...goal,
    status: nextStatus,
    updatedAt: now,
  };
}
