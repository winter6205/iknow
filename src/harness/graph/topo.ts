/**
 * PROTOTYPE — self-written Graph multi-task orchestration: topology
 * validation and layering.
 *
 * Validation question: (same as types.ts header)
 * Pure-function module: validateGraph detects unknown-dep / self-dep /
 * duplicate-id / cycle (best effort); topoWaves does Kahn layering (wave 0 =
 * no deps, wave N = deps all in layers < N; throws Error on an invalid spec).
 * No IO, no console, no loop-engine imports.
 *
 * Boundary: shared compile-time dependency of the prototypes in this
 * directory; pure logic layer with no subagent/trace dependency.
 */

import type { GraphSpec } from "./types.js";

export type GraphValidationError =
  | {
      readonly kind: "unknown-dep";
      readonly node: string;
      readonly dep: string;
    }
  | { readonly kind: "self-dep"; readonly node: string }
  | { readonly kind: "duplicate-id"; readonly id: string }
  | { readonly kind: "cycle"; readonly involved: ReadonlyArray<string> };

/**
 * Validate: unknown deps / self-deps / duplicate ids / cycles. [] = valid.
 * Cycle detection uses the Kahn residue: nodes left unprocessed are on
 * cycles (best effort).
 */
export function validateGraph(
  spec: GraphSpec
): ReadonlyArray<GraphValidationError> {
  const errors: GraphValidationError[] = [];
  const ids = new Set<string>();

  // duplicate-id
  for (const node of spec.nodes) {
    if (ids.has(node.id)) {
      errors.push({ kind: "duplicate-id", id: node.id });
    }
    ids.add(node.id);
  }

  // self-dep + unknown-dep
  for (const node of spec.nodes) {
    for (const dep of node.deps) {
      if (dep === node.id) {
        errors.push({ kind: "self-dep", node: node.id });
      } else if (!ids.has(dep)) {
        errors.push({ kind: "unknown-dep", node: node.id, dep });
      }
    }
  }

  // Cycle detection via Kahn residue (only meaningful when the three checks
  // above all pass, but still best effort)
  const { inDegree, dependents } = buildAdjacency(spec, ids);
  const queue: string[] = [];
  for (const [id, deg] of inDegree) {
    if (deg === 0) queue.push(id);
  }
  const visited = new Set<string>();
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (visited.has(id)) continue;
    visited.add(id);
    for (const dependent of dependents.get(id) ?? []) {
      const next = (inDegree.get(dependent) ?? 1) - 1;
      inDegree.set(dependent, next);
      if (next === 0) queue.push(dependent);
    }
  }
  if (visited.size < ids.size) {
    const involved: string[] = [];
    for (const id of ids) {
      if (!visited.has(id)) involved.push(id);
    }
    errors.push({ kind: "cycle", involved });
  }

  return errors;
}

/** Kahn layering: wave 0 = no deps, wave N = deps all in layers < N. Throws Error on an invalid graph. */
export function topoWaves(
  spec: GraphSpec
): ReadonlyArray<ReadonlyArray<string>> {
  const errors = validateGraph(spec);
  if (errors.length > 0) {
    throw new Error(`invalid graph: ${describeError(errors[0]!)}`);
  }

  // Record spec.nodes' original order; each layer is stably sorted by it
  const nodeOrder = new Map<string, number>();
  for (let i = 0; i < spec.nodes.length; i++) {
    nodeOrder.set(spec.nodes[i]!.id, i);
  }

  const { inDegree, dependents } = buildAdjacency(spec);

  const waves: string[][] = [];
  let current = sortByOrder(
    [...inDegree.entries()].filter(([, deg]) => deg === 0).map(([id]) => id),
    nodeOrder
  );

  while (current.length > 0) {
    waves.push(current);
    const next: string[] = [];
    for (const id of current) {
      for (const dependent of dependents.get(id) ?? []) {
        const newDeg = (inDegree.get(dependent) ?? 1) - 1;
        inDegree.set(dependent, newDeg);
        if (newDeg === 0) next.push(dependent);
      }
    }
    current = sortByOrder(next, nodeOrder);
  }

  return waves;
}

/**
 * Adjacency extraction, shared by validateGraph (cycle-residue detection)
 * and topoWaves (Kahn layering). `validIds` is only for validateGraph (to
 * skip illegal edges during cycle detection).
 */
function buildAdjacency(
  spec: GraphSpec,
  validIds?: ReadonlySet<string>
): {
  inDegree: Map<string, number>;
  dependents: Map<string, string[]>;
} {
  const inDegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const node of spec.nodes) {
    if (!inDegree.has(node.id)) inDegree.set(node.id, 0);
    if (!dependents.has(node.id)) dependents.set(node.id, []);
  }
  for (const node of spec.nodes) {
    for (const dep of node.deps) {
      if (validIds && (dep === node.id || !validIds.has(dep))) continue;
      inDegree.set(node.id, (inDegree.get(node.id) ?? 0) + 1);
      dependents.get(dep)!.push(node.id);
    }
  }
  return { inDegree, dependents };
}

function sortByOrder(
  ids: ReadonlyArray<string>,
  order: ReadonlyMap<string, number>
): string[] {
  return [...ids].sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
}

function describeError(err: GraphValidationError): string {
  switch (err.kind) {
    case "unknown-dep":
      return `node "${err.node}" depends on unknown node "${err.dep}"`;
    case "self-dep":
      return `node "${err.node}" depends on itself`;
    case "duplicate-id":
      return `duplicate node id "${err.id}"`;
    case "cycle":
      return `cycle detected involving nodes: ${err.involved.join(", ")}`;
  }
}
