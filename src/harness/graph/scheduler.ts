/**
 * PROTOTYPE — self-written Graph multi-task orchestration: scheduler.
 *
 * Validation question: (same as types.ts header)
 * Pure orchestration: run nodes concurrently per wave (Promise.all), waves
 * serial; a node failure marks its (transitive) dependents skipped
 * (branch fail-fast) while independent branches continue; state accumulates
 * immutably and one GraphExecution is returned at the end. No loop-engine
 * imports, no console.log (callbacks receive parameters; the logic never
 * prints directly).
 *
 * Boundary: pure orchestration, never spawns directly; the executor closure
 * is injected by the caller.
 */

import { validateGraph, topoWaves } from "./topo.js";
import { formatNodeError } from "./error-render.js";
import type {
  GraphExecution,
  GraphNodeResult,
  GraphSpec,
  NodeContext,
  NodeExecutor,
  NodeStatus,
} from "./types.js";

export interface RunGraphOptions {
  /** Callback before each wave containing runnable nodes starts (skipped for an all-skipped wave; the shell prints progress, the logic never uses it for control flow). */
  readonly onWave?: (wave: number, ids: ReadonlyArray<string>) => void;
  /** Callback after each node settles (skipped nodes included). */
  readonly onNode?: (result: GraphNodeResult) => void;
}

/**
 * Run by waves: concurrent within a wave (Promise.all), serial across waves.
 * A failed node marks its (transitive) dependents skipped (branch fail-fast)
 * while independent branches continue. State accumulates immutably; one
 * GraphExecution is returned.
 */
export async function runGraph(
  spec: GraphSpec,
  exec: NodeExecutor,
  opts?: RunGraphOptions
): Promise<GraphExecution> {
  const errors = validateGraph(spec);
  if (errors.length > 0) {
    throw new Error(`invalid graph: ${errors[0]!.kind}`);
  }

  const waves = topoWaves(spec);

  // depsOf: direct-dependency table (for tracing failed upstreams)
  const depsOf = new Map<string, ReadonlyArray<string>>();
  for (const node of spec.nodes) {
    depsOf.set(node.id, node.deps);
  }

  // Immutable accumulation: each wave end spreads a new object, so the whole
  // GraphExecution can be frozen and the ctx.outputs that exec reads is also
  // an Object.freeze snapshot (refrozen at every wave start below).
  let statuses: Record<string, NodeStatus> = {};
  let results: Record<string, GraphNodeResult> = {};
  let outputs: Readonly<Record<string, unknown>> = {};

  // Initial state: all nodes pending
  for (const node of spec.nodes) {
    statuses[node.id] = "pending";
  }

  let waveCount = 0;
  for (let w = 0; w < waves.length; w++) {
    const wave = waves[w]!;
    waveCount = w + 1;

    // Decide which nodes in this wave run and which are marked skipped
    const toRun: string[] = [];
    for (const id of wave) {
      const failedUpstream = findFailedUpstream(id, depsOf, results);
      if (failedUpstream !== null) {
        const reason = `upstream node "${failedUpstream}" did not complete`;
        const result: GraphNodeResult = { id, status: "skipped", reason };
        statuses = { ...statuses, [id]: "skipped" };
        results = { ...results, [id]: result };
        opts?.onNode?.(result);
      } else {
        toRun.push(id);
      }
    }

    if (toRun.length === 0) continue;

    opts?.onWave?.(w, toRun);

    for (const id of toRun) {
      statuses = { ...statuses, [id]: "running" };
    }

    // Nodes in the same wave share one ctx (snapshot of done nodes' outputs)
    const ctx: NodeContext = Object.freeze({
      outputs: Object.freeze({ ...outputs }),
    });

    const settled = await Promise.all(
      toRun.map(async (id): Promise<GraphNodeResult> => {
        try {
          const outcome = await exec(id, ctx);
          return { id, ...outcome };
        } catch (err) {
          return { id, status: "failed", error: formatNodeError(err) };
        }
      })
    );

    for (const result of settled) {
      statuses = { ...statuses, [result.id]: result.status };
      results = { ...results, [result.id]: result };
      if (result.status === "done") {
        outputs = { ...outputs, [result.id]: result.output };
      }
      opts?.onNode?.(result);
    }
  }

  return Object.freeze({
    statuses: Object.freeze({ ...statuses }),
    results: Object.freeze({ ...results }),
    waveCount,
  });
}

/**
 * Walk up the deps chain to find the first failed/skipped upstream node;
 * decides whether this node is marked skipped by branch fail-fast.
 */
function findFailedUpstream(
  nodeId: string,
  depsOf: ReadonlyMap<string, ReadonlyArray<string>>,
  results: Readonly<Record<string, GraphNodeResult>>
): string | null {
  const visited = new Set<string>();
  const stack: string[] = [...(depsOf.get(nodeId) ?? [])];
  while (stack.length > 0) {
    const dep = stack.pop()!;
    if (visited.has(dep)) continue;
    visited.add(dep);
    const r = results[dep];
    if (r && (r.status === "failed" || r.status === "skipped")) {
      return dep;
    }
    const upstream = depsOf.get(dep);
    if (upstream) stack.push(...upstream);
  }
  return null;
}
