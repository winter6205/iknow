/**
 * Outcome-driven failure-edge scheduler for graphs carrying `onFailure`.
 *
 * Division of labour with `scheduler.ts`: the original `runGraph` remains the
 * Kahn wave scheduler for graphs without failure edges (byte-identical
 * behaviour); this module owns the scheduling line for graphs with them.
 * Enablement is judged by NodeOutcome:
 *
 *   - **Forward edges = deps**: a node starts only when all deps are done
 *     (same semantics as the Kahn path).
 *
 // (ADR-0055)
 *   - **Failure edges = onFailure**: a target is started once only when the
 *     source settles as failed; done / skipped sources never trigger failure
 *     edges.
 *   - **Failure-edge starts bypass the deps gate**: the target may itself
 *     depend on the just-failed source (the common drawing for a fresh
 *     retry node) — deps being unsatisfied is fine, the back edge itself is
 *     the enablement basis, and the host never reroutes based on failure
 *     content.
 *   - **Re-entry of the same id**: when the target is the just-failed old id
 *     (including self), it re-enters the executor; if the target is already
 *     done in this run → violation: no spawn, scheduling converges, and the
 *     handler rejects typed (done never re-runs because of a failure edge).
 *   - **After abort**: no new entries start; the run converges once
 *     in-flight nodes settle, no spinning.
 *
 * Entry dedup: the `queued` set holds an id while it is in the current ready
 * list or in an already-spliced about-to-run batch, so re-entry is refused —
 * failure-edge kicks and deps promotions both dedup through `queued`, hence
 * **at most one in-flight entry per id at any time**. Two layers make this
 * hold: (a) `queued`/`isFinal` short-circuit at the enqueue entry; (b) **the
 * failure-edge kick only raises after the whole wave has settled, in the
 * second pass** (see `for (const r of settled)` below), so no second kick
 * can enqueue the same id mid-wave. The cap on repeated same-id re-entries
 * (effort fuse) is not here — it is a gate at the executor entry.
 *
 * Layering: this module never calls validateGraph (inputs must already pass
 * handler validation), does not read the ledger, does not import
 * node-executor / loop-engine.
 *
 * Boundary: pure scheduling; the executor closure is injected by the caller.
 * No imports of loop-engine / build-engine / index.ts.
 */

import type {
  GraphExecution,
  GraphNodeResult,
  GraphSpec,
  NodeContext,
  NodeExecutor,
  NodeOutcome,
  NodeStatus,
} from "./types.js";
import { formatNodeError } from "./error-render.js";

export interface FailureEdgeViolation {
  /** Source id that triggered the violation (failed here, but its `onFailure` target is already done). */
  readonly from: string;
  /** Declared failure-edge target (already done in this run, may never re-run). */
  readonly target: string;
}

export interface FailureEdgeExecutionResult {
  readonly execution: GraphExecution;
  /**
   * Mid-run typed violation: a failure-edge target was already done in this
   * run. The handler rejects typed on this (same partial-results channel as
   * abort — already-done results are kept and frozen), distinct from
   * submit-time schema/validation rejection.
   */
  readonly violation?: FailureEdgeViolation;
}

export interface RunGraphWithFailureEdgesOptions {
  /** Callback before each ready batch starts (wave index from 0; the shell prints progress). */
  readonly onWave?: (wave: number, ids: ReadonlyArray<string>) => void;
  /** Callback after each node settles (skipped included; same-id re-entry fires per settle). */
  readonly onNode?: (result: GraphNodeResult) => void;
  /**
   * Caller's cancellation signal. After abort: in-flight nodes settle with
   * their real NodeOutcome, but no new entries start (both failure-edge
   * kicks and deps promotions stop).
   */
  readonly signal?: AbortSignal;
}

/**
 * Outcome-driven failure-edge scheduler. Returns an immutable
 * GraphExecution plus an optional violation.
 */
