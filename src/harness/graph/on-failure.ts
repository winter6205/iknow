/**
 * `onFailure` failure-edge validation.
 *
 * Layering: this module is only a linear scan + rejection list; it does not
 * touch the Kahn logic in `validateGraph` / `topoWaves`. Cycle detection
 * covers `deps` only — cycles formed solely by `onFailure` edges are legal.
 *
 * Three typed rejection classes:
 *   - target not in this batch's ids → `onFailure targeting unknown node "X"`;
 *   - target already frozen on the ledger (done / failed) → `onFailure
 *     targeting frozen node "X" (done|failed)`, covering cross-call freeze
 *     semantics (a done node is never re-run because of a failure edge);
 *   - self-targeting `onFailure` is legal — the explicit form of a
 *     single-cell re-entry into an unfrozen id on failure.
 *
 * Boundary: pure function reading only the ledger's `isFrozen` /
 * `statusOf`; imports no scheduler / node-executor / loop-engine.
 */

import type { LiveGraphLedger } from "./ledger.js";

/** Minimal node shape (readNodes has already recognized id/task/deps before handing off to validation). */
export interface OnFailureNode {
  readonly id: string;
  readonly onFailure?: string;
}

/**
 * Failure-edge validation: for each node declaring `onFailure`, check the
 * target is legal (present in this batch's ids, not frozen on the ledger).
 * Returns rejection reason strings; an empty array = pass.
 *
 * `nodes` should be all nodes submitted by this `run_graph` call (already
 * past the schema/readNodes shape checks for id/task/deps). An absent
 * `ledger` = no cross-call freeze to consult, equivalent to everything
 * unfrozen (same convention as `mergeResidual` without a ledger:
 * this-batch ids only).
 */
export function validateOnFailureEdges(
  nodes: ReadonlyArray<OnFailureNode>,
  ledger: LiveGraphLedger | undefined
): ReadonlyArray<string> {
  const rejections: string[] = [];
  const ids = new Set<string>();
  for (const node of nodes) ids.add(node.id);

  for (const node of nodes) {
    const target = node.onFailure;
    if (target === undefined) continue;
    // Check cross-call freeze before unknown-target: an id already frozen
    // on the ledger must report the more specific "targeting frozen node"
    // rejection even if it is absent from this batch, so the model learns
    // to submit a new id instead of assuming a typo. self-onFailure is
    // naturally legal here — a this-batch self id is not yet frozen, and
    // `isFrozen` only consults the ledger.
    if (ledger !== undefined && ledger.isFrozen(target)) {
      const status = ledger.statusOf(target);
      rejections.push(
        `onFailure targeting frozen node "${target}" (${status}) — a frozen node cannot be re-run; submit a new node id instead`
      );
      continue;
    }
    // The target must be one of this batch's ids (a this-batch target includes self).
    if (!ids.has(target)) {
      rejections.push(
        `onFailure targeting unknown node "${target}" — target must be the id of one of the nodes in this submission`
      );
    }
  }
  return rejections;
}
