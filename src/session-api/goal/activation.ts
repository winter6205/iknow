/**
 * Goal-feature activation: the one read of "is the goal feature running".
 *
 * Design principles (same pins as the folder):
 * - Pure functions, no IO leakage (the caller owns the store load)
 * - Never infer from messages
 *
 * Activation is a non-empty `goal.text` and nothing else. It deliberately
 * does not read `goal.source` or `goal.status`: the two verify dispatch sites
 * fire for a legacy `source: "user_initial"` goal, and status is written back
 * by the verify loop — reading it here would let activation inherit the core
 * loop's terminal vocabulary. A consumer that asks a narrower question layers
 * its own clause on top (see `/continue`), so the non-empty-text rule itself
 * stays single-sourced.
 *
 * The result carries the goal because a consumer that learned "active" needs
 * `goal.text` next, as the judge task; re-evaluating the condition to re-derive
 * it is how two sites can silently disagree about what "active" means.
 */
import type { GoalState, SessionFileV1 } from "../store/schema.js";

/** Activation verdict: active carries the goal that made it active. */
export type GoalActivation =
  | { readonly active: true; readonly goal: GoalState }
  | { readonly active: false };

/**
 * The rule, stated over the goal itself. Stated here rather than over a
 * session because consumers differ in what they hold: the dispatch sites and
 * the auto loop have a loaded session, `/continue` receives a bare goal.
 */
export function goalActivation(goal: GoalState | undefined): GoalActivation {
  if (goal === undefined || goal.text.length === 0) {
    return { active: false };
  }
  return { active: true, goal };
}

/** The same rule lifted to a loaded session; reads only `session.goal`. */
export function sessionGoalActivation(
  session: Pick<SessionFileV1, "goal">
): GoalActivation {
  return goalActivation(session.goal);
}
