/**
 * Effort fuse for `run_graph`.
 *
 * effort = how many times the executor enters a given node id within one
 * `run_graph` call (including the first). The threshold is 8, so the 9th
 * entry into the same id trips the fuse for the whole call. Normal failure
 * rewinds should never reach it; spin loops (e.g. an always-failing
 * self-onFailure re-entering serially forever) should. The number is
 * deliberately not a setting — changing it requires a separate decision.
 *
 * The gate sits at the handler's executor entry, not in the scheduler or
 * validation layer (keep effort out of validateGraph / topo / on-failure).
 * A trip notifies the scheduler through an AbortController `signal`:
 * in-flight nodes settle with their real outcome, no new entries start, and
 * the call converges; the handler first freezes the done results through
 * the same partial-results channel as mid-run violations, then rejects with
 * a typed error.
 *
 * Counting is per call: a trip only ends this handler invocation — the next
 * residual subgraph in the outer loop uses new ids and is unaffected.
 *
 * Boundary: pure counter + abort signal; imports no scheduler / ledger /
 * node-executor.
 */

import { EFFORT_FUSE_THRESHOLD } from "./effort-threshold.js";

export interface EffortFuse {
  /**
   * Called at every executor entry. Returns false once an id exceeds the
   * threshold (9th entry) — the caller must spawn nothing and let the call
   * converge; after a false, all entries are rejected and no longer
   * counted. Counting ignores node status — entering the executor counts
   * (including the first).
   */
  enter(id: string): boolean;
  /** Aborted once tripped; the handler composes it with the caller signal for the scheduler. */
  readonly signal: AbortSignal;
  /** The id that tripped the fuse (for the typed rejection message); undefined until tripped. */
  readonly trippedBy: string | undefined;
}

/**
 * One fuse per `run_graph` handler invocation (single-call lifetime).
 * Not installed on the plain Kahn path (no failure edges) — that path
 * enters each id at most once, so it never triggers.
 */
export function createEffortFuse(): EffortFuse {
  const counts = new Map<string, number>();
  const controller = new AbortController();
  let trippedBy: string | undefined;
  return {
    enter(id: string): boolean {
      if (controller.signal.aborted) return false;
      const n = (counts.get(id) ?? 0) + 1;
      counts.set(id, n);
      if (n > EFFORT_FUSE_THRESHOLD) {
        trippedBy = id;
        controller.abort();
        return false;
      }
      return true;
    },
    signal: controller.signal,
    get trippedBy(): string | undefined {
      return trippedBy;
    },
  };
}
