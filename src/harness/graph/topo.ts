/**
 * PROTOTYPE — Self-written Graph 多任务编排：拓扑校验与分层。
 *
 * 验证问题：（同 types.ts 头注释）
 * 本文件是纯函数模块：validateGraph 检测 unknown-dep / self-dep / duplicate-id /
 * cycle（尽力而为）；topoWaves 做 Kahn 分层（wave 0 = 无依赖，wave N =
 * 依赖全在 < N 层；非法图抛 Error）。无 IO、无 console、不 import loop-engine。
 *
 * 边界：本模块是 A/B/C 三个原型的共同编译依赖；纯逻辑层，不依赖 subagent/trace。
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
 * 校验：未知依赖 / 自依赖 / 重复 id / 环。返回 [] = 合法。
 * cycle 检测用 Kahn 残留：处理不到的节点集即环上节点（尽力而为）。
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

  // cycle detection via Kahn 残留（仅在前面三项均通过时才有意义，但仍尽力而为）
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

/** Kahn 分层：wave 0 = 无依赖，wave N = 依赖全在 < N 的层。非法图抛 Error。 */
export function topoWaves(
  spec: GraphSpec
): ReadonlyArray<ReadonlyArray<string>> {
  const errors = validateGraph(spec);
  if (errors.length > 0) {
    throw new Error(`invalid graph: ${describeError(errors[0]!)}`);
  }

  // 记录 spec.nodes 的原始顺序，每层内按此稳定排序
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
 * Adjacency 抽取：被 validateGraph（cycle 残差检测）与 topoWaves（Kahn 分层）
 * 共同依赖。`validIds` 仅 validateGraph 用（用于跳过非法边的环检测）。
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
