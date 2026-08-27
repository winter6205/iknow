/**
 * run_graph 人眼进度快照：由 onWave / onNode 累加，不读 JSONL。
 *
 * TUI 只消费本 DTO（经 `graph_progress` 流事件），不反向 import scheduler / topo。
 */
import type { GraphNodeResult, NodeStatus } from "./types.js";

export interface GraphNodeProgress {
  readonly id: string;
  readonly deps: ReadonlyArray<string>;
  readonly status: NodeStatus;
  readonly summary?: string;
}

export interface GraphProgressSnapshot {
  /** 最近一次 onWave 的波次下标；尚未开波 = -1。 */
  readonly waveIndex: number;
  readonly nodes: ReadonlyArray<GraphNodeProgress>;
}

export interface GraphNodeSeed {
  readonly id: string;
  readonly deps: ReadonlyArray<string>;
}

function summaryOf(result: GraphNodeResult): string | undefined {
  if (result.status === "done") return String(result.output ?? "");
  if (result.status === "failed") return result.error;
  return result.reason;
}

export interface GraphProgressTracker {
  snapshot(): GraphProgressSnapshot;
  onWave(wave: number, ids: ReadonlyArray<string>): GraphProgressSnapshot;
  onNode(result: GraphNodeResult): GraphProgressSnapshot;
}

export function createGraphProgressTracker(
  nodes: ReadonlyArray<GraphNodeSeed>
): GraphProgressTracker {
  const order = nodes.map((n) => n.id);
  const depsOf = new Map(nodes.map((n) => [n.id, n.deps]));
  const statuses = new Map<string, NodeStatus>(
    order.map((id) => [id, "pending"])
  );
  const summaries = new Map<string, string>();
  let waveIndex = -1;

  function snapshot(): GraphProgressSnapshot {
    return Object.freeze({
      waveIndex,
      nodes: Object.freeze(order.map(projectNode)),
    });
  }

  function projectNode(id: string): GraphNodeProgress {
    const summary = summaries.get(id);
    return Object.freeze({
      id,
      deps: depsOf.get(id) ?? [],
      status: statuses.get(id) ?? "pending",
      ...(summary !== undefined ? { summary } : {}),
    });
  }

  function onWave(
    wave: number,
    ids: ReadonlyArray<string>
  ): GraphProgressSnapshot {
    waveIndex = wave;
    for (const id of ids) statuses.set(id, "running");
    return snapshot();
  }

  function onNode(result: GraphNodeResult): GraphProgressSnapshot {
    statuses.set(result.id, result.status);
    const summary = summaryOf(result);
    if (summary !== undefined) summaries.set(result.id, summary);
    return snapshot();
  }

  return { snapshot, onWave, onNode };
}
