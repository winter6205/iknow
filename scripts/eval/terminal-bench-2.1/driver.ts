/**
 * The ordered driver loop: preflight → gate → dispatch → ledger, with OUTER-loop stops.
 *
 * Why this exists (issue 1219 requirement 1): in `run-arms.py` the gate check ended in
 * `break` that sat inside `for slot in pr["slots"]` (line 128), so the outer
 * `for pr in pairs` loop (line 126) simply advanced to the NEXT task. A wiring failure
 * therefore did not stop the driver — it skipped one arm and burned the next task's budget.
 * The same defect sat on the ceiling check and the provision abort.
 *
 * There is no nesting here at all: one loop over slots, and every stop condition RETURNS.
 * That is the whole fix — a `break` cannot be aimed at the wrong loop when there is only
 * one. Distinction preserved deliberately:
 *   - a GATE FAILURE (untrustworthy or absent record) stops the whole driver, nonzero;
 *   - an explicit EXCLUSION (a task/environment property) skips that one slot and the
 *     frozen list continues, with the exclusion recorded and counted separately.
 */
import type { GateDecision } from "./preflight.js";
import { compareIdentities, type RunIdentity } from "./identities.js";
import type { DriverSlot } from "./config.js";

/** Why the driver stopped; surfaced so a report never has to infer it. */
export type StopReason =
  "completed" | "gate-failure" | "ceiling" | "slot-unavailable";

export interface DriverExit {
  readonly code: number;
  readonly stopReason: StopReason;
  /** Slot key the driver stopped on, or `null` when it ran to completion. */
  readonly stoppedAt: string | null;
  readonly dispatched: ReadonlyArray<string>;
  readonly excluded: ReadonlyArray<string>;
}

/** What the driver needs from its environment, injected so tests need no Docker. */
export interface DriverDeps {
  readonly slots: ReadonlyArray<DriverSlot>;
  /** The identity the manifest requires for a slot; used to re-verify every decision. */
  readonly identityFor: (slot: DriverSlot) => RunIdentity;
  /** Decide the gate for one slot. Returns a decision bound to the slot's identity. */
  readonly gate: (slot: DriverSlot) => Promise<GateDecision>;
  /** Dispatch exactly one attempt for a slot whose gate passed. */
  readonly dispatch: (slot: DriverSlot) => Promise<void>;
  /** Whether another attempt may be dispatched against the claimed budget. */
  readonly mayDispatchMore: () => boolean;
  readonly budgetReason: () => string;
}

/**
 * Re-verify a decision's record against the slot's identity.
 *
 * Selection is the gate's job, but a caller that hands the driver a record it built itself
 * must not be able to slip a stale verdict past the loop — that is precisely how #1212
 * accepted an `EXCLUDE` record beside `reward=1`. A mismatch is a gate failure, not an
 * exclusion, because it says the harness is untrustworthy rather than the task is hard.
 */
function decisionIsTrustworthy(
  decision: GateDecision,
  identity: RunIdentity
): boolean {
  if (decision.kind === "reject") return false;
  if (decision.record === null) return false;
  return compareIdentities(identity, decision.record.identity).fresh;
}

/** Terminal stop: returns rather than breaks, so it cannot escape the wrong loop. */
function stop(
  reason: StopReason,
  slotKey: string | null,
  exit: Partial<DriverExit>
): DriverExit {
  return {
    code: 1,
    stopReason: reason,
    stoppedAt: slotKey,
    dispatched: exit.dispatched ?? [],
    excluded: exit.excluded ?? [],
  };
}

/**
 * Run the frozen slot list once.
 *
 * Ordering is fixed and mechanical: gate before any dispatch, budget before any dispatch,
 * and the ledger intent row written inside `dispatch` before the runner is invoked.
 */
export async function runDriver(deps: DriverDeps): Promise<DriverExit> {
  const dispatched: string[] = [];
  const excluded: string[] = [];

  for (const slot of deps.slots) {
    const decision = await deps.gate(slot);

    if (!decisionIsTrustworthy(decision, deps.identityFor(slot))) {
      // Untrustworthy or absent record: the harness itself is in question, so nothing
      // further is dispatched. This is the defect the #1212 `break` failed to stop.
      return stop("gate-failure", slot.slotKey, { dispatched, excluded });
    }
    if (decision.kind === "exclude") {
      excluded.push(slot.slotKey);
      continue;
    }
    if (!deps.mayDispatchMore()) {
      return stop("ceiling", slot.slotKey, { dispatched, excluded });
    }
    await deps.dispatch(slot);
    dispatched.push(slot.slotKey);
  }

  return {
    code: 0,
    stopReason: "completed",
    stoppedAt: null,
    dispatched,
    excluded,
  };
}
