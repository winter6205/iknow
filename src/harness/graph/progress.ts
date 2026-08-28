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
  /** onWave→onNode 墙钟毫秒；尚未终态则缺省。 */
  readonly durationMs?: number;
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

/** 粗摘要上限：TUI 一行/详情够扫读，不把 envelope.result 整包推进快照。 */
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
    // EXIT: 未知 id 不进快照 —— 投影只按 seed order；写进 statuses 也看不见。
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
