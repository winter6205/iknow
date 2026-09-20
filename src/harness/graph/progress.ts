/**
 * Human-eye progress snapshot for run_graph: accumulated from onWave /
 * onNode callbacks, never reads JSONL.
 *
 * The TUI consumes only this DTO (via the `graph_progress` stream event) and
 * never imports scheduler / topo back.
 */
import type { GraphNodeResult, NodeStatus } from "./types.js";

export interface GraphNodeProgress {
  readonly id: string;
  readonly deps: ReadonlyArray<string>;
  readonly status: NodeStatus;
  readonly summary?: string;
  /** Wall-clock ms from onWave to onNode; absent before the node settles. */
  readonly durationMs?: number;
}

export interface GraphProgressSnapshot {
  /** Wave index of the latest onWave; -1 before the first wave starts. */
  readonly waveIndex: number;
  readonly nodes: ReadonlyArray<GraphNodeProgress>;
}

export interface GraphNodeSeed {
  readonly id: string;
  readonly deps: ReadonlyArray<string>;
}

/** Coarse-summary cap: enough for one TUI line / scannable detail; never pushes a whole envelope.result into the snapshot. */
export const GRAPH_SUMMARY_MAX = 240;

function clipSummary(text: string): string {
  if (text.length <= GRAPH_SUMMARY_MAX) return text;
  return text.slice(0, GRAPH_SUMMARY_MAX);
}

function summaryOf(result: GraphNodeResult): string | undefined {
  if (result.status === "done") return clipSummary(String(result.output ?? ""));
  if (result.status === "failed") return clipSummary(result.error);
  return clipSummary(result.reason);
}

export interface GraphProgressTracker {
  snapshot(): GraphProgressSnapshot;
  onWave(wave: number, ids: ReadonlyArray<string>): GraphProgressSnapshot;
  onNode(result: GraphNodeResult): GraphProgressSnapshot;
}

export function createGraphProgressTracker(
  nodes: ReadonlyArray<GraphNodeSeed>,
  opts?: { readonly nowMs?: () => number }
): GraphProgressTracker {
  const nowMs = opts?.nowMs ?? Date.now;
  const order = nodes.map((n) => n.id);
  const depsOf = new Map(nodes.map((n) => [n.id, n.deps]));
  const statuses = new Map<string, NodeStatus>(
    order.map((id) => [id, "pending"])
  );
  const summaries = new Map<string, string>();
  const startedAt = new Map<string, number>();
  const durations = new Map<string, number>();
  let waveIndex = -1;

  function snapshot(): GraphProgressSnapshot {
    return Object.freeze({
      waveIndex,
      nodes: Object.freeze(order.map(projectNode)),
    });
  }

  function projectNode(id: string): GraphNodeProgress {
    const summary = summaries.get(id);
    const durationMs = durations.get(id);
    return Object.freeze({
      id,
      deps: depsOf.get(id) ?? [],
      status: statuses.get(id) ?? "pending",
      ...(summary !== undefined ? { summary } : {}),
      ...(durationMs !== undefined ? { durationMs } : {}),
    });
  }

  function onWave(
    wave: number,
    ids: ReadonlyArray<string>
  ): GraphProgressSnapshot {
    const t = nowMs();
    waveIndex = wave;
    for (const id of ids) {
      statuses.set(id, "running");
      startedAt.set(id, t);
    }
    return snapshot();
  }

  function onNode(result: GraphNodeResult): GraphProgressSnapshot {
    // EXIT: unknown ids never enter the snapshot — projection follows seed
    // order only; writing into statuses would not make them visible anyway.
    if (!depsOf.has(result.id)) return snapshot();
    statuses.set(result.id, result.status);
    const summary = summaryOf(result);
    if (summary !== undefined) summaries.set(result.id, summary);
    const start = startedAt.get(result.id);
    if (start !== undefined) {
      durations.set(result.id, Math.max(0, nowMs() - start));
      startedAt.delete(result.id);
    }
    return snapshot();
  }

  return { snapshot, onWave, onNode };
}