export async function runGraphWithFailureEdges(
  spec: GraphSpec,
  exec: NodeExecutor,
  opts?: RunGraphWithFailureEdgesOptions
): Promise<FailureEdgeExecutionResult> {
  const onWave = opts?.onWave;
  const onNode = opts?.onNode;
  const signal = opts?.signal;

  const depsOf = new Map<string, ReadonlyArray<string>>();
  const failureEdgeOf = new Map<string, string | undefined>();
  for (const node of spec.nodes) {
    depsOf.set(node.id, node.deps);
    failureEdgeOf.set(node.id, node.onFailure);
  }

  const statuses: Record<string, NodeStatus> = {};
  const results: Record<string, GraphNodeResult> = {};
  const outputs: Record<string, unknown> = {};

  // ready: batch waiting to start; queued: ids either in the ready list or in
  // an already-spliced running batch (deleted at splice — mid-wave re-entry
  // is still blocked by isFinal / the second-pass kick timing, see "Entry
  // dedup" in the module header). Failure-edge kicks and deps promotions both
  // dedup through queued — at most one entry per id at a time.
  const ready: string[] = [];
  const queued = new Set<string>();

  function isFinal(id: string): boolean {
    const s = statuses[id];
    return s === "done" || s === "failed" || s === "skipped";
  }

  function depsSatisfied(id: string): boolean {
    for (const dep of depsOf.get(id) ?? []) {
      if (results[dep]?.status !== "done") return false;
    }
    return true;
  }

  /** Deps promotion: all deps done and neither queued nor settled → enqueue. */
  function enqueueIfReady(id: string): void {
    if (queued.has(id) || isFinal(id)) return;
    if (!depsSatisfied(id)) return;
    queued.add(id);
    ready.push(id);
  }

  /**
   * Failure-edge kick: bypasses both the deps gate and isFinal (the target
   * being the just-failed old id is re-entry proper; the target depending on
   * the just-failed source is the fresh-retry-node drawing). The only
   * forbidden target state is done — the caller checks that as a violation
   * first.
   */
  function enqueueFailureEdgeTarget(target: string): void {
    if (queued.has(target)) return;
    queued.add(target);
    ready.push(target);
  }

  /** Transitively mark unsettled nodes depending on a failed node as skipped, along deps. */
  function skipDependentsOf(rootId: string, reason: string): void {
    const visited = new Set<string>([rootId]);
    const stack = [rootId];
    while (stack.length > 0) {
      const id = stack.pop()!;
      for (const node of spec.nodes) {
        if (!node.deps.includes(id) || visited.has(node.id)) continue;
        visited.add(node.id);
        stack.push(node.id);
        // A node already kicked via a failure edge is not marked skipped —
        // its enablement basis is the back edge, not deps (already queued,
        // about to really run).
        if (queued.has(node.id) || isFinal(node.id)) continue;
        const r: GraphNodeResult = { id: node.id, status: "skipped", reason };
        results[node.id] = r;
        statuses[node.id] = "skipped";
        onNode?.(r);
      }
    }
  }

  // Initial state: root nodes without deps are enqueued.
  for (const node of spec.nodes) {
    if (node.deps.length === 0) enqueueIfReady(node.id);
  }

  let waveCount = 0;
  let violation: FailureEdgeViolation | undefined;

  while (violation === undefined) {
    if (ready.length === 0) {
      // Convergence. On the abort path, remaining unsettled nodes are not
      // back-filled with skipped (the handler rejects typed anyway and only
      // freezes done); still-blocked nodes on a non-abort path would be a
      // validation hole, so the fallback skip prevents a dead loop (normally
      // unreachable — dep cycles are already rejected by topo).
      if (signal?.aborted) break;
      for (const node of spec.nodes) {
        if (isFinal(node.id) || queued.has(node.id)) continue;
        const r: GraphNodeResult = {
          id: node.id,
          status: "skipped",
          reason: "deps could not be satisfied",
        };
        results[node.id] = r;
        statuses[node.id] = "skipped";
        onNode?.(r);
      }
      break;
    }

    const batch = ready.splice(0, ready.length);
    for (const id of batch) queued.delete(id);
    waveCount++;
    onWave?.(waveCount - 1, batch);
    for (const id of batch) statuses[id] = "running";

    const ctx: NodeContext = Object.freeze({
      outputs: Object.freeze({ ...outputs }),
    });

    const settled = await Promise.all(
      batch.map(async (id): Promise<GraphNodeResult> => {
        try {
          const outcome: NodeOutcome = await exec(id, ctx);
          return { id, ...outcome };
        } catch (err) {
          return { id, status: "failed", error: formatNodeError(err) };
        }
      })
    );

    // Two passes: first write every settle result of the whole wave into
    // results / statuses / outputs (the partial-results channel's promise:
    // the handler freezes all settled ids of the wave; breaking "done is
    // never re-run" would let the next segment's residual subgraph run them
    // again). Only then judge failure edges / violations — so the wave's
    // records are complete before a violation raises.
    for (const r of settled) {
      // Same-id re-entry: the last outcome overwrites the previous one
      // (results / statuses / onNode move together).
      results[r.id] = r;
      statuses[r.id] = r.status;
      if (r.status === "done") outputs[r.id] = r.output;
      onNode?.(r);
    }

    for (const r of settled) {
      if (signal?.aborted) continue; // after abort: settle only, never advance

      if (r.status === "done") {
        // Forward edges: nodes depending on this one attempt promotion
        // (failure edges never trigger here).
        // (ADR-0055)
        for (const node of spec.nodes) {
          if (node.deps.includes(r.id)) enqueueIfReady(node.id);
        }
      } else if (r.status === "failed") {
        // Failure edge (single target): target already done in this run →
        // violation; otherwise kick (fresh entry or same-id re-entry).
        const target = failureEdgeOf.get(r.id);
        if (target !== undefined) {
          if (results[target]?.status === "done") {
            violation = { from: r.id, target };
            break;
          }
          enqueueFailureEdgeTarget(target);
        }
        skipDependentsOf(r.id, `upstream node "${r.id}" did not complete`);
      }
      // A skipped outcome never triggers a failure edge; its dependents are
      // blocked naturally by skipDependentsOf or unsatisfied deps.
    }
  }

  return {
    execution: Object.freeze({
      statuses: Object.freeze({ ...statuses }),
      results: Object.freeze({ ...results }),
      waveCount,
    }),
    ...(violation !== undefined ? { violation } : {}),
  };
}
