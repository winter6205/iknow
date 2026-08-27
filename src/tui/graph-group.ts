/**
 * run_graph 语义分组：now / issues / done / waiting / selected。
 * 纯函数，不 import scheduler / topo，不进 run-graph-tool。
 */
import type {
  GraphNodeProgress,
  GraphProgressSnapshot,
} from "../harness/graph/progress.js";

export const GRAPH_GLYPH = Object.freeze({
  running: "*",
  done: "+",
  failed: "x",
  skipped: "-",
  pending: ".",
});

export interface GroupedIssue {
  readonly id: string;
  readonly node: GraphNodeProgress;
  readonly skipped: ReadonlyArray<GraphNodeProgress>;
}

export interface WaitingCluster {
  readonly on: string;
  readonly nodes: ReadonlyArray<GraphNodeProgress>;
}

export interface GraphGroups {
  readonly now: ReadonlyArray<GraphNodeProgress>;
  readonly issues: ReadonlyArray<GroupedIssue>;
  readonly done: ReadonlyArray<GraphNodeProgress>;
  readonly waiting: ReadonlyArray<WaitingCluster>;
}

export interface SelectedNodeContext {
  readonly id: string;
  readonly needs: ReadonlyArray<string>;
  readonly unlocks: ReadonlyArray<string>;
  readonly last: string | undefined;
}

function failedAncestorId(
  node: GraphNodeProgress,
  byId: ReadonlyMap<string, GraphNodeProgress>
): string | null {
  const seen = new Set<string>();
  const stack = [...node.deps];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const dep = byId.get(id);
    if (dep?.status === "failed") return id;
    if (dep) stack.push(...dep.deps);
  }
  return null;
}

function firstUnmetDep(
  node: GraphNodeProgress,
  byId: ReadonlyMap<string, GraphNodeProgress>
): string {
  for (const id of node.deps) {
    const dep = byId.get(id);
    if (dep === undefined || dep.status !== "done") return id;
  }
  return node.deps[0] ?? "unknown";
}

export function groupGraphSnapshot(
  snapshot: GraphProgressSnapshot
): GraphGroups {
  const byId = new Map(snapshot.nodes.map((n) => [n.id, n]));
  const now = snapshot.nodes.filter((n) => n.status === "running");
  const done = snapshot.nodes.filter((n) => n.status === "done");
  const failed = snapshot.nodes.filter((n) => n.status === "failed");
  const skipped = snapshot.nodes.filter((n) => n.status === "skipped");
  const pending = snapshot.nodes.filter((n) => n.status === "pending");

  const skippedByFailed = new Map<string, GraphNodeProgress[]>();
  const orphanSkipped: GraphNodeProgress[] = [];
  for (const node of skipped) {
    const parent = failedAncestorId(node, byId);
    if (parent === null) {
      orphanSkipped.push(node);
      continue;
    }
    const list = skippedByFailed.get(parent) ?? [];
    list.push(node);
    skippedByFailed.set(parent, list);
  }

  const issues: GroupedIssue[] = failed.map((node) =>
    Object.freeze({
      id: node.id,
      node,
      skipped: Object.freeze(skippedByFailed.get(node.id) ?? []),
    })
  );
  for (const node of orphanSkipped) {
    issues.push(
      Object.freeze({
        id: node.id,
        node,
        skipped: Object.freeze([]),
      })
    );
  }

  const waitingMap = new Map<string, GraphNodeProgress[]>();
  for (const node of pending) {
    const on = firstUnmetDep(node, byId);
    const list = waitingMap.get(on) ?? [];
    list.push(node);
    waitingMap.set(on, list);
  }
  const waiting: WaitingCluster[] = [...waitingMap.entries()].map(
    ([on, nodes]) => Object.freeze({ on, nodes: Object.freeze(nodes) })
  );

  return Object.freeze({
    now: Object.freeze(now),
    issues: Object.freeze(issues),
    done: Object.freeze(done),
    waiting: Object.freeze(waiting),
  });
}

