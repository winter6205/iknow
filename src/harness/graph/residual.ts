/**
 * 活图剩余子图合并（live-graph-phase1 T2 / spec SC5–SC7 / ADR-0050）。
 *
 * 外环只交剩余子图：已 done 的上游不再出现在提交里，但下游 deps 仍指向它。
 * 本模块把「账本里冻结的终态」折叠进本次提交：
 *
 *   - 提交里出现已冻结 id（done 或 failed）→ 拒（SC5 末句 / SC6）；
 *   - dep 指向 frozen-done → 满足：从 dep 列表剔除，产出由账本补进下游
 *     task（SC5 数据流）；
 *   - dep 指向 frozen-failed → 拒：阶段 1 失败再试 = 新 id，不是图上绕回
 *     （spec ASSUMPTIONS #3）；
 *   - dep 指向 skipped 或未知 id → 原样留给 validateGraph（skipped 未冻可
 *     再交，SC7；未知 id 仍 typed 拒，ADR-0066 / SC12）。
 *
 * 分层边界（complexity-anti-drift）：本模块只做「合并前的一次线性扫描 +
 * 拒绝清单」，不改 validateGraph / topoWaves 的 Kahn 逻辑；环 / 自依赖 /
 * 重复 id 仍由 topo 单点裁决。
 *
 * 边界：纯函数模块，不 import scheduler / node-executor / loop-engine。
 */

import type { LiveGraphLedger } from "./ledger.js";

/** 账本缺席时（deps.ledger undefined）的零行为变化：返回原 nodes、无拒绝。 */
export interface ResidualNodeInput {
  readonly id: string;
  readonly task: string;
  readonly deps: ReadonlyArray<string>;
}

export interface ResidualMergeResult {
  /**
   * 合并后的 nodes：frozen-done 的 dep 已从 deps 剔除（satisfied），
   * 其余 deps / 顺序原样 —— 直接交给 validateGraph，语义与其单跑一致。
   */
  readonly nodes: ReadonlyArray<ResidualNodeInput>;
  /**
   * frozen-done dep 的产出，按 dep id 索引 —— handler 把它并进 NodeContext
   * 的 outputs，让 renderTask 无改动地把上游产出写进下游 task（SC5）。
   */
  readonly ledgerOutputs: Readonly<Record<string, string>>;
  /** 全部拒绝原因（冻结冲突 / frozen-failed dep）；空数组 = 可继续校验。 */
  readonly rejections: ReadonlyArray<string>;
}

/**
 * 把账本终态折叠进本次提交（见模块头注释）。纯函数：不 ensure / 不 freeze。
 */
export function resolveResidualSubgraph(
  nodes: ReadonlyArray<ResidualNodeInput>,
  ledger: LiveGraphLedger
): ResidualMergeResult {
  const rejections: string[] = [];

  // SC5 末句 / SC6：已冻结 id 再交 = 重演，整段拒绝（零 spawn）。
  const frozenSubmitted = nodes
    .map((n) => n.id)
    .filter((id) => ledger.isFrozen(id));
  if (frozenSubmitted.length > 0) {
    rejections.push(
      `frozen id(s) cannot be re-run on the same live graph: ${frozenSubmitted.join(", ")}`
    );
  }

  // SC6（ASSUMPTIONS #3）：dep 指向 frozen-failed —— 不当 satisfied，也不当
  // unknown-dep（错误信息要对模型有用：指向失败 id 必须换新 id 重试）。
  // skipped / 从未跑过的 id 不在这里处理：前者 SC7 可再交，后者留给
  // validateGraph 的 unknown-dep（ADR-0066）。
  for (const node of nodes) {
    for (const dep of node.deps) {
      if (ledger.statusOf(dep) === "failed") {
        rejections.push(
          `node "${node.id}" depends on failed node "${dep}" — a failed node cannot be depended on; retry with a new node id`
        );
      }
    }
  }

  // SC5：frozen-done 的 dep = satisfied，从 spec 剔除；产出单独带回。
  const ledgerOutputs: Record<string, string> = {};
  const merged = nodes.map((node) => {
    const kept = node.deps.filter((dep) => {
      if (ledger.statusOf(dep) === "done") {
        const output = ledger.outputOf(dep);
        if (output !== undefined) ledgerOutputs[dep] = output;
        return false;
      }
      return true;
    });
    return kept.length === node.deps.length ? node : { ...node, deps: kept };
  });

  return { nodes: merged, ledgerOutputs, rejections };
}
