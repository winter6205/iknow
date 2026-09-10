/**
 * live-graph-phase2 T1 — `onFailure` 失败边校验（spec SC4–SC5 / Changes /
 * ADR-0053、0058–0060、0066）。
 *
 * 分层（complexity-anti-drift）：本模块只做"线性扫描 + 拒绝清单"，不改
 * `validateGraph` / `topoWaves` 的 Kahn；环检测只对 `deps`，仅因
 * `onFailure` 形成的圈合法（ADR-0058/0059）。
 *
 * 三类 typed 拒绝：
 *   - 目标不在本批 ids → `onFailure targeting unknown node "X"`；
 *   - 目标在账本上已冻结（done / failed） → `onFailure targeting frozen
 *     node "X" (done|failed)`，覆盖跨调用冻结语义（ADR-0060：done 永
 *     不因失败边再跑）；
 *   - `onFailure` 指向自己（self）合法 —— spec Changes「失败回走到未冻
 *     旧 id 时 spawn 次数增加」的单格再进入显式表达（ADR-0053）。
 *
 * 边界：本模块是纯函数，只读账本 `isFrozen` / `statusOf`；不 import
 * scheduler / node-executor / loop-engine。
 */

import type { LiveGraphLedger } from "./ledger.js";

/** 单个节点的最小形态（readNodes 已识别完 id/task/deps 后交给校验层）。 */
export interface OnFailureNode {
  readonly id: string;
  readonly onFailure?: string;
}

/**
 * 失败边校验：对每个声明 `onFailure` 的节点检查目标是否合法（在本批 ids
 * 中、不在账本已冻结）。返回拒绝原因字符串数组；空数组 = 通过。
 *
 * `nodes` 应为本次 `run_graph` 提交的全部节点（已通过 schema/readNodes
 * 的 id/task/deps 形状校验）。`ledger` 缺席 = 无跨调用冻结可查，等价于
 * 全部未冻结（与 `mergeResidual` 缺席时一致：纯本批 id 检查）。
 */
export function validateOnFailureEdges(
  nodes: ReadonlyArray<OnFailureNode>,
  ledger: LiveGraphLedger | undefined
): ReadonlyArray<string> {
  const rejections: string[] = [];
  const ids = new Set<string>();
  for (const node of nodes) ids.add(node.id);

  for (const node of nodes) {
    const target = node.onFailure;
    if (target === undefined) continue;
    // 跨调用冻结（ADR-0060）先于 unknown 检查：账本上已冻结的 id 即使
    // 不在本批 ids 里，也要报出「指向冻结节点」这一更具体的拒绝原因，
    // 让模型知道该换新 id，而不是误以为拼错了 id。self-onFailure 在此
    // 自然合法 —— 本批 self id 未冻结，`isFrozen` 只查账本。
    if (ledger !== undefined && ledger.isFrozen(target)) {
      const status = ledger.statusOf(target);
      rejections.push(
        `onFailure targeting frozen node "${target}" (${status}) — a frozen node cannot be re-run; submit a new node id instead`
      );
      continue;
    }
    // spec Changes：目标必须是本批 ids 之一（指向本批即含 self）。
    if (!ids.has(target)) {
      rejections.push(
        `onFailure targeting unknown node "${target}" — target must be the id of one of the nodes in this submission`
      );
    }
  }
  return rejections;
}
