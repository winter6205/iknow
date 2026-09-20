/**
 * PROTOTYPE — self-written Graph multi-task orchestration: compile-coupling
 * partitioning core function.
 *
 * Validation question: given tasks tagged with compile-coupling labels
 * (which modules they touch), can coupled ones be chained and decoupled ones
 * split into parallel waves as a basis for subagent allocation?
 *
 * Answer: partitionByCoupling maps each task's declared `touches` into a
 * GraphSpec with deps; tasks coupled on a module are chained (same module →
 * adjacent edges only), decoupled tasks form concurrent waves.
 * topoWaves(spec) then yields the layering — the allocation basis.
 *
 * Boundary: no imports of loop-engine / build-engine; depends only on
 * ./types and ./topo.
 */

import type { GraphNodeSpec, GraphSpec } from "./types.js";

/** Minimal task shape: id + list of touched modules. */
export interface CouplingTask {
  readonly id: string;
  readonly touches: ReadonlyArray<string>;
}

/**
 * Partition an (id, touches) task list into a GraphSpec by compile coupling.
 *
 * Rule: for each module m, collect all tasks touching m (in input order) and
 * **add an edge only between adjacent pairs** (prev → next, i.e.
 * next.deps includes prev). Union the adjacent edges across all modules.
 *
 * Why "adjacent" instead of a full clique?
 * If several tasks touch the same module, a clique would force a total
 * serial order among them — but real compile coupling only needs "the next
 * task revisits after the previous one finishes". Adjacent edges give the
 * minimally serializing partial order: chain only what must be chained, keep
 * what needn't be decoupled so it stays parallel.
 *
 * Complexity: O(T × M), T = task count, M = average touches per task.
 */
export function partitionByCoupling(
  tasks: ReadonlyArray<CouplingTask>
): GraphSpec {
  const depsById = new Map<string, string[]>();
  for (const t of tasks) {
    depsById.set(t.id, []);
  }

  // Task input positions (for "sort by input order")
  const inputIndex = new Map<string, number>();
  for (let i = 0; i < tasks.length; i++) {
    inputIndex.set(tasks[i]!.id, i);
  }

  // module → ids of tasks touching it (in input order)
  const byModule = new Map<string, string[]>();
  for (const t of tasks) {
    for (const m of t.touches) {
      const list = byModule.get(m) ?? [];
      list.push(t.id);
      byModule.set(m, list);
    }
  }

  // For each module: add one prev → next edge between adjacent task pairs
  for (const ids of byModule.values()) {
    for (let i = 1; i < ids.length; i++) {
      const prev = ids[i - 1]!;
      const next = ids[i]!;
      depsById.get(next)!.push(prev);
    }
  }

  // Assemble the GraphSpec: nodes in input order, deps deduplicated (one
  // task can gain duplicate edges via several shared upstream modules),
  // sorted stably by inputIndex for verifiability and readability.
  const result: GraphNodeSpec[] = [];
  for (const t of tasks) {
    const deps = depsById.get(t.id)!;
    const stableDeps = [...new Set(deps)].sort(
      (a, b) => (inputIndex.get(a) ?? 0) - (inputIndex.get(b) ?? 0)
    );
    result.push({ id: t.id, deps: stableDeps });
  }
  return { nodes: result };
}

/** Whether two ids land in the same wave of topoWaves(spec). */
export function sameWave(
  a: string,
  b: string,
  waves: ReadonlyArray<ReadonlyArray<string>>
): boolean {
  for (const w of waves) {
    if (w.includes(a) && w.includes(b)) return true;
  }
  return false;
}
