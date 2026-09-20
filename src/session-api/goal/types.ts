/**
 * Status-machine edge types for the session-goal lifecycle.
 *
 * Carries only `VALID_GOAL_TRANSITIONS` and `TransitionInput`; the
 * former model-propose / confirm channel types were dropped outright
 * and never merged.
 */
import type { GoalStatus } from "../store/schema.js";

/** Transition input: current → next. Consumed by assertValidTransition. */
export interface TransitionInput {
  readonly from: GoalStatus;
  readonly to: GoalStatus;
}

/**
 * Legal transition table (single source with assertValidTransition).
 * GoalStatus stays active | achieved | aborted | superseded — union
 * unextended, no schema v5 bump. Same-status "no-op transitions" are
 * invalid (self-transitions rejected explicitly by
 * assertValidTransition).
 */
export const VALID_GOAL_TRANSITIONS: ReadonlyArray<
  readonly [GoalStatus, GoalStatus]
> = [
  ["active", "achieved"],
  ["active", "aborted"],
  ["active", "superseded"],
  ["achieved", "superseded"],
  ["aborted", "superseded"],
] as const;
