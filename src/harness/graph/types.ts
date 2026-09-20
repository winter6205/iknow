/**
 * PROTOTYPE — self-written Graph multi-task orchestration: type contracts.
 *
 * Validation question: the harness currently only has the single-task serial
 * loop at loop-engine.run(); can an additive decoration layer give it
 * multi-task graph orchestration without touching the frozen protocol or
 * product traffic? This file defines only the pure types of graph
 * orchestration (statuses / spec / results / context / executor signature) —
 * no runtime code, no loop-engine imports; shared compile-time dependency of
 * the prototypes in this directory.
 *
 * Boundary: no imports of loop-engine / build-engine / index.ts. Only
 * subagent/ (manager / envelope / role) and trace/ are allowed.
 */

export type NodeStatus = "pending" | "running" | "done" | "failed" | "skipped";

export interface GraphNodeSpec {
  readonly id: string;
  readonly deps: ReadonlyArray<string>; // node ids this node depends on
  /**
   * Declared failure edge (single target): the target is started once only
   * when this node's `NodeOutcome` is `failed`; pointing at itself =
   *
   // (ADR-0055)
   * single-node re-entry. Consumed by the outcome scheduler; graphs without
   * failure edges are statically validated by `validateOnFailureEdges` and
   * the Kahn scheduler ignores this field.
   */
  readonly onFailure?: string;
}
export interface GraphSpec {
  readonly nodes: ReadonlyArray<GraphNodeSpec>;
}

/** Node execution tri-state outcome (done carries output / failed carries error / skipped carries reason). */
export type NodeOutcome =
  | { readonly status: "done"; readonly output: unknown }
  | { readonly status: "failed"; readonly error: string }
  | { readonly status: "skipped"; readonly reason: string };

export type GraphNodeResult = NodeOutcome & { readonly id: string };

/** Immutable execution snapshot: status table + result table + waves advanced. */
export interface GraphExecution {
  readonly statuses: Readonly<Record<string, NodeStatus>>;
  readonly results: Readonly<Record<string, GraphNodeResult>>;
  readonly waveCount: number;
}

/** Node execution context: outputs of all completed deps, indexed by node id (the carrier of data flowing along edges). */
export interface NodeContext {
  readonly outputs: Readonly<Record<string, unknown>>;
}
export type NodeExecutor = (
  id: string,
  ctx: NodeContext
) => Promise<NodeOutcome>;