export function selectedNodeContext(
  snapshot: GraphProgressSnapshot,
  selectedId: string
): SelectedNodeContext | null {
  const node = snapshot.nodes.find((n) => n.id === selectedId);
  if (node === undefined) return null;
  const unlocks = snapshot.nodes
    .filter((n) => n.deps.includes(selectedId))
    .map((n) => n.id);
  return Object.freeze({
    id: node.id,
    needs: node.deps,
    unlocks: Object.freeze(unlocks),
    last: node.summary,
  });
}

export interface GraphViewRow {
  readonly key: string;
  readonly kind: "header" | "node" | "skipped";
  readonly text: string;
  readonly dim: boolean;
  readonly nodeId?: string;
}

function nodeText(node: GraphNodeProgress): string {
  return `${GRAPH_GLYPH[node.status]} ${node.id}`;
}

export function graphGroupRows(
  snapshot: GraphProgressSnapshot,
  selectedId: string | null
): ReadonlyArray<GraphViewRow> {
  const g = groupGraphSnapshot(snapshot);
  const rows: GraphViewRow[] = [];
  const pushHeader = (title: string): void => {
    rows.push({ key: `h:${title}`, kind: "header", text: title, dim: true });
  };
  const pushNode = (node: GraphNodeProgress, key: string): void => {
    rows.push({
      key,
      kind: "node",
      text: nodeText(node),
      dim: false,
      nodeId: node.id,
    });
  };

  pushHeader("now");
  for (const n of g.now) pushNode(n, `now:${n.id}`);
  pushHeader("issues");
  for (const issue of g.issues) {
    pushNode(issue.node, `issue:${issue.id}`);
    for (const sk of issue.skipped) {
      rows.push({
        key: `skip:${sk.id}`,
        kind: "skipped",
        text: `  ${GRAPH_GLYPH.skipped} ${sk.id}`,
        dim: false,
        nodeId: sk.id,
      });
    }
  }
  pushHeader("done");
  for (const n of g.done) pushNode(n, `done:${n.id}`);
  for (const cluster of g.waiting) {
    pushHeader(`waiting on ${cluster.on}`);
    for (const n of cluster.nodes) pushNode(n, `wait:${n.id}`);
  }
  if (selectedId !== null) {
    const ctx = selectedNodeContext(snapshot, selectedId);
    if (ctx !== null) {
      pushHeader("selected");
      rows.push({
        key: "selected",
        kind: "header",
        text: `${ctx.id} needs ${ctx.needs.join(",") || "-"} unlocks ${ctx.unlocks.join(",") || "-"}`,
        dim: true,
      });
    }
  }
  return Object.freeze(rows);
}

export function selectableNodeIds(
  rows: ReadonlyArray<GraphViewRow>
): ReadonlyArray<string> {
  return rows
    .map((r) => r.nodeId)
    .filter((id): id is string => id !== undefined);
}

export function sliceGraphViewRows(
  rows: ReadonlyArray<GraphViewRow>,
  selectedId: string | null,
  viewRows: number
): ReadonlyArray<GraphViewRow> {
  const height = Math.max(1, viewRows);
  if (rows.length <= height) return rows;
  let idx = rows.findIndex((r) => r.nodeId === selectedId);
  if (idx < 0) idx = 0;
  const start = Math.max(0, Math.min(idx, rows.length - height));
  return rows.slice(start, start + height);
}

export function moveSelection(
  ids: ReadonlyArray<string>,
  current: string | null,
  delta: number
): string | null {
  if (ids.length === 0) return null;
  const idx = current === null ? 0 : Math.max(0, ids.indexOf(current));
  const next = idx + delta;
  if (next < 0) return ids[0]!;
  if (next >= ids.length) return ids[ids.length - 1]!;
  return ids[next]!;
}
