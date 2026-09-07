/**
 * PROTOTYPE — Self-written Graph 多任务编排：类型契约。
 *
 * 验证问题：harness 当前只有 loop-engine.run() 这一层单任务顺序循环，能否以
 * 加法式装饰层让 harness 具备多任务 graph 编排能力（不改冻结协议、不碰产品流量）。
 * 本文件只定义 graph 编排的纯类型（状态 / 规格 / 结果 / 上下文 / 执行器签名），
 * 无运行时代码、不 import loop-engine；是 A/B/C 三个原型的共同编译依赖。
 *
 * 边界：本模块不 import loop-engine / build-engine / index.ts。仅允许依赖
 * subagent/（manager / envelope / role）与 trace/。
 */

export type NodeStatus = "pending" | "running" | "done" | "failed" | "skipped";

export interface GraphNodeSpec {
  readonly id: string;
  readonly deps: ReadonlyArray<string>; // 本节点依赖的节点 id
  /**
   * live-graph-phase2 T1/T2：标明的失败边（单终点）。仅当本节点
   * `NodeOutcome` 为 `failed` 时启动终点一次（ADR-0055）；指向自己 =
   * 单格再进入（ADR-0053）。T2 起被 outcome 调度器消费；T1 阶段该
   * 字段被 `validateOnFailureEdges` 静态校验、调度器忽略。
   */
  readonly onFailure?: string;
}
export interface GraphSpec {
  readonly nodes: ReadonlyArray<GraphNodeSpec>;
}

/** 节点执行三态结果（done 带 output / failed 带 error / skipped 带 reason）。 */
export type NodeOutcome =
  | { readonly status: "done"; readonly output: unknown }
  | { readonly status: "failed"; readonly error: string }
  | { readonly status: "skipped"; readonly reason: string };

export type GraphNodeResult = NodeOutcome & { readonly id: string };

/** 不可变执行快照：状态表 + 结果表 + 已推进的 wave 数。 */
export interface GraphExecution {
  readonly statuses: Readonly<Record<string, NodeStatus>>;
  readonly results: Readonly<Record<string, GraphNodeResult>>;
  readonly waveCount: number;
}

/** 节点执行上下文：所有已完成依赖的 output，按节点 id 索引（数据沿边流动的载体）。 */
export interface NodeContext {
  readonly outputs: Readonly<Record<string, unknown>>;
}
export type NodeExecutor = (
  id: string,
  ctx: NodeContext
) => Promise<NodeOutcome>;
