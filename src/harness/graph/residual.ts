/**
 * Live-graph residual-subgraph merge: folds ledger-frozen terminal states
 * into a new submission.
 *
 * The outer loop submits only the residual subgraph: already-done upstream
 * nodes no longer appear in the submission, but downstream deps still point
 * at them. This module merges that reality:
 *
 *   - a frozen id (done or failed) appearing in the submission → reject
 *     (re-running frozen work is never allowed);
 *   - dep pointing at frozen-done → satisfied: strip it from the dep list,
 *     and the ledger supplies its output into downstream tasks (the data
 *     flow for reading upstream results);
 *   - dep pointing at frozen-failed → reject: retrying a failure means a new
 *     id, not routing around it on the graph;
 *   - dep pointing at skipped or an unknown id → left untouched for
 *     validateGraph (skipped was never frozen and may be resubmitted;
 *     unknown ids stay typed-rejected there).
 *
 * Layering: one linear scan plus a rejection list — this module never touches
 * validateGraph / topoWaves' Kahn logic; cycles, self-deps and duplicate ids
 * remain topo's single-point rulings.
 *
 * Boundary: pure function module; no imports of scheduler / node-executor /
 * loop-engine.
 */

import type { LiveGraphLedger } from "./ledger.js";

/** One submitted node's minimal shape: id + task + deps. */
export interface ResidualNodeInput {
  readonly id: string;
  readonly task: string;
  readonly deps: ReadonlyArray<string>;
}

export interface ResidualMergeResult {
  /**
   * Merged nodes: frozen-done deps stripped (satisfied), everything else in
   * original order — feed straight into validateGraph with the same
   * semantics as running it alone.
   */
  readonly nodes: ReadonlyArray<ResidualNodeInput>;
  /**
   * Outputs of frozen-done deps, indexed by dep id — the handler folds them
   * into NodeContext outputs so renderTask writes upstream results into
   * downstream tasks unchanged.
   */
  readonly ledgerOutputs: Readonly<Record<string, string>>;
  /** All rejection reasons (frozen conflict / frozen-failed dep); empty = validation may proceed. */
  readonly rejections: ReadonlyArray<string>;
}

/**
 * Fold ledger terminal states into this submission (see module header).
 * Pure: never calls ensure / freeze.
 */
export function resolveResidualSubgraph(
  nodes: ReadonlyArray<ResidualNodeInput>,
  ledger: LiveGraphLedger
): ResidualMergeResult {
  const rejections: string[] = [];

  // A frozen id resubmitted = re-run → reject the whole segment (zero spawn).
  const frozenSubmitted = nodes
    .map((n) => n.id)
    .filter((id) => ledger.isFrozen(id));
  if (frozenSubmitted.length > 0) {
    rejections.push(
      `frozen id(s) cannot be re-run on the same live graph: ${frozenSubmitted.join(", ")}`
    );
  }

  // Dep pointing at frozen-failed — neither satisfied nor unknown-dep (the
  // error text must be useful to the model: pointing at a failed id requires
  // a new node id). skipped / never-run ids are not handled here: the former
  // may be resubmitted, the latter stay validateGraph's unknown-dep case.
  for (const node of nodes) {
    for (const dep of node.deps) {
      if (ledger.statusOf(dep) === "failed") {
        rejections.push(
          `node "${node.id}" depends on failed node "${dep}" — a failed node cannot be depended on; retry with a new node id`
        );
      }
    }
  }

  // frozen-done deps = satisfied; strip from the spec, carry outputs back separately.
  const ledgerOutputs: Record<string, string> = {};
  const merged = nodes.map((node) => {
    const kept = node.deps.filter((dep) => {
      if (ledger.statusOf(dep) === "done") {
        const output = ledger.outputOf(dep);
        if (output !== undefined) ledgerOutputs[dep] = output;
        return false;
      }
      return true;
    });
    return kept.length === node.deps.length ? node : { ...node, deps: kept };
  });

  return { nodes: merged, ledgerOutputs, rejections };
}
